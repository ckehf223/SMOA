import { test } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import {
  buildConversion, createPreviewStore, dailyRoutes, draftViolations, guarded, legacy, legacyError, loadWorkbook, maskContact,
  noReportError, redact, redactDeep, reviewRows, sessionOf, withRosterRules,
} from '../server/daily.js';
import { reportsRoutes } from '../server/reports.js';
import { createStore } from '../server/store.js';

// 모든 자료는 가상 자료다. 전화번호도 실제 번호가 아닌 예시 값이다.
const PHONE = '010-1234-5678';
const admin = { admin: true, keys: new Set(), signature: 'admin|all' };
const district1 = { admin: false, keys: new Set(['1구역']), signature: 'manager|d1' };

const reportText = (district, name, intro, tail = '') => [
  `${district} 일보`, '날짜: 11/24', '활동자 수: 총 2명 (가나다, 라마바)', '1. 적극적 활동자: 가나다 라마바',
  '찾B : 신규 1건', '신규', `11/24 여백 ${name} 남 25 ${tail} 제기동 천호 23시 ${intro}`,
].join('\n');

const session = (token = 't1', userId = 'u1', signature = district1.signature) => ({ token, userId, signature });

test('전화번호 가리기: 끝 네 자리만 남고 날짜는 그대로', () => {
  const masked = redact(`연락처 ${PHONE}, 01098765432, 보고일 2026-11-03`);
  assert.ok(masked.includes('끝 4자리 5678') && masked.includes('끝 4자리 5432'));
  assert.ok(masked.includes('2026-11-03'));
  assert.ok(!/1234|9876/.test(masked));
  assert.equal(maskContact(PHONE), '끝 4자리 5678');
  assert.equal(maskContact(''), '');
  assert.equal(maskContact('12'), '');
  const deep = redactDeep({ phone: PHONE, note: `전화 ${PHONE}`, id: '1234-5678', rows: [['010 9999 8888']] });
  assert.equal(deep.phone, '끝 4자리 5678');
  assert.ok(!deep.note.includes('1234'));
  assert.equal(deep.id, '1234-5678');
  assert.ok(!JSON.stringify(deep.rows).includes('9999'));
});

test('원본 모듈 검증 오류는 400, 코드 오류는 그대로', () => {
  const converted = legacyError(new Error(`번호 ${PHONE} 확인`));
  assert.equal(converted.status, 400);
  assert.ok(!converted.message.includes('1234'));
  const bug = new TypeError('버그');
  assert.equal(legacyError(bug), bug);
});

test('모든 경로가 화면·동작을 선언하고 업로드는 binary:true', () => {
  const store = { now: () => 0 };
  const routes = [...dailyRoutes(store), ...reportsRoutes(store)];
  const actions = new Set(['read', 'write', 'export']);
  for (const r of routes) {
    assert.ok(['daily', 'reports'].includes(r.screen), r.path);
    assert.ok(actions.has(r.action), r.path);
    if (r.method === 'GET') assert.notEqual(r.action, 'write', r.path);
  }
  const find = (method, path) => routes.find((r) => r.method === method && r.path === path);
  assert.equal(find('POST', '/api/daily/import-file').binary, true);
  assert.equal(find('POST', '/api/reports/import-preview').binary, true);
  for (const r of routes.filter((x) => /workbook|\/export$/.test(x.path))) assert.equal(r.action, 'export', r.path);
  // 새 흐름: 반영은 쓰기, 미리보기·분석은 읽기, 엑셀은 내보내기
  assert.equal(find('POST', '/api/daily/text-preview').action, 'read');
  assert.equal(find('POST', '/api/daily/text-apply').action, 'write');
  assert.equal(find('POST', '/api/daily/changes-preview').action, 'read');
  assert.equal(find('GET', '/api/daily/changes/:id/workbook').action, 'export');
  assert.equal(find('GET', '/api/daily/analytics').action, 'read');
});

