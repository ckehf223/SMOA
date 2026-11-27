"use strict";
const Excel = require("exceljs");
const O = require("./organization.cjs");
const M = require("./model.cjs");
const { phoneKey } = require("./person-phone.cjs");
const { activityReportName, isExcludedActivityMember } = require("./daily-activity-roster.cjs");

const activityHeaders = ["부", "구역", "반", "이름", "활동여부"];
const format = "SMOA 구역 일보 정리본";
const findingHeaders = [
  "분류1(개척/지인/가족)",
  "분류2(노방/소셜링/온라인/세미나/기타)",
  "도구",
  "단계",
  "대상자",
  "성별",
  "나이",
  "연락처",
  "거주지",
  "찾기장소",
  "찾기시간",
  "지역",
  "  구역",
  "반",
  "인도자",
  "상담사",
  "찾B",
  "만픽",
  "찾A",
  "탈락",
  "탈락사유",
];
const updateHeaders = [
  ...findingHeaders.slice(0, 11),
  ...findingHeaders.slice(14),
  "합B",
  "합A\n(육따)",
  "영따",
  "복신",
  "신카접수",
  "센터등록",
  "입교",
];
const stageHeaders = new Map([
  ["만픽", "만픽"],
  ["찾A", "찾A"],
  ["합B", "합B"],
  ["합A", "합A\n(육따)"],
  ["영따", "영따"],
  ["복음방", "복신"],
  ["신카접수", "신카접수"],
  ["센터등록", "센터등록"],
  ["입교", "입교"],
]);
const normalize = (value) =>
  String(value ?? "")
    .normalize("NFC")
    .replace(/\s/g, "");
const districtKey = (value) => {
  const token = normalize(value);
  const number = /^(\d+)(?:구역)?$/u.exec(token);
  return number ? String(Number(number[1])) : token;
};
const nameBase = (value) => normalize(value).replace(/[A-Z]$/i, "");
const classValue = (value) => {
  const number = String(value || "").match(/^(\d+)\s*반?$/);
  return number ? Number(number[1]) : value || null;
};
const dateValue = (value) => (value ? new Date(`${value}T00:00:00Z`) : null);
function updateIdentity(values) {
  const raw = values.찾B;
  const date = typeof raw === "number"
    ? new Date(Date.UTC(1899, 11, 30) + Math.floor(raw) * 86400000)
    : raw;
  const found = date instanceof Date && Number.isFinite(date.valueOf())
    ? date.toISOString().slice(0, 10)
    : String(date ?? "").trim();
  return M.hash([normalize(values.대상자), normalize(values.인도자), found]);
}
function updateContactIdentity(values) {
  return M.hash([normalize(values.대상자), normalize(values.인도자), phoneKey(values.연락처)]);
}
const districtOf = (chain) =>
  [...chain]
    .reverse()
    .find((node) => node.reportRegion || /구역/.test(node.type));
const areaOf = (chain) =>
  [...chain].reverse().find((node) => /지역/.test(node.type)) ||
  (chain.length > 1 ? chain[0] : undefined);

