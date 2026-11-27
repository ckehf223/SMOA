"use strict";
const M = require("./model.cjs"),
  O = require("./organization.cjs"),
  K = require("./codes.cjs");
const HEADERS = {
  "지역·구역": ["지역", "구역"],
  구성원명부: ["이름", "지역", "구역", "반"],
};
function apply(ws, rows, actor, duplicate) {
  let changed = 0,
    skipped = 0;
  const clean = (value) => {
    M.assert(
      value == null || ["string", "number", "boolean"].includes(typeof value),
      "셀의 표시 내용을 텍스트로 읽을 수 없습니다. 엑셀 입력값을 확인해 주세요.",
    );
    const result = String(value ?? "").trim();
    M.assert(
      result !== "[object Object]",
      "[object Object]는 올바른 입력값이 아닙니다. 원래 이름·지역·구역·반을 확인해 주세요.",
    );
    return result;
  };
  function node(name, type, parentId = "") {
    M.text(name, 60, true);
    const matches = O.get(ws).nodes.filter(
      (n) => n.name === name && n.parentId === parentId && n.type === type,
    );
    M.assert(matches.length <= 1, `${name}: 같은 소속의 조직이 여러 개입니다.`);
    if (matches.length) {
      M.assert(matches[0].active, `${name}: 보관된 조직입니다.`);
      return matches[0];
    }
    const area = O.get(ws).nodes.find((n) => n.id === parentId);
    const reportRegion =
      type === "구역"
        ? O.get(ws).nodes.some((n) => n.reportRegion === name)
          ? `${area.name} / ${name}`
          : name
        : "";
    const delta = O.saveNode(ws, {
      name,
      type,
      parentId,
      leaderTitle: type === "지역" ? "지역장" : "구역장",
      reportRegion,
    });
    M.audit(
      ws,
      actor,
      "간단 명부 조직 등록",
      delta.after.id,
      null,
      delta.after,
    );
    changed++;
    return delta.after;
  }
  function unit(row) {
    const area = node(clean(row.지역), "지역");
    return clean(row.구역) ? node(clean(row.구역), "구역", area.id) : area;
  }
  for (const { data, index } of rows["지역·구역"] || []) {
    try {
      const before = changed;
      const existing = unit(data);
      if (before === changed) {
        skipped++;
        duplicate?.("지역·구역", index, data, existing);
      }
    } catch (e) {
      throw new Error(`지역·구역 ${index}행: ${e.message}`);
    }
  }
  const seen = new Map();
  for (const { data, index } of rows["구성원명부"] || []) {
    try {
      const name = M.text(clean(data.이름), 100, true),
        orgUnit = unit(data);
      const key = JSON.stringify([orgUnit.id, name]);
      const first = seen.get(key);
      if (first)
        duplicate?.("구성원명부", index, data, first.data, {
          matchedRow: first.index,
          matchedSheet: "구성원명부",
          blocking: true,
          reason: "파일에서 같은 소속과 이름이 중복됩니다.",
        });
      M.assert(
        !seen.has(key),
        `${name}: 같은 소속의 이름이 파일 안에서 중복됩니다.`,
      );
      seen.set(key, { index, data });
      const members = O.get(ws).members.filter(
        (m) => m.unitId === orgUnit.id && m.name === name,
      );
      M.assert(
        members.length <= 1,
        `${name}: 소속까지 같은 동명이인은 앱에서 직접 확인해 주세요.`,
      );
      const before = members[0];
      let className = "";
      if (clean(data.반)) {
        try {
          className = K.resolve(
            ws,
            "className",
            clean(data.반),
            before?.className,
          );
        } catch {
          const delta = K.saveItem(ws, {
            groupId: "className",
            value: clean(data.반),
            label: clean(data.반),
          });
          M.audit(ws, actor, "간단 명부 반 등록", delta.after.id, null, {
            ...delta.after,
            groupId: delta.groupId,
          });
          className = delta.after.value;
        }
      }
      if (before && before.className === className) {
        skipped++;
        duplicate?.("구성원명부", index, data, before);
        continue;
      }
      const delta = O.saveMember(ws, {
        ...before,
        name,
        unitId: orgUnit.id,
        className,
      });
      M.audit(
        ws,
        actor,
        before ? "간단 명부 반 변경" : "간단 명부 구성원 등록",
        delta.after.member.id,
        delta.before,
        delta.after,
      );
      changed++;
    } catch (e) {
      throw new Error(`구성원명부 ${index}행: ${e.message}`);
    }
  }
  return { changed, skipped };
}
module.exports = { HEADERS, apply };