test('미리보기 보관: 세션 토큰·사용자·종류·구역 서명에 묶이고 만료된다', () => {
  let clock = 1000;
  const store = createPreviewStore(() => clock, { ttlMs: 500, perUser: 2 });
  const mine = session();
  const { id } = store.put(mine, 3, 'import', { x: 1 });
  assert.deepEqual(store.get(mine, id, 'import').data, { x: 1 });
  assert.equal(store.get(mine, id, 'import').revision, 3);
  assert.throws(() => store.get(session('t2'), id, 'import'), { status: 404 }); // 다른 로그인 세션
  assert.throws(() => store.get(session('t1', 'u2'), id, 'import'), { status: 404 }); // 다른 사용자
  assert.throws(() => store.get(mine, id, 'conversion'), { status: 404 });
  assert.throws(() => store.get(session('t1', 'u1', 'viewer|d1'), id, 'import'), { status: 409 }); // 역할·구역이 바뀜
  assert.throws(() => store.get(mine, id, 'import'), { status: 404 }); // 서명 불일치 뒤에는 지워짐
  const second = store.put(mine, 3, 'import', {});
  store.put(mine, 3, 'import', {});
  store.put(mine, 3, 'import', {}); // 사용자당 2개를 넘으면 오래된 것부터 지운다.
  assert.throws(() => store.get(mine, second.id, 'import'), { status: 404 });
  const last = store.put(mine, 3, 'import', {});
  clock += 501;
  assert.throws(() => store.get(mine, last.id, 'import'), { status: 404 });
});

test('세션 정보: 토큰이 없으면 거부하고 서명에 역할이 들어간다', () => {
  assert.throws(() => sessionOf({ user: { id: 'u1' } }, district1), { status: 401 });
  assert.deepEqual(sessionOf({ token: 'abc', user: { id: 'u1' } }, district1), { token: 'abc', userId: 'u1', signature: 'manager|d1' });
});

test('일보 원문 → 변환: 정리본 4개 시트, 연락처는 끝 네 자리만', async () => {
  const M = legacy('model.cjs');
  const ws = M.newWorkspace();
  const { result } = buildConversion(ws, admin, { text: reportText('1구역', '예시대상가', '가나다', PHONE), year: 2026, settings: {} });
  assert.equal(result.date, '2026-11-24');
  assert.equal(result.counts.찾기, 1);
  assert.equal(result.findingRows[0].연락처, '끝 4자리 5678');
  assert.ok(!/1234-5678|01012345678/.test(JSON.stringify(result)));

  const buffer = await legacy('daily-area-workbook.cjs').workbook(result);
  const raw = new ExcelJS.Workbook();
  await raw.xlsx.load(buffer);
  assert.deepEqual(raw.worksheets.map((s) => s.name), ['활동자', '찾기', '업데이트', '활동자보고']);
  assert.equal(raw.getWorksheet('찾기').getRow(2).getCell(8).value, '끝 4자리 5678');

  // 읽어 들일 때는 연락처 열을 비우고, 원본 가져오기 모듈이 정리본으로 인식한다.
  const { workbook } = await loadWorkbook(buffer);
  assert.equal(workbook.getWorksheet('찾기').getRow(2).getCell(8).value, null);
  const source = legacy('daily-area-import.cjs').select(workbook, '일보분석-2026-11-24.xlsx');
  assert.deepEqual(source.available, ['activity', 'finding', 'updates']);
  assert.equal(source.date, '2026-11-24');
});

test('구역 권한: 권한 밖 구역은 변환 전에 제외하고 모두 밖이면 403, 구조가 없으면 400', async () => {
  const ws = legacy('model.cjs').newWorkspace();
  const text = `${reportText('1구역', '예시대상가', '가나다')}\n${reportText('2구역', '다른구역대상', '라마바')}`;
  const { result, dropped } = buildConversion(ws, district1, { text, year: 2026, settings: {} });
  assert.equal(dropped, 1);
  assert.ok(!JSON.stringify(result).includes('다른구역대상'));
  assert.ok(result.warnings.some((w) => w.includes('제외')));
  assert.equal(result.findingRows.length, 1);
  assert.throws(() => buildConversion(ws, { ...district1, keys: new Set(['3구역']) }, { text, year: 2026, settings: {} }), { status: 403 });
  // 일보 구조가 없는 글은 권한 문제가 아니므로 400이며 관리자도 같다.
  for (const info of [district1, admin]) {
    await assert.rejects(() => guarded(() => buildConversion(ws, info, { text: '그냥 메모입니다.', year: 2026, settings: {} })), (err) => err.status === 400 && /구역 제목|일보 구조/.test(err.message));
  }
  assert.equal(noReportError([`연락처 ${PHONE}`]).status, 400);
  assert.ok(!noReportError([`연락처 ${PHONE}`]).message.includes('1234'));
});

