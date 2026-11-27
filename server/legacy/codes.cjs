"use strict";
const { randomUUID } = require("node:crypto");
const SYSTEM = [
  ["className", "반", ["1", "2", "3"]],
  ["employment", "직업 구분", ["미입력", "직장인", "학생", "기타"]],
  [
    "position",
    "직책",
    ["구성원", "구역원", "구역장", "지역장", "부구역장", "부지역장"],
  ],
  ["activityKind", "활동 종류", ["대화", "콜링", "만남"]],
  ["activityPlace", "활동 장소", []],
];
const fail = (ok, msg) => {
  if (!ok) throw new Error(msg);
};
const str = (v, max = 200, required = false) => {
  fail(
    typeof v === "string" && v.length <= max,
    `공통코드 항목은 ${max}자 이내로 입력해 주세요.`,
  );
  const s = v.trim();
  fail(!required || s, "공통코드 필수 항목을 입력해 주세요.");
  return s;
};
const ident = (v) => {
  fail(
    typeof v === "string" &&
      /^[A-Za-z0-9_-]{1,80}$/.test(v) &&
      !["__proto__", "prototype", "constructor"].includes(v),
    "코드 그룹 식별자를 확인해 주세요.",
  );
  return v;
};
const item = (value, label = value, order = 0) => ({
  id: randomUUID(),
  value,
  label,
  aliases: [],
  active: true,
  order,
});
const defaults = () => ({
  groups: SYSTEM.map(([id, label, values]) => ({
    id,
    label,
    system: true,
    active: true,
    items: values.map((v, i) => item(v, v, i)),
  })),
});
const catalog = (ws) => ws?.commonCodes || defaults();
const group = (ws, key) => catalog(ws).groups.find((g) => g.id === key);
const tokens = (i) => [i.value, i.label, ...i.aliases];
const find = (ws, key, value) =>
  group(ws, key)?.items.find((i) => tokens(i).includes(value));
const label = (ws, key, value) =>
  value ? find(ws, key, value)?.label || value : "";
