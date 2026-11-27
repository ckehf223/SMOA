"use strict";
(function (root) {
  const featureGroups = [
    ["g:socialing", "소셜링", ["socialingManage", "socialingStats"]],
    ["g:calling", "콜링", ["callingManage", "callingStats"]],
  ];
  function defaults(keys) {
    const groups = [
        [
          "g:data",
          "데이터현황",
          [
            "regionData",
            "memberData",
            "classData",
            "findingStats",
            "diagnostics",
            "stagePerformance",
          ],
        ],
        ...featureGroups.filter(([, , routes]) => routes.some((key) => keys.includes(key))),
        [
          "g:records",
          "기록관리",
          ["people", "activities", "regionalActivity", "stages", "history"],
        ],
        ["g:files", "자료작업", ["reports", "daily"]],
        ["g:admin", "관리설정", ["organization", "codes", "settings"]],
      ],
      nodes = [];
    const addView = (key, parent = null) => {
      if (keys.includes(key))
        nodes.push({
          id: `v:${key}`,
          type: "view",
          view: key,
          label: "",
          parent,
          hidden: false,
        });
    };
    addView("dashboard");
    for (const [id, label, children] of groups.slice(0, -1)) {
      nodes.push({ id, type: "group", label, parent: null });
      children.forEach((key) => addView(key, id));
    }
    addView("goals");
    const [id, label, children] = groups.at(-1);
    nodes.push({ id, type: "group", label, parent: null });
    children.forEach((key) => addView(key, id));
    for (const key of keys)
      if (!nodes.some((n) => n.view === key)) addView(key);
    return { version: 1, nodes };
  }
  function normalize(input, keys) {
    if (!input || !Array.isArray(input.nodes)) return defaults(keys);
    const nodes = [],
      ids = new Set(),
      seenViews = new Set();
    for (const raw of input.nodes.slice(0, 250)) {
      if (!raw || typeof raw !== "object") continue;
      const group = raw.type === "group";
      if (
        group
          ? !/^g:[a-zA-Z0-9_-]{1,80}$/.test(raw.id)
          : raw.type !== "view" ||
            !keys.includes(raw.view) ||
            seenViews.has(raw.view)
      )
        continue;
      const id = group ? raw.id : `v:${raw.view}`;
      if (ids.has(id)) continue;
      ids.add(id);
      if (!group) seenViews.add(raw.view);
      nodes.push({
        id,
        type: group ? "group" : "view",
        ...(group ? {} : { view: raw.view, hidden: raw.hidden === true }),
        label:
          typeof raw.label === "string"
            ? raw.label.trim().slice(0, 60) || (group ? "새 그룹" : "")
            : group
              ? "새 그룹"
              : "",
        parent: typeof raw.parent === "string" ? raw.parent : null,
      });
    }
    const groups = new Set(
        nodes.filter((n) => n.type === "group").map((n) => n.id),
      ),
      map = new Map(nodes.map((n) => [n.id, n]));
    for (const n of nodes) {
      if (!groups.has(n.parent) || n.parent === n.id) n.parent = null;
      let p = n.parent;
      const seen = new Set([n.id]);
      while (p) {
        if (seen.has(p)) {
          n.parent = null;
          break;
        }
        seen.add(p);
        p = map.get(p)?.parent || null;
      }
    }
    const baseline = defaults(keys);
    // Add feature groups to older menus while respecting groups users removed.
    for (const [id, , routes] of featureGroups) {
      if (groups.has(id) || !routes.some((key) => keys.includes(key) && !seenViews.has(key)))
        continue;
      const index = nodes.findIndex((n) => n.id === "g:records" && n.parent === null);
      nodes.splice(index < 0 ? nodes.length : index, 0, baseline.nodes.find((n) => n.id === id));
      groups.add(id);
    }
    for (const n of baseline.nodes.filter(
      (n) => n.type === "view" && !seenViews.has(n.view),
    ))
      nodes.push({ ...n, parent: groups.has(n.parent) ? n.parent : null });
    return { version: 1, nodes };
  }
  const children = (tree, parent = null) =>
    tree.nodes.filter((n) => n.parent === parent);
  function descendants(tree, id) {
    const found = new Set();
    const visit = (p) => {
      for (const n of children(tree, p)) {
        if (found.has(n.id)) continue;
        found.add(n.id);
        if (n.type === "group") visit(n.id);
      }
    };
    visit(id);
    return found;
  }
  function ordered(tree) {
    const result = [];
    const visit = (parent, depth) => {
      for (const n of children(tree, parent)) {
        result.push({ ...n, depth });
        if (n.type === "group") visit(n.id, depth + 1);
      }
    };
    visit(null, 0);
    return result;
  }
  function move(tree, id, parent = null, before = null) {
    const copy = JSON.parse(JSON.stringify(tree)),
      n = copy.nodes.find((n) => n.id === id);
    if (!n) throw Error("메뉴를 찾을 수 없습니다.");
    if (
      parent &&
      !copy.nodes.some((n) => n.id === parent && n.type === "group")
    )
      throw Error("상위 그룹을 확인하세요.");
    if (parent === id || descendants(copy, id).has(parent))
      throw Error("자신 또는 하위 그룹 안으로 옮길 수 없습니다.");
    copy.nodes = copy.nodes.filter((x) => x.id !== id);
    n.parent = parent;
    const siblings = children(copy, parent);
    let index = before
      ? copy.nodes.findIndex((x) => x.id === before && x.parent === parent)
      : -1;
    if (index < 0)
      index = siblings.length
        ? copy.nodes.findIndex((x) => x.id === siblings.at(-1).id) + 1
        : copy.nodes.length;
    copy.nodes.splice(index, 0, n);
    return copy;
  }
  function removeGroup(tree, id) {
    const copy = JSON.parse(JSON.stringify(tree)),
      group = copy.nodes.find((n) => n.id === id && n.type === "group");
    if (!group) return copy;
    const siblings = children(copy, group.parent),
      next = siblings[siblings.findIndex((n) => n.id === id) + 1]?.id || null;
    let result = copy;
    for (const n of children(copy, id))
      result = move(result, n.id, group.parent, next);
    result.nodes = result.nodes.filter((n) => n.id !== id);
    return result;
  }
  function fromLegacy(order, keys) {
    const tree = defaults(keys),
      rank = new Map(
        [...new Set([...order.filter((k) => keys.includes(k)), ...keys])].map(
          (k, i) => [k, i],
        ),
      );
    const getRank = (n) =>
      n.type === "view"
        ? rank.get(n.view)
        : Math.min(...children(tree, n.id).map(getRank), 10000);
    tree.nodes.sort((a, b) => getRank(a) - getRank(b));
    return tree;
  }
  const api = {
    defaults,
    normalize,
    children,
    descendants,
    ordered,
    move,
    removeGroup,
    fromLegacy,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.MenuTree = api;
})(typeof window === "undefined" ? globalThis : window);