test('임시 명부 규칙: 계산에만 쓰고 초안과 작업 영역에는 원래 전역 값을 되돌린다', () => {
  const temp = { excludedText: '1구역 | 가나다', aliasesText: '' };
  // 전역 규칙이 없던 경우
  const none = { stages: ['a'] };
  let seen;
  const outcome = withRosterRules(none, temp, (ws) => {
    seen = structuredClone(ws.dailyActivityRosterRules);
    return { draft: structuredClone(ws) };
  });
  assert.deepEqual(seen, temp);
  assert.equal(Object.hasOwn(none, 'dailyActivityRosterRules'), false);
  assert.equal(Object.hasOwn(outcome.draft, 'dailyActivityRosterRules'), false);
  // 전역 규칙이 있던 경우
  const global = { excludedText: '2구역 | 라마바', aliasesText: '' };
  const had = { stages: ['a'], dailyActivityRosterRules: structuredClone(global) };
  const out2 = withRosterRules(had, temp, (ws) => ({ draft: structuredClone(ws) }));
  assert.deepEqual(had.dailyActivityRosterRules, global);
  assert.deepEqual(out2.draft.dailyActivityRosterRules, global);
  // 실행 중 오류가 나도 복원한다.
  assert.throws(() => withRosterRules(had, temp, () => { throw new Error('실패'); }), /실패/);
  assert.deepEqual(had.dailyActivityRosterRules, global);
  // 초안이 없는 결과도 처리한다.
  assert.equal(withRosterRules(had, temp, () => ({ draft: null })).draft, null);
});

test('검토 표 행: 행 수가 같아야 하고 보고일·구역·대상자ID는 고칠 수 없다', () => {
  const parsed = [{ 보고일: '2026-11-24', 구역: '1구역', 대상자: '예시대상가', 대상자ID: 'DP-1', 단계: '찾B', _line: 3, _review: ['확인'] }];
  const editable = ['대상자', '단계'];
  assert.equal(reviewRows(parsed, undefined, editable), undefined);
  const [row] = reviewRows(parsed, [{ 대상자: '예시대상나', 구역: '2구역', 대상자ID: 'DP-9', 보고일: '2020-01-01' }], editable);
  assert.equal(row.대상자, '예시대상나');
  assert.equal(row.구역, '1구역');
  assert.equal(row.대상자ID, 'DP-1');
  assert.equal(row.보고일, '2026-11-24');
  assert.equal(Object.hasOwn(row, '_line'), false);
  assert.throws(() => reviewRows(parsed, [], editable), { status: 400 });
  assert.throws(() => reviewRows(parsed, [{ 대상자: 5 }], editable), { status: 400 });
  assert.throws(() => reviewRows(parsed, [{ 대상자: 'ㄱ'.repeat(201) }], editable), { status: 400 });
  assert.throws(() => reviewRows(parsed, ['x'], editable), { status: 400 });
});

test('가져오기 초안 검사: 전역 설정 변경과 구역 밖 행을 막는다', () => {
  const baseline = legacy('model.cjs').newWorkspace();
  const same = structuredClone(baseline);
  assert.deepEqual(draftViolations(baseline, same, district1), []);

  const outside = structuredClone(baseline);
  outside.people.push({ id: 'p1', region: '2구역' });
  assert.ok(draftViolations(baseline, outside, district1).some((m) => m.includes('대상자 1건')));
  assert.deepEqual(draftViolations(baseline, outside, admin), []);

  const inside = structuredClone(baseline);
  inside.people.push({ id: 'p2', region: '1구역' });
  assert.deepEqual(draftViolations(baseline, inside, district1), []);

  const global = structuredClone(baseline);
  global.goals.push({ region: '1구역' });
  assert.ok(draftViolations(baseline, global, admin).some((m) => m.includes('전역 설정')));
});

