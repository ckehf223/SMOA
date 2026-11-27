import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../server/store.js';
import { organizationRoutes, periodRange, previousGoalRange } from '../server/organization.js';
import { adminRoutes } from '../server/admin.js';
import { seoulDateOf } from '../server/domain.js';
import { scopeFor } from '../server/permissions.js';

// 로컬 메모리 저장소와 가상 자료만 쓴다. DB·Git·네트워크는 쓰지 않고 라우트 처리기를 직접 부른다.
async function setup() {
  const store = await createStore();
  const users = [...store.users.values()];
  const admin = users.find((u) => u.username === 'admin');
  const manager = users.find((u) => u.username === 'manager1');
  const routes = organizationRoutes(store);
  const call = (user, method, path, { body = {}, query = {}, params = [], token = 'session-a', file } = {}) => {
    const route = routes.find((r) => r.method === method && r.path === path);
    assert.ok(route, `${method} ${path}`);
    if (user.role !== 'admin' && route.auth === 'admin') return Promise.reject(Object.assign(new Error('관리자 전용'), { status: 403 }));
    return Promise.resolve().then(() => route.handler({ user, token, body, query: new URLSearchParams(query), params, file, recheck() {} }));
  };
  const today = seoulDateOf(store.now());
  const month = periodRange('month', today);
  const next = periodRange('month', new Date(Date.parse(`${month.to}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10));
  const ownRegions = (u) => store.districts.filter((d) => scopeFor(store, u).has(d.id)).map((d) => d.name);
  return { store, admin, manager, routes, call, month, next, ownRegions };
}

test('기간 계산: 주(시작 요일)·월·직접 지정의 직전 기간', () => {
  assert.deepEqual(previousGoalRange({ periodUnit: 'week', from: '2026-11-09', to: '2026-11-15' }, 1), { from: '2026-11-02', to: '2026-11-08' });
  assert.deepEqual(previousGoalRange({ periodUnit: 'month', from: '2024-03-01', to: '2024-03-31' }), { from: '2024-02-01', to: '2024-02-29' });
  assert.deepEqual(previousGoalRange({ periodUnit: 'custom', from: '2026-01-01', to: '2026-01-03' }), { from: '2025-12-29', to: '2025-12-31' });
  assert.throws(() => previousGoalRange({ periodUnit: 'week', from: '2026-11-15', to: '2026-11-09' }));
});

test('목표 복사: 미리보기는 저장하지 않고, 반영은 한 번에 하며, 다시 하면 기존 목표를 유지한다', async () => {
  const { store, admin, call, month, next } = await setup();
  const before = store.workspace.goals.length;
  const input = { periodUnit: 'month', from: next.from, to: next.to, regionScope: '' };

  const preview = await call(admin, 'POST', '/api/goals/copy/preview', { body: input });
  assert.equal(store.workspace.goals.length, before, '미리보기는 저장하지 않는다');
  assert.deepEqual(preview.source, month);
  assert.equal(preview.counts.copy, 6);
  assert.equal(preview.canApply, true);

  const revision = store.workspace.revision;
  const done = await call(admin, 'POST', '/api/goals/copy/apply', { body: { previewId: preview.previewId } });
  assert.equal(done.applied, 6);
  assert.equal(store.workspace.goals.length, before + 6);
  assert.ok(store.workspace.revision > revision);
  await assert.rejects(call(admin, 'POST', '/api/goals/copy/apply', { body: { previewId: preview.previewId } }), { status: 404 }); // 한 번만 쓸 수 있다

  // 다시 만들면 모두 기존 목표 유지. 직전 기간 값을 바꾸면 덮어쓰기 선택 때만 바뀐다.
  const again = await call(admin, 'POST', '/api/goals/copy/preview', { body: input });
  assert.equal(again.counts.keep, 6);
  assert.equal(again.canApply, false);
  assert.equal(again.previewId, null);
  await call(admin, 'PUT', '/api/goals/:id', { params: ['g-d1-found'], body: { target: 99 } });
  assert.equal((await call(admin, 'POST', '/api/goals/copy/preview', { body: input })).counts.overwrite, 0);
  const over = await call(admin, 'POST', '/api/goals/copy/preview', { body: { ...input, conflict: 'overwrite' } });
  assert.equal(over.counts.overwrite, 1);
  await call(admin, 'POST', '/api/goals/copy/apply', { body: { previewId: over.previewId } });
  assert.equal(store.workspace.goals.find((g) => g.region === '1구역' && g.from === next.from && g.stageId === '*').target, 99);
});

test('목표 복사: 0건 목표를 그대로 옮기고, 바뀐 자료·다른 세션·다른 사용자의 미리보기는 거부한다', async () => {
  const { store, admin, manager, call, month, next } = await setup();
  const zero = { id: 'g-zero', region: '1구역', from: month.from, to: month.to, stageId: '*', target: 0, periodUnit: 'month', className: '1' };
  await call(admin, 'POST', '/api/goals', { body: zero });
  const input = { periodUnit: 'month', from: next.from, to: next.to };
  const preview = await call(admin, 'POST', '/api/goals/copy/preview', { body: input });
  assert.ok(preview.items.some((i) => i.className === '1' && i.target === 0 && i.status === 'copy'));

  await assert.rejects(call(manager, 'POST', '/api/goals/copy/apply', { body: { previewId: preview.previewId } }), { status: 404 }); // 다른 사용자
  await assert.rejects(call(admin, 'POST', '/api/goals/copy/apply', { token: 'session-b', body: { previewId: preview.previewId } }), { status: 403 }); // 다른 세션
  await call(admin, 'PUT', '/api/goals/:id', { params: ['g-d1-found'], body: { target: 5 } }); // 미리보기 이후 자료가 바뀜
  await assert.rejects(call(admin, 'POST', '/api/goals/copy/apply', { body: { previewId: preview.previewId } }), { status: 409 });

  const fresh = await call(admin, 'POST', '/api/goals/copy/preview', { body: input });
  await call(admin, 'POST', '/api/goals/copy/apply', { body: { previewId: fresh.previewId } });
  assert.equal(store.workspace.goals.find((g) => g.from === next.from && g.className === '1').target, 0);
});

test('목표 복사: 구역 담당자는 배정 구역의 목표만 미리보고 복사한다', async () => {
  const { store, manager, call, next, ownRegions } = await setup();
  const own = ownRegions(manager);
  const preview = await call(manager, 'POST', '/api/goals/copy/preview', { body: { periodUnit: 'month', from: next.from, to: next.to } });
  assert.ok(preview.items.length > 0);
  assert.ok(preview.items.every((i) => own.includes(i.region)));
  const other = store.districts.map((d) => d.name).find((n) => !own.includes(n));
  await assert.rejects(call(manager, 'POST', '/api/goals/copy/preview', { body: { periodUnit: 'month', from: next.from, to: next.to, regionScope: other } }), { status: 403 });
  await call(manager, 'POST', '/api/goals/copy/apply', { body: { previewId: preview.previewId } });
  assert.ok(store.workspace.goals.filter((g) => g.from === next.from).every((g) => own.includes(g.region)));
});

test('목표 표: 0과 빈칸을 구분해 저장하고 삭제하며, 바뀐 표·다른 구역은 거부한다', async () => {
  const { store, admin, manager, call, month, ownRegions } = await setup();
  const query = { scope: 'region', from: month.from, to: month.to, periodUnit: 'month', stageId: '*' };
  const table = await call(admin, 'GET', '/api/goals/matrix', { query });
  assert.equal(table.rows.length, 3);
  assert.ok(table.rows.every((r) => r.goalId && typeof r.target === 'number'));
  const [one, two, three] = table.rows;

  const save = (extra) => call(admin, 'POST', '/api/goals/batch', { body: { scope: 'region', from: month.from, to: month.to, periodUnit: 'month', stageId: '*', version: table.version, ...extra } });
  // 둘째 구역은 보내지 않아(빈칸) 그대로 두고, 첫째는 0건으로 저장, 셋째는 삭제한다.
  const res = await save({ rows: [{ region: one.region, className: '', target: 0 }], deleteIds: [three.goalId] });
  assert.equal(res.changed, true);
  const goals = store.workspace.goals;
  assert.equal(goals.find((g) => g.id === one.goalId).target, 0);
  assert.equal(goals.find((g) => g.id === two.goalId).target, two.target);
  assert.equal(goals.some((g) => g.id === three.goalId), false);

  await assert.rejects(save({ rows: [{ region: one.region, className: '', target: 1 }] }), { status: 409 }); // 이전 표 버전
  const fresh = await call(admin, 'GET', '/api/goals/matrix', { query });
  const stage = (extra) => call(admin, 'POST', '/api/goals/batch', { body: { scope: 'region', from: month.from, to: month.to, periodUnit: 'month', stageId: '*', version: fresh.version, ...extra } });
  await assert.rejects(stage({ rows: [{ region: one.region, className: '', target: '' }] }), { status: 400 }); // 빈칸은 값이 아니다
  await assert.rejects(stage({ rows: [{ region: '없는구역', className: '', target: 1 }] }), { status: 400 });

  // 구역 담당자
  await assert.rejects(call(manager, 'GET', '/api/goals/matrix', { query: { ...query, scope: 'class' } }), { status: 403 });
  const mine = await call(manager, 'GET', '/api/goals/matrix', { query });
  assert.ok(mine.rows.every((r) => ownRegions(manager).includes(r.region)));
  const other = store.districts.map((d) => d.name).find((n) => !ownRegions(manager).includes(n));
  await assert.rejects(call(manager, 'POST', '/api/goals/batch', { body: { scope: 'region', from: month.from, to: month.to, periodUnit: 'month', stageId: '*', version: mine.version, rows: [{ region: other, className: '', target: 3 }] } }), { status: 403 });
  await assert.rejects(call(manager, 'POST', '/api/goals/batch', { body: { scope: 'region', from: month.from, to: month.to, periodUnit: 'month', stageId: '*', version: mine.version, rows: [], deleteIds: [two.goalId] } }), { status: 400 });
});

test('조직 엑셀 가져오기: 관리자 전용 미리보기 → 반영, 구역 연동 조직과 다른 시트는 거부한다', async () => {
  const { store, admin, manager, routes, call } = await setup();
  for (const path of ['/api/organization/template', '/api/organization/import/preview', '/api/organization/import/apply']) {
    assert.equal(routes.find((r) => r.path === path).auth, 'admin');
    assert.equal(routes.find((r) => r.path === path).screen, 'organization');
  }
  await assert.rejects(call(manager, 'GET', '/api/organization/template'), { status: 403 });

  // 연락처 모양 문장이 있는 비고도 내려받은 양식을 그대로 올리면 바뀌지 않는다(가려진 값 보존).
  await call(admin, 'PUT', '/api/organization/members/:id', { params: ['m-d1-2'], body: { notes: '연락 010-1234-5678' } });
  const { default: ExcelJS } = await import('exceljs');
  const template = (await call(admin, 'GET', '/api/organization/template')).body;
  const edit = async (change) => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(template);
    change(wb);
    return Buffer.from(await wb.xlsx.writeBuffer());
  };
  const unchanged = await call(admin, 'POST', '/api/organization/import/preview', { file: await edit(() => {}) });
  assert.equal(unchanged.canApply, false);
  assert.equal(unchanged.totalChanges, 0);
  assert.deepEqual(unchanged.errors, []);

  const file = await edit((wb) => {
    const nodes = wb.getWorksheet('조직');
    const members = wb.getWorksheet('구성원');
    nodes.getRow(nodes.actualRowCount + 1).values = ['O-NEW', '신규 팀', '팀', 'O-ROOT', '', '책임자', '', '사용'];
    members.getRow(members.actualRowCount + 1).values = ['M-NEW', '신규 구성원', 'O-NEW', '구성원', '', '미입력', '활동 중', ''];
  });
  const nodesBefore = store.workspace.organization.nodes.length;
  const preview = await call(admin, 'POST', '/api/organization/import/preview', { file });
  assert.deepEqual(preview.errors, []);
  assert.equal(preview.canApply, true);
  assert.equal(preview.counts.조직신규, 1);
  assert.equal(preview.counts.구성원신규, 1);
  assert.equal(store.workspace.organization.nodes.length, nodesBefore, '미리보기는 저장하지 않는다');

  await assert.rejects(call(admin, 'POST', '/api/organization/import/apply', { token: 'session-b', body: { previewId: preview.previewId } }), { status: 403 });
  const done = await call(admin, 'POST', '/api/organization/import/apply', { body: { previewId: preview.previewId } });
  assert.equal(done.applied, 2);
  const org = store.workspace.organization;
  assert.equal(org.nodes.length, nodesBefore + 1);
  assert.ok(org.members.some((m) => m.code === 'M-NEW'));
  for (const d of store.districts) assert.ok(org.nodes.some((n) => n.id === d.id && n.name === d.name && n.active), `${d.name} 연동 조직 유지`);
  assert.equal(org.members.find((m) => m.id === 'm-d1-2').notes, '연락 010-1234-5678');
  await assert.rejects(call(admin, 'POST', '/api/organization/import/apply', { body: { previewId: preview.previewId } }), { status: 404 });

  // 구역 연동 조직 이름 변경은 오류로 막는다.
  const renamed = await edit((wb) => {
    const sheet = wb.getWorksheet('조직');
    sheet.eachRow((row, n) => { if (n > 1 && row.getCell(1).value === 'O-D1') row.getCell(2).value = '다른 이름'; });
  });
  const blocked = await call(admin, 'POST', '/api/organization/import/preview', { file: renamed });
  assert.equal(blocked.canApply, false);
  assert.ok(blocked.errors.length > 0);

  // 조직·구성원 외 시트의 자료는 받지 않는다.
  const foreign = await edit((wb) => { wb.getWorksheet('대상자').getRow(2).getCell(1).value = 'P-X'; });
  await assert.rejects(call(admin, 'POST', '/api/organization/import/preview', { file: foreign }), { status: 400 });
});

test('구성원 발령: 소속 변경 이력을 남기고 범위 밖 구성원은 보여 주지 않는다', async () => {
  const { admin, manager, call } = await setup();
  await call(admin, 'PUT', '/api/organization/members/:id', { params: ['m-d1-2'], body: { unitId: 'd2', transferDate: '2026-11-20', transferReason: '확인용 발령' } });
  const { items } = await call(admin, 'GET', '/api/organization/members/:id/transfers', { params: ['m-d1-2'] });
  assert.equal(items.length, 1);
  assert.equal(items[0].reason, '확인용 발령');
  assert.equal(items[0].date, '2026-11-20');
  await assert.rejects(call(manager, 'GET', '/api/organization/members/:id/transfers', { params: ['m-d1-2'] }), { status: 404 });
  const view = await call(admin, 'GET', '/api/organization');
  assert.ok(view.metrics.members >= 13);
});

test('사용자 항목: 규칙에 맞게 추가·수정하고, 입력된 값이 있으면 삭제를 막는다', async () => {
  const { store, admin } = await setup();
  const routes = adminRoutes(store, { destroyUser() {} });
  const call = (method, path, { body = {}, params = [] } = {}) => Promise.resolve().then(() => routes.find((r) => r.method === method && r.path === path).handler({ user: admin, token: 't', body, query: new URLSearchParams(), params, recheck() {} }));

  const { field } = await call('POST', '/api/admin/fields', { body: { label: '관심 분야', type: 'select', options: ['음악', '운동'] } });
  assert.deepEqual(field.options, ['음악', '운동']);
  await assert.rejects(call('POST', '/api/admin/fields', { body: { label: '관심 분야', type: 'text' } }), { status: 400 }); // 이름 중복
  await assert.rejects(call('POST', '/api/admin/fields', { body: { label: '잘못', type: 'select', codeGroupId: 'nope' } }), { status: 400 });
  await assert.rejects(call('PATCH', '/api/admin/fields/:id', { params: [field.id], body: { type: 'text' } }), { status: 400 }); // 유형 고정

  const linked = (await call('POST', '/api/admin/fields', { body: { label: '직책 연결', type: 'select', codeGroupId: 'position' } })).field;
  assert.equal(linked.codeGroupId, 'position');

  store.workspace.people[0].custom = { ...(store.workspace.people[0].custom ?? {}), [field.id]: '음악' };
  await assert.rejects(call('PATCH', '/api/admin/fields/:id', { params: [field.id], body: { options: ['운동'] } }), { status: 400 }); // 쓰는 선택지는 뺄 수 없다
  await assert.rejects(call('DELETE', '/api/admin/fields/:id', { params: [field.id] }), { status: 400 });
  assert.equal((await call('GET', '/api/admin/fields')).fields.find((f) => f.id === field.id).used, 1);

  const patched = await call('PATCH', '/api/admin/fields/:id', { params: [field.id], body: { label: '관심', options: ['음악', '운동', '독서'] } });
  assert.equal(patched.field.label, '관심');
  await call('DELETE', '/api/admin/fields/:id', { params: [linked.id] });
  assert.equal(store.workspace.fields.length, 1);
  assert.ok(store.workspace.history.some((h) => h.action === '사용자 항목 삭제'));
});
