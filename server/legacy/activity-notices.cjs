"use strict";
const M = require("./model.cjs"),
  O = require("./organization.cjs"),
  K = require("./codes.cjs"),
  Clock = require("./clock.cjs");
const HEADERS = [
  "날짜",
  "활동자",
  "활동장소",
  "시작시간",
  "종료시간",
  "활동종류",
  "활동메모",
];
const firstPlace = (s) =>
  String(s || "")
    .split(/[,，]/)[0]
    .trim();
const cleanName = (s) =>
  String(s || "")
    .replace(/01[016789][- ]?\d{3,4}[- ]?\d{4}/g, "")
    .replace(/\([^)]*\)/g, "")
    .replace(/^[-\s]+/, "")
    .trim();
function range(value, parent) {
  if (!value) return parent ? [parent.start, parent.end] : ["", ""];
  const parts = value.trim().split(/\s*[-~–—]\s*/);
  M.assert(parts.length <= 2, "활동 시간 구간을 확인하세요.");
  const parse = (s) => (s ? Clock.parseClock(s.trim()) : "");
  return [
    parse(parts[0]) || parent?.start || "",
    parts.length === 2
      ? parse(parts[1]) || parent?.end || ""
      : parent?.end || "",
  ];
}
function preview(ws, text, context = {}) {
  M.text(text, 1000000);
  const date = M.date(context.date),
    org = O.get(ws),
    kind = K.label(
      ws,
      "activityKind",
      context.activityKind || K.preferred(ws, "activityKind", "적극적 활동"),
    ),
    warnings = [],
    errors = [],
    activityRows = [],
    sessions = [];
  let current = null,
    extra = false,
    lineNo = 0;
  const extraRows = [];
  const person = (name, region) => {
    const all = org.members.filter((m) => m.name === name),
      local = all.filter((m) => O.regionOf(org, m.unitId) === region),
      m = local.length === 1 ? local[0] : all.length === 1 ? all[0] : null;
    if (!m) {
      warnings.push(
        `${name}: 명부 연결을 확인하세요.${all.length > 1 ? " 동명이인은 구역·소속으로 구분해야 합니다." : ""}`,
      );
      return {
        name,
        key: JSON.stringify([name, region]),
        exportName: name,
        region,
      };
    }
    if (region && O.regionOf(org, m.unitId) !== region)
      warnings.push(
        `${name}: 공지의 ${region}과 명부 소속이 다릅니다. 가져올 때 명부 소속을 사용합니다.`,
      );
    return {
      name: m.name,
      key: m.code,
      exportName:
        all.length > 1 ? `${m.name} · ${O.pathName(org, m.unitId)}` : m.name,
      region: region || O.regionOf(org, m.unitId),
    };
  };
  const add = (session, name, region, time, place) => {
    const p = person(name, region),
      [start, end] = range(time, session);
    const row = {
      날짜: date,
      활동자: p.exportName,
      활동장소: firstPlace(place || session?.place),
      시작시간: start,
      종료시간: end,
      활동종류: kind,
      활동메모: "",
      _name: p.name,
      _key: p.key,
      _타임: session?.label || "그외 활동",
      회차ID: session
        ? `AP-${M.hash([date, session.label, session.start, session.end, session.place]).slice(0, 32)}`
        : "",
    };
    if (Boolean(start) !== Boolean(end))
      warnings.push(
        `${name}: 시작 또는 종료 시각이 미입력입니다. 알려진 시각만 보관하고 순활동시간은 미기록으로 처리합니다.`,
      );
    if (session) session.rows.push(row);
    else extraRows.push(row);
  };
  for (const raw of text.split(/\r?\n/)) {
    lineNo++;
    const line = raw.trim();
    if (!line) continue;
    try {
      const header = line.match(/타임\s*활동\s*\(([^)]+)\)\s*[/／]\s*(.+)/);
      if (header) {
        const [start, end] = range(header[1]);
        M.assert(
          start && end && M.minutes(start, end) > 0,
          "회차의 시작·종료 시각을 입력하세요.",
        );
        current = {
          label: `${sessions.length + 1}타임`,
          start,
          end,
          place: firstPlace(header[2]),
          leader: "",
          rows: [],
        };
        sessions.push(current);
        extra = false;
        continue;
      }
      if (/그\s*외\s*활동/.test(line)) {
        current = null;
        extra = true;
        continue;
      }
      const leader = line.match(/주관자\s*[:：]\s*(.+)/);
      if (leader) {
        M.assert(current, "주관자 앞에 타임 활동 시간을 입력하세요.");
        current.leader = cleanName(leader[1]);
        continue;
      }
      const district = line.match(/^\s*(\d+구역)\s*[/／]\s*(.+)$/);
      if (!district) continue;
      const region = district[1],
        body = district[2];
      if (region === "0구역" || /^이름(?:[/／]|$)/.test(body)) continue;
      if (extra) {
        const parts = body.split(/[/／]/).map((s) => s.trim()),
          p = parts[0].match(/^([^()]+)(?:\(([^)]+)\))?$/);
        M.assert(p, "그외 활동의 이름과 시간을 확인하세요.");
        const name = p[1].trim(),
          time = p[2] || (parts.length >= 3 ? parts[1] : ""),
          place = parts.length >= 3 ? parts.slice(2).join("/") : parts[1];
        add(null, name, region, time, place);
      } else {
        M.assert(current, "참여자 앞에 타임 활동 시간을 입력하세요.");
        let consumed = "";
        const re = /([^\s(),/]+)\s*(?:\(([^()]*)\))?/g;
        for (const match of body.matchAll(re)) {
          if (/^\d/.test(match[1])) continue;
          add(current, match[1], region, match[2] || "", current.place);
          consumed += match[0];
        }
        M.assert(consumed, "활동자 이름을 확인하세요.");
      }
    } catch (e) {
      errors.push(`${lineNo}줄: ${e.message}`);
    }
  }
  for (const session of sessions) {
    if (session.leader) {
      const candidates = session.rows.filter((r) => r._name === session.leader);
      if (new Set(candidates.map((r) => r._key)).size > 1)
        errors.push(`${session.label}: 주관자 동명이인을 구분하세요.`);
      else if (candidates.length)
        candidates.forEach((r) => (r.활동메모 = "주관자"));
      else {
        const before = session.rows.length;
        add(session, session.leader, "", "", session.place);
        session.rows[before].활동메모 = "주관자";
      }
    }
    const seen = new Set();
    for (const r of session.rows) {
      const key = JSON.stringify([r._key, r.시작시간, r.종료시간, r.활동메모]);
      if (seen.has(key)) continue;
      seen.add(key);
      activityRows.push(r);
    }
  }
  activityRows.push(...extraRows);
  const reportToken = text.match(/^(?:\D*)(\d{2})(\d{2})(\d{2})\s*\(/u);
  if (reportToken && `${reportToken[2]}-${reportToken[3]}` !== date.slice(5))
    warnings.push(
      `공지의 월일(${reportToken[2]}/${reportToken[3]})과 선택한 보고일이 다릅니다. 선택한 보고일로 저장하므로 날짜를 확인하세요.`,
    );
  if (!activityRows.length && !errors.length)
    errors.push(
      "변환할 활동 기록이 없습니다. 타임 제목과 구역/이름 형식을 확인하세요.",
    );
  M.assert(
    activityRows.length <= 10000,
    "한 번에 10,000행까지 변환할 수 있습니다.",
  );
  return {
    date,
    region: "전체구역",
    activityRows,
    findings: [],
    activities: [],
    errors,
    warnings: [...new Set(warnings)],
    counts: {
      "활동 기록": activityRows.length,
      타임: sessions.length,
      "주관 기록": activityRows.filter((r) => r.활동메모 === "주관자").length,
      "시간 미입력": activityRows.filter((r) => !r.시작시간 || !r.종료시간)
        .length,
    },
  };
}
async function workbook(rows) {
  const E = require("exceljs"),
    w = new E.Workbook(),
    s = w.addWorksheet("활동기록", { views: [{ state: "frozen", ySplit: 1 }] });
  s.addRow([...HEADERS, "회차ID"]);
  for (const r of rows)
    s.addRow([
      ...HEADERS.map((h) =>
        h === "날짜" ? new Date(r[h] + "T00:00:00Z") : r[h],
      ),
      r.회차ID,
    ]);
  s.columns.forEach((c) => (c.width = 20));
  s.getColumn(1).numFmt = "yyyy-mm-dd";
  s.getColumn(8).hidden = true;
  s.getRow(1).font = {
    name: "맑은 고딕",
    bold: true,
    color: { argb: "FFFFFFFF" },
  };
  s.getRow(1).eachCell(
    (c) =>
      (c.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FF194B3B" },
      }),
  );
  s.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: rows.length + 1, column: 8 },
  };
  return Buffer.from(await w.xlsx.writeBuffer());
}
async function archive(root, result, protectedDirectory) {
  const bytes = await workbook(result.activityRows);
  return require("./daily-changes.cjs").archive(
    root,
    { ...result, newRows: [], updateRows: [] },
    protectedDirectory,
    [{ kind: "activity", title: "활동 기록", bytes }],
  );
}
module.exports = { HEADERS, preview, workbook, archive };
