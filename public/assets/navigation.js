/**
 * 왼쪽 업무 메뉴: 4.0.41의 메뉴 트리(menu-tree.js)와 '메뉴 관리'를 웹으로 옮긴 모듈.
 *
 * 권한 경계
 * - 그릴 메뉴는 언제나 서버(/api/me)가 알려 준 `items`와 교집합이다. 저장된 구성에 있어도 서버가 주지 않은 화면은 그리지 않는다.
 * - 이 모듈의 설정(그룹·순서·이름·숨김·접힘)은 이 브라우저의 localStorage에만 두며 서버로 보내지 않는다.
 *   저장 키에는 사용자 UUID(개인정보 아님)만 쓴다. 숨김이나 순서 변경은 화면 접근 권한을 바꾸지 않는다.
 */
import { h } from './common.js';

const TREE_KEY = 'smoa-menu-tree';
const OPEN_KEY = 'smoa-menu-open';

let current = null; // 마지막으로 그린 메뉴의 입력: { nav, items, activeId, scope }
let menuTreePromise = null;
let stylePromise = null;

// ───────── 자원 불러오기(같은 출처의 스크립트·스타일만) ─────────

/** menu-tree.js는 4.0.41 원본 그대로의 일반 스크립트라서 모듈 import 대신 script로 불러와 window.MenuTree를 쓴다. */
function loadMenuTree() {
  if (window.MenuTree) return Promise.resolve(window.MenuTree);
  menuTreePromise ??= new Promise((resolve, reject) => {
    document.head.append(h('script', {
      src: '/assets/menu-tree.js',
      onload: () => (window.MenuTree ? resolve(window.MenuTree) : reject(new Error('메뉴 구성 파일이 올바르지 않습니다.'))),
      onerror: () => { menuTreePromise = null; reject(new Error('메뉴 구성 파일을 불러오지 못했습니다.')); },
    }));
  });
  return menuTreePromise;
}

function loadStyle() {
  stylePromise ??= new Promise((resolve) => {
    if (document.querySelector('link[href="/assets/navigation.css"]')) return resolve();
    document.head.append(h('link', { rel: 'stylesheet', href: '/assets/navigation.css', onload: resolve, onerror: resolve }));
  });
  return stylePromise;
}

// ───────── 이 브라우저에만 두는 사용자 설정 ─────────

const storageKey = (base) => `${base}:${current.scope}`;

