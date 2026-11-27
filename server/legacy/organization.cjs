"use strict";
const { randomUUID } = require("node:crypto");
const K = require("./codes.cjs");
const empty = () => ({ nodes: [], members: [] });
const check = (ok, message) => {
  if (!ok) throw new Error(message);
};
const text = (v, max = 100, required = false) => {
  check(
    typeof v === "string" && v.length <= max,
    `조직 항목은 ${max}자 이내로 입력해 주세요.`,
  );
  const s = v.trim();
  check(!required || s, "조직의 필수 항목을 입력해 주세요.");
  return s;
};
const id = (v) => {
  check(
    typeof v === "string" &&
      /^[A-Za-z0-9_-]{1,80}$/.test(v) &&
      !["__proto__", "constructor", "prototype"].includes(v),
    "조직 식별자가 올바르지 않습니다.",
  );
  return v;
};
const get = (ws) => ws.organization || empty();
const stamp = () => new Date().toISOString();
const code = (prefix) =>
  `${prefix}-${randomUUID().replace(/-/g, "").slice(0, 12).toUpperCase()}`;
function ancestors(org, unitId) {
  const result = [],
    seen = new Set();
  while (unitId) {
    check(
      !seen.has(unitId) && result.length < 12,
      "조직 순환 참조 또는 최대 깊이(12단계)를 확인해 주세요.",
    );
    seen.add(unitId);
    const node = org.nodes.find((n) => n.id === unitId);
    check(node, "등록되지 않은 상위 조직입니다.");
    result.unshift(node);
    unitId = node.parentId;
  }
  return result;
}
const within = (org, unitId, rootId) =>
  !!unitId && ancestors(org, unitId).some((n) => n.id === rootId);
const pathName = (org, unitId) =>
  ancestors(org, unitId)
    .map((n) => n.name)
    .join(" / ");
const regionOf = (org, unitId) =>
  ancestors(org, unitId)
    .reverse()
    .map((n) => n.reportRegion || (/구역/.test(n.type) ? n.name : ""))
    .find(Boolean) || "";
