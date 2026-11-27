"use strict";
// The daily workflow consumes preconfigured organization data; it never creates members or codes.
const M = require("./model.cjs"),
  O = require("./organization.cjs"),
  K = require("./codes.cjs"),
  Milestones = require("./ui/person-milestones.js");
const HEADERS = {
  활동일보: ["활동일", "구역", "활동자", "시작", "종료", "활동ID"],
  찾기일보: [
    "보고일",
    "구역",
    "단계",
    "구분",
    "찾은날짜",
    "도구",
    "대상자",
    "성별",
    "나이",
    "거주지",
    "찾기장소",
    "찾기시간",
    "인도자",
    "대상자ID",
  ],
};
const GUIDE = [
  [
    "활동·찾기 일보 입력",
    "조직·구역원·반·단계는 프로그램에서 미리 설정합니다. 입력 시트는 활동일보와 찾기일보 두 개입니다.",
  ],
  [
    "활동일보",
    "한 사람의 날짜·시간 구간당 한 행. 활동자는 등록된 이름으로 선택·연결합니다. 여러 날짜와 여러 구간을 입력할 수 있습니다.",
  ],
  [
    "순활동시간",
    "괄호로 입력한 각 구간의 시작~종료 시간을 그대로 합산합니다. 활동일·시작·종료 시각을 모두 보관합니다. 자정이 지나면 익일 종료입니다. 겹친 구간은 오류로 표시합니다.",
  ],
  [
    "찾기일보",
    "대상자는 찾은날짜·도구·대상자·성별·나이·거주지·찾기장소·찾기시간·인도자 9개 항목을 보관합니다. 보고일과 구역은 화면에서 선택합니다. 기존 일보의 제목과 상태 구분을 읽습니다.",
  ],
  [
    "구성원 연결",
    "활동자와 인도자는 미리 등록한 명부에서 연결합니다. 동명이인은 검토 표의 구성원 목록에서 선택합니다. 반은 인도자의 등록 정보를 사용합니다.",
  ],
  [
    "식별번호 · 자동 생성",
    "활동ID와 대상자ID는 프로그램이 자동 생성·관리합니다. 직접 입력하지 않아도 됩니다. 변환한 파일의 번호는 다시 가져올 때 중복을 방지하는 데 사용합니다.",
  ],
  [
    "시간·빈칸",
    "날짜 YYYY-MM-DD, 시각은 17, 17:00, 1700, 1710 또는 17시로 입력할 수 있습니다. 1710은 17:10으로 저장합니다. 모르는 대상자 항목은 빈칸으로 보관합니다.",
  ],
  [
    "신규·유지·탈락",
    "보고일의 상태를 그대로 보관합니다. 최초 창출은 대상자마다 찾은날짜에 한 번 집계합니다. 매일 반복된 유지 건수를 신규로 더하지 않습니다.",
  ],
  [
    "다시 가져오기",
    "같은 일보는 중복 반영하지 않습니다. 같은 보고일·대상자의 내용이 달라지면 자동 덮어쓰지 않고 오류를 표시합니다. 과거 일보는 날짜순으로 반영하세요.",
  ],
  [
    "사용 순서",
    "날짜·구역 선택 → 원문 붙여넣기 → 변환 확인 → 날짜별 엑셀 보관 → 엑셀 가져오기 → 전체 반영. 보관 폴더/날짜/구역.xlsx로 나눠 저장합니다.",
  ],
];
const SAMPLE = `2026-11-03 일보
10구역
활동자 : 차재경(19:00-20:10), 선유리(17:00-19:00)

찾기 건수
찾B
10/31 여백 예시대상가 남 25 제기동 천호 23시 차재경 신규
10/27 여백 예시대상나 남 24 미사 미사 14시 차재경 유지
10/22 여백 예시대상다 여 20 암사 암사 20시 선유리 탈락
찾A
신규
유지
탈락`;
const key = (...v) => M.hash(v).slice(0, 32);
const val = (v) =>
  v == null
    ? ""
    : v instanceof Date
      ? v.toISOString().slice(0, 10)
      : String(v).trim();