function parseActivityOrder(text) {
  M.assert(
    typeof text === "string" && text.length <= 500000,
    "활동자 순서는 500000자 이내로 입력해 주세요.",
  );
  const lines = text.split(/\r\n?|\n/u);
  const order = [];
  const seen = new Set();

  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const isTabSeparated = line.includes("\t");
    const cells = isTabSeparated ? line.split("\t") : trimmed.split("|");
    if (!isTabSeparated) {
      if (cells.length > 4 && !cells[0]) cells.shift();
      if (cells.length > 4 && !cells.at(-1)) cells.pop();
    }
    const values = cells.map((value) => value.trim().normalize("NFC"));
    if (
      values.length === 4 &&
      (values.every((value) => /^:?-+:?$/u.test(value)) ||
        (["부", "지역", "부/지역", "지역/부"].includes(normalize(values[0])) &&
          normalize(values[1]) === "구역" &&
          normalize(values[2]) === "반" &&
          ["이름", "성명", "활동자명"].includes(normalize(values[3]))))
    )
      continue;

    const [part, district, className, name] =
      values.length === 1 ? ["", "", "", values[0]] : values;
    M.assert(
      (values.length === 1 || values.length === 4) &&
        !!name && values.every((value) => value.length <= 100),
      `활동자 순서 ${index + 1}행에 부·구역·반·이름 또는 이름만 입력해 주세요.`,
    );
    const key = JSON.stringify([part, district, classValue(className), name].map(normalize));
    M.assert(
      !seen.has(key),
      `활동자 순서 ${index + 1}행에 같은 항목이 두 번 있습니다.`,
    );
    seen.add(key);
    order.push({ part, district, className, name });
  }
  return order;
}

function orderActivityRows(rows, activityOrder, policy) {
  if (!activityOrder.length) return rows;
  const exact = new Map();
  const base = new Map();
  const add = (map, key, row) => {
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  };
  for (const row of rows) {
    add(exact, normalize(row[3]), row);
    add(base, nameBase(row[3]), row);
  }

  const ordered = new Set();
  for (const entry of activityOrder) {
    const name = normalize(activityReportName(policy, entry.district, entry.name));
    const part = normalize(entry.part);
    const district = normalize(entry.district);
    const className = normalize(classValue(entry.className));
    const matchesArea = (row) =>
      (!part || !row[0] || normalize(row[0]) === part) &&
      (!district || normalize(row[1]) === district);
    let matches = (exact.get(name) || []).filter(matchesArea);
    if (!matches.length && !/[A-Z]$/i.test(name))
      matches = (base.get(name) || []).filter(matchesArea);
    if (matches.length > 1 && className)
      matches = matches.filter(
        (row) => normalize(classValue(String(row[2] ?? ""))) === className,
      );
    if (matches.length === 1) ordered.add(matches[0]);
  }
  return [...ordered, ...rows.filter((row) => !ordered.has(row))];
}

function nameMatches(entries, name) {
  const exact = entries.filter(
    (entry) => normalize(entry.name) === normalize(name),
  );
  if (exact.length || /[A-Z]$/i.test(name)) return exact;
  return entries.filter((entry) => nameBase(entry.name) === normalize(name));
}

function activityRoster(members, policy, district) {
  if (!policy?.aliases.length) return members;
  const entries = members.map((member) => {
    const name = activityReportName(policy, district, member.name);
    return { member, name, renamed: normalize(name) !== normalize(member.name) };
  });
  const used = new Set(entries
    .filter(({ renamed }) => !renamed)
    .map(({ name }) => normalize(name)));

  return entries.flatMap(({ member, name, renamed }) => {
    if (renamed) {
      const key = normalize(name);
      // Prefer a current roster entry when both the old and current names exist.
      if (used.has(key)) return [];
      used.add(key);
    }
    return [name === member.name ? member : { ...member, name }];
  });
}

function classifications(change) {
  const method = normalize(change.method);
  const first = /가족/.test(method)
    ? "가족"
    : /지인/.test(method)
      ? "지인"
      : method
        ? "개척"
        : null;
  const second = /소셜링|동아리/.test(method)
    ? "소셜링"
    : /온라인|유튜브|유투브/.test(method)
      ? "온라인"
      : /세미나/.test(method)
        ? "세미나"
        : /여백|부트캠프|필모어|퓨어니스|노방/.test(method)
          ? "노방"
          : method
            ? "기타"
            : null;
  return [first, second];
}

function findingTime(value) {
  if (!value || typeof value === "number") return value || null;
  const clock = value.match(/^(\d{1,2}):(\d{2})$/);
  if (clock) return Number(clock[1]) + Number(clock[2]) / 60;
  return /^\d{1,2}(?:\.\d+)?$/.test(value) ? Number(value) : value;
}

