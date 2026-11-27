"use strict";

const M = require("./model.cjs");
const O = require("./organization.cjs");
const RegionalActivity = require("./regional-activity.cjs");
const { addIssue, CANDIDATE_LIMIT, inputFields, issueFields } = require("./daily-area-import-issues.cjs");
const {
  parseActivityRosterRules,
  activityReportName,
  isExcludedActivityMember,
} = require("./daily-activity-roster.cjs");

const LEADER_DISTRICT = "지역장가편";
const compact = (value) =>
  String(value ?? "")
    .normalize("NFC")
    .replace(/\s/gu, "");
const classKey = (value) => compact(value).replace(/^(\d+)반$/u, "$1");
const nameBase = (value) => value.replace(/[A-Z]$/iu, "");
const isDistrict = (node) => node.reportRegion || /구역/u.test(node.type);
const isArea = (node) => /지역/u.test(node.type) && !/구역/u.test(node.type);

function rosterIndex(workspace) {
  const organization = O.get(workspace);
  const leaders = new Map();
  for (const node of organization.nodes) {
    if (!node.active || !isArea(node) || !node.leaderId) continue;
    if (!leaders.has(node.leaderId)) leaders.set(node.leaderId, []);
    leaders.get(node.leaderId).push(node.name);
  }
  const byDistrict = new Map();
  const paths = new Map();
  const add = (district, entry) => {
    const key = compact(district);
    if (!key) return;
    if (!byDistrict.has(key)) byDistrict.set(key, []);
    byDistrict.get(key).push(entry);
  };
  for (const member of organization.members) {
    if (member.status !== "active") continue;
    if (!paths.has(member.unitId))
      paths.set(member.unitId, O.ancestors(organization, member.unitId));
    const path = paths.get(member.unitId);
    if (path.some((node) => !node.active)) continue;
    const districtIndex = path.findLastIndex(isDistrict);
    const district = path[districtIndex];
    const scope = district ? path.slice(0, districtIndex) : path;
    const areas = scope.filter(isArea).map((node) => compact(node.name));
    if (scope.length && !areas.length) areas.push(compact(scope[0].name));
    if (district) {
      const labels = [
        ...new Set(
          [district.name, district.reportRegion].filter(Boolean).map(compact),
        ),
      ];
      const entry = { member, areas, labels };
      for (const label of labels) add(label, entry);
    }
    const leaderAreas = leaders.get(member.id);
    if (
      leaderAreas &&
      (!district || compact(district.name) === LEADER_DISTRICT)
    ) {
      const alreadyIndexedAsLeader =
        district &&
        [district.name, district.reportRegion].some(
          (label) => compact(label) === LEADER_DISTRICT,
        );
      if (!alreadyIndexedAsLeader)
        add(LEADER_DISTRICT, {
          member,
          areas: leaderAreas.map(compact),
          labels: [LEADER_DISTRICT],
        });
    }
  }
  return byDistrict;
}

function resolvedNames(policy, labels, name) {
  const original = compact(name);
  const aliases = new Set(
    labels.map((label) => compact(activityReportName(policy, label, name))),
  );
  aliases.delete(original);
  return aliases.size ? aliases : new Set([original]);
}

function resolveMember(index, policy, { area, district, className, name }) {
  const entries = (index.get(district) || []).filter(
    ({ areas, member }) =>
      (!area || areas.includes(area)) &&
      (!className || classKey(member.className) === className),
  );
  const labels = [
    ...new Set([district, ...entries.flatMap((entry) => entry.labels)]),
  ];
  if (labels.some((label) => isExcludedActivityMember(policy, label, name)))
    return { excluded: true };

  const expected = resolvedNames(policy, labels, name);
  const exact = [];
  const alias = [];
  const suffix = [];
  let excluded = false;
  for (const { member, labels } of entries) {
    const actual = compact(member.name);
    const names = resolvedNames(policy, labels, member.name);
    const matching = [...names].some((item) => expected.has(item));
    const matchingSuffix = [...names].some((item) =>
      [...expected].some(
        (given) => given === nameBase(given) && nameBase(item) === given,
      ),
    );
    if (!expected.has(actual) && !matching && !matchingSuffix) continue;
    if (
      labels.some((label) =>
        isExcludedActivityMember(policy, label, member.name),
      )
    ) {
      excluded = true;
      continue;
    }
    if (expected.has(actual)) exact.push(member);
    else if (matching) alias.push(member);
    else suffix.push(member);
  }
  const members = exact.length ? exact : alias.length ? alias : suffix;
  return { members, excluded: !members.length && excluded };
}

function activityStatus(code) {
  return `${code} · ${RegionalActivity.LABELS[code]}`;
}

function activityCodeText(value) {
  if (typeof value === "number") return String(value);
  return typeof value === "string" ? value.trim() : "";
}

