// 공통 셸: 로그인 확인 → 서버 권한 메뉴 → 프로그램 페이지(HTML 조각, 서버가 권한 검사) → 모듈 스크립트 로딩.
// 메뉴 표시는 편의일 뿐이며 페이지(/pages/*)와 API 는 서버가 다시 검사한다.
import { api, logout, me as fetchMe } from './api.js';
import { menuPath, menuTree } from './menu-layout.js';
import { MODULES } from './modules.js';
import { clear, errorMessage, h, notice, toast } from './ui.js';

const navEl = document.getElementById('nav');
const mainEl = document.getElementById('main');
const sidebar = document.getElementById('sidebar');
const navToggle = document.getElementById('nav-toggle');
const backdrop = document.getElementById('nav-backdrop');
const compact = window.matchMedia('(max-width: 760px)');
let current = null; // 로그인한 me 응답
let renderToken = 0;

window.addEventListener('smoa:unauthorized', () => {
  // 세션 만료: 다시 로그인하도록 안내한다. 진행 중이던 변경 요청은 자동 재시도하지 않는다.
  window.location.replace('/login.html');
});

document.getElementById('logout').addEventListener('click', async () => {
  await logout().catch(() => {});
  current = null;
  window.location.replace('/login.html');
});

function setMenu(open) {
  sidebar.classList.toggle('open', open);
  navToggle.setAttribute('aria-expanded', String(open));
  backdrop.hidden = !open;
  sidebar.inert = compact.matches && !open;
  if (open) navEl.querySelector('[aria-current="page"], a')?.focus();
}

function closeMenu() {
  setMenu(false);
  if (compact.matches) navToggle.focus();
}

navToggle.addEventListener('click', () => setMenu(true));
backdrop.addEventListener('click', closeMenu);
compact.addEventListener('change', () => setMenu(false));
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && sidebar.classList.contains('open')) closeMenu();
});
setMenu(false);

function programIdFromHash() {
  const match = /^#\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})$/.exec(window.location.hash);
  return match ? match[1] : null;
}

function renderNav() {
  const open = new Set([...navEl.querySelectorAll('details[open]')].map((section) => section.dataset.menuPath));
  const previousScroll = navEl.scrollTop;
  clear(navEl);
  function renderItems(nodes, depth = 0) {
    return nodes.flatMap((node) => {
      if (node.programId) {
        return h('li', {}, h('a', {
          class: depth ? 'nav-link' : 'nav-link nav-link-root',
          href: `#/${node.programId}`, 'data-program-id': node.programId, text: node.name,
          onclick: () => { if (compact.matches && programIdFromHash() === node.programId) closeMenu(); },
        }));
      }
      const children = renderItems(node.children, depth + 1);
      if (!children.length) return [];
      return h('li', {}, h('details', {
        class: depth ? 'nav-group nav-subgroup' : 'nav-group',
        'data-menu-path': node.path, open: open.has(node.path),
      }, h('summary', {}, h('span', { class: 'nav-arrow', 'aria-hidden': 'true' }), node.name),
      h('ul', { class: 'nav-children' }, children)));
    });
  }
  const tree = h('ul', { class: 'nav-tree' }, renderItems(menuTree(current.menus, current.menuGroups)));
  navEl.append(tree);
  navEl.scrollTop = previousScroll;
}

function markActive(programId) {
  for (const link of navEl.querySelectorAll('.nav-link')) {
    if (link.dataset.programId === programId) {
      link.setAttribute('aria-current', 'page');
      for (let section = link.closest('details'); section; section = section.parentElement.closest('details')) {
        section.open = true;
      }
    } else link.removeAttribute('aria-current');
  }
}

function markLocation(item) {
  const path = menuPath(item.group);
  const group = document.getElementById('crumb-group');
  group.textContent = path.join(' / ');
  group.hidden = !path.length;
  document.getElementById('crumb-separator').hidden = !path.length;
  document.getElementById('crumb').textContent = item.name;
  document.title = `${item.name} · SMOA`;
}

