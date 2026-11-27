import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../server/store.js';
import { commitWorkspace, scopedWorkspace } from '../server/domain.js';

// 로컬 메모리 저장소와 가상 자료만 사용한다. DB·Git·네트워크는 쓰지 않는다.
async function setup() {
  const store = await createStore();
  const users = [...store.users.values()];
  const admin = users.find((u) => u.username === 'admin');
  const manager = users.find((u) => u.username === 'manager1');
  const manager2 = users.find((u) => u.username === 'manager2');
  return { store, admin, manager, manager2 };
}

const memberOf = (store, user) => {
  const draft = scopedWorkspace(store, user);
  const m = draft.organization.members[0];
  assert.ok(m, '범위 안 구성원이 필요합니다');
  return m;
};

const mutate = (store, user, fn) => {
  const draft = scopedWorkspace(store, user);
  draft.regionalActivities = draft.regionalActivities ?? [];
  fn(draft);
  return commitWorkspace(store, user, draft);
};

test('지역활동: id 없는 행을 날짜·월 자연 식별자로 저장하고 서로 독립이다', async () => {
  const { store, manager } = await setup();
  const m = memberOf(store, manager);
  const base = { memberId: m.id, region: '1구역', name: m.name, memberCode: m.code, code: 1 };
  mutate(store, manager, (d) => d.regionalActivities.push({ ...base, month: '2026-11', date: '2026-11-24' }, { ...base, month: '2026-11', code: 3 }));
  assert.equal(store.workspace.regionalActivities.length, 2);

  // 같은 구성원의 날짜 행만 고쳐도 월 행은 그대로다.
  mutate(store, manager, (d) => { d.regionalActivities.find((r) => r.date).code = 2; });
  const rows = store.workspace.regionalActivities;
  assert.equal(rows.find((r) => r.date).code, 2);
  assert.equal(rows.find((r) => !r.date).code, 3);

  // 같은 내용을 다시 보내면 변경이 없다(재실행 무해).
  const before = store.workspace.revision;
  assert.equal(mutate(store, manager, () => {}).changed, false);
  assert.equal(store.workspace.revision, before);

  // 삭제는 해당 행만 지운다.
  mutate(store, manager, (d) => { d.regionalActivities = d.regionalActivities.filter((r) => !r.date); });
  assert.deepEqual(store.workspace.regionalActivities.map((r) => r.date), [undefined]);
});

test('지역활동: 관리자도 같은 식별 규칙으로 저장한다', async () => {
  const { store, admin } = await setup();
  const m = memberOf(store, admin);
  mutate(store, admin, (d) => d.regionalActivities.push({ memberId: m.id, month: '2026-11', date: '2026-11-24', code: 1, region: '1구역' }));
  assert.equal(store.workspace.regionalActivities.length, 1);
});

test('지역활동: 범위 밖 기록은 바뀌지 않고, 범위 밖 구성원·중복·잘못된 입력은 거부한다', async () => {
  const { store, admin, manager, manager2 } = await setup();
  const other = memberOf(store, manager2);
  mutate(store, admin, (d) => d.regionalActivities.push({ memberId: other.id, month: '2026-11', date: '2026-11-24', code: 4, region: '2구역' }));
  const snapshot = JSON.stringify(store.workspace.regionalActivities);

  const m = memberOf(store, manager);
  // 1구역 담당자의 초안에는 2구역 기록이 없고, 저장해도 그대로 남는다.
  mutate(store, manager, (d) => {
    assert.equal(d.regionalActivities.length, 0);
    d.regionalActivities.push({ memberId: m.id, month: '2026-11', date: '2026-11-24', code: 1, region: '1구역' });
  });
  assert.equal(JSON.stringify(store.workspace.regionalActivities.filter((r) => r.memberId === other.id)), snapshot);

  // 2구역 기록과 같은 식별자는 가로챌 수 없다.
  assert.throws(() => mutate(store, manager, (d) => d.regionalActivities.push({ memberId: other.id, month: '2026-11', date: '2026-11-24', code: 1, region: '1구역' })), { status: 403 });

  const bad = [
    { memberId: m.id, month: '2026-11', date: '2026-11-31', code: 1, region: '1구역' },
    { memberId: m.id, month: '2026-11', date: '2026-10-05', code: 1, region: '1구역' },
    { memberId: m.id, month: '2026-13', code: 1, region: '1구역' },
    { memberId: m.id, code: 1, region: '1구역' },
    { month: '2026-11', code: 1, region: '1구역' },
    { memberId: '', month: '2026-11', code: 1, region: '1구역' },
  ];
  for (const row of bad) assert.throws(() => mutate(store, manager, (d) => d.regionalActivities.push(row)), { status: 400 }, JSON.stringify(row));

  assert.throws(() => mutate(store, manager, (d) => {
    const row = { memberId: m.id, month: '2026-11', code: 1, region: '1구역' };
    d.regionalActivities.push(row, { ...row });
  }), { status: 400 });
});
