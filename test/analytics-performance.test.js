import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../server/store.js';
import { analyticsRoutes } from '../server/analytics.js';
import { dashboardOverview } from '../server/dashboard.js';
import { scopeFor } from '../server/permissions.js';

// 로컬 메모리 저장소와 가상 자료만 쓴다. DB·Git·네트워크는 쓰지 않고 라우트 처리기를 직접 부른다.
async function setup() {
  const store = await createStore();
  const users = [...store.users.values()];
  const admin = users.find((u) => u.username === 'admin');
  const manager = users.find((u) => u.username === 'manager1');
  const routes = analyticsRoutes(store);
  const call = (user, path, query = {}) => {
    const route = routes.find((r) => r.method === 'GET' && r.path === path);
    assert.ok(route, path);
    return Promise.resolve().then(() => route.handler({ user, query: new URLSearchParams(query), params: [], recheck() {} }));
  };
  const ownRegions = (u) => store.districts.filter((d) => scopeFor(store, u).has(d.id)).map((d) => d.name);
  return { store, admin, manager, call, ownRegions };
}

const sum = (rows, key) => rows.reduce((n, row) => n + (row[key] ?? 0), 0);

test('구역별 데이터: 날짜만 쓰는 별도 overview 없이 조회 조건을 따른 districtOverview만 보낸다', async () => {
  const { store, admin, call } = await setup();
  const region = store.districts[0].name;
  for (const query of [
    { from: '2000-01-01', to: '2100-12-31' },
    { from: '2000-01-01', to: '2100-12-31', region },
    { from: '2000-01-01', to: '2100-12-31', region, classification2: '노방' },
    { from: '2000-01-01', to: '2100-12-31', classification2: '소셜링' },
  ]) {
    const d = await call(admin, '/api/analytics/region-data', query);
    assert.equal('overview' in d, false, JSON.stringify(query));
    assert.ok(d.districtOverview && Array.isArray(d.districtOverview.findingChange), JSON.stringify(query));
    // 구역별 증감 표의 합계는 같은 조건의 찾기 건수와 같다(분류2·구역 필터를 함께 따른다).
    assert.equal(sum(d.districtOverview.findingChange, 'current'), d.totals.findings, JSON.stringify(query));
    if (query.region) {
      assert.ok(d.districtOverview.findingChange.every((row) => row.region === region), '다른 구역이 섞이지 않는다');
      assert.ok(d.rows.every((row) => row.key === region), '구역 행도 선택 구역만');
    }
    // 기간을 지정하면 직전 같은 일수와 비교한다.
    assert.ok(d.comparison && d.comparison.to < query.from);
  }
});

test('구역별 데이터: 담당 구역 밖 조건은 거절하고 담당 구역 사용자는 자기 구역만 받는다', async () => {
  const { store, manager, call, ownRegions } = await setup();
  const own = ownRegions(manager);
  const other = store.districts.map((d) => d.name).find((name) => !own.includes(name));
  if (other) await assert.rejects(call(manager, '/api/analytics/region-data', { region: other }), { status: 403 });
  const d = await call(manager, '/api/analytics/region-data', { from: '2000-01-01', to: '2100-12-31' });
  assert.equal('overview' in d, false);
  for (const row of d.districtOverview.findingChange) assert.ok(own.includes(row.region) || row.region === '구역 미입력', row.region);
});

test('대시보드 반 행은 실제 반 코드(value)를 보내고, 그 값으로 반별 데이터를 열면 같은 반이 선택된다', async () => {
  const { store, admin, call } = await setup();
  const d = dashboardOverview(store, { user: admin, query: new URLSearchParams({ period: 'month' }) });
  const options = (await call(admin, '/api/analytics/class-data', { from: d.from, to: d.to })).options.classes.map((c) => c.value);
  for (const row of d.classCounts) {
    assert.equal(typeof row.value, 'string', row.label);
    assert.match(row.label, /^[123]반$/);
    if (!options.includes(row.value)) continue; // 코드가 없는 자료실이면 숫자 코드로 대신한다.
    const classData = await call(admin, '/api/analytics/class-data', { from: d.from, to: d.to, statsClass: row.value, classification2: '' });
    assert.equal(classData.selectedClass, row.value, row.label);
  }
});

test('개인별·구역별·반별 첫 진입: period=week이고 날짜가 모두 비면 금주, 그 밖에는 받은 기간 그대로', async () => {
  const { admin, call } = await setup();
  for (const path of ['/api/analytics/member-data', '/api/analytics/region-data', '/api/analytics/class-data']) {
    const first = await call(admin, path, { period: 'week' });
    const week = first.presets.find((p) => p.label === '금주');
    assert.equal(first.from, week.from, path);
    assert.equal(first.to, week.to, path);
    const explicit = await call(admin, path, { period: 'week', from: '2000-01-01', to: '2100-12-31' });
    assert.equal(explicit.from, '2000-01-01', path);
    assert.equal(explicit.to, '2100-12-31', path);
    const all = await call(admin, path, {});
    assert.ok(!all.from && !all.to, `${path} 전체 기간은 유지`);
  }
});

test('반별 데이터: 대시보드의 반 이름(N반)으로 조회해도 응답의 selectedClass로 조건을 돌려준다', async () => {
  const { admin, call } = await setup();
  const d = await call(admin, '/api/analytics/class-data', { from: '2000-01-01', to: '2100-12-31', statsClass: '1반' });
  assert.equal(typeof d.selectedClass, 'string');
  assert.ok(Array.isArray(d.classes));
  for (const row of d.rows) assert.ok(row.engagement && row.metrics && row.cohort, row.key);
});
