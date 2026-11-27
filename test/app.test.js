import { test } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { createApp } from '../server/app.js';
import { DEMO_ACCOUNTS } from '../server/store.js';

const pw = (name) => DEMO_ACCOUNTS.find((a) => a.username === name).password;

async function start(t, opts) {
  const app = await createApp(opts);
  const port = await app.listen(0);
  t.after(() => app.close());
  return { app, base: `http://127.0.0.1:${port}` };
}

function client(base) {
  let cookie = '';
  const c = {
    get cookie() { return cookie; },
    set cookie(v) { cookie = v; },
    async call(method, path, body, headers = {}) {
      const mutating = method !== 'GET';
      const res = await fetch(base + path, {
        method,
        redirect: 'manual',
        headers: { ...(mutating ? { 'Content-Type': 'application/json', Origin: base } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
        body: mutating ? JSON.stringify(body ?? {}) : undefined,
      });
      const sc = res.headers.get('set-cookie');
      if (sc) cookie = /Max-Age=0/i.test(sc) ? '' : sc.split(';')[0];
      const type = res.headers.get('content-type') ?? '';
      const data = type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer());
      return { status: res.status, data, res };
    },
    get: (p) => c.call('GET', p),
    post: (p, b) => c.call('POST', p, b),
    put: (p, b) => c.call('PUT', p, b),
    patch: (p, b) => c.call('PATCH', p, b),
  };
  return c;
}

async function loginAs(base, username, password = pw(username)) {
  const c = client(base);
  const r = await c.post('/api/login', { username, password });
  assert.equal(r.status, 200, `${username} 로그인`);
  return c;
}

const person = (over = {}) => ({ name: '테스트 대상', districtId: 'd1', stageId: 's1', ...over });
const setPerm = (admin, role, screens) => admin.put(`/api/admin/permissions/${role}`, { screens });
const allOn = { access: true, read: true, write: true, export: true };

test('인증 없이는 401, 페이지는 로그인으로 이동', async (t) => {
  const { base } = await start(t);
  const c = client(base);
  for (const p of ['/api/me', '/api/people', '/api/dashboard', '/api/admin/users', '/api/people/export']) {
    assert.equal((await c.get(p)).status, 401, p);
  }
  for (const p of ['/', '/admin']) {
    const r = await c.get(p);
    assert.equal(r.status, 302);
    assert.equal(r.res.headers.get('location'), '/login');
  }
  assert.equal((await c.get('/login')).status, 200);
  assert.equal((await c.get('/assets/app.css')).status, 200);
  assert.equal((await c.get('/assets/..%2Fserver%2Fapp.js')).status, 404);
});

test('로그인: 쿠키 속성, 오류 문구, 로그아웃 후 세션 폐기, 비밀번호 미노출', async (t) => {
  const { base } = await start(t);
  const c = client(base);
  assert.equal((await c.post('/api/login', { username: 'admin', password: 'wrong-password-1' })).status, 401);
  assert.equal((await c.post('/api/login', { username: 'nobody', password: 'wrong-password-1' })).status, 401);
  const ok = await c.post('/api/login', { username: 'admin', password: pw('admin') });
  assert.equal(ok.status, 200);
  const sc = ok.res.headers.get('set-cookie');
  assert.match(sc, /HttpOnly/);
  assert.match(sc, /SameSite=Strict/);

  const users = await c.get('/api/admin/users');
  assert.ok(users.data.users.length >= 4);
  const dump = JSON.stringify(users.data);
  assert.ok(!/passwordHash|password|scrypt/i.test(dump));

  const oldCookie = c.cookie;
  assert.equal((await c.post('/api/logout', {})).status, 200);
  const stale = client(base);
  stale.cookie = oldCookie;
  assert.equal((await stale.get('/api/me')).status, 401);
});

test('변경 요청 방어: Origin·JSON 검사, 가입 경로 없음, 로컬 Host만', async (t) => {
  const { base } = await start(t);
  const c = await loginAs(base, 'admin');
  const hdr = (h) => ({ method: 'POST', headers: { Cookie: c.cookie, ...h }, body: '{"siteName":"X"}' });
  assert.equal((await fetch(`${base}/api/admin/settings`, { ...hdr({ 'Content-Type': 'application/json' }), method: 'PUT' })).status, 403);
  assert.equal((await fetch(`${base}/api/admin/settings`, { ...hdr({ 'Content-Type': 'application/json', Origin: 'http://evil.example' }), method: 'PUT' })).status, 403);
  assert.equal((await fetch(`${base}/api/admin/settings`, { ...hdr({ 'Content-Type': 'text/plain', Origin: base }), method: 'PUT' })).status, 415);
  assert.equal((await c.get('/api/admin/settings')).data.siteName, 'SMOA');
  assert.equal((await client(base).post('/api/register', {})).status, 404);
  assert.equal((await client(base).post('/api/signup', {})).status, 404);
});

test('세션은 서버에서 유휴·절대 만료된다', async (t) => {
  let clock = 1_800_000_000_000;
  const { base } = await start(t, { now: () => clock, idleMs: 60_000, absoluteMs: 300_000 });
  const c = await loginAs(base, 'manager1');
  clock += 30_000;
  assert.equal((await c.get('/api/me')).status, 200);
  clock += 61_000;
  assert.equal((await c.get('/api/me')).status, 401);

  const d = await loginAs(base, 'manager1');
  for (let i = 0; i < 5; i++) {
    clock += 59_000;
    assert.equal((await d.get('/api/me')).status, 200);
  }
  clock += 59_000;
  assert.equal((await d.get('/api/me')).status, 401, '절대 만료');
});

test('로그인 실패가 반복되면 잠시 차단된다', async (t) => {
  const { base } = await start(t, { loginMaxFailures: 3 });
  const c = client(base);
  for (let i = 0; i < 3; i++) assert.equal((await c.post('/api/login', { username: 'viewer1', password: 'wrong-password-1' })).status, 401);
  assert.equal((await c.post('/api/login', { username: 'viewer1', password: pw('viewer1') })).status, 429);
});

test('비관리자는 관리 API와 관리 페이지를 사용할 수 없다', async (t) => {
  const { base } = await start(t);
  const m = await loginAs(base, 'manager1');
  for (const [method, p, body] of [
    ['GET', '/api/admin/users'], ['GET', '/api/admin/permissions'], ['GET', '/api/admin/codes'], ['GET', '/api/admin/settings'],
    ['POST', '/api/admin/users', { username: 'hacker1', displayName: 'x', password: 'Hacker-Pass-2026!', role: 'admin' }],
    ['PUT', '/api/admin/permissions/manager', { screens: { people: allOn } }],
    ['POST', '/api/admin/codes/stages', { name: '새단계' }],
    ['PUT', '/api/admin/settings', { siteName: 'X' }],
  ]) {
    assert.equal((await m.call(method, p, body)).status, 403, `${method} ${p}`);
  }
  const me = (await m.get('/api/me')).data;
  assert.equal(me.isAdmin, false);
  assert.deepEqual(me.adminMenu, []);
  const page = await m.get('/admin');
  assert.equal(page.status, 302);
  assert.equal(page.res.headers.get('location'), '/');
});

test('역할 권한(화면 접근·읽기·쓰기·내보내기)이 접속 중인 세션에 바로 적용된다', async (t) => {
  const { base } = await start(t);
  const admin = await loginAs(base, 'admin');
  const m = await loginAs(base, 'manager1');
  assert.deepEqual((await m.get('/api/me')).data.menu.map((x) => x.id), ['dashboard', 'people']);
  assert.equal((await m.post('/api/people', person())).status, 200);

  // 쓰기 끔
  await setPerm(admin, 'manager', { people: { access: true, read: true, write: false, export: true } });
  assert.equal((await m.post('/api/people', person())).status, 403);
  assert.equal((await m.get('/api/people')).status, 200);
  const rows = (await m.get('/api/people')).data.items;
  assert.equal((await m.put(`/api/people/${rows[0].id}`, person({ code: undefined }))).status, 403);
  assert.equal((await m.get('/api/me')).data.perms.people.write, false);

  // 내보내기 끔
  await setPerm(admin, 'manager', { people: { access: true, read: true, write: true, export: false } });
  assert.equal((await m.get('/api/people/export')).status, 403);
  assert.equal((await m.post('/api/people', person())).status, 200);

  // 읽기 끄면 쓰기·내보내기도 무효 (저장 값도 정규화)
  const res = await setPerm(admin, 'manager', { people: { access: true, read: false, write: true, export: true } });
  assert.deepEqual(res.data.permissions.people, { access: true, read: false, write: false, export: false });
  assert.equal((await m.get('/api/people')).status, 403);
  assert.equal((await m.post('/api/people', person())).status, 403);
  assert.equal((await m.get('/api/people/export')).status, 403);

  // 화면 접근 끄면 메뉴에서 사라지고 어떤 동작도 불가
  await setPerm(admin, 'manager', { people: { ...allOn, access: false } });
  const me = (await m.get('/api/me')).data;
  assert.deepEqual(me.menu.map((x) => x.id), ['dashboard']);
  assert.equal((await m.get('/api/people')).status, 403);
  assert.equal((await m.post('/api/people', person())).status, 403);
  assert.equal((await m.get('/api/people/export')).status, 403);
  assert.equal((await m.get('/api/dashboard')).status, 200);

  await setPerm(admin, 'manager', { dashboard: { ...allOn, access: false } });
  assert.equal((await m.get('/api/dashboard')).status, 403);
  assert.deepEqual((await m.get('/api/me')).data.menu, []);

  // 잘못된 값·관리자 역할 변경·알 수 없는 화면은 거부
  assert.equal((await setPerm(admin, 'manager', { people: { access: 'yes' } })).status, 400);
  assert.equal((await setPerm(admin, 'manager', { secret: allOn })).status, 400);
  assert.equal((await setPerm(admin, 'admin', { people: { access: false } })).status, 400);
  assert.equal((await setPerm(admin, 'nonexistent', {})).status, 404);
  assert.equal((await admin.get('/api/people')).status, 200, '관리자는 항상 접근');
});

test('구역 격리: 목록·내보내기·등록·수정', async (t) => {
  const { base, app } = await start(t);
  const m1 = await loginAs(base, 'manager1');
  const m2 = await loginAs(base, 'manager2');
  const admin = await loginAs(base, 'admin');

  const l1 = (await m1.get('/api/people?page=1')).data;
  assert.ok(l1.total > 0);
  assert.ok(l1.items.every((p) => p.districtId === 'd1'));
  assert.equal((await m1.get('/api/people?districtId=d2')).status, 403);
  assert.equal((await m1.get('/api/people?districtId=nope')).status, 403);
  assert.deepEqual((await m1.get('/api/dashboard')).data.byDistrict.map((d) => d.id), ['d1']);

  const adminTotal = (await admin.get('/api/people')).data.total;
  assert.equal(adminTotal, app.store.people.length);
  assert.ok(adminTotal > l1.total);
  assert.equal((await admin.get('/api/dashboard')).data.total, adminTotal);

  // 등록·수정
  assert.equal((await m1.post('/api/people', person({ districtId: 'd2' }))).status, 403);
  assert.equal((await m1.post('/api/people', person({ districtId: 'zz' }))).status, 400);
  const other = app.store.people.find((p) => p.districtId === 'd2');
  assert.equal((await m1.put(`/api/people/${other.id}`, person())).status, 404);
  assert.equal((await m1.put(`/api/people/${other.id}`, person({ districtId: 'd2' }))).status, 404);
  const mine = l1.items[0];
  assert.equal((await m1.put(`/api/people/${mine.id}`, person({ districtId: 'd2' }))).status, 403, '다른 구역으로 이동 불가');
  const edited = await m1.put(`/api/people/${mine.id}`, person({ name: '수정된 이름', id: 'forged', code: 'FORGED-1' }));
  assert.equal(edited.status, 200);
  assert.equal(edited.data.person.name, '수정된 이름');
  assert.equal(edited.data.person.id, mine.id, 'id 위조 무시');
  assert.equal(edited.data.person.code, mine.code, '식별번호는 수정 불가');
  assert.equal(app.store.people.find((p) => p.id === other.id).name, other.name);

  // 내보내기: 같은 구역 범위만
  const ex = await m2.get('/api/people/export?q=');
  assert.equal(ex.status, 200);
  assert.match(ex.res.headers.get('content-type'), /spreadsheetml/);
  assert.match(ex.res.headers.get('content-disposition'), /attachment/);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(ex.data);
  const sheet = wb.getWorksheet('대상자');
  const districts = new Set();
  sheet.eachRow((row, i) => { if (i > 1) districts.add(row.getCell(5).value); });
  assert.deepEqual([...districts], ['2구역']);
  assert.equal(sheet.rowCount - 1, (await m2.get('/api/people')).data.total);
  assert.equal((await m2.get('/api/people/export?districtId=d1')).status, 403);
});

test('등록 검증: 식별번호·나이·날짜·단계, 수식 문자 무력화', async (t) => {
  const { base } = await start(t);
  const m = await loginAs(base, 'manager1');
  for (const bad of [
    person({ code: '1234' }), person({ code: 'a b' }), person({ code: 'DEMO-001' }), person({ name: ' ' }), person({ age: 200 }),
    person({ age: 'x' }), person({ registeredDate: '2026-02-31' }), person({ stageId: 'nope' }), person({ gender: '??' }), person({ name: { a: 1 } }),
  ]) {
    assert.equal((await m.post('/api/people', bad)).status >= 400, true, JSON.stringify(bad));
  }
  const ok = await m.post('/api/people', person({ name: '=HYPERLINK("x")', age: '30', notes: '<img src=x onerror=1>' }));
  assert.equal(ok.status, 200);
  assert.match(ok.data.person.code, /^P-\d{4}$/);
  const ex = await m.get('/api/people/export?q=hyperlink');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(ex.data);
  assert.equal(wb.getWorksheet('대상자').getRow(2).getCell(2).value, `'=HYPERLINK("x")`);
});

test('관리자 계정 추가·비활성화·변경이 기존 세션에 바로 반영된다', async (t) => {
  const { base } = await start(t);
  const admin = await loginAs(base, 'admin');
  const created = await admin.post('/api/admin/users', { username: 'newuser1', displayName: '가상 신규', password: 'New-Password-2026!', role: 'viewer', districts: ['d2'] });
  assert.equal(created.status, 200);
  assert.ok(!JSON.stringify(created.data).includes('New-Password'));
  const id = created.data.user.id;

  const u = await loginAs(base, 'newuser1', 'New-Password-2026!');
  assert.ok((await u.get('/api/people')).data.items.every((p) => p.districtId === 'd2'));
  assert.equal((await u.post('/api/people', person({ districtId: 'd2' }))).status, 403);

  // 역할·구역 변경 → 같은 세션에 즉시 반영
  assert.equal((await admin.patch(`/api/admin/users/${id}`, { role: 'manager', districts: ['d1', 'd2'] })).status, 200);
  assert.equal((await u.post('/api/people', person({ districtId: 'd1' }))).status, 200);
  assert.equal((await admin.patch(`/api/admin/users/${id}`, { districts: ['d1'] })).status, 200);
  assert.equal((await u.get('/api/people?districtId=d2')).status, 403);

  // 비활성화 → 기존 세션 종료, 로그인 불가
  assert.equal((await admin.patch(`/api/admin/users/${id}`, { active: false })).status, 200);
  assert.equal((await u.get('/api/me')).status, 401);
  assert.equal((await client(base).post('/api/login', { username: 'newuser1', password: 'New-Password-2026!' })).status, 401);
  await admin.patch(`/api/admin/users/${id}`, { active: true });

  // 비밀번호 재설정 → 기존 세션 종료, 새 비밀번호로만 로그인
  const again = await loginAs(base, 'newuser1', 'New-Password-2026!');
  assert.equal((await admin.post(`/api/admin/users/${id}/password`, { password: 'Reset-Password-2026!' })).status, 200);
  assert.equal((await again.get('/api/me')).status, 401);
  assert.equal((await client(base).post('/api/login', { username: 'newuser1', password: 'New-Password-2026!' })).status, 401);
  assert.equal((await client(base).post('/api/login', { username: 'newuser1', password: 'Reset-Password-2026!' })).status, 200);
});

test('잘못된 계정 입력과 권한 상승·관리자 잠금 시도는 안전하게 거부된다', async (t) => {
  const { base, app } = await start(t);
  const admin = await loginAs(base, 'admin');
  const base1 = { username: 'valid.user', displayName: '가상', password: 'Valid-Password-2026!', role: 'viewer', districts: ['d1'] };
  for (const bad of [
    { ...base1, username: 'AB' }, { ...base1, username: 'admin' }, { ...base1, role: 'superuser' }, { ...base1, districts: ['d9'] },
    { ...base1, districts: [] }, { ...base1, password: 'short' }, { ...base1, password: 'valid.user-123456' }, { ...base1, displayName: '' },
  ]) {
    assert.ok((await admin.post('/api/admin/users', bad)).status >= 400, JSON.stringify(bad));
  }
  assert.equal(app.store.users.size, 4);

  const self = [...app.store.users.values()].find((x) => x.username === 'admin');
  assert.equal((await admin.patch(`/api/admin/users/${self.id}`, { active: false })).status, 400);
  assert.equal((await admin.patch(`/api/admin/users/${self.id}`, { role: 'viewer', districts: ['d1'] })).status, 400);
  assert.equal((await admin.get('/api/me')).status, 200);

  // 다른 관리자를 만들어도 기본 관리자는 보호되고, 관리자 간 자기 자신 비활성화도 막힌다
  const second = await admin.post('/api/admin/users', { ...base1, username: 'admin2', role: 'admin', password: 'Second-Admin-2026!' });
  assert.equal(second.status, 200);
  const a2 = await loginAs(base, 'admin2', 'Second-Admin-2026!');
  assert.equal((await a2.patch(`/api/admin/users/${self.id}`, { active: false })).status, 400);
  assert.equal((await a2.patch(`/api/admin/users/${second.data.user.id}`, { active: false })).status, 400);

  // 일반 사용자는 자신을 관리자로 올릴 수 없다
  const m = await loginAs(base, 'manager1');
  const m1 = [...app.store.users.values()].find((x) => x.username === 'manager1');
  assert.equal((await m.patch(`/api/admin/users/${m1.id}`, { role: 'admin' })).status, 403);
  assert.equal(app.store.users.get(m1.id).role, 'manager');
});

test('공통코드(단계)와 설정이 실제 화면 데이터에 반영된다', async (t) => {
  const { base, app } = await start(t);
  const admin = await loginAs(base, 'admin');
  const m = await loginAs(base, 'manager1');

  const target = (await m.get('/api/people')).data.items[0];
  const stageId = target.stageId;
  assert.equal((await admin.patch(`/api/admin/codes/stages/${stageId}`, { name: '이름 변경 단계' })).status, 200);
  const me = (await m.get('/api/me')).data;
  assert.equal(me.stages.find((s) => s.id === stageId).name, '이름 변경 단계');
  assert.equal((await m.get('/api/people')).data.items.find((p) => p.id === target.id).stageId, stageId, '참조 ID 유지');
  assert.ok((await m.get('/api/dashboard')).data.byStage.some((s) => s.name === '이름 변경 단계'));

  const added = await admin.post('/api/admin/codes/stages', { name: '새 단계' });
  assert.equal(added.status, 200);
  assert.equal((await m.post('/api/people', person({ stageId: added.data.stage.id }))).status, 200);
  assert.equal((await m.get(`/api/people?stageId=${added.data.stage.id}`)).data.total, 1);
  assert.equal((await admin.post('/api/admin/codes/stages', { name: '새 단계' })).status, 409);

  // 사용 안 함: 새 선택은 거부, 기존 기록은 유지
  assert.equal((await admin.patch(`/api/admin/codes/stages/${added.data.stage.id}`, { active: false })).status, 200);
  assert.equal((await m.post('/api/people', person({ stageId: added.data.stage.id }))).status, 400);
  assert.equal((await m.get(`/api/people?stageId=${added.data.stage.id}`)).data.total, 1);
  assert.ok((await m.get('/api/dashboard')).data.byStage.some((s) => s.id === added.data.stage.id && s.count === 1));
  for (const s of app.store.stages.filter((x) => x.active).slice(1)) await admin.patch(`/api/admin/codes/stages/${s.id}`, { active: false });
  const last = app.store.stages.find((s) => s.active);
  assert.equal((await admin.patch(`/api/admin/codes/stages/${last.id}`, { active: false })).status, 400, '마지막 사용 단계 보호');

  // 설정: 사이트 이름은 모든 세션과 로그인 화면 정보에 반영
  assert.equal((await admin.put('/api/admin/settings', { siteName: '' })).status, 400);
  assert.equal((await admin.put('/api/admin/settings', { siteName: '가상 SMOA 센터' })).status, 200);
  assert.equal((await m.get('/api/me')).data.siteName, '가상 SMOA 센터');
  assert.equal((await client(base).get('/api/public/info')).data.siteName, '가상 SMOA 센터');
});