function readJson(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

const menuKeys = () => current.items.map((i) => i.id);

/** 저장된 트리를 현재 서버 허용 화면 기준으로 정규화한다(순환·중복·알 수 없는 화면은 MenuTree가 걷어 낸다). */
function readTree() {
  return window.MenuTree.normalize(readJson(storageKey(TREE_KEY)), menuKeys());
}

function readOpen() {
  const value = readJson(storageKey(OPEN_KEY));
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function rememberOpen(groupId, open) {
  writeJson(storageKey(OPEN_KEY), { ...readOpen(), [groupId]: open });
}

// ───────── 메뉴 그리기 ─────────

/** 메뉴를 바꿔 끼우되 스크롤 위치와, 메뉴 안에 있던 키보드 초점을 유지한다. */
function replaceNav(nav, children, activeId) {
  const focusKey = nav.contains(document.activeElement) ? document.activeElement.dataset.navKey : null;
  const top = nav.scrollTop;
  nav.replaceChildren(...children);
  nav.scrollTop = top;
  if (focusKey) {
    [...nav.querySelectorAll('[data-nav-key]')].find((el) => el.dataset.navKey === focusKey)?.focus({ preventScroll: true });
  }
  if (activeId) nav.querySelector('[aria-current="page"]')?.scrollIntoView({ block: 'nearest' });
}

const leaf = (item, label, activeId) => h('a', {
  class: 'nav-leaf',
  href: `#/${item.id}`,
  'aria-current': item.id === activeId ? 'page' : null,
  'data-nav-key': `leaf:${item.id}`,
}, label);

/** 묶음 없는 단순 메뉴(관리 화면, 메뉴 구성 파일을 못 불러온 경우). 서버가 준 순서와 group을 그대로 쓴다. */
function paintPlain(nav, items, activeId) {
  const groups = [];
  for (const item of items) {
    let g = groups.find((x) => x.name === (item.group ?? ''));
    if (!g) groups.push((g = { name: item.group ?? '', items: [] }));
    g.items.push(item);
  }
  replaceNav(nav, groups.map((g) => h('section', { class: 'navgroup', 'aria-label': g.name || null },
    g.name ? h('p', { class: 'navtitle' }, g.name) : null,
    h('ul', null, g.items.map((i) => h('li', null, leaf(i, i.label, activeId)))))), activeId);
}

/** 트리를 <details> 묶음으로 그린다. 보이는 화면이 하나도 없는 묶음은 그리지 않는다. */
function paintTree() {
  const { nav, items, activeId } = current;
  const MT = window.MenuTree;
  const tree = readTree();
  const open = readOpen();
  const byId = new Map(items.map((i) => [i.id, i]));

  const walk = (parent) => MT.children(tree, parent).flatMap((node) => {
    if (node.type === 'view') {
      const item = byId.get(node.view);
      if (!item || node.hidden) return [];
      return [{ active: item.id === activeId, el: h('li', null, leaf(item, node.label || item.label, activeId)) }];
    }
    const kids = walk(node.id);
    if (!kids.length) return [];
    const active = kids.some((k) => k.active);
    const details = h('details', { class: 'nav-group', open: active || open[node.id] === true },
      h('summary', {
        'data-nav-key': `group:${node.id}`,
        // 클릭 직전의 상태를 뒤집어 기억한다. 키보드(Enter·Space)도 click으로 들어온다.
        onclick: () => rememberOpen(node.id, !details.open),
      }, h('span', { class: 'nav-arrow', 'aria-hidden': 'true' }), h('span', null, node.label)),
      h('ul', { class: 'nav-children' }, kids.map((k) => k.el)));
    return [{ active, el: h('li', null, details) }];
  });

  const entries = walk(null);
  replaceNav(nav, [
    h('div', { class: 'nav-tree-heading' },
      h('h2', { class: 'nav-tree-title' }, '메뉴'),
      h('button', { type: 'button', class: 'nav-manage', 'data-nav-key': 'manage', 'aria-haspopup': 'dialog', onclick: openManager }, '메뉴 관리')),
    entries.length
      ? h('ul', { class: 'nav-tree' }, entries.map((e) => e.el))
      : h('p', { class: 'nav-empty' }, '표시할 메뉴가 없습니다. 메뉴 관리에서 숨긴 메뉴를 다시 표시하거나 기본 메뉴로 복원하세요.'),
  ], activeId);
}

/**
 * 메뉴를 그린다.
 * items: 서버가 허용한 화면 [{ id, label, group }]  activeId: 현재 화면  scope: 사용자 UUID
 * tree: false면 관리 화면처럼 단순 목록  isCurrent: 오래된 화면 갱신이면 false를 돌려주는 확인 함수
 */
export async function renderNavigation(nav, { items, activeId, scope, tree = true, isCurrent = () => true }) {
  if (!tree) {
    paintPlain(nav, items, activeId);
    return;
  }
  await loadStyle();
  let menuTreeReady = true;
  try {
    await loadMenuTree();
  } catch {
    menuTreeReady = false; // 구성 파일이 없어도 서버 허용 메뉴는 서버 순서대로 보여 준다.
  }
  if (!isCurrent()) return;
  current = { nav, items, activeId, scope };
  if (menuTreeReady) paintTree();
  else paintPlain(nav, items, activeId);
}

// ───────── 메뉴 관리 ─────────

function newGroupId() {
  const unique = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `g:${unique}`;
}

/** 이름 · 상위 그룹 경로 표시용: "기록관리 / 하위 그룹". */
function pathOf(tree, id) {
  const parts = [];
  const seen = new Set();
  for (let node = tree.nodes.find((n) => n.id === id); node && !seen.has(node.id); node = tree.nodes.find((n) => n.id === node.parent)) {
    seen.add(node.id);
    parts.unshift(node.label);
  }
  return parts.join(' / ');
}

function openManager() {
  const MT = window.MenuTree;
  const message = h('p', { class: 'menu-manager-message', role: 'status' });
  const problem = h('p', { class: 'menu-manager-message error', role: 'alert' });
  const list = h('ul', { class: 'menu-manager-list' });

  const itemOf = (node) => current.items.find((i) => i.id === node.view);
  const shownLabel = (node) => (node.type === 'group' ? node.label : node.label || itemOf(node)?.label || node.view);

  /** 변경을 이 브라우저에 저장하고 목록·왼쪽 메뉴를 다시 그린다. 서버에는 아무것도 보내지 않는다. */
  function commit(tree, done, focusKey) {
    const saved = MT.normalize(tree, menuKeys());
    if (!writeJson(storageKey(TREE_KEY), saved)) {
      problem.textContent = '메뉴 구성을 이 브라우저에 저장하지 못했습니다.';
      return;
    }
    problem.textContent = '';
    message.textContent = done;
    paint(focusKey);
    paintTree();
  }

  /** 오류는 대화상자 안에 알리고 목록을 저장된 상태로 되돌린다. */
  const attempt = (fn, focusKey) => () => {
    try {
      fn();
    } catch (err) {
      problem.textContent = err.message;
      message.textContent = '';
      paint(focusKey);
    }
  };

  const reorder = (tree, node, position) => {
    const rest = MT.children(tree, node.parent).filter((n) => n.id !== node.id);
    return MT.move(tree, node.id, node.parent, rest[position - 1]?.id ?? null);
  };

  function edit(id, change, done, focusKey) {
    let tree = readTree();
    const node = tree.nodes.find((n) => n.id === id);
    if (!node) throw new Error('메뉴를 찾을 수 없습니다. 목록을 다시 불러옵니다.');
    tree = change(tree, node) ?? tree;
    commit(tree, done, focusKey);
  }

  function row(tree, node) {
    const isGroup = node.type === 'group';
    const label = shownLabel(node);
    const siblings = MT.children(tree, node.parent);
    const index = siblings.findIndex((n) => n.id === node.id);
    const excluded = isGroup ? new Set([node.id, ...MT.descendants(tree, node.id)]) : new Set();
    const parents = tree.nodes.filter((n) => n.type === 'group' && !excluded.has(n.id));
    const move = (offset) => attempt(() => edit(node.id, (t, n) => reorder(t, n, index + 1 + offset),
      `${label}을(를) ${offset < 0 ? '위로' : '아래로'} 옮겼습니다.`, `${offset < 0 ? 'up' : 'down'}:${node.id}`), `${offset < 0 ? 'up' : 'down'}:${node.id}`);

    return h('li', { class: `menu-manager-row ${isGroup ? 'is-group' : 'is-view'}`, 'data-depth': Math.min(node.depth, 4) },
      h('span', { class: 'menu-kind' }, isGroup ? '그룹' : '메뉴'),
      h('label', { class: 'menu-field' }, h('span', null, '이름'),
        h('input', {
          type: 'text', value: node.label, maxlength: '60', placeholder: isGroup ? null : itemOf(node)?.label,
          'data-focus': `name:${node.id}`,
          onchange: (e) => attempt(() => {
            const text = e.target.value.trim();
            if (isGroup && !text) throw new Error('그룹 이름을 입력해 주세요.');
            edit(node.id, (t, n) => { n.label = text; }, text ? `이름을 '${text}'(으)로 바꿨습니다.` : '기본 이름으로 되돌렸습니다.', `name:${node.id}`);
          }, `name:${node.id}`)(),
        })),
      h('label', { class: 'menu-field' }, h('span', null, '상위 그룹'),
        h('select', {
          'data-focus': `parent:${node.id}`,
          onchange: (e) => attempt(() => edit(node.id, (t) => MT.move(t, node.id, e.target.value || null),
            `${label}을(를) 옮겼습니다.`, `parent:${node.id}`), `parent:${node.id}`)(),
        }, h('option', { value: '', selected: !node.parent }, '최상위'),
        parents.map((g) => h('option', { value: g.id, selected: g.id === node.parent }, pathOf(tree, g.id))))),
      isGroup ? null : h('label', { class: 'menu-check' },
        h('input', {
          type: 'checkbox', checked: !node.hidden, 'data-focus': `visible:${node.id}`,
          onchange: (e) => attempt(() => edit(node.id, (t, n) => { n.hidden = !e.target.checked; },
            `${label}을(를) ${e.target.checked ? '표시' : '숨김'}으로 바꿨습니다.`, `visible:${node.id}`), `visible:${node.id}`)(),
        }), '메뉴에 표시'),
      h('div', { class: 'menu-row-actions' },
        h('button', { type: 'button', class: 'secondary small', 'data-focus': `up:${node.id}`, 'aria-label': `${label} 위로 이동`, disabled: index === 0, onclick: move(-1) }, '위로'),
        h('button', { type: 'button', class: 'secondary small', 'data-focus': `down:${node.id}`, 'aria-label': `${label} 아래로 이동`, disabled: index === siblings.length - 1, onclick: move(1) }, '아래로'),
        isGroup ? h('button', {
          type: 'button', class: 'secondary small', title: '그룹 안의 메뉴는 상위로 옮겨집니다', 'aria-label': `${label} 그룹 삭제`,
          onclick: attempt(() => commit(MT.removeGroup(readTree(), node.id), `'${label}' 그룹을 삭제했습니다. 안에 있던 메뉴는 상위로 옮겼습니다.`, 'add-group')),
        }, '그룹 삭제') : null));
  }

  /** 다시 그린 뒤 방금 쓰던 조작으로 초점을 돌려준다(끝 줄의 '아래로'가 꺼지면 반대쪽 버튼으로). */
  function paint(focusKey) {
    const tree = readTree();
    const rows = MT.ordered(tree);
    list.replaceChildren(...rows.map((node) => row(tree, node)));
    if (!focusKey) return;
    const find = (key) => [...dialog.querySelectorAll('[data-focus]')].find((el) => el.dataset.focus === key && !el.disabled);
    const [kind, id] = [focusKey.split(':')[0], focusKey.slice(focusKey.indexOf(':') + 1)];
    const opposite = { up: 'down', down: 'up' }[kind];
    const target = find(focusKey) ?? (opposite && find(`${opposite}:${id}`)) ?? find(`name:${id}`) ?? dialog.querySelector('[data-focus="add-group"]');
    target?.focus();
    if (kind === 'name' && target?.select) target.select();
  }

  const addGroup = attempt(() => {
    const id = newGroupId();
    const tree = readTree();
    tree.nodes.push({ id, type: 'group', label: '새 그룹', parent: null });
    commit(tree, '새 그룹을 추가했습니다. 이름을 바꾸고 메뉴를 옮겨 담으세요.', `name:${id}`);
  });

  const dialog = h('dialog', { class: 'menu-manager', 'aria-labelledby': 'menu-manager-title' },
    h('h2', { id: 'menu-manager-title' }, '메뉴 관리'),
    h('p', { class: 'note' }, '그룹과 메뉴의 이름·순서·표시 여부를 정합니다. 설정은 이 브라우저에만 저장되며, 열 수 있는 화면은 서버 권한이 정합니다.'),
    message, problem,
    h('div', { class: 'menu-manager-tools' },
      h('button', { type: 'button', 'data-focus': 'add-group', onclick: addGroup }, '새 그룹 추가'),
      h('button', {
        type: 'button', class: 'secondary',
        onclick: attempt(() => commit(MT.defaults(menuKeys()), '기본 메뉴로 복원했습니다.', 'add-group')),
      }, '기본 메뉴로 복원')),
    list,
    h('div', { class: 'buttons' }, h('button', { type: 'button', onclick: () => dialog.close() }, '닫기')));
  dialog.addEventListener('close', () => {
    dialog.remove();
    [...document.querySelectorAll('[data-nav-key="manage"]')][0]?.focus();
  });
  paint();
  document.body.append(dialog);
  dialog.showModal();
}
