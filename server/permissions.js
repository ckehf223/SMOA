const R = ['read'];
const RE = ['read', 'export'];
const RWE = ['read', 'write', 'export'];

/**
 * 구현된 업무 화면. 권한 행렬과 메뉴는 이 목록을 기준으로 서버가 만든다.
 * actions: 화면에서 의미가 있는 동작(읽기·쓰기·내보내기). 화면 접근(access)은 모든 화면에 있다.
 * group: 사이드 메뉴의 묶음 이름. 배열 순서가 메뉴 순서다.
 */
export const SCREENS = [
  { id: 'dashboard', label: '대시보드', group: '최상위', actions: R },
  { id: 'regionData', label: '구역별 데이터', group: '데이터현황', actions: RE },
  { id: 'memberData', label: '개인별 데이터', group: '데이터현황', actions: RE },
  { id: 'classData', label: '반별 데이터', group: '데이터현황', actions: RE },
  { id: 'findingStats', label: '찾기·주관자 통계', group: '데이터현황', actions: RE },
  { id: 'diagnostics', label: '통계 진단', group: '데이터현황', actions: RE },
  { id: 'stagePerformance', label: '단계 강약 분석', group: '데이터현황', actions: RE },
  { id: 'socialingManage', label: '소셜링 관리', group: '소셜링', actions: RWE },
  { id: 'socialingStats', label: '소셜링 데이터현황', group: '소셜링', actions: RE },
  { id: 'callingManage', label: '콜링 관리', group: '콜링', actions: RWE },
  { id: 'callingStats', label: '콜링 데이터 현황', group: '콜링', actions: RE },
  { id: 'people', label: '대상자 관리', group: '기록관리', actions: RWE },
  { id: 'activities', label: '활동 기록', group: '기록관리', actions: RWE },
  { id: 'regionalActivity', label: '지역활동기록', group: '기록관리', actions: RWE },
  { id: 'stages', label: '단계 이동 분석', group: '기록관리', actions: RE },
  { id: 'history', label: '변경 이력', group: '기록관리', actions: RE },
  { id: 'reports', label: '엑셀 · 자료 가져오기', group: '자료작업', actions: RWE },
  { id: 'daily', label: '일보 변환 · 분석', group: '자료작업', actions: RWE },
  { id: 'goals', label: '구역·반 기간 목표', group: '최상위', actions: RWE },
  { id: 'organization', label: '조직 · 구성원 관리', group: '관리설정', actions: RWE },
];

export const ADMIN_MENU = [
  { id: 'users', label: '사용자 관리' },
  { id: 'permissions', label: '접근 권한 관리' },
  { id: 'codes', label: '공통코드 관리' },
  { id: 'settings', label: '설정' },
];

export const ACTIONS = ['access', 'read', 'write', 'export'];

const ALL = { access: true, read: true, write: true, export: true };
const NONE = { access: false, read: false, write: false, export: false };
const screenOf = (id) => SCREENS.find((s) => s.id === id);

/**
 * 저장 형태 정규화: 화면 접근이 꺼지면 모두 꺼지고, 읽기가 꺼지면 쓰기·내보내기도 꺼진다.
 * screenId를 주면 그 화면에 없는 동작(예: 통계 화면의 쓰기)도 꺼진다.
 */
export function normalizePerm(p, screenId) {
  const applicable = screenId ? (screenOf(screenId)?.actions ?? []) : ['read', 'write', 'export'];
  const access = p?.access === true;
  const read = access && applicable.includes('read') && p?.read === true;
  return {
    access,
    read,
    write: read && applicable.includes('write') && p?.write === true,
    export: read && applicable.includes('export') && p?.export === true,
  };
}

/** 적용 가능한 동작만 켠 기본 권한. */
export function fullPerm(screenId) {
  return normalizePerm(ALL, screenId);
}

export function effective(store, user, screenId) {
  if (user.role === 'admin') return fullPerm(screenId);
  const p = store.permissions.get(user.role)?.[screenId];
  return p ? normalizePerm(p, screenId) : { ...NONE };
}

/** 중앙 동작 검사: 모든 업무 API는 이 함수로만 허용 여부를 결정한다. */
export function can(store, user, screenId, action) {
  const e = effective(store, user, screenId);
  return e[action] === true;
}

export function menuFor(store, user) {
  return SCREENS.filter((s) => can(store, user, s.id, 'access')).map(({ id, label, group }) => ({ id, label, group }));
}

/** 데이터 경계: 사용자가 볼 수 있는 구역 ID 집합. 관리자는 전체 구역. */
export function scopeFor(store, user) {
  const all = store.districts.map((d) => d.id);
  if (user.role === 'admin') return new Set(all);
  return new Set(user.districts.filter((id) => all.includes(id)));
}
