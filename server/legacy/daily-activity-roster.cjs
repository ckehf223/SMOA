"use strict";

const normalize = (value) => String(value ?? "").normalize("NFC").replace(/\s/g, "");
const compiled = new WeakMap();

function ruleRows(text, headings, label) {
  if (typeof text !== "string" || text.length > 500000)
    throw new Error(label + "은 500000자 이내로 입력해 주세요.");
  const rows = [];
  for (const [i, line] of text.split(/\r\n?|\n/u).entries()) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const tab = line.includes("\t");
    const pipe = !tab && trimmed.includes("|");
    const cells = tab
      ? line.split("\t")
      : pipe
        ? trimmed.replace(/^\||\|$/gu, "").split("|")
        : trimmed.replace(/\s*(?:→|->)\s*/gu, " ").split(/\s+/u);
    const values = cells.map((cell) => cell.trim().normalize("NFC"));
    if (
      values.length === headings.length &&
      (values.every((value) => /^:?-+:?$/u.test(value)) ||
        values.every((value, index) => normalize(value) === headings[index]))
    )
      continue;
    if (
      values.length !== headings.length ||
      values.some((value) => !value || value.length > 100)
    )
      throw new Error(label + " " + (i + 1) + "행에 " + headings.join("·") + "을 입력해 주세요.");
    rows.push({ values, line: i + 1 });
  }
  return rows;
}

function uniqueRows(rows, label) {
  const seen = new Set();
  for (const { values, line } of rows) {
    const key = JSON.stringify(values.slice(0, 2).map(normalize));
    if (seen.has(key))
      throw new Error(label + " " + line + "행에 같은 항목이 두 번 있습니다.");
    seen.add(key);
  }
  return rows;
}

function resolveAliases(edges) {
  const result = new Map();
  for (const source of edges.keys()) {
    const chain = new Set();
    let key = source;
    let name;
    while (edges.has(key) && !result.has(key)) {
      if (chain.has(key))
        throw new Error("활동자 이름 변경이 서로 이어져 마지막 이름을 정할 수 없습니다.");
      chain.add(key);
      name = edges.get(key);
      const next = normalize(name);
      if (next === key) break;
      key = next;
    }
    if (result.has(key)) name = result.get(key);
    for (const previous of chain) result.set(previous, name);
  }
  return result;
}

function policyByDistrict(policy) {
  if (compiled.has(policy)) return compiled.get(policy);
  const districts = new Map();
  const districtRules = (district) => {
    const key = normalize(district);
    if (!districts.has(key))
      districts.set(key, { aliases: new Map(), excluded: new Set() });
    return districts.get(key);
  };
  for (const { district, oldName, name } of policy.aliases)
    districtRules(district).aliases.set(normalize(oldName), name);
  for (const rules of districts.values()) rules.aliases = resolveAliases(rules.aliases);
  for (const { district, name } of policy.excluded) {
    const rules = districtRules(district);
    const key = normalize(name);
    rules.excluded.add(normalize(rules.aliases.get(key) ?? key));
  }
  compiled.set(policy, districts);
  return districts;
}

function parseActivityRosterRules({ excludedText = "", aliasesText = "" } = {}) {
  const excludedLabel = "활동자 제외";
  const aliasesLabel = "활동자 이름 변경";
  const excluded = uniqueRows(
    ruleRows(excludedText, ["구역", "이름"], excludedLabel),
    excludedLabel,
  ).map(({ values: [district, name] }) => ({ district, name }));
  const aliases = uniqueRows(
    ruleRows(aliasesText, ["구역", "이전이름", "현재이름"], aliasesLabel),
    aliasesLabel,
  ).map(({ values: [district, oldName, name] }) => ({ district, oldName, name }));
  const policy = { excluded, aliases };
  policyByDistrict(policy);
  return policy;
}

function activityReportName(policy, district, name) {
  const rules = policy && policyByDistrict(policy).get(normalize(district));
  return rules?.aliases.get(normalize(name)) ?? name;
}

function isExcludedActivityMember(policy, district, name) {
  const rules = policy && policyByDistrict(policy).get(normalize(district));
  const key = normalize(name);
  return Boolean(rules?.excluded.has(normalize(rules.aliases.get(key) ?? key)));
}

module.exports = { parseActivityRosterRules, activityReportName, isExcludedActivityMember };