function applyActivity(draft, { activity, date, activityDistricts }, actor) {
  const errors = [];
  const warnings = [];
  const issues = [];
  const details = [];
  const counts = {
    "활동 신규": 0,
    "활동 수정": 0,
    "활동 변경 없음": 0,
    "활동 중복 건너뜀": 0,
    "활동 확인 필요": 0,
    "활동 제외": 0,
  };
  const result = { counts, errors, warnings, issues, details };
  const recordOutcome = ({ row, values }, outcome, message, context = {}) => {
    counts[outcome]++;
    details.push({
      sheet: "활동자", row, outcome, message, values, date, ...context,
    });
  };
  if (!activity.length) return result;
  const selected =
    activityDistricts === undefined
      ? null
      : new Set(activityDistricts.map(compact));
  if (selected?.size === 0) {
    for (const input of activity)
      recordOutcome(input, "활동 제외", "이 파일에 활동 보고 구역이 없어 제외했습니다.");
    return result;
  }
  const roster = rosterIndex(draft);
  const policy = parseActivityRosterRules(draft.dailyActivityRosterRules);
  const existing = new Map(
    (draft.regionalActivities || [])
      .filter((entry) => entry.date === date)
      .map((entry) => [entry.memberId, entry.code]),
  );
  const candidates = new Map();
  const describeMembers = (members) => {
    if (!members.length) return {};
    return {
      candidates: members.slice(0, CANDIDATE_LIMIT).map((member) => ({
        fields: issueFields([
          ["이름", member.name],
          ["반", member.className],
          ["기존 활동여부", existing.has(member.id) ? activityStatus(existing.get(member.id)) : ""],
        ]),
      })),
      totalCandidates: members.length,
    };
  };
  const reportRows = [];
  const defaultRows = [];
  for (const input of activity) {
    const { 구역, 활동여부 } = input.values;
    if (selected && !selected.has(compact(구역)) && activityCodeText(활동여부) === "4")
      defaultRows.push(input);
    else reportRows.push(input);
  }
  // A district can appear under two labels. Explicit reports take precedence over defaults.
  for (const input of [...reportRows, ...defaultRows]) {
    const { row, values } = input;
    const location = `활동자 ${row}행`;
    const recordIssue = (severity, message, summary, context = {}) => {
      addIssue(issues, {
        sheet: "활동자",
        row,
        severity,
        message,
        summary,
        fields: inputFields("활동자", values, { date }),
        ...context,
      });
    };
    try {
      const district = compact(M.text(values.구역 ?? "", 60, true));
      const outsideReport = selected && !selected.has(district);
      const codeText = activityCodeText(values.활동여부);
      if (outsideReport && codeText !== "4") {
        recordOutcome(input, "활동 제외", "이 파일의 활동 보고 구역에 포함되지 않아 제외했습니다.");
        continue;
      }
      const name = M.text(values.이름 ?? "", 100, true);
      const area = compact(M.text(values.부 ?? "", 60));
      const classValue = values.반 ?? "";
      const className = classKey(
        typeof classValue === "number"
          ? String(classValue)
          : M.text(classValue, 60),
      );
      M.assert(
        /^[1-4]$/u.test(codeText),
        "활동여부에 1~4 중 하나를 입력해 주세요.",
      );
      const code = Number(codeText);
      const resolved = resolveMember(roster, policy, {
        area,
        district,
        className,
        name,
      });
      if (resolved.excluded) {
        recordOutcome(input, "활동 제외", "자료실의 활동자 제외 목록에 등록되어 있습니다.");
        continue;
      }
      if (resolved.members.length !== 1) {
        const message = resolved.members.length
          ? "명부에서 일치하는 구성원이 여러 명입니다."
          : "지정한 구역과 반의 활동 명부에서 일치하는 구성원을 찾지 못했습니다.";
        const summary = `${location}: ${name} · ${message}`;
        warnings.push(summary);
        const matched = !resolved.members.length && className
          ? resolveMember(roster, policy, { area, district, className: "", name }).members
          : resolved.members;
        const context = describeMembers(matched);
        recordOutcome(input, "활동 확인 필요", message, context);
        recordIssue("warning", message, summary, context);
        continue;
      }
      const [member] = resolved.members;
      const memberId = member.id;
      const previous = candidates.get(memberId);
      if (previous) {
        if (outsideReport && previous.code !== code) {
          recordOutcome(
            input, "활동 제외", `보고 구역의 ${previous.row}행에 적힌 활동 상태를 우선 반영합니다.`,
          );
          continue;
        }
        M.assert(
          previous.code === code,
          `${previous.row}행과 같은 구성원의 활동여부가 다릅니다.`,
        );
        recordOutcome(
          input, "활동 중복 건너뜀", `같은 구성원과 활동 상태가 ${previous.row}행에 있어 건너뜁니다.`,
        );
        continue;
      }
      const context = describeMembers([member]);
      if (outsideReport && existing.has(memberId) && existing.get(memberId) !== code) {
        recordOutcome(
          input, "활동 제외", "보고일에 이미 저장된 활동 상태를 우선합니다.", context,
        );
        continue;
      }
      candidates.set(memberId, { memberId, code, row });
      const after = issueFields([["활동여부", activityStatus(code)]]);
      if (!existing.has(memberId))
        recordOutcome(input, "활동 신규", outsideReport
          ? "보고일 기록이 없어 엑셀에 입력된 비활동 상태를 추가합니다."
          : "보고일에 활동 기록을 새로 추가합니다.", {
          ...context, after,
        });
      else if (existing.get(memberId) === code)
        recordOutcome(input, "활동 변경 없음", "보고일에 같은 활동 상태가 이미 저장되어 있습니다.", context);
      else
        recordOutcome(input, "활동 수정", "보고일에 이미 저장된 활동 상태를 수정합니다.", {
          ...context, after,
        });
    } catch (error) {
      const summary = `${location}: ${error.message}`;
      errors.push(summary);
      recordIssue("error", error.message, summary);
    }
  }
  if (!errors.length && (counts["활동 신규"] || counts["활동 수정"])) {
    try {
      RegionalActivity.saveMany(
        draft,
        { date, rows: [...candidates.values()] },
        actor,
      );
    } catch (error) {
      errors.push(`활동자: ${error.message}`);
    }
  }
  return result;
}

module.exports = { applyActivity };