function targetRow(
  workspace,
  change,
  report,
  reportArea,
  district,
  introducers,
) {
  const currentIntroducer = nameMatches(introducers, change.introducer);
  const intro = currentIntroducer.length === 1 ? currentIntroducer[0] : null;
  const introducerName = intro?.name || change.introducer;
  const isNew = change.status === "신규";
  const isFinding = isNew && change.stage === "찾B";
  const isDropout = change.status === "탈락";
  const foundDate = change.sourceFoundDate || (change.stage === "찾B" ? change.date : "");
  const districtKeys = [district?.name, district?.reportRegion, report.district]
    .map(districtKey)
    .filter(Boolean);
  let candidates =
    isFinding || !introducerName
      ? []
      : (workspace.people || []).filter((person) => {
          if (normalize(person.name) !== normalize(change.name)) return false;
          if (isNew && person.status === "dropped") return false;
          const linked = intro && person.introducerId === intro.id;
          if (intro && person.introducerId && !linked) return false;
          if (person.region ? !districtKeys.includes(districtKey(person.region)) : !linked)
            return false;
          return linked || [person.worker, person.introducerSnapshot?.name].some(
            (name) => normalize(name) === normalize(introducerName),
          );
        });
  if (candidates.length > 1) {
    const active = candidates.filter((person) => person.status !== "dropped");
    if (active.length) candidates = active;
  }
  const phone = phoneKey(change.phone);
  if (candidates.length > 1 && phone) {
    const byPhone = candidates.filter((person) => phoneKey(person.phone) === phone);
    if (byPhone.length) candidates = byPhone;
  }
  if (candidates.length > 1 && foundDate) {
    const byDate = candidates.filter((person) => person.date === foundDate);
    if (byDate.length) candidates = byDate;
  }
  const existing = candidates.length === 1 ? candidates[0] : undefined;
  const usesSlashFields = Object.hasOwn(change, "classification2");
  const [legacyFirst, legacySecond] = classifications(change);
  const first = usesSlashFields
    ? change.classification1 || null
    : existing?.classification1 || legacyFirst;
  const second = usesSlashFields
    ? change.classification2 || null
    : existing?.classification2 || legacySecond;
  const includesFindingDetails =
    change.customSlashLayout || !usesSlashFields || second === "노방";
  const includesCounselor =
    change.customSlashLayout || !usesSlashFields || !["찾B", "만픽"].includes(change.stage);
  const row = {
    [findingHeaders[0]]: first,
    [findingHeaders[1]]: second,
    도구: change.method || existing?.tool,
    단계: change.stage,
    대상자: change.name,
    성별:
      change.gender ||
      (existing?.gender === "미입력" ? null : existing?.gender),
    나이: change.age === "" ? existing?.age : change.age,
    연락처: change.phone || existing?.phone,
    거주지: change.residence || existing?.residence,
    찾기장소: includesFindingDetails ? change.place || existing?.place : null,
    찾기시간: includesFindingDetails ? findingTime(change.time || existing?.time) : null,
    지역: reportArea?.name,
    "  구역": district?.name || report.district,
    반: classValue(intro?.className),
    인도자: introducerName,
    상담사: includesCounselor ? change.teacher || existing?.teacher : null,
    탈락: isDropout ? dateValue(report.date) : null,
    탈락사유: isDropout ? change.reason : null,
  };
  const firstManpik = isNew && change.stage === "만픽" && candidates.length === 0;
  let actualFoundDate = existing?.date;
  if (isFinding) actualFoundDate = change.date;
  else if (firstManpik) actualFoundDate = change.date || report.date;
  else if (!existing && isDropout) actualFoundDate = foundDate;
  row.찾B = dateValue(actualFoundDate);
  if (!isFinding && !isDropout) {
    const heading = stageHeaders.get(change.stage);
    if (heading) row[heading] = dateValue(firstManpik ? actualFoundDate : report.date);
  }
  return { row, matchCount: candidates.length };
}

