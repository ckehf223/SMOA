import { menuPath, menuTree } from '../js/menu-layout.js';
import { badge, clear, errorMessage, field, h, select } from '../js/ui.js';

const joinPath = (path, name) => path ? path + ' / ' + name : name;
const nodeKey = (node) => node.programId ? 'program:' + node.programId : 'group:' + node.path;

function findNode(nodes, key) {
  for (const [index, node] of nodes.entries()) {
    if (nodeKey(node) === key) return { node, index, siblings: nodes };
    if (node.children) {
      const found = findNode(node.children, key);
      if (found) return found;
    }
  }
  return null;
}

function copyTree(nodes) {
  return nodes.map((node) => node.children ? { ...node, children: copyTree(node.children) } : { ...node });
}

function groupChoices(nodes) {
  return nodes.flatMap((node) => node.children ? [[node.path, node.path], ...groupChoices(node.children)] : []);
}

function layoutPayload(tree) {
  const groups = [];
  const placements = [];
  let sortOrder = 0;

  function visit(nodes, parent) {
    const names = new Set();
    for (const node of nodes) {
      sortOrder += 10;
      if (node.programId) {
        placements.push({ programId: node.programId, group: parent, sortOrder, name: node.editedName });
        continue;
      }
      const path = joinPath(parent, node.name);
      if (!node.name || node.name.includes('/') || path.length > 30) {
        throw new Error('그룹 이름에 / 문자를 사용할 수 없으며, 전체 경로는 30자 이하여야 합니다.');
      }
      if (names.has(node.name)) throw new Error('같은 위치에 동일한 그룹 이름이 있습니다.');
      names.add(node.name);
      groups.push({ path, sortOrder });
      visit(node.children, path);
    }
  }
  visit(tree, '');
  return { groups, placements };
}