// ───────────── 핸들러 단위 확인 (로컬 메모리 저장소의 가상 자료, DB 연결 없음) ─────────────

async function fixture() {
  const store = await createStore(() => Date.now());
  const routes = [...dailyRoutes(store)];
  const user = (name) => [...store.users.values()].find((u) => u.username === name);
  const call = (method, path, u, { body = {}, query = '', params = [], token = `token-${u.username}` } = {}) => {
    const route = routes.find((r) => r.method === method && r.path === path);
    return route.handler({ user: u, token, body, query: new URLSearchParams(query), params, recheck: () => {} });
  };
  return { store, user, call };
}

test('텍스트 일보·변경 건·분석: 권한 밖 구역 선택은 403, 입력 누락은 400', async () => {
  const { user, call } = await fixture();
  const manager = user('manager1');
  const text = '2026-11-24 일보\n1구역\n활동자 : M-D1-01(19:00-20:00)';
  await assert.rejects(call('POST', '/api/daily/text-preview', manager, { body: { text, region: '2구역' } }), { status: 403 });
  await assert.rejects(call('POST', '/api/daily/changes-preview', manager, { body: { text, region: '2구역', date: '2026-11-24' } }), { status: 403 });
  await assert.rejects(call('GET', '/api/daily/analytics', manager, { query: 'region=2구역' }), { status: 403 });
  await assert.rejects(call('POST', '/api/daily/text-preview', manager, { body: { text: '  ' } }), { status: 400 });
  await assert.rejects(call('POST', '/api/daily/changes-preview', manager, { body: { text, date: '2026-11-24' } }), { status: 400 }); // 구역 누락
  await assert.rejects(call('POST', '/api/daily/changes-preview', manager, { body: { text, region: '1구역' } }), { status: 400 }); // 보고일 누락
  await assert.rejects(call('GET', '/api/daily/analytics', manager, { query: 'from=2026-12-01&to=2026-11-01' }), { status: 400 });
  // 원문 속 구역이 권한 밖이면 403
  const foreign = '2026-11-24 일보\n2구역\n활동자 : M-D2-01(19:00-20:00)';
  await assert.rejects(call('POST', '/api/daily/text-preview', manager, { body: { text: foreign } }), { status: 403 });
  // 일보 구조가 없는 변환은 400
  await assert.rejects(call('POST', '/api/daily/convert', manager, { body: { text: '메모만 있습니다.' } }), { status: 400 });
});

test('텍스트 일보 미리보기: 세션에 묶인 미리보기 ID를 만들고 다른 세션은 쓸 수 없다', async () => {
  const { user, call } = await fixture();
  const manager = user('manager1');
  const text = '2026-11-24 일보\n1구역\n활동자 : M-D1-01(19:00-20:00)';
  const data = await call('POST', '/api/daily/text-preview', manager, { body: { text } });
  assert.ok(data.previewId && typeof data.counts === 'object');
  assert.ok(!JSON.stringify(data).includes('2구역'));
  // 같은 사용자라도 다른 로그인 세션이면 반영할 수 없다.
  await assert.rejects(call('POST', '/api/daily/text-apply', manager, { body: { previewId: data.previewId }, token: 'other-session' }), { status: 404 });
  await assert.rejects(call('POST', '/api/daily/text-apply', user('manager2'), { body: { previewId: data.previewId } }), { status: 404 });
});

test('기간 분석: 담당 구역의 집계만 반환하고 행 단위 자료는 싣지 않는다', async () => {
  const { user, call } = await fixture();
  const mine = await call('GET', '/api/daily/analytics', user('manager1'));
  const all = await call('GET', '/api/daily/analytics', user('admin'));
  assert.ok(mine.creations > 0 && all.creations > mine.creations);
  assert.ok(mine.byRegion.every((x) => x.label === '1구역'));
  assert.ok(mine.dimensions.region.every((x) => x.label === '1구역'));
  assert.ok(all.byRegion.length > 1);
  for (const key of ['activities', 'records']) assert.equal(Object.hasOwn(mine, key), false);
  assert.ok(!/\d{3}-\d{4}-\d{4}/.test(JSON.stringify(mine)));
});