function collect(workspace, parsed, regionId = "", activityOrder = [], policy) {
  const { reports } = parsed;
  const warnings = [...parsed.warnings];
  M.assert(
    reports.length,
    warnings[0] || "구역 제목과 보고 날짜가 있는 일보를 입력하세요.",
  );
  const dates = new Set(reports.map((report) => report.date));
  M.assert(dates.size === 1, "한 번에 같은 날짜의 구역 일보를 입력하세요.");
  M.assert(
    new Set(reports.map((report) => normalize(report.district))).size ===
      reports.length,
    "같은 날짜의 구역 일보가 두 번 나왔습니다. 구역별 최신 일보를 한 번씩 입력하세요.",
  );
  const date = reports[0].date;
  const org = O.get(workspace);
  const districts = org.nodes.filter(
    (node) => node.active && (node.reportRegion || /구역/.test(node.type)),
  );
  const organizationAreas = org.nodes.filter(
    (node) => node.active && /지역/.test(node.type) && !/구역/.test(node.type),
  );
  const districtAreas = new Map(
    districts.map((node) => [
      node.id,
      areaOf(O.ancestors(org, node.id).slice(0, -1)),
    ]),
  );
  const matchedDistricts = (name) =>
    districts.filter((node) =>
      [node.name, node.reportRegion].some(
        (label) => normalize(label) === normalize(name),
      ),
    );
  const matchedAreas = new Set(
    reports.flatMap((report) =>
      matchedDistricts(report.district)
        .map((node) => districtAreas.get(node.id)?.id)
        .filter(Boolean),
    ),
  );
  const reportArea = regionId
    ? organizationAreas.find((node) => node.id === regionId)
    : matchedAreas.size === 1
      ? org.nodes.find((node) => matchedAreas.has(node.id))
      : organizationAreas.length === 1
        ? organizationAreas[0]
        : undefined;
  M.assert(!regionId || reportArea, "선택한 지역 조직을 찾을 수 없습니다.");
  M.assert(
    reportArea || matchedAreas.size <= 1,
    "같은 이름의 구역이 여러 지역에 있습니다. 지역을 선택하세요.",
  );

  const memberEntries = org.members
    .filter((member) => member.status === "active")
    .map((member) => ({
      ...member,
      district: districtOf(O.ancestors(org, member.unitId)),
    }));
  const activityRows = [],
    findingRows = [],
    updateRows = [],
    cumulativeChanges = [],
    activityDistricts = new Set(),
    activityLines = [],
    findANames = [];
  const seenChanges = new Set();
  let activeCount = 0;

  for (const report of [...reports].sort((a, b) =>
    a.district.localeCompare(b.district, "ko", { numeric: true }),
  )) {
    const matches = matchedDistricts(report.district).filter(
      (node) => !reportArea || districtAreas.get(node.id)?.id === reportArea.id,
    );
    M.assert(
      matches.length < 2,
      `${report.district}에 일치하는 조직이 여러 개입니다.`,
    );
    const district = matches[0];
    if (report.hasActivityReport || report.activities.length)
      activityDistricts.add(district?.name || report.district);
    const members = district
      ? memberEntries.filter((member) => member.district?.id === district.id)
      : [];
    const roster = activityRoster(members, policy, report.district);
    const excluded = (name) => isExcludedActivityMember(policy, report.district, name);
    const statuses = new Map();
    const reportedNames = new Set();
    const unlistedActivities = new Map();
    for (const activity of report.activities) {
      if (excluded(activity.name)) continue;
      const name = activityReportName(policy, report.district, activity.name);
      const matching = nameMatches(roster, name);
      if (matching.length && matching.every((member) => excluded(member.name)))
        continue;
      if (matching.length === 1) {
        const member = matching[0];
        statuses.set(
          member.id,
          Math.min(statuses.get(member.id) ?? 4, activity.status),
        );
        if (activity.status < 4) reportedNames.add(member.name);
      } else {
        if (activity.status < 4) reportedNames.add(name);
        if (!matching.length)
          unlistedActivities.set(
            name,
            Math.min(unlistedActivities.get(name) ?? 4, activity.status),
          );
        if (members.length)
          warnings.push(
            `${report.district} ${name} · ${matching.length ? "동명이인" : "활동자 명부 일치 없음"}`,
          );
      }
    }
    if (!members.length && (!report.activities.length || unlistedActivities.size))
      warnings.push(
        `${report.district} 명부가 없어 일보에 나온 이름과 활동여부만 기록했습니다.`,
      );
    activeCount += reportedNames.size;
    const displayDistrict = report.district.replace(/\s*구역$/, "");
    activityLines.push(
      `${displayDistrict}${reportedNames.size ? " " + [...reportedNames].join(" ") : ""}`,
    );
    for (const member of roster) {
      if (excluded(member.name)) continue;
      const status = statuses.get(member.id) ?? 4;
      activityRows.push([
        reportArea?.name,
        district.name,
        classValue(member.className),
        member.name,
        status,
      ]);
    }
    for (const [name, status] of unlistedActivities)
      activityRows.push([
        reportArea?.name,
        district?.name || report.district,
        null,
        name,
        status,
      ]);

    for (const change of report.changes) {
      const key = JSON.stringify([
        report.district,
        change.status,
        change.stage,
        change.date,
        normalize(change.name),
        normalize(change.introducer),
      ]);
      if (seenChanges.has(key)) {
        warnings.push(
          `${report.district} ${change.name} · 동일한 ${change.stage} ${change.status} 행을 한 번만 기록했습니다.`,
        );
        continue;
      }
      seenChanges.add(key);
      const { row, matchCount } = targetRow(
        workspace,
        change,
        report,
        reportArea,
        district,
        members,
      );
      cumulativeChanges.push({
        district: report.district,
        worker: change.introducer,
        status: change.status,
        detailDate: change.date,
        explicitPhone: change.phone,
        row,
      });
      if (!row.인도자)
        warnings.push(`${report.district} ${change.name} · 인도자 미기입`);
      if (matchCount > 1)
        warnings.push(
          `${report.district} ${change.name} · 자료실에서 같은 대상자 정보가 여러 건과 일치합니다.`,
        );
      if (!matchCount && !row.찾B && change.status === "탈락" && !["찾B", "만픽"].includes(change.stage))
        warnings.push(
          `${report.district} ${change.name} · 자료실에서 일치하는 기존 대상자를 찾지 못했습니다.`,
        );
      if (change.status === "신규" && change.stage === "찾B")
        findingRows.push(row);
      else updateRows.push(row);
      if (change.status === "신규" && change.stage === "찾A")
        findANames.push(change.name);
    }
  }
  const leaderDistrict = "지역장가편";
  const leader = memberEntries.find(
    (member) =>
      reportArea?.leaderId === member.id &&
      (!member.district || normalize(member.district.name) === leaderDistrict),
  );
  if (leader && !isExcludedActivityMember(policy, leaderDistrict, leader.name)) {
    const name = activityReportName(policy, leaderDistrict, leader.name);
    if (!activityRows.some((row) =>
      normalize(row[1]) === leaderDistrict && normalize(row[3]) === normalize(name))) {
      activityRows.unshift([
        reportArea.name,
        leaderDistrict,
        classValue(leader.className),
        name,
        1,
      ]);
      activityLines.unshift(name);
      activeCount++;
      if (activityDistricts.size) activityDistricts.add(leaderDistrict);
    }
  }
  const [year, month, day] = date.split("-").map(Number);
  const weekday = "일월화수목금토"[
    new Date(Date.UTC(year, month - 1, day)).getUTCDay()
  ];
  const summary = [
    `${month}/${day} (${weekday}) 전도 일일 보고 현황`,
    `- 활동자수 ${activeCount}명`,
  ];
  if (findANames.length)
    summary.push(`신규 찾A ${findANames.length}명 (${findANames.join(", ")})`);

  return {
    date,
    activityRows: orderActivityRows(activityRows, activityOrder, policy),
    findingRows,
    updateRows,
    cumulativeChanges,
    activityDistricts,
    summary: [
      summary.join("\n"),
      [`활동자 ${activeCount}명`, ...activityLines].join("\n"),
    ],
    warnings: [...new Set(warnings)],
    counts: {
      활동자: activeCount,
      찾기: findingRows.length,
      업데이트: updateRows.length,
    },
  };
}

