import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRoutes } from '../server/app.js';
import { SCREENS, effective, fullPerm } from '../server/permissions.js';

const ok = (extra) => ({ method: 'GET', path: '/api/x', screen: 'callingManage', action: 'write', handler() {}, ...extra });

test('편집 화면 전용 GET 조회(write 동작)는 허용된다', () => {
  assert.doesNotThrow(() => validateRoutes([ok()]));
});

test('화면·동작이 없거나 지원하지 않으면 시작 검증이 거부한다', () => {
  assert.throws(() => validateRoutes([ok({ screen: undefined })]));
  assert.throws(() => validateRoutes([ok({ screen: 'nope' })]));
  assert.throws(() => validateRoutes([ok({ action: 'delete' })]));
  assert.throws(() => validateRoutes([ok({ screen: 'dashboard', action: 'export' })]));
  assert.throws(() => validateRoutes([ok(), ok()]));
  assert.throws(() => validateRoutes([ok({ method: 'GET', binary: true })]));
});

test('관리자 실효 권한은 화면에 해당하는 동작만 알린다', () => {
  const admin = { role: 'admin' };
  for (const s of SCREENS) assert.deepEqual(effective({}, admin, s.id), fullPerm(s.id));
  assert.equal(effective({}, admin, 'dashboard').write, false);
  assert.equal(effective({}, admin, 'callingStats').write, false);
  assert.equal(effective({}, admin, 'people').write, true);
});

test('메뉴 이름이 기존 화면 이름과 맞는다', () => {
  const label = (id) => SCREENS.find((s) => s.id === id).label;
  assert.equal(label('daily'), '일보 변환 · 분석');
  assert.equal(label('reports'), '엑셀 · 자료 가져오기');
  assert.equal(label('regionalActivity'), '지역활동기록');
  assert.equal(label('diagnostics'), '통계 진단');
  assert.equal(label('stagePerformance'), '단계 강약 분석');
});
