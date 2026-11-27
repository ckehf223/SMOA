import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterPeople } from '../server/people.js';

// 가상 자료만 쓰는 좁은 단위 테스트: 대상자 관리 검색이 인도자 이름·찾기 장소를 찾고,
// 범위 밖 인도자와 연락처(끝 네 자리 포함)는 검색 낱말로 쓰지 않는지 확인한다.
function fakeStore() {
  const organization = {
    nodes: [
      { id: 'n1', parentId: '', name: '가구역', type: '구역', reportRegion: '가구역' },
      { id: 'n2', parentId: '', name: '나구역', type: '구역', reportRegion: '나구역' },
    ],
    members: [
      { id: 'm1', code: 'M-001', name: '김인도', unitId: 'n1', status: 'active' },
      { id: 'm2', code: 'M-002', name: '박바깥', unitId: 'n2', status: 'active' },
    ],
  };
  const raw = [
    { id: 'p1', status: 'active', introducerId: 'm1', place: '가나공원 010-1234-5678' },
    { id: 'p2', status: 'active', introducerId: 'm2', place: '다라역' },
  ];
  const row = (id, code, name) => ({ id, code, name, districtId: 'd1', stageId: 's1', registeredDate: '2026-01-01', worker: '담당가', notes: '' });
  return {
    workspace: { people: raw, organization },
    people: [row('p1', 'P-1', '대상하나'), row('p2', 'P-2', '대상둘')],
    districts: [{ id: 'd1', name: '가구역' }, { id: 'd2', name: '나구역' }],
    stages: [{ id: 's1', name: '단계1', active: true }],
  };
}
const find = (store, q, scope = new Set(['d1'])) => filterPeople(store, scope, new URLSearchParams({ q })).map((p) => p.id);

test('대상자 검색: 인도자 이름·번호와 찾기 장소로 찾는다', () => {
  const store = fakeStore();
  assert.deepEqual(find(store, '김인도'), ['p1']);
  assert.deepEqual(find(store, 'm-001'), ['p1']);
  assert.deepEqual(find(store, '가나공원'), ['p1']);
  assert.deepEqual(find(store, '다라'), ['p2']);
  assert.deepEqual(find(store, 'P-2'), ['p2']);
  assert.deepEqual(find(store, '담당가').sort(), ['p1', 'p2']);
});

test('대상자 검색: 범위 밖 인도자와 연락처는 검색 낱말이 아니다', () => {
  const store = fakeStore();
  assert.deepEqual(find(store, '박바깥'), []);
  assert.deepEqual(find(store, '5678'), []);
  assert.deepEqual(find(store, '010'), []);
  // 인도자 구역 권한이 있으면 찾는다.
  assert.deepEqual(find(store, '박바깥', new Set(['d1', 'd2'])), ['p2']);
});