function options(ws, key, current = "", all = false) {
  const g = group(ws, key);
  const list = (g?.items || [])
    .filter(
      (i) =>
        all ||
        (g.active && (i.active || i.value === current)) ||
        tokens(i).includes(current),
    )
    .sort(
      (a, b) =>
        a.order - b.order ||
        a.label.localeCompare(b.label, "ko", { numeric: true }),
    )
    .map((i) => [
      i.value,
      `${i.label}${!g.active || !i.active ? " (보관)" : ""}`,
    ]);
  if (current && !list.some((i) => i[0] === current))
    list.push([current, `${label(ws, key, current)} (기존 값)`]);
  return list;
}
function resolve(ws, key, value, existing) {
  const raw = str(value ?? "", key === "activityPlace" ? 200 : 60);
  if (!raw) return "";
  const g = group(ws, key),
    i = find(ws, key, raw);
  if (!i) {
    fail(
      raw === existing,
      `${g?.label || key}: '${raw}'는 등록되지 않은 값입니다. 공통코드 관리에서 먼저 추가해 주세요.`,
    );
    return raw;
  }
  fail(
    (g.active && i.active) ||
      (existing !== undefined && tokens(i).includes(existing)),
    `${g.label}: 보관된 항목은 새로 선택할 수 없습니다.`,
  );
  return i.value;
}
function preferred(ws, key, value) {
  const i = find(ws, key, value);
  return i?.active && group(ws, key)?.active ? i.value : "";
}
function validate(c) {
  fail(
    c && Array.isArray(c.groups) && c.groups.length <= 60,
    "코드 그룹은 최대 60개입니다.",
  );
  const ids = new Set(),
    labels = new Set();
  let total = 0;
  for (const g of c.groups) {
    ident(g.id);
    str(g.label, 60, true);
    fail(
      !ids.has(g.id) && !labels.has(g.label),
      "코드 그룹ID 또는 이름이 중복됩니다.",
    );
    ids.add(g.id);
    labels.add(g.label);
    fail(
      typeof g.active === "boolean" &&
        typeof g.system === "boolean" &&
        Array.isArray(g.items) &&
        g.items.length <= 500,
      "코드 그룹 설정을 확인해 주세요. 그룹당 최대 500개입니다.",
    );
    fail(
      g.system === SYSTEM.some((s) => s[0] === g.id) && (!g.system || g.active),
      "기본 코드 그룹은 제거하거나 보관할 수 없습니다.",
    );
    const itemIDs = new Set(),
      keys = new Set();
    for (const i of g.items) {
      ident(i.id);
      str(i.value, 60, true);
      str(i.label, g.id === "activityPlace" ? 200 : 60, true);
      fail(!itemIDs.has(i.id), "코드 식별자가 중복됩니다.");
      itemIDs.add(i.id);
      fail(
        typeof i.active === "boolean" &&
          Number.isInteger(i.order) &&
          i.order >= 0 &&
          i.order <= 9999 &&
          Array.isArray(i.aliases) &&
          i.aliases.length <= 30,
        "코드 사용 상태·순서·이전 이름을 확인해 주세요.",
      );
      for (const token of new Set(tokens(i))) {
        str(token, 200, true);
        fail(
          !keys.has(token),
          "코드값·표시명·이전 표시명이 다른 항목과 겹칩니다.",
        );
        keys.add(token);
      }
      total++;
    }
  }
  fail(total <= 10000, "공통코드는 총 10,000개까지 등록할 수 있습니다.");
  for (const [key] of SYSTEM)
    fail(ids.has(key), "기본 코드 그룹이 누락되었습니다.");
  return c;
}
function valuesFromWorkspace(ws) {
  const out = new Map(SYSTEM.map(([k]) => [k, new Set()]));
  const add = (key, value) => {
    if (typeof value === "string" && value.trim())
      out.get(key).add(value.trim());
  };
  for (const p of ws.people || []) {
    add("className", p.className);
    add("employment", p.employment);
    for (const t of p.transitions || []) {
      add("className", t.className);
      add("employment", t.employment);
    }
    for (const a of p.activities || []) {
      add("activityKind", a.kind);
      add("activityPlace", a.place);
    }
  }
  for (const a of ws.activityLogs || []) {
    add("activityKind", a.kind);
    add("activityPlace", a.place);
  }
  for (const m of ws.organization?.members || []) {
    add("className", m.className);
    add("employment", m.employment);
    add("position", m.position);
  }
  return out;
}
function collect(ws, skipOverflow = false) {
  const c = structuredClone(catalog(ws)),
    changes = [];
  for (const [key, values] of valuesFromWorkspace(ws)) {
    const g = c.groups.find((g) => g.id === key);
    for (const value of values)
      if (!g.items.some((i) => tokens(i).includes(value))) {
        if (skipOverflow && g.items.length >= 500) continue;
        const after = item(value, value, g.items.length);
        g.items.push(after);
        changes.push({ groupId: key, before: null, after });
      }
  }
  validate(c);
  ws.commonCodes = c;
  return changes;
}
function ensure(ws) {
  if (!Object.hasOwn(ws, "commonCodes")) {
    ws.commonCodes = defaults();
    collect(ws, true);
  }
  validate(ws.commonCodes);
}
function saveGroup(ws, p) {
  const c = structuredClone(catalog(ws)),
    old = p.id ? c.groups.find((g) => g.id === p.id) : null;
  fail(!p.id || old, "코드 그룹을 찾을 수 없습니다.");
  const after = {
    id: old?.id || randomUUID(),
    label: str(p.label, 60, true),
    system: old?.system || false,
    active: old?.system ? true : p.active !== false,
    items: old?.items || [],
  };
  if (old) c.groups[c.groups.indexOf(old)] = after;
  else c.groups.push(after);
  validate(c);
  ws.commonCodes = c;
  return {
    before: old ? { ...old, items: undefined } : null,
    after: { ...after, items: undefined },
  };
}
function editItem(g, p, old) {
  fail(
    p.aliases === undefined || Array.isArray(p.aliases),
    "이전 표시명은 배열로 전달해 주세요.",
  );
  const value = str(
    p.value ||
      old?.value ||
      `C-${randomUUID().replace(/-/g, "").slice(0, 12).toUpperCase()}`,
    60,
    true,
  );
  fail(!old || value === old.value, "생성한 코드값은 변경할 수 없습니다.");
  const nextLabel = str(p.label, g.id === "activityPlace" ? 200 : 60, true);
  const aliases = [
    ...new Set([
      ...(old?.aliases || []),
      ...(p.aliases || []),
      ...(old && old.label !== nextLabel ? [old.label] : []),
    ]),
  ].filter((v) => v !== nextLabel && v !== value);
  return {
    id: old?.id || randomUUID(),
    value,
    label: nextLabel,
    aliases,
    active: p.active !== false,
    order: Number(p.order ?? old?.order ?? g.items.length),
  };
}
function saveItem(ws, p) {
  const c = structuredClone(catalog(ws)),
    g = c.groups.find((g) => g.id === p.groupId);
  fail(g, "코드 그룹을 찾을 수 없습니다.");
  const old = p.id ? g.items.find((i) => i.id === p.id) : null;
  fail(!p.id || old, "코드 항목을 찾을 수 없습니다.");
  const after = editItem(g, p, old);
  if (old) g.items[g.items.indexOf(old)] = after;
  else g.items.push(after);
  validate(c);
  ws.commonCodes = c;
  return { groupId: g.id, before: old, after };
}
function removeItem(ws, p) {
  const c = structuredClone(catalog(ws)),
    g = c.groups.find((g) => g.id === p.groupId),
    before = g?.items.find((i) => i.id === p.id);
  fail(before, "코드 항목을 찾을 수 없습니다.");
  const used = valuesFromWorkspace(ws).get(g.id) || new Set();
  if (g.id === "className") {
    for (const r of [
      ...(ws.goals || []),
      ...(ws.findingReports || []),
      ...(ws.activityLogs || []),
    ])
      if (r.className) used.add(r.className);
  }
  for (const p of ws.people || []) {
    if (
      ["className", "employment", "position"].includes(g.id) &&
      p.introducerSnapshot?.[g.id]
    )
      used.add(p.introducerSnapshot[g.id]);
    if (g.id === "className")
      for (const a of p.activities || [])
        if (a.className) used.add(a.className);
    for (const f of ws.fields || [])
      if (f.codeGroupId === g.id && p.custom?.[f.id]) used.add(p.custom[f.id]);
  }
  fail(
    !tokens(before).some((v) => used.has(v)),
    "기존 기록·구성원·목표에서 사용 중인 코드입니다. 연결된 값을 변경하거나 항목을 보관해 주세요.",
  );
  g.items.splice(g.items.indexOf(before), 1);
  validate(c);
  ws.commonCodes = c;
  return { groupId: g.id, before, after: null };
}
function removeGroup(ws, p) {
  const c = structuredClone(catalog(ws)),
    before = c.groups.find((g) => g.id === p.id);
  fail(before, "코드 그룹을 찾을 수 없습니다.");
  fail(
    !before.system,
    "기본 코드 그룹은 삭제할 수 없습니다. 그룹 안의 항목은 개별 삭제할 수 있습니다.",
  );
  fail(
    !(ws.fields || []).some((f) => f.codeGroupId === before.id),
    "사용자 항목에 연결된 코드 그룹입니다. 사용자 항목의 코드 그룹 연결을 변경하거나 그룹을 보관해 주세요.",
  );
  c.groups.splice(c.groups.indexOf(before), 1);
  validate(c);
  ws.commonCodes = c;
  return { before, after: null };
}
function importRows(ws, rows, onDuplicate) {
  const draft = { commonCodes: structuredClone(catalog(ws)) },
    changes = [],
    seen = new Set(),
    meta = new Map();
  let skipped = 0;
  for (const p of rows) {
    ident(p.groupId);
    const key = JSON.stringify([p.groupId, p.value]);
    fail(!seen.has(key), "파일 안에서 코드 그룹·코드값이 중복됩니다.");
    seen.add(key);
    const title = str(p.groupLabel, 60, true),
      active = p.groupActive !== false,
      signature = JSON.stringify([title, active]);
    fail(
      !meta.has(p.groupId) || meta.get(p.groupId) === signature,
      "같은 코드 그룹의 이름·사용 상태가 서로 다릅니다.",
    );
    meta.set(p.groupId, signature);
    let g = draft.commonCodes.groups.find((g) => g.id === p.groupId),
      groupChanged = false;
    if (!g) {
      g = {
        id: p.groupId,
        label: title,
        active,
        system: SYSTEM.some((s) => s[0] === p.groupId),
        items: [],
      };
      draft.commonCodes.groups.push(g);
      changes.push({
        groupId: g.id,
        before: null,
        after: { ...g, items: undefined },
      });
      groupChanged = true;
    } else if (g.label !== title || g.active !== active) {
      const before = { ...g, items: undefined };
      g.label = title;
      g.active = active;
      changes.push({
        groupId: g.id,
        before,
        after: { ...g, items: undefined },
      });
      groupChanged = true;
    }
    if (!p.value) {
      if (!groupChanged) {
        skipped++;
        onDuplicate?.(p, { label: g.label, groupId: g.id, active: g.active });
      }
      continue;
    }
    const old = g.items.find((i) => i.value === p.value),
      after = editItem(g, p, old);
    if (old && JSON.stringify(old) === JSON.stringify(after)) {
      if (!groupChanged) {
        skipped++;
        onDuplicate?.(p, old);
      }
      continue;
    }
    if (old) g.items[g.items.indexOf(old)] = after;
    else g.items.push(after);
    changes.push({ groupId: g.id, before: old || null, after });
  }
  validate(draft.commonCodes);
  ws.commonCodes = draft.commonCodes;
  return { changes, skipped };
}
module.exports = {
  SYSTEM,
  defaults,
  catalog,
  group,
  find,
  label,
  options,
  resolve,
  preferred,
  validate,
  ensure,
  collect,
  saveGroup,
  saveItem,
  removeItem,
  removeGroup,
  importRows,
};