function date(v, report) {
  let s = val(v).replace(/\([월화수목금토일](?:요일)?\)$/, ""),
    full = s.match(/^(\d{4})[./-](\d{1,2})[./-](\d{1,2})\.?$/);
  if (full)
    s = `${full[1]}-${full[2].padStart(2, "0")}-${full[3].padStart(2, "0")}`;
  s = s.replace(/^(\d{1,2})월\s*(\d{1,2})일$/, "$1/$2");
  let m = s.match(/^(\d{1,2})[/.\-](\d{1,2})\.?$/);
  if (m) {
    M.assert(report, "월/일 앞에 YYYY-MM-DD 일보를 입력하세요.");
    let year = Number(report.slice(0, 4));
    s = `${year}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
    if (s > report && report.slice(5, 7) === "01" && m[1] === "12")
      s = `${year - 1}${s.slice(4)}`;
  }
  return M.date(s);
}
function clock(v, optional = false) {
  if (optional && v === "-") return "";
  return require("./clock.cjs").parseClock(
    v instanceof Date || typeof v === "number" || v == null ? v : val(v),
    { required: !optional },
  );
}
function member(ws, value, region) {
  const org = O.get(ws),
    token = val(value),
    explicit = token.match(/^(.*?)\[([^\]]+)\]$/);
  let candidates = org.members.filter(
    (m) =>
      m.status === "active" &&
      (explicit
        ? m.code === explicit[2] && (!explicit[1] || m.name === explicit[1])
        : m.code === token || m.name === token),
  );
  if (!explicit && candidates.length > 1) {
    const local = candidates.filter(
      (m) => O.regionOf(org, m.unitId) === region,
    );
    if (local.length) candidates = local;
  }
  M.assert(
    candidates.length === 1,
    candidates.length
      ? `${token}: 동명이인입니다. 이름[구성원ID]로 입력하세요.`
      : `${token || "이름 없음"}: 등록된 구성원을 찾을 수 없습니다. 명부와 보관 여부를 확인하세요.`,
  );
  return candidates[0];
}
function gospelStageId(ws, value) {
  const milestone = Milestones.fieldForStageLabel(value);
  return milestone?.field === "bokshinDate"
    ? Milestones.stageId(ws, milestone.field)
    : undefined;
}
function stage(ws, value) {
  const compact = (s) => s.replace(/\s/g, "");
  const gospelStage = gospelStageId(ws, value);
  const matches = gospelStage
    ? [gospelStage]
    : ws.stages.filter(
        (s) =>
          compact(s) === compact(value) ||
          compact(ws.stageNames[s]) === compact(value),
      );
  M.assert(
    matches.length === 1 && !ws.inactiveStages.includes(matches[0]),
    `단계 '${value}'를 설정에서 먼저 등록하거나 이름을 확인하세요.`,
  );
  return matches[0];
}
function regionCheck(ws, region) {
  M.text(region, 60, true);
  M.assert(
    O.get(ws).nodes.some(
      (n) =>
        n.active &&
        (n.reportRegion || (/구역/.test(n.type) ? n.name : "")) === region,
    ),
    `${region}: 조직 관리에 구역을 먼저 등록하세요.`,
  );
}
function parse(text, ws, context = {}) {
  return require("./daily-parser.cjs").parse(text, ws, context, {
    date,
    clock,
  });
}
function normalizeActivity(d, ws) {
  const day = date(d.활동일),
    region = val(d.구역);
  regionCheck(ws, region);
  const m = member(ws, d.활동자, region),
    start = clock(d.시작),
    end = clock(d.종료);
  M.assert(
    O.regionOf(O.get(ws), m.unitId) === region,
    `${m.name}: 등록된 소속 구역과 보고 구역이 다릅니다.`,
  );
  M.assert(M.minutes(start, end) > 0, "활동 시작과 종료가 같습니다.");
  const code = val(d.활동ID) || `DA-${key(day, region, m.code, start, end)}`;
  return M.validateActivity(
    {
      code,
      date: day,
      region,
      workerId: m.code,
      worker: m.name,
      start,
      end,
      className: m.className,
      ...O.reportDimensions(ws, m, region),
      kind: val(d.활동종류) || K.preferred(ws, "activityKind", "대화"),
      place: val(d.활동장소),
      notes: "일보 활동 기록",
    },
    null,
    ws,
  );
}
function normalizeFinding(d, ws) {
  const report = date(d.보고일),
    region = val(d.구역);
  regionCheck(ws, region);
  const found = date(d.찾은날짜, report),
    name = M.text(val(d.대상자), 100, true),
    m = member(ws, d.인도자, region);
  M.assert(found <= report, "찾은 날짜는 보고일보다 늦을 수 없습니다.");
  const status = val(d.구분),
    age = val(d.나이) === "" ? "" : Number(d.나이);
  M.assert(
    ["신규", "유지", "탈락"].includes(status),
    "구분은 신규/유지/탈락입니다.",
  );
  M.assert(
    age === "" || (Number.isInteger(age) && age >= 0 && age <= 120),
    "나이는 0~120 정수입니다.",
  );
  const gender = val(d.성별) || "미입력";
  M.assert(
    ["남", "여", "기타", "미입력"].includes(gender),
    "성별을 확인하세요.",
  );
  const history = ws.findingReports || [];
  let code = val(d.대상자ID);
  if (!code) {
    M.assert(
      !ws.people.some(
        (p) =>
          p.dateUnknown &&
          p.name === name &&
          (p.gender === "미입력" ||
            gender === "미입력" ||
            p.gender === gender) &&
          (p.worker === m.name || p.introducerId === m.id),
      ),
      `${name}: 이전 자료의 찾은 날짜가 미기록입니다. 기존 대상자의 찾은 날짜를 먼저 보완한 뒤 변환하세요.`,
    );
    const candidates = history.filter(
      (r) =>
        r.name === name &&
        r.foundDate === found &&
        r.region === region &&
        (!r.gender ||
          r.gender === "미입력" ||
          gender === "미입력" ||
          r.gender === gender),
    );
    let matching = [...new Set(candidates.map((r) => r.personCode))];
    if (matching.length > 1)
      matching = [
        ...new Set(
          candidates
            .filter(
              (r) =>
                r.residence === val(d.거주지) &&
                r.place === val(d.찾기장소) &&
                r.time === clock(d.찾기시간, true) &&
                r.memberCode === m.code,
            )
            .map((r) => r.personCode),
        ),
      ];
    M.assert(
      matching.length <= 1,
      `${name}: 동명이인을 구분할 성별·나이·거주지·찾기시간을 확인하세요.`,
    );
    if (matching.length) code = matching[0];
    else {
      const existing = ws.people.filter(
        (p) =>
          p.name === name &&
          p.date === found &&
          p.region === region &&
          (p.gender === "미입력" || gender === "미입력" || p.gender === gender),
      );
      M.assert(
        existing.length <= 1,
        `${name}: 동명이인을 구분할 성별·나이·거주지·찾기시간을 확인하세요.`,
      );
      code =
        existing[0]?.code ||
        `DP-${key(name, region, found, gender, age, val(d.거주지), val(d.찾기장소), clock(d.찾기시간, true), m.code)}`;
    }
  }
  const row = {
    id: `DF-${key(report, code)}`,
    date: report,
    region,
    stage: stage(ws, val(d.단계)),
    status,
    personCode: M.text(code, 60, true),
    foundDate: found,
    name,
    gender,
    age,
    tool: M.text(val(d.도구), 200),
    residence: M.text(val(d.거주지), 200),
    place: M.text(val(d.찾기장소), 200),
    time: clock(d.찾기시간, true),
    memberId: m.id,
    memberCode: m.code,
    worker: m.name,
    className: m.className,
    unitPath: O.pathName(O.get(ws), m.unitId),
    ...O.reportDimensions(ws, m, region),
  };
  return row;
}
function applyRows(ws, rows, actor, counts, errors, warnings, duplicate) {
  ws.findingReports ||= [];
  const bump = (k) => (counts[k] = (counts[k] || 0) + 1);
  const seenActs = new Map(),
    seenFinds = new Map();
  const recordOnce = (seen, key, sheet, index, data, reason) => {
    const first = seen.get(key);
    if (first)
      duplicate?.(sheet, index, data, first.data, {
        matchedRow: first.index,
        matchedSheet: sheet,
        reason,
        blocking: true,
      });
    M.assert(!first, reason);
    seen.set(key, { index, data });
  };
  const sameWorker = (token, code, name) =>
    [code, name, `${name}[${code}]`, `[${code}]`].includes(val(token));
  for (const { data: d, index } of rows.활동일보 || [])
    try {
      const saved = ws.activityLogs.find((a) => a.code === val(d.활동ID));
      if (
        saved &&
        saved.date === date(d.활동일) &&
        saved.region === val(d.구역) &&
        sameWorker(d.활동자, saved.workerId, saved.worker) &&
        saved.start === clock(d.시작) &&
        saved.end === clock(d.종료)
      ) {
        recordOnce(
          seenActs,
          saved.code,
          "활동일보",
          index,
          d,
          "파일 안에 동일 활동이 중복됩니다.",
        );
        bump("중복 건너뜀");
        duplicate?.("활동일보", index, d, saved);
        continue;
      }
      const a = normalizeActivity(d, ws),
        all = [...ws.activityLogs, ...ws.people.flatMap((p) => p.activities)],
        before = all.find((b) => b.code === a.code);
      recordOnce(
        seenActs,
        a.code,
        "활동일보",
        index,
        d,
        "파일 안에 동일 활동이 중복됩니다.",
      );
      M.assert(
        !before || ws.activityLogs.includes(before),
        "대상자에 연결된 기존 활동ID입니다.",
      );
      // Compare real timestamps including overnight spill across adjacent reporting days.
      const range = (x) => {
        const start = Date.parse(`${x.date}T${x.start}:00Z`);
        return [start, start + M.minutes(x.start, x.end) * 60000];
      };
      const [from, to] = range(a);
      for (const other of all.filter(
        (b) =>
          b.code !== a.code &&
          (b.workerId === a.workerId ||
            (!b.workerId && b.worker === a.worker && b.region === a.region)) &&
          b.start &&
          b.end,
      )) {
        const [x, y] = range(other);
        if (from < y && to > x)
          duplicate?.("활동일보", index, d, other, {
            reason: "기존 활동과 시간이 겹칩니다.",
            blocking: true,
          });
        M.assert(
          from >= y || to <= x,
          `${a.worker}: 기존 활동과 시간이 겹칩니다. 중복을 제거하거나 활동ID로 정정하세요.`,
        );
      }
      const clean = (v) => ({ ...v, id: "", createdAt: "", updatedAt: "" });
      if (
        before &&
        JSON.stringify(clean(before)) === JSON.stringify(clean(a))
      ) {
        bump("중복 건너뜀");
        duplicate?.("활동일보", index, d, before);
        continue;
      }
      if (before) {
        a.id = before.id;
        a.createdAt = before.createdAt;
        ws.activityLogs[ws.activityLogs.indexOf(before)] = a;
      } else ws.activityLogs.push(a);
      M.audit(ws, actor, "일보 활동 입력", a.id, before || null, a);
      bump(before ? "활동 수정" : "활동 신규");
    } catch (e) {
      errors.push(`활동일보 ${index}행: ${e.message}`);
    }
  const input = (rows.찾기일보 || [])
    .slice()
    .sort((a, b) => val(a.data.보고일).localeCompare(val(b.data.보고일)));
  for (const { data: d, index } of input)
    try {
      const reportDay = date(d.보고일),
        foundDay = date(d.찾은날짜, reportDay);
      const savedCandidates = ws.findingReports.filter(
        (r) =>
          r.date === reportDay &&
          (val(d.대상자ID)
            ? r.personCode === val(d.대상자ID)
            : r.region === val(d.구역) &&
              r.name === val(d.대상자) &&
              r.foundDate === foundDay),
      );
      const saved = savedCandidates.length === 1 ? savedCandidates[0] : null;
      if (
        saved &&
        saved.region === val(d.구역) &&
        saved.foundDate === foundDay &&
        saved.name === val(d.대상자) &&
        ([saved.stage, ws.stageNames[saved.stage]].includes(val(d.단계)) ||
          gospelStageId(ws, val(d.단계)) === saved.stage) &&
        saved.status === val(d.구분) &&
        saved.gender === (val(d.성별) || "미입력") &&
        saved.age === (val(d.나이) === "" ? "" : Number(d.나이)) &&
        saved.tool === val(d.도구) &&
        saved.residence === val(d.거주지) &&
        saved.place === val(d.찾기장소) &&
        saved.time === clock(d.찾기시간, true) &&
        sameWorker(d.인도자, saved.memberCode, saved.worker)
      ) {
        recordOnce(
          seenFinds,
          saved.id,
          "찾기일보",
          index,
          d,
          "파일 안에 같은 보고일·대상자가 중복됩니다.",
        );
        bump("중복 건너뜀");
        duplicate?.("찾기일보", index, d, saved);
        continue;
      }
      const r = normalizeFinding(d, ws),
        before = ws.findingReports.find((x) => x.id === r.id);
      recordOnce(
        seenFinds,
        r.id,
        "찾기일보",
        index,
        d,
        "파일 안에 같은 보고일·대상자가 중복됩니다.",
      );
      if (before) {
        if (JSON.stringify(before) !== JSON.stringify(r))
          duplicate?.("찾기일보", index, d, before, {
            blocking: true,
            reason: "같은 대상자의 같은 보고일 기록과 내용이 다릅니다.",
          });
        M.assert(
          JSON.stringify(before) === JSON.stringify(r),
          "이미 반영한 같은 날짜 대상자의 일보 내용이 다릅니다. 기존 일보와 대상자 이력을 확인하세요.",
        );
        bump("중복 건너뜀");
        duplicate?.("찾기일보", index, d, before);
        continue;
      }
      const prev = ws.findingReports
        .filter((x) => x.personCode === r.personCode)
        .at(-1);
      M.assert(
        !prev || prev.date < r.date,
        "과거 일보는 날짜순으로 가져오세요. 최신 일보보다 앞선 기록을 끼워 넣을 수 없습니다.",
      );
      if (prev)
        M.assert(
          prev.name === r.name && prev.foundDate === r.foundDate,
          "같은 대상자ID의 이름·찾은날짜가 다릅니다. 식별번호를 확인하세요.",
        );
      const old = ws.people.find((p) => p.code === r.personCode);
      M.assert(
        !old || (old.name === r.name && old.date === r.foundDate),
        "기존 대상자ID의 이름·찾은날짜가 다릅니다.",
      );
      const effective = `${r.date}T23:59`;
      const p = M.validatePerson(
        {
          ...(old || {}),
          code: r.personCode,
          name: r.name,
          date: r.foundDate,
          gender: r.gender,
          age: r.age,
          ageAsOf: r.date,
          time: r.time,
          place: r.place,
          tool: r.tool,
          residence: r.residence,
          region: r.region,
          className: r.className,
          introducerId: r.memberId,
          worker: r.worker,
          employment: old?.employment || "미입력",
          stage: old?.stage || r.stage,
        },
        ws,
        old,
      );
      if (!old) {
        // A retained record establishes a baseline on the first report, never a fictitious historical stage entry.
        M.transition(
          p,
          null,
          r.stage,
          r.status === "신규" ? r.foundDate + "T00:00" : effective,
          actor,
          "일보 최초 확인",
          ws.stageNames,
        );
        p.transitions[0].baseline = r.status !== "신규";
        bump("신규 대상자");
        if (r.status !== "신규")
          warnings.push(
            `${r.name}: 기존 자료에 없어 ${r.status} 상태의 기준 자료로 등록합니다. 과거 단계 이력은 추정하지 않습니다.`,
          );
      }
      if (p.status === "dropped" && r.status !== "탈락") {
        M.lifecycleChange(p, "active", effective, actor, "일보 재확인");
        bump("탈락·복귀");
      }
      if (p.stage !== r.stage) {
        M.transition(
          p,
          p.stage,
          r.stage,
          effective,
          actor,
          "일보 단계 확인",
          ws.stageNames,
        );
        p.stage = r.stage;
        bump("단계 변경");
      }
      if (r.status === "탈락" && p.status !== "dropped") {
        M.lifecycleChange(p, "dropped", effective, actor, "일보 탈락");
        bump("탈락·복귀");
      }
      if (old) ws.people[ws.people.indexOf(old)] = p;
      else ws.people.push(p);
      ws.findingReports.push(r);
      M.audit(
        ws,
        actor,
        "일보 찾기 입력",
        p.id,
        old ? { stage: old.stage, status: old.status } : null,
        r,
      );
      bump("찾기 일보");
    } catch (e) {
      errors.push(`찾기일보 ${index}행: ${e.message}`);
    }
}
async function workbook(rows = { 활동일보: [], 찾기일보: [] }) {
  const ExcelJS = require("exceljs"),
    b = new ExcelJS.Workbook();
  const guide = b.addWorksheet("작성안내");
  GUIDE.forEach((x) => guide.addRow(x));
  guide.getColumn(1).width = 24;
  guide.getColumn(2).width = 105;
  guide.eachRow((r) => {
    r.height = 48;
    r.alignment = { vertical: "middle", wrapText: true };
  });
  for (const [name, headers] of Object.entries(HEADERS)) {
    const s = b.addWorksheet(name, { views: [{ state: "frozen", ySplit: 1 }] });
    s.addRow(headers);
    for (const r of rows[name] || [])
      s.addRow(
        headers.map((h) => {
          if (
            ["활동일", "보고일", "찾은날짜"].includes(h) &&
            /^\d{4}-\d{2}-\d{2}$/.test(val(r[h]))
          )
            return new Date(`${r[h]}T00:00:00Z`);
          if (h === "나이" && val(r[h]) !== "") return Number(r[h]);
          return r[h] ?? "";
        }),
      );
    headers.forEach((h, i) => {
      const c = s.getColumn(i + 1);
      c.width = h.endsWith("ID") ? 40 : 18;
      c.numFmt = ["활동일", "보고일", "찾은날짜"].includes(h)
        ? "yyyy-mm-dd"
        : h === "나이"
          ? "0"
          : "@";
    });
    s.autoFilter = {
      from: "A1",
      to: { row: Math.max(1, s.rowCount), column: headers.length },
    };
    for (const label of ["구분"]) {
      const col = headers.indexOf(label) + 1;
      if (!col || label === "단계") continue;
      for (let row = 2; row <= 1001; row++)
        s.getCell(row, col).dataValidation = {
          type: "list",
          allowBlank: true,
          formulae: [label === "구분" ? '"신규,유지,탈락"' : '"오픈,비오픈"'],
          showErrorMessage: true,
        };
    }
  }
  b.worksheets.forEach((s) => {
    s.eachRow((r) =>
      r.eachCell((c) => {
        c.font = { name: "맑은 고딕", size: 11 };
      }),
    );
    s.getRow(1).height = 32;
    s.getRow(1).eachCell((c) => {
      c.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FF194B3B" },
      };
      c.font = {
        name: "맑은 고딕",
        bold: true,
        color: { argb: "FFFFFFFF" },
        size: 11,
      };
    });
  });
  return Buffer.from(await b.xlsx.writeBuffer());
}
function previewText(ws, text, actor, context = {}) {
  const parsed = parse(text, ws, context),
    draft = M.copy(ws),
    counts = {},
    errors = [...parsed.errors],
    warnings = [];
  if (context.findings !== undefined) {
    M.assert(
      Array.isArray(context.findings) &&
        context.findings.length === parsed.rows.찾기일보.length,
      "검토 행 수가 원문과 다릅니다. 원문을 다시 확인하세요.",
    );
    parsed.rows.찾기일보 = context.findings.map((input, i) => {
      const row = {};
      for (const h of HEADERS.찾기일보)
        row[h] = M.text(String(input[h] ?? ""), 2000);
      row.보고일 = context.date || row.보고일;
      row.구역 = context.region || row.구역;
      row._line = parsed.rows.찾기일보[i]._line;
      return row;
    });
  } else {
    for (const r of parsed.rows.찾기일보)
      if (r._review?.length)
        errors.push(
          `${r._line}줄: ${r._review.join(" ")} 아래 검토 표에서 확인하고 다시 변환하세요.`,
        );
  }
  if (!errors.length)
    applyRows(
      draft,
      Object.fromEntries(
        Object.entries(parsed.rows).map(([sheet, data]) => [
          sheet,
          data.map((d, i) => ({ data: d, index: d._line || i + 2 })),
        ]),
      ),
      actor,
      counts,
      errors,
      warnings,
    );
  if (!errors.length)
    try {
      M.validateWorkspace(draft);
    } catch (e) {
      errors.push(e.message);
    }
  if (!errors.length) {
    for (const d of parsed.rows.활동일보) {
      const a = normalizeActivity(d, ws);
      d.활동ID = a.code;
      d.활동자 = a.workerId;
    }
    for (const d of parsed.rows.찾기일보) {
      const r = normalizeFinding(d, draft);
      d.대상자ID = r.personCode;
      d.인도자 = r.memberCode;
      d.찾은날짜 = r.foundDate;
      d.찾기시간 = r.time;
    }
  }
  return {
    rows: parsed.rows,
    draft,
    counts,
    errors,
    warnings: [...new Set(warnings)],
  };
}
function analytics(ws, filters = {}) {
  const inDate = (d) =>
    (!filters.from || d >= filters.from) && (!filters.to || d <= filters.to);
  const region = (r) => !filters.region || r === filters.region;
  const records = (ws.findingReports || []).filter(
    (r) => inDate(r.date) && region(r.region),
  );
  const first = new Map();
  for (const r of (ws.findingReports || [])
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date)))
    if (r.foundDate && !r.dateUnknown && !first.has(r.personCode))
      first.set(r.personCode, r);
  const creations = [...first.values()].filter(
    (r) => inDate(r.foundDate) && region(r.region),
  );
  // Manual findings share the same person identity as imported daily findings.
  // A daily snapshot takes precedence, so a person is counted only once.
  for (const p of ws.people) {
    if (
      first.has(p.code) ||
      !p.date ||
      p.dateUnknown ||
      !inDate(p.date) ||
      !region(p.region)
    )
      continue;
    const member = O.get(ws).members.find((m) => m.id === p.introducerId);
    const memberCode = p.introducerSnapshot?.code || member?.code || "";
    creations.push({
      personCode: p.code,
      foundDate: p.date,
      date: p.date,
      region: p.region,
      name: p.name,
      gender: p.gender,
      age: p.age,
      time: p.time || "",
      place: p.place || "",
      tool: p.tool || "",
      residence: p.residence || "",
      memberId: p.introducerId || "",
      memberCode,
      worker: p.introducerSnapshot?.name || member?.name || p.worker,
      className: p.className,
      ...O.reportDimensions(ws, member, p.region),
    });
  }
  const acts = [
    ...ws.activityLogs,
    ...ws.people.flatMap((p) => p.activities),
  ].filter((a) => inDate(a.date) && region(a.region));
  const groups = (list, fn) => {
    const map = new Map();
    for (const r of list) {
      const label = fn(r) || "미입력";
      map.set(label, (map.get(label) || 0) + 1);
    }
    return [...map]
      .map(([label, value]) => ({ label, value }))
      .sort(
        (a, b) => b.value - a.value || a.label.localeCompare(b.label, "ko"),
      );
  };
  const workers = new Map();
  for (const a of acts) {
    const id = a.workerId || `${a.region}/${a.worker}`;
    const r = workers.get(id) || {
      id,
      name: a.worker,
      region: a.region,
      days: new Set(),
      minutes: 0,
      count: 0,
      unknownTimeCount: 0,
    };
    r.days.add(a.date);
    r.minutes += a.minutes;
    r.count++;
    if (!a.start || !a.end) r.unknownTimeCount++;
    workers.set(id, r);
  }
  return {
    reports: records.length,
    reportedNew: records.filter((r) => r.status === "신규").length,
    retained: records.filter((r) => r.status === "유지").length,
    dropped: records.filter((r) => r.status === "탈락").length,
    creations: creations.length,
    workers: [...workers.values()].map((r) => ({ ...r, days: r.days.size })),
    activities: acts,
    records,
    byWorker: groups(creations, (r) => `${r.worker} [${r.memberCode}]`),
    byHour: groups(creations, (r) =>
      r.time ? r.time.slice(0, 2) + "시" : "미입력",
    ),
    byRegion: groups(creations, (r) => r.region),
    byClass: groups(creations, (r) => K.label(ws, "className", r.className)),
    dimensions: require("./dimensions.cjs").summarize(
      ws,
      acts,
      creations,
      records,
    ),
  };
}
function splitByDay(rows) {
  const groups = new Map();
  for (const sheet of Object.keys(HEADERS))
    for (const r of rows[sheet] || []) {
      const day = date(r[sheet === "활동일보" ? "활동일" : "보고일"]),
        region = M.text(val(r.구역), 60, true),
        k = JSON.stringify([day, region]);
      if (!groups.has(k))
        groups.set(k, {
          date: day,
          region,
          rows: { 활동일보: [], 찾기일보: [] },
        });
      groups.get(k).rows[sheet].push(r);
    }
  return [...groups.values()].sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      a.region.localeCompare(b.region, "ko", { numeric: true }),
  );
}
async function archiveRows(root, rows, protectedDirectory) {
  const fs = require("node:fs/promises"),
    path = require("node:path");
  const directory = path.resolve(root),
    protectedRoot = path.resolve(protectedDirectory).toLowerCase();
  M.assert(
    directory.toLowerCase() !== protectedRoot &&
      !directory.toLowerCase().startsWith(protectedRoot + path.sep),
    "프로그램 저장소 밖의 보관 폴더를 선택하세요.",
  );
  const groups = splitByDay(rows),
    output = [];
  M.assert(
    groups.length > 0 && groups.length <= 366,
    "한 번에 날짜·구역 파일 366개까지 저장할 수 있습니다.",
  );
  // Prepare the entire batch before creating files. Existing files are never overwritten.
  const prepared = [];
  for (const g of groups)
    prepared.push({ ...g, bytes: await workbook(g.rows) });
  try {
    for (const g of prepared) {
      const folder = path.join(directory, g.date);
      await fs.mkdir(folder, { recursive: true });
      let safeRegion = g.region
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, "-")
        .replace(/[. ]+$/g, "");
      if (!safeRegion || /^(CON|PRN|AUX|NUL|COM\d|LPT\d)$/i.test(safeRegion))
        safeRegion = `구역-${key(g.region).slice(0, 8)}`;
      else if (safeRegion !== g.region)
        safeRegion += `-${key(g.region).slice(0, 6)}`;
      for (let version = 1; ; version++) {
        const file = path.join(
          folder,
          `${safeRegion}${version > 1 ? `-${String(version).padStart(2, "0")}` : ""}.xlsx`,
        );
        let handle;
        try {
          handle = await fs.open(file, "wx");
        } catch (e) {
          if (e.code === "EEXIST") continue;
          throw e;
        }
        output.push({
          date: g.date,
          region: g.region,
          fileName: path.basename(file),
          path: file,
        });
        try {
          await handle.writeFile(g.bytes);
          await handle.sync();
        } finally {
          await handle.close();
        }
        break;
      }
    }
    return { directory, files: output };
  } catch (e) {
    for (const f of output) await fs.unlink(f.path).catch(() => {});
    throw e;
  }
}
module.exports = {
  HEADERS,
  GUIDE,
  SAMPLE,
  parse,
  member,
  normalizeActivity,
  normalizeFinding,
  applyRows,
  workbook,
  previewText,
  analytics,
  splitByDay,
  archiveRows,
};
