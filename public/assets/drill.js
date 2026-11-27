/**
 * 현황 화면 사이의 상세 이동. (대시보드 → 구역별·반별 데이터, 반별 → 개인별 데이터)
 * 이동 조건은 주소가 아니라 그 이동으로 생긴 history 항목의 state에 담는다.
 * - 이동한 화면은 첫 조회부터 그 조건을 쓴다.
 * - 메뉴로 들어온 항목에는 조건이 없어 기본값으로 연다.
 * - 뒤로가기 뒤 앞으로가기를 하면 그 항목에 남은 조건(같은 화면에서 바꾼 조건 포함)으로 다시 연다.
 * 권한은 서버가 다시 확인한다. 화면은 읽기 권한이 없는 메뉴로는 이동 단추를 만들지 않는다.
 */

const KEY = 'smoaDrill';

/** 메뉴에 있고 읽기 권한이 있는 화면인지 */
export function canOpen(me, view) {
  return Boolean(me?.menu?.some((item) => item.id === view) && me.perms?.[view]?.read);
}

/** 조건을 담은 새 history 항목으로 화면을 옮긴다. 셸은 hashchange로 화면을 다시 그린다. */
export function openDrill(view, filters) {
  history.pushState({ [KEY]: { view, filters: { ...filters } } }, '', `#/${view}`);
  window.dispatchEvent(new HashChangeEvent('hashchange'));
}

/** 현재 history 항목이 이 화면으로의 상세 이동이면 그 조건(복사본)을 돌려 준다. */
export function drillOf(view) {
  const entry = history.state?.[KEY];
  if (!entry || entry.view !== view || !entry.filters || typeof entry.filters !== 'object') return null;
  return Object.fromEntries(Object.entries(entry.filters).filter(([, value]) => typeof value === 'string'));
}

/** 상세 이동으로 연 화면에서 조건을 바꾸면 같은 history 항목에 새 조건을 남긴다. (메뉴로 연 항목은 그대로 둔다) */
export function keepDrill(view, filters) {
  if (history.state?.[KEY]?.view !== view) return;
  history.replaceState({ [KEY]: { view, filters: { ...filters } } }, '', location.href);
}
