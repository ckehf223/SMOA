import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../server/store.js';
import { scopedWorkspace } from '../server/domain.js';

// 로컬 메모리 저장소와 가상 자료만 사용한다. DB·Git·네트워크는 쓰지 않는다.
test('구성원 이력: 배정 밖 조직이 한쪽이라도 있으면 지금 보여도 이력에서 제외한다', async () => {
  const store = await createStore();
  const users = [...store.users.values()];
  const manager = users.find((u) => u.username === 'manager1');
  const own = scopedWorkspace(store, manager).organization.members[0];
  assert.ok(own, '범위 안 구성원이 필요합니다');
  const ownUnit = own.unitId;
  const at = '2026-11-24T00:00:00.000Z';
  const entry = (id, action, before, after) => ({ id, at, actor: '가상', action, target: own.id, before, after });
  store.workspace.history.push(
    entry('H-ok', '구성원 수정', { ...own, notes: '1구역 메모' }, { member: { ...own, notes: '1구역 메모2' } }),
    entry('H-reg', '구성원 등록', null, { member: { ...own, unitId: 'private-d2-child', notes: '2구역 등록 메모' } }),
    entry('H-move', '구성원 수정', { ...own, unitId: 'private-d2-child' }, { member: { ...own, unitId: ownUnit }, transfer: { fromPath: '2구역 > 비공개', toPath: '1구역', reason: '비공개 사유' } }),
    entry('H-node', '조직 수정', { id: ownUnit, parentId: 'private-d2-child', leaderId: '' }, { id: ownUnit, parentId: ownUnit, leaderId: '' }),
  );

  const ids = scopedWorkspace(store, manager).history.map((h) => h.id);
  assert.ok(ids.includes('H-ok'), '배정 조직 안의 이력은 보인다');
  for (const hidden of ['H-reg', 'H-move', 'H-node']) assert.ok(!ids.includes(hidden), `${hidden}은 가려야 한다`);

  const text = JSON.stringify(scopedWorkspace(store, manager).history);
  for (const secret of ['private-d2-child', '2구역 등록 메모', '2구역 > 비공개', '비공개 사유']) assert.ok(!text.includes(secret), secret);

  const admin = users.find((u) => u.username === 'admin');
  const adminIds = scopedWorkspace(store, admin).history.map((h) => h.id);
  for (const id of ['H-ok', 'H-reg', 'H-move']) assert.ok(adminIds.includes(id), `관리자는 ${id}을 본다`);
});