export function menuEditor(ctx, programs, layout, refresh) {
  const positions = new Map(layout.placements.map((entry) => [entry.programId, entry]));
  const tree = menuTree(programs.map((item) => ({ ...item, ...positions.get(item.programId) })), layout.groups);
  const groups = groupChoices(tree);
  const list = h('ul', { class: 'menu-edit-tree', 'aria-label': '메뉴 목록' });
  const editor = h('div', { class: 'panel menu-edit-fields' });
  const status = h('p', { class: 'error', role: 'alert', hidden: true });
  const split = h('div', { class: 'menu-edit-layout' }, list, editor);
  let busy = false;

  const addGroup = h('button', { class: 'btn primary small', type: 'button', text: '메뉴 그룹 추가' });
  const surface = h('div', {}, h('div', { class: 'actions menu-edit-tabs' }, addGroup), status, split);

  async function submit(change) {
    if (busy) return;
    busy = true;
    split.inert = true;
    addGroup.disabled = true;
    status.hidden = true;
    let saved = false;
    try {
      const draft = copyTree(tree);
      const selection = change(draft);
      await ctx.api.patch('/api/admin/menu-layout', layoutPayload(draft));
      saved = true;
      ctx.toast('메뉴 배치를 저장했습니다.', 'ok');
      await ctx.refreshMenus?.();
      await refresh(selection);
    } catch (error) {
      status.textContent = saved ? '메뉴를 다시 불러오지 못했습니다. 페이지를 새로고침해 주세요.' : errorMessage(error);
      status.hidden = false;
    } finally {
      busy = false;
      split.inert = false;
      addGroup.disabled = false;
    }
  }

  function childrenOf(nodes, path) {
    return path ? findNode(nodes, 'group:' + path).node.children : nodes;
  }

  function markSelected(key) {
    for (const row of list.querySelectorAll('[data-menu-node]')) {
      row.setAttribute('aria-pressed', String(row.dataset.menuNode === key));
    }
  }

  function showForm(title, controls, save, remove, focus) {
    status.hidden = true;
    const heading = h('h3', { text: title, tabindex: -1 });
    clear(editor).append(heading, h('form', {
      onsubmit: (event) => {
        event.preventDefault();
        void submit(save);
      },
    }, controls, h('div', { class: 'actions' },
      h('button', { type: 'submit', class: 'btn primary small', text: '저장' }),
      remove && h('button', { type: 'button', class: 'btn small', text: '빈 그룹 삭제', onclick: () => submit(remove) }))));
    if (focus) heading.focus();
  }

  function editGroup(node, focus = false) {
    const key = node ? nodeKey(node) : null;
    markSelected(key);
    const oldParent = node ? menuPath(node.path).slice(0, -1).join(' / ') : '';
    const name = h('input', { type: 'text', value: node?.name || '', maxlength: 30, required: true });
    const parents = groups.filter(([path]) => !path.includes('/')
      && path !== node?.path && !node?.children.some((entry) => entry.children));
    const parent = select([['', '최상위'], ...parents], oldParent);
    showForm(node ? '메뉴 그룹 수정' : '메뉴 그룹 추가',
      [field('그룹 이름', name), field('상위 그룹', parent)],
      (draft) => {
        const label = name.value.trim();
        const next = node ? findNode(draft, key) : null;
        if (next) {
          next.node.name = label;
          if (oldParent !== parent.value) {
            const destination = childrenOf(draft, parent.value);
            next.siblings.splice(next.index, 1);
            destination.push(next.node);
          }
        } else {
          childrenOf(draft, parent.value).push({ name: label, children: [] });
        }
        return 'group:' + joinPath(parent.value, label);
      }, node && !node.children.length ? (draft) => {
        const { siblings, index } = findNode(draft, key);
        siblings.splice(index, 1);
        return oldParent ? 'group:' + oldParent : null;
      } : null, focus);
  }

  function editProgram(node, focus = false) {
    const key = nodeKey(node);
    markSelected(key);
    const name = h('input', { type: 'text', value: node.name, maxlength: 50, required: true });
    const parent = select([['', '최상위 독립 메뉴'], ...groups], node.group);
    showForm('프로그램 배치', [field('메뉴 이름', name), field('상위 그룹', parent)], (draft) => {
      const next = findNode(draft, key);
      const label = name.value.trim();
      if (!label) throw new Error('메뉴 이름을 입력해 주세요.');
      if (label !== node.name) next.node.editedName = label;
      if ((node.group || '') !== parent.value) {
        next.siblings.splice(next.index, 1);
        childrenOf(draft, parent.value).push(next.node);
      }
      return key;
    }, null, focus);
  }

  function choose(node, focus) {
    if (node.programId) editProgram(node, focus);
    else editGroup(node, focus);
  }

  function renderRows(nodes, depth = 0) {
    return nodes.map((node, index) => {
      const key = nodeKey(node);
      const label = node.path || joinPath(node.group, node.name);
      const buttons = [-1, 1].map((delta) => h('button', {
        class: 'btn small', type: 'button', text: delta < 0 ? '↑' : '↓',
        'aria-label': label + (delta < 0 ? ' 위로 이동' : ' 아래로 이동'),
        disabled: index + delta < 0 || index + delta >= nodes.length,
        onclick: () => submit((draft) => {
          const { siblings } = findNode(draft, key);
          const other = index + delta;
          [siblings[index], siblings[other]] = [siblings[other], siblings[index]];
          return key;
        }),
      }));
      const kind = node.children ? (depth ? ' menu-edit-middle' : ' menu-edit-main') : '';
      return h('li', {}, h('div', { class: 'menu-edit-row' + kind },
        h('button', {
          class: 'btn small menu-edit-program', type: 'button', 'data-menu-node': key,
          'aria-pressed': 'false', onclick: () => choose(node, true),
        }, node.name, node.programId && !node.active ? badge('비활성', 'warn') : null),
        h('div', { class: 'actions menu-edit-order' }, buttons)),
      node.children?.length ? h('ul', { class: 'menu-edit-children' }, renderRows(node.children, depth + 1)) : null);
    });
  }

  addGroup.addEventListener('click', () => editGroup(null, true));
  list.append(...renderRows(tree));
  const first = findNode(tree, ctx.menuSelection)?.node || tree[0];
  if (first) choose(first);
  else editGroup(null);
  return surface;
}