async function refreshMenus() {
  current = await fetchMe();
  renderNav();
  const item = current.menus.find((menu) => menu.programId === programIdFromHash());
  if (item) {
    markActive(item.programId);
    markLocation(item);
  } else {
    route();
  }
}

function showMessage(kind, message) {
  clear(mainEl).append(notice(kind, message));
}

/** 서버가 허용한 프로그램만 이 함수에 도달한다. 페이지 조각 요청도 서버가 다시 검사한다. */
async function openProgram(programId) {
  const token = ++renderToken;
  const item = current.menus.find((m) => m.programId === programId);
  if (!item) {
    showMessage('error', '이 프로그램을 열 권한이 없거나 사용할 수 없습니다.');
    return;
  }
  markActive(programId);
  markLocation(item);
  if (sidebar.classList.contains('open')) {
    setMenu(false);
    mainEl.focus();
  }
  clear(mainEl).append(h('p', { class: 'muted', text: '불러오는 중…' }));
  let html;
  try {
    const response = await fetch(item.page, { credentials: 'same-origin', headers: { Accept: 'text/html' } });
    if (response.status === 401) { window.dispatchEvent(new CustomEvent('smoa:unauthorized')); return; }
    if (response.status === 403) { showMessage('error', '이 화면에 대한 권한이 없습니다.'); return; }
    if (!response.ok) { showMessage('error', '화면을 불러오지 못했습니다.'); return; }
    html = await response.text();
  } catch (error) {
    showMessage('error', '화면을 불러오지 못했습니다. 네트워크를 확인해 주세요.');
    return;
  }
  if (token !== renderToken) return; // 그 사이 다른 화면으로 이동
  const doc = new DOMParser().parseFromString(html, 'text/html'); // 파싱만 하며 스크립트는 실행되지 않는다
  clear(mainEl);
  for (const node of Array.from(doc.body.childNodes)) mainEl.append(document.importNode(node, true));
  const body = mainEl.querySelector('.program-body');
  const scriptPath = MODULES[item.module];
  if (!body) { showMessage('error', '화면 형식이 올바르지 않습니다.'); return; }
  if (!scriptPath) {
    body.append(notice('warn', '이 프로그램의 모듈이 아직 등록되지 않았습니다. 관리자에게 문의해 주세요.'));
    return;
  }
  try {
    const module = await import(scriptPath);
    if (token !== renderToken) return;
    await module.mount({
      programId, program: item, permissions: current.permissions[programId], container: body, me: current,
      api, toast, refreshMenus,
    });
  } catch (error) {
    if (token !== renderToken) return;
    clear(body).append(notice('error', errorMessage(error)));
  }
}

function route() {
  if (!current) return;
  if (current.noMenu) {
    showMessage('warn', '사용할 수 있는 프로그램이 없습니다. 관리자에게 권한 패키지 부여를 요청해 주세요.');
    return;
  }
  const programId = programIdFromHash();
  if (programId && current.menus.some((m) => m.programId === programId)) {
    openProgram(programId);
  } else {
    const first = navEl.querySelector('.nav-link');
    if (first) window.location.replace(first.getAttribute('href'));
  }
}

async function start() {
  try {
    current = await fetchMe();
  } catch (error) {
    window.location.replace('/login.html');
    return;
  }
  document.getElementById('who').textContent = current.displayName;
  document.getElementById('avatar').textContent = current.displayName?.trim().slice(0, 1) || 'S';
  document.getElementById('permission-package').textContent = current.pkg?.name || '';
  document.getElementById('dev-badge').hidden = !current.devMemory;
  if (!current.packageActive) {
    showMessage('warn', '권한 패키지가 비활성이거나 없습니다. 관리자에게 문의해 주세요.');
    return;
  }
  renderNav();
  window.addEventListener('hashchange', route);
  route();
}

start();
