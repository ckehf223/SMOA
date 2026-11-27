import { randomUUID } from 'node:crypto';
import { hashPassword } from './security.js';
import { SCREENS, normalizePerm } from './permissions.js';
import { OPTIONS, projectPerson, seedWorkspace, stageList } from './domain.js';

/**
 * 로컬 메모리 모드 전용 저장소. 프로세스를 끄면 모든 자료가 사라진다. 모든 자료는 가상 자료다.
 * 업무 자료의 원본은 store.workspace(4.0.41 호환 작업 영역)이고, store.people·store.stages는 그 투영(읽기 전용)이다.
 */
export { OPTIONS };

// 데모 전용 가상 계정. 실제 계정·비밀번호가 아니다.
export const DEMO_ACCOUNTS = [
  { username: 'admin', displayName: '가상 관리자', role: 'admin', districts: [], password: 'Admin-Demo-2026!', root: true },
  { username: 'manager1', displayName: '가상 담당자(1구역)', role: 'manager', districts: ['d1'], password: 'Manager1-Demo-2026!' },
  { username: 'manager2', displayName: '가상 담당자(2구역)', role: 'manager', districts: ['d2'], password: 'Manager2-Demo-2026!' },
  { username: 'viewer1', displayName: '가상 열람자(1·2구역)', role: 'viewer', districts: ['d1', 'd2'], password: 'Viewer1-Demo-2026!' },
];

// 새 화면의 기본값은 접근 없음이다. 관리자가 접근 권한 관리에서 역할별로 켠다.
const DEFAULT_PERMISSIONS = {
  manager: {
    dashboard: { access: true, read: true },
    people: { access: true, read: true, write: true, export: true },
  },
  viewer: {
    dashboard: { access: true, read: true },
    people: { access: true, read: true },
  },
};

export async function createStore(now = Date.now) {
  const store = {
    now,
    settings: { siteName: 'SMOA' },
    districts: [
      { id: 'd1', name: '1구역' },
      { id: 'd2', name: '2구역' },
      { id: 'd3', name: '3구역' },
    ],
    roles: [
      { id: 'admin', name: '관리자' },
      { id: 'manager', name: '구역 담당자' },
      { id: 'viewer', name: '열람자' },
    ],
    permissions: new Map(),
    users: new Map(),
    workspace: null,
    previews: new Map(),
    counters: { stage: 9, person: 24 },
    dummyHash: await hashPassword('dummy-password-for-timing'),
  };
  // 읽기 전용 투영: 매번 원본에서 계산하므로 별도 사본이 생기지 않는다.
  Object.defineProperty(store, 'stages', { enumerable: true, get: () => stageList(store.workspace) });
  Object.defineProperty(store, 'people', { enumerable: true, get: () => store.workspace.people.map((p) => projectPerson(store, p)) });

  for (const [role, screens] of Object.entries(DEFAULT_PERMISSIONS)) {
    const perms = {};
    for (const s of SCREENS) perms[s.id] = normalizePerm(screens[s.id], s.id);
    store.permissions.set(role, perms);
  }

  const hashes = await Promise.all(DEMO_ACCOUNTS.map((a) => hashPassword(a.password)));
  DEMO_ACCOUNTS.forEach((a, i) => {
    const id = randomUUID();
    store.users.set(id, {
      id,
      username: a.username,
      displayName: a.displayName,
      role: a.role,
      districts: [...a.districts],
      active: true,
      root: a.root === true,
      passwordHash: hashes[i],
      createdAt: new Date(now()).toISOString(),
    });
  });

  store.workspace = seedWorkspace(store);
  return store;
}