function validate(org, ws) {
  check(
    org &&
      Array.isArray(org.nodes) &&
      org.nodes.length <= 1000 &&
      Array.isArray(org.members) &&
      org.members.length <= 30000,
    "조직은 1,000개, 구성원은 30,000명까지 등록할 수 있습니다.",
  );
  const ids = new Set(),
    codes = new Set(),
    labels = new Set(),
    regions = new Set();
  for (const n of org.nodes) {
    id(n.id);
    check(
      typeof n.parentId === "string" && typeof n.leaderId === "string",
      "조직 연결 식별자를 확인해 주세요.",
    );
    if (n.parentId) id(n.parentId);
    if (n.leaderId) id(n.leaderId);
    check(!ids.has(n.id), "중복 조직 식별자입니다.");
    ids.add(n.id);
    const c = text(n.code, 60, true);
    check(!codes.has(c), "중복 조직ID입니다.");
    codes.add(c);
    text(n.name, 60, true);
    text(n.type, 30, true);
    text(n.leaderTitle, 40, true);
    text(n.reportRegion, 60);
    check(typeof n.active === "boolean", "조직 사용 상태를 확인해 주세요.");
    const label = `${n.parentId}\u0000${n.name}`;
    check(
      !labels.has(label),
      "같은 상위 조직 안에 같은 이름의 조직이 있습니다.",
    );
    labels.add(label);
    if (n.reportRegion) {
      check(
        !regions.has(n.reportRegion),
        "한 데이터 구역명은 하나의 조직에만 연결해 주세요.",
      );
      regions.add(n.reportRegion);
    }
  }
  for (const n of org.nodes) {
    const chain = ancestors(org, n.id);
    check(
      !n.active || chain.every((x) => x.active),
      "사용 중인 하위 조직이 있습니다. 하위 조직부터 보관하거나 이동해 주세요.",
    );
  }
  ids.clear();
  codes.clear();
  for (const m of org.members) {
    id(m.id);
    id(m.unitId);
    check(!ids.has(m.id), "중복 구성원 식별자입니다.");
    ids.add(m.id);
    const c = text(m.code, 60, true);
    check(!codes.has(c), "이미 사용 중인 구성원ID입니다.");
    codes.add(c);
    text(m.name, 100, true);
    text(m.position, 60);
    text(m.notes, 5000);
    text(m.className, 60);
    check(
      ["active", "inactive"].includes(m.status),
      "구성원 상태를 확인해 주세요.",
    );
    if (ws) {
      K.resolve(ws, "employment", m.employment, m.employment);
      K.resolve(ws, "className", m.className, m.className);
      K.resolve(ws, "position", m.position, m.position);
    }
    const chain = ancestors(org, m.unitId);
    check(chain.length, "구성원의 소속 조직을 지정해 주세요.");
    check(
      m.status !== "active" || chain.every((n) => n.active),
      "보관된 조직에는 활동 중인 구성원을 둘 수 없습니다.",
    );
  }
  for (const n of org.nodes) {
    if (!n.leaderId) continue;
    const member = org.members.find((m) => m.id === n.leaderId);
    check(
      n.active &&
        member?.status === "active" &&
        within(org, member.unitId, n.id),
      "책임자는 해당 조직 또는 하위 조직의 활동 중인 구성원으로 지정해 주세요.",
    );
  }
  return org;
}
function nodeValue(p, before) {
  const result = {
    id: before?.id || randomUUID(),
    code: text(p.code || before?.code || code("O"), 60, true),
    name: text(p.name, 60, true),
    type: text(p.type || "구역", 30, true),
    parentId: p.parentId ? id(p.parentId) : "",
    leaderId: p.leaderId ? id(p.leaderId) : "",
    leaderTitle: text(p.leaderTitle || "책임자", 40, true),
    reportRegion: text(p.reportRegion || "", 60),
    active: p.active !== false,
    createdAt: before?.createdAt || stamp(),
    updatedAt: stamp(),
  };
  check(
    !before || result.code === before.code,
    "조직ID는 생성 후 변경할 수 없습니다.",
  );
  return result;
}
function memberValue(p, before, ws) {
  const result = {
    id: before?.id || randomUUID(),
    code: text(p.code || before?.code || code("M"), 60, true),
    name: text(p.name, 100, true),
    unitId: id(p.unitId),
    position: K.resolve(
      ws,
      "position",
      p.position || K.preferred(ws, "position", "구성원"),
      before?.position,
    ),
    className: K.resolve(ws, "className", p.className || "", before?.className),
    employment: K.resolve(
      ws,
      "employment",
      p.employment || K.preferred(ws, "employment", "미입력"),
      before?.employment,
    ),
    status: p.status || "active",
    notes: text(p.notes || "", 5000),
    createdAt: before?.createdAt || stamp(),
    updatedAt: stamp(),
  };
  check(
    !before || result.code === before.code,
    "구성원ID는 생성 후 변경할 수 없습니다.",
  );
  return result;
}
function replace(list, before, after) {
  if (before) list[list.indexOf(before)] = after;
  else list.push(after);
}
function saveNode(ws, p) {
  const org = structuredClone(get(ws)),
    before = p.id ? org.nodes.find((n) => n.id === p.id) : null;
  check(!p.id || before, "조직을 찾을 수 없습니다.");
  const after = nodeValue(p, before);
  replace(org.nodes, before, after);
  validate(org);
  ws.organization = org;
  return { before, after };
}
function saveMember(ws, p) {
  const org = structuredClone(get(ws)),
    before = p.id ? org.members.find((m) => m.id === p.id) : null;
  check(!p.id || before, "구성원을 찾을 수 없습니다.");
  const after = memberValue(p, before, ws),
    cleared = [];
  replace(org.members, before, after);
  for (const n of org.nodes)
    if (
      n.leaderId === after.id &&
      (after.status !== "active" || !within(org, after.unitId, n.id))
    ) {
      cleared.push({ id: n.id, name: n.name, leaderId: n.leaderId });
      n.leaderId = "";
      n.updatedAt = stamp();
    }
  validate(org);
  ws.organization = org;
  return {
    before: { member: before, leadership: cleared },
    after: {
      member: after,
      leadership: cleared.map((n) => ({ ...n, leaderId: "" })),
    },
  };
}
function reportDimensions(ws, member, region) {
  const org = get(ws),
    district = org.nodes.find(
      (n) => (n.reportRegion || (/구역/.test(n.type) ? n.name : "")) === region,
    );
  const chain = district ? ancestors(org, district.id).slice(0, -1) : [];
  const area =
    [...chain].reverse().find((n) => /지역/.test(n.type)) || chain[0];
  return {
    areaId: area?.id || "",
    areaName: area?.name || "",
    unitPath: member ? pathName(org, member.unitId) : "",
  };
}
function removeNode(ws, p) {
  const org = structuredClone(get(ws)),
    before = org.nodes.find((n) => n.id === p.id);
  check(before, "조직을 찾을 수 없습니다.");
  check(
    !org.nodes.some((n) => n.parentId === before.id),
    "하위 조직이 있습니다. 하위 조직을 먼저 이동하거나 삭제해 주세요.",
  );
  check(
    !org.members.some((m) => m.unitId === before.id),
    "소속 구성원이 있습니다. 구성원을 먼저 이동하거나 삭제해 주세요.",
  );
  const region =
      before.reportRegion || (/구역/.test(before.type) ? before.name : ""),
    records = [
      ...(ws.people || []),
      ...(ws.activityLogs || []),
      ...(ws.findingReports || []),
      ...(ws.dailyReports || []),
      ...(ws.goals || []),
    ];
  for (const person of ws.people || [])
    records.push(
      ...(person.activities || []),
      ...(person.transitions || []),
      ...(person.introducerSnapshot ? [person.introducerSnapshot] : []),
    );
  check(
    !records.some(
      (r) =>
        r.areaId === before.id ||
        r.unitId === before.id ||
        (region && r.region === region),
    ),
    "기록·목표에 연결된 조직입니다. 연결 자료를 먼저 정리하거나 조직을 보관해 주세요.",
  );
  org.nodes.splice(org.nodes.indexOf(before), 1);
  validate(org, ws);
  ws.organization = org;
  return { before, after: null };
}
function removeMember(ws, p) {
  const org = structuredClone(get(ws)),
    member = org.members.find((m) => m.id === p.id);
  check(member, "구성원을 찾을 수 없습니다.");
  const records = [
    ...(ws.people || []),
    ...(ws.socialing?.pending || []),
    ...(ws.activityLogs || []),
    ...(ws.findingReports || []),
  ];
  for (const person of ws.people || [])
    records.push(...(person.activities || []), ...(person.transitions || []));
  check(
    !records.some(
      (r) =>
        r.introducerId === member.id ||
        r.memberId === member.id ||
        r.workerId === member.code ||
        r.memberCode === member.code ||
        r.introducerSnapshot?.code === member.code,
    ),
    "대상자·활동·일보에 연결된 구성원입니다. 연결 자료를 먼저 정리하거나 구성원을 보관해 주세요.",
  );
  const leadership = org.nodes
    .filter((n) => n.leaderId === member.id)
    .map((n) => ({ id: n.id, name: n.name, leaderId: n.leaderId }));
  for (const n of org.nodes)
    if (n.leaderId === member.id) {
      n.leaderId = "";
      n.updatedAt = stamp();
    }
  org.members.splice(org.members.indexOf(member), 1);
  validate(org, ws);
  ws.organization = org;
  return { before: { member, leadership }, after: null };
}
function assignClasses(ws, districtId, rows) {
  const org = structuredClone(get(ws)),
    district = org.nodes.find((n) => n.id === districtId);
  check(
    district && (district.reportRegion || /구역/.test(district.type)),
    "반을 지정할 구역을 선택하세요.",
  );
  check(
    Array.isArray(rows) && rows.length > 0 && rows.length <= 30000,
    "반을 지정할 구성원을 선택하세요.",
  );
  const seen = new Set(),
    changes = [];
  for (const row of rows) {
    check(!seen.has(row.memberId), "같은 구성원이 중복되었습니다.");
    seen.add(row.memberId);
    const m = org.members.find((m) => m.id === row.memberId);
    check(
      m && within(org, m.unitId, districtId),
      "선택한 구역 밖의 구성원은 변경할 수 없습니다.",
    );
    const className = K.resolve(
      ws,
      "className",
      row.className || "",
      m.className,
    );
    if (className === m.className) continue;
    changes.push({
      id: m.id,
      name: m.name,
      before: m.className,
      after: className,
    });
    m.className = className;
    m.updatedAt = stamp();
  }
  validate(org, ws);
  ws.organization = org;
  return changes;
}
function introducer(ws, value, existing) {
  const org = get(ws),
    key = value === undefined ? existing?.introducerId || "" : value;
  if (!key) return { introducerId: "", introducerSnapshot: null };
  const m = org.members.find((m) => m.id === id(key));
  check(m, "등록된 인도자를 선택해 주세요.");
  check(
    m.status === "active" || key === existing?.introducerId,
    "활동 중인 인도자를 선택해 주세요.",
  );
  if (existing?.introducerId === key && existing.introducerSnapshot) {
    const s = existing.introducerSnapshot;
    text(s.code, 60, true);
    text(s.name, 100, true);
    return {
      introducerId: key,
      introducerSnapshot: structuredClone(existing.introducerSnapshot),
    };
  }
  return {
    introducerId: key,
    introducerSnapshot: {
      code: m.code,
      name: m.name,
    },
  };
}
function importRows(ws, nodeRows, memberRows) {
  const org = structuredClone(get(ws)),
    nodeByCode = new Map(org.nodes.map((n) => [n.code, n])),
    memberByCode = new Map(org.members.map((m) => [m.code, m])),
    nodesSeen = new Set(),
    membersSeen = new Set(),
    pending = [];
  for (const r of nodeRows) {
    const key = text(r.code, 60, true);
    check(!nodesSeen.has(key), `조직ID가 중복됩니다: ${key}`);
    nodesSeen.add(key);
    const before = nodeByCode.get(key),
      after = nodeValue({ ...r, parentId: "", leaderId: "" }, before);
    replace(org.nodes, before, after);
    nodeByCode.set(key, after);
    pending.push([after, r]);
  }
  for (const [after, r] of pending) {
    after.parentId = r.parentCode ? nodeByCode.get(r.parentCode)?.id : "";
    check(
      after.parentId !== undefined,
      `상위 조직ID를 찾을 수 없습니다: ${r.parentCode}`,
    );
  }
  for (const r of memberRows) {
    const key = text(r.code, 60, true);
    check(!membersSeen.has(key), `구성원ID가 중복됩니다: ${key}`);
    membersSeen.add(key);
    const unit = nodeByCode.get(r.unitCode);
    check(unit, `소속 조직ID를 찾을 수 없습니다: ${r.unitCode}`);
    const before = memberByCode.get(key),
      after = memberValue({ ...r, unitId: unit.id }, before, ws);
    replace(org.members, before, after);
    memberByCode.set(key, after);
  }
  for (const [after, r] of pending) {
    after.leaderId = r.leaderCode ? memberByCode.get(r.leaderCode)?.id : "";
    check(
      after.leaderId !== undefined,
      `책임자 구성원ID를 찾을 수 없습니다: ${r.leaderCode}`,
    );
  }
  validate(org);
  const clean = (v) => JSON.stringify({ ...v, updatedAt: undefined });
  const changes = [];
  for (const kind of ["nodes", "members"])
    for (const value of org[kind]) {
      const before = get(ws)[kind].find((n) => n.id === value.id);
      if (before && clean(before) === clean(value))
        value.updatedAt = before.updatedAt;
      else
        changes.push({
          kind,
          before: before || null,
          after: structuredClone(value),
        });
    }
  ws.organization = org;
  return changes;
}
module.exports = {
  empty,
  get,
  validate,
  ancestors,
  within,
  pathName,
  regionOf,
  saveNode,
  saveMember,
  removeNode,
  removeMember,
  assignClasses,
  reportDimensions,
  introducer,
  importRows,
};
