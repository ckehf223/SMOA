import { test } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { createStore } from '../server/store.js';
import { commitWorkspace, scopedWorkspace } from '../server/domain.js';
import { recordsRoutes } from '../server/records.js';

// 지역활동기록 엑셀 가져오기: 로컬 메모리 저장소와 가상 자료만 사용한다. DB·Git·네트워크는 쓰지 않는다.
const PREVIEW = '/api/regional-activity/import-preview';
const APPLY = '/api/regional-activity/import-apply';

async function sheet(rows, headers = ['날짜', '이름', '활동종류']) {
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet('활동기록').addRows([headers, ...rows]);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

async function setup() {
  const store = await createStore();
  const user = (name) => [...store.users.values()].find((u) => u.username === name);
  const routes = recordsRoutes(store);
  const call = (path, who, { body, query = '' } = {}) => {
    const route = routes.find((r) => r.path === path);
    return route.handler({ user: who, token: `token-${who.username}`, body, query: new URLSearchParams(query), params: [], recheck() {} });
  };
  const members = scopedWorkspace(store, user('admin')).organization.members;
  const member = (name) => members.find((m) => m.name === name);
  return { store, routes, call, admin: user('admin'), manager: user('manager1'), member };
}

const query = 'month=2026-11&name=가상활동기록.xlsx';

test('가져오기 경로는 지역활동기록 화면의 쓰기 동작으로 선언되고 업로드는 binary다', async () => {
  const { routes } = await setup();
  const preview = routes.find((r) => r.method === 'POST' && r.path === PREVIEW);
  const apply = routes.find((r) => r.method === 'POST' && r.path === APPLY);
  for (const route of [preview, apply]) {
    assert.equal(route.screen, 'regionalActivity');
    assert.equal(route.action, 'write');
  }
  assert.equal(preview.binary, true);
  assert.notEqual(apply.binary, true);
});

test('구역 담당자: 권한 밖 구역 행은 오류가 되고 응답에 나오지 않으며 반영되지 않는다', async () => {
  const { store, call, manager } = await setup();
  const revision = store.workspace.revision;
  const mixed = await call(PREVIEW, manager, { body: await sheet([['2026-11-20', '가상 구성원 1-2', 1], ['2026-11-20', '가상 구성원 2-2', 2]]), query });
  assert.equal(mixed.canCommit, false);
  assert.equal(mixed.importId, '');
  assert.equal(mixed.counts.errors, 1);
  assert.match(mixed.errors[0].message, /같은 이름을 찾을 수 없습니다/);
  assert.ok(!JSON.stringify(mixed).includes('가상 구성원 2-2'));
  assert.equal(store.workspace.revision, revision);
  assert.equal(store.workspace.regionalActivities?.length ?? 0, 0);
});

test('구역 담당자: 배정 밖 구역을 조회 구역으로 고르면 403', async () => {
  const { call, manager } = await setup();
  const body = await sheet([['2026-11-20', '가상 구성원 1-2', 1]]);
  await assert.rejects(() => call(PREVIEW, manager, { body, query: `${query}&region=2구역` }), { status: 403 });
});

test('미리보기 → 반영은 한 번의 일괄 저장이고 재실행하면 바뀌지 않는다', async () => {
  const { store, call, manager } = await setup();
  const revision = store.workspace.revision;
  const body = await sheet([['2026-11-20', '가상 구성원 1-2', 1], ['2026-11-21', '가상 구성원 1-3', 4]]);

  const preview = await call(PREVIEW, manager, { body, query });
  assert.equal(preview.canCommit, true);
  assert.deepEqual([preview.counts.insert, preview.counts.replace, preview.counts.unchanged], [2, 0, 0]);
  assert.equal(preview.dateMode, true);
  assert.equal([preview.firstDate, preview.lastDate].join(), '2026-11-20,2026-11-21');
  assert.equal(store.workspace.revision, revision); // 미리보기는 정본을 바꾸지 않는다.

  const result = call(APPLY, manager, { body: { importId: preview.importId } });
  assert.equal(result.applied, 2);
  assert.equal(result.lastDate, '2026-11-21');
  assert.equal(store.workspace.regionalActivities.length, 2);
  assert.ok(store.workspace.regionalActivities.every((r) => r.region === '1구역'));
  assert.equal(store.workspace.revision, revision + 1); // 이력 한 건 = 한 번의 반영
  assert.throws(() => call(APPLY, manager, { body: { importId: preview.importId } }), { status: 404 }); // 한 번만 쓸 수 있다.

  const again = await call(PREVIEW, manager, { body, query });
  assert.equal(again.counts.unchanged, 2);
  assert.equal(again.rows.length, 0);
  assert.equal(again.totalDuplicates, 2);
  // 원본 4.0.41처럼 변경 없는 행만 있어도 반영 토큰은 발급되고, 적용하면 0건이며 revision은 그대로다.
  assert.equal(again.canCommit, true);
  assert.ok(again.importId);
  assert.equal(call(APPLY, manager, { body: { importId: again.importId } }).applied, 0);
  assert.equal(store.workspace.revision, revision + 1);

  const changed = await call(PREVIEW, manager, { body: await sheet([['2026-11-20', '가상 구성원 1-2', 3]]), query });
  assert.equal(changed.counts.replace, 1);
  assert.equal(changed.rows[0].previousCode, 1);
  call(APPLY, manager, { body: { importId: changed.importId } });
  assert.equal(store.workspace.regionalActivities.find((r) => r.date === '2026-11-20').code, 3);
});

test('다른 사용자·세션은 미리보기를 쓸 수 없고 자료가 바뀌면 409', async () => {
  const { store, call, admin, manager, member } = await setup();
  const body = await sheet([['2026-11-22', '가상 구성원 1-2', 2]]);
  const preview = await call(PREVIEW, manager, { body, query });
  assert.throws(() => call(APPLY, admin, { body: { importId: preview.importId } }), { status: 404 });

  const draft = scopedWorkspace(store, admin);
  const other = member('가상 구성원 2-2');
  draft.regionalActivities = [...(draft.regionalActivities ?? []), { memberId: other.id, month: '2026-11', date: '2026-11-23', code: 1, region: '2구역', name: other.name, memberCode: other.code }];
  commitWorkspace(store, admin, draft);
  assert.throws(() => call(APPLY, manager, { body: { importId: preview.importId } }), { status: 409 });
  assert.equal(store.workspace.regionalActivities.length, 1); // 담당자 반영은 일어나지 않았다.
});

test('같은 기간의 기존 기록이 배정 구역 밖에 있으면 그 행은 오류이고 관리자는 가져올 수 있다', async () => {
  const { store, call, admin, manager, member } = await setup();
  const moved = member('가상 구성원 1-3'); // 1구역 구성원이지만 기록은 2구역으로 남아 있다.
  const draft = scopedWorkspace(store, admin);
  draft.regionalActivities = [{ memberId: moved.id, month: '2026-11', date: '2026-11-24', code: 4, region: '2구역', name: moved.name, memberCode: moved.code }];
  commitWorkspace(store, admin, draft);

  const body = await sheet([['2026-11-24', '가상 구성원 1-3', 1]]);
  const blocked = await call(PREVIEW, manager, { body, query });
  assert.equal(blocked.canCommit, false);
  assert.match(blocked.errors[0].message, /배정 구역 밖/);
  assert.equal(blocked.counts.insert, 0);

  const asAdmin = await call(PREVIEW, admin, { body, query });
  assert.equal(asAdmin.canCommit, true);
  assert.equal(asAdmin.counts.replace, 1);
});

test('날짜 열이 없는 파일은 조회월에 적용하고 월 형식이 틀리면 400', async () => {
  const { store, call, manager } = await setup();
  const modern = await call(PREVIEW, manager, { body: await sheet([['가상 구성원 1-2', 2]], ['이름', '활동종류']), query });
  assert.equal(modern.canCommit, false);
  assert.equal(modern.importId, '');
  const body = await sheet([['가상 구성원 1-2', 2]], ['이름', '종료시간']);
  const preview = await call(PREVIEW, manager, { body, query });
  assert.equal(preview.dateMode, false);
  assert.equal(preview.month, '2026-11');
  assert.equal(call(APPLY, manager, { body: { importId: preview.importId } }).applied, 1);
  assert.deepEqual(store.workspace.regionalActivities.map((r) => [r.month, r.date]), [['2026-11', undefined]]);
  await assert.rejects(() => call(PREVIEW, manager, { body, query: 'month=2026-13' }), { status: 400 });
});
