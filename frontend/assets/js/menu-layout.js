export function menuPath(group) {
  return (group || '').split('/').map((name) => name.trim()).filter(Boolean);
}

/** 그룹과 프로그램을 한 트리에 모아, 같은 부모 아래에서 함께 정렬한다. */
export function menuTree(items, groups = []) {
  const root = { children: [] };
  const folders = new Map([['', root]]);

  function putGroup(path, order) {
    const parts = menuPath(path);
    let parent = root;
    let key = '';
    for (const name of parts) {
      key = key ? key + ' / ' + name : name;
      if (!folders.has(key)) {
        const group = { path: key, name, children: [], sortOrder: order };
        folders.set(key, group);
        parent.children.push(group);
      }
      parent = folders.get(key);
    }
    return parent;
  }

  groups.forEach(({ path, sortOrder }) => {
    const group = putGroup(path, sortOrder);
    group.sortOrder = sortOrder;
  });
  items.forEach((item, index) => {
    const sortOrder = item.sortOrder ?? index;
    putGroup(item.group, sortOrder).children.push({ ...item, sortOrder });
  });
  for (const { children } of folders.values()) {
    children.sort((a, b) => a.sortOrder - b.sortOrder);
  }
  return root.children;
}