function writeRows(sheet, headers, rows) {
  sheet.addRow(headers);
  sheet.getRow(1).font = { name: "맑은 고딕", size: 11, bold: true };
  sheet.getRow(1).alignment = { vertical: "middle", wrapText: true };
  sheet.getRow(1).height = 31;
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  sheet.autoFilter = {
    from: "A1",
    to: sheet.getRow(1).getCell(headers.length).address,
  };
  for (const values of rows) {
    const row = sheet.addRow(values);
    row.font = { name: "맑은 고딕", size: 11 };
    row.alignment = { vertical: "middle" };
    row.eachCell((cell) => {
      if (cell.value instanceof Date) cell.numFmt = "yyyy-mm-dd";
    });
  }
}

function updateDistrictMap(rows, identity) {
  const districts = new Map();
  for (const row of rows) {
    const district = row["  구역"];
    if (!district) continue;
    const key = identity(row);
    if (!districts.has(key)) districts.set(key, district);
    else if (districts.get(key) !== district) districts.set(key, null);
  }
  return Object.fromEntries(districts);
}

async function workbook(result) {
  const file = new Excel.Workbook();
  file.description = JSON.stringify({
    format,
    date: result.date,
    activityDistricts: result.activityDistricts && [...result.activityDistricts],
    updateDistricts: updateDistrictMap(result.updateRows, updateIdentity),
    updateDistrictsByContact: updateDistrictMap(result.updateRows, updateContactIdentity),
  });
  const activity = file.addWorksheet("활동자");
  writeRows(
    activity,
    activityHeaders,
    result.activityRows,
  );
  [12, 16, 7, 14, 13].forEach((width, offset) => {
    activity.getColumn(offset + 1).width = width;
  });
  activity.eachRow((row) => {
    row.alignment = { horizontal: "center", vertical: "middle" };
  });
  for (const [name, headers, rows] of [
    ["찾기", findingHeaders, result.findingRows],
    ["업데이트", updateHeaders, result.updateRows],
  ]) {
    const sheet = file.addWorksheet(name);
    writeRows(
      sheet,
      headers,
      rows.map((row) => headers.map((header) => row[header] ?? null)),
    );
    headers.forEach((header, offset) => {
      sheet.getColumn(offset + 1).width =
        offset < 2 ? 23 : header === "탈락사유" ? 22 : 14;
    });
  }
  const summary = file.addWorksheet("활동자보고");
  summary.addRows([["요약보고", "활동자"], result.summary]);
  summary.getColumn(1).width = 46.664;
  summary.getColumn(2).width = 52.5;
  summary.getRow(2).height = Math.max(
    58,
    17 * (result.summary[1].split("\n").length + 1),
  );
  summary.eachRow((row) => {
    row.font = { name: "맑은 고딕", size: 11 };
    row.alignment = { vertical: "top", wrapText: true };
  });
  summary.getRow(1).font = { name: "맑은 고딕", size: 11, bold: true };
  return Buffer.from(await file.xlsx.writeBuffer());
}

module.exports = {
  collect, workbook, parseActivityOrder, orderActivityRows,
  activityHeaders, findingHeaders, updateHeaders, updateIdentity, updateContactIdentity, format,
};
