"use strict";
const ExcelJS = require("exceljs");
const { inflateRawSync } = require("node:zlib");
const M = require("./model.cjs");
const O = require("./organization.cjs");
const K = require("./codes.cjs");
const G = require("./goals.cjs");
const D = require("./daily.cjs");
const S = require("./person-stages.cjs");
const Milestones = require("./ui/person-milestones.js");
const Preview = require("./import-preview.cjs");
const { PHONE_HEADER, isPhoneHeader, readPhone } = require("./person-phone.cjs");
const { parseClock } = require("./clock.cjs");
const SHEETS = {
  공통코드: [
    "그룹ID",
    "그룹명",
    "코드값",
    "표시명",
    "이전표시명JSON",
    "사용상태",
    "정렬순서",
    "그룹상태",
  ],
  조직: [
    "조직ID",
    "조직명",
    "조직유형",
    "상위조직ID",
    "책임자구성원ID",
    "책임자호칭",
    "데이터구역명",
    "사용상태",
  ],
  구성원: [
    "구성원ID",
    "이름",
    "소속조직ID",
    "직책",
    "반",
    "직장인구분",
    "상태",
    "메모",
  ],
  대상자: [
    "대상자ID",
    "이름",
    "구역",
    "반",
    "담당자",
    "찾은날짜",
    "분류1",
    "분류2",
    "성별",
    "나이",
    "나이기준일",
    "직장인구분",
    "최초단계",
    "메모",
    "인도자ID",
    "만픽일",
    "찾A일",
    "복신일",
    PHONE_HEADER,
  ],
  단계변경: [
    "변경ID",
    "대상자ID",
    "변경전단계",
    "변경후단계",
    "적용시각",
    "변경사유",
  ],
  탈락복귀: ["변경ID", "대상자ID", "구분", "적용시각", "사유"],
  활동: [
    "활동ID",
    "대상자ID",
    "활동일",
    "구역",
    "활동자ID",
    "활동자명",
    "시작",
    "종료",
    "활동장소",
    "활동종류",
    "메모",
    "분류2",
  ],
  구역일계: ["일자", "구역", "찾B건수", "단계향상건수", "탈락건수", "메모"],
  목표: ["구역", "단계", "시작일", "종료일", "목표건수", "반", "기간단위"],
};
const IMPORT_SHEETS = {
  ...SHEETS,
  ...D.HEADERS,
  ...require("./simple-roster.cjs").HEADERS,
  ...require("./simple-records.cjs").HEADERS,
};
function checkZip(buffer, { allowPrinterSettings = false } = {}) {
  M.assert(
    Buffer.isBuffer(buffer) && buffer.length <= 15 * 1024 * 1024,
    "엑셀 파일은 최대 15MB입니다.",
  );
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--)
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  M.assert(eocd >= 0, "올바른 .xlsx 파일이 아닙니다.");
  const entries = buffer.readUInt16LE(eocd + 10),
    offset = buffer.readUInt32LE(eocd + 16),
    directorySize = buffer.readUInt32LE(eocd + 12);
  M.assert(
    entries > 0 && entries <= 250 && offset + directorySize <= eocd,
    "지원하지 않거나 너무 복잡한 엑셀 파일입니다.",
  );
  let pos = offset,
    total = 0;
  const names = new Set();
  for (let i = 0; i < entries; i++) {
    M.assert(
      pos + 46 <= buffer.length && buffer.readUInt32LE(pos) === 0x02014b50,
      "엑셀 압축 구조가 올바르지 않습니다.",
    );
    const flags = buffer.readUInt16LE(pos + 8),
      packed = buffer.readUInt32LE(pos + 20),
      size = buffer.readUInt32LE(pos + 24),
      nameLength = buffer.readUInt16LE(pos + 28),
      extra = buffer.readUInt16LE(pos + 30),
      comment = buffer.readUInt16LE(pos + 32);
    M.assert(
      !(flags & 1) &&
        size <= 20 * 1024 * 1024 &&
        size !== 0xffffffff &&
        size / Math.max(packed, 1) <= 1000,
      "압축된 엑셀의 크기 또는 보안 제한을 초과했습니다.",
    );
    total += size;
    M.assert(
      total <= 64 * 1024 * 1024,
      "압축 해제 크기 제한(64MB)을 초과했습니다.",
    );
    M.assert(
      pos + 46 + nameLength + extra + comment <= buffer.length,
      "엑셀 압축 항목이 잘렸습니다.",
    );
    const name = buffer.toString("utf8", pos + 46, pos + 46 + nameLength);
    const printerSettings =
      allowPrinterSettings &&
      /^xl\/printerSettings\/printerSettings[1-9]\d*\.bin$/.test(name) &&
      size <= 64 * 1024;
    M.assert(
      !/vbaProject|\.\.[/\\]|^[/\\]/i.test(name) &&
        (!/\.bin$/i.test(name) || printerSettings) &&
        !names.has(name),
      "중복 항목·매크로·바이너리 포함 파일은 가져올 수 없습니다.",
    );
    names.add(name);
    const method = buffer.readUInt16LE(pos + 10),
      local = buffer.readUInt32LE(pos + 42);
    M.assert(
      local + 30 <= offset &&
        buffer.readUInt32LE(local) === 0x04034b50 &&
        [0, 8].includes(method),
      "지원하지 않는 엑셀 압축 방식입니다.",
    );
    const start =
      local +
      30 +
      buffer.readUInt16LE(local + 26) +
      buffer.readUInt16LE(local + 28);
    M.assert(
      start + packed <= offset,
      "엑셀 압축 데이터 범위가 잘못되었습니다.",
    );
    let expanded;
    try {
      expanded =
        method === 0
          ? buffer.subarray(start, start + packed)
          : inflateRawSync(buffer.subarray(start, start + packed), {
              maxOutputLength: 20 * 1024 * 1024,
            });
    } catch {
      throw new Error(
        "엑셀 압축 데이터가 손상되었거나 해제 크기 제한을 초과했습니다.",
      );
    }
    M.assert(
      expanded.length === size,
      "엑셀 압축 크기가 실제 데이터와 다릅니다.",
    );
    if (/\.(xml|rels)$/i.test(name))
      M.assert(
        !/<!DOCTYPE|<!ENTITY/i.test(expanded.toString("utf8")),
        "외부 엔터티를 포함한 XML은 가져올 수 없습니다.",
      );
    pos += 46 + nameLength + extra + comment;
  }
}
function str(value) {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    if (
      Array.isArray(value.richText) &&
      value.richText.every((t) => typeof t.text === "string")
    )
      return value.richText
        .map((t) => t.text)
        .join("")
        .trim();
    throw new Error("수식·링크·오류 셀은 값으로 바꿔 입력해 주세요.");
  }
  return String(value).trim();
}
function day(v, required = true) {
  const value = v instanceof Date ? v.toISOString().slice(0, 10) : str(v);
  return M.date(value, required);
}
function datetime(v) {
  let value =
    v instanceof Date ? v.toISOString().slice(0, 16) : str(v).replace(" ", "T");
  M.assert(
    /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/.test(value),
    "적용시각은 YYYY-MM-DD HH:mm 형식입니다.",
  );
  M.date(value.slice(0, 10));
  return value;
}
function clock(v) {
  return parseClock(
    v instanceof Date || typeof v === "number" || v == null ? v : str(v),
  );
}
function integer(v, label, empty = 0) {
  if (v == null || v === "") return empty;
  const n = Number(v);
  M.assert(
    Number.isInteger(n) && n >= 0 && n <= 1000000,
    `${label}: 0 이상의 정수를 입력해 주세요.`,
  );
  return n;
}
function stageID(ws, name) {
  const value = str(name),
    milestone = Milestones.fieldForStageLabel(value),
    milestoneStage = milestone && S.stageId(ws, milestone.field),
    id =
      (milestone?.field === "bokshinDate" && milestoneStage) ||
      ws.stages.find((s) => s === value || ws.stageNames[s] === value) ||
      milestoneStage;
  M.assert(id, `알 수 없는 단계: ${value}. 설정에서 먼저 추가해 주세요.`);
  return id;
}
async function createTemplate(ws) {
  const workbook = new ExcelJS.Workbook();
  const lookup = workbook.addWorksheet("_선택목록", { state: "veryHidden" });
  const lists = new Map();
  const namedList = (key, values) => {
    if (lists.has(key)) return lists.get(key);
    if (!values.length) return null;
    const index = lists.size + 1,
      name = `CC_${index}`,
      column = lookup.getColumn(index).letter;
    values.forEach((v, i) => (lookup.getCell(i + 1, index).value = v));
    workbook.definedNames.add(
      `'_선택목록'!$${column}$1:$${column}$${values.length}`,
      name,
    );
    lists.set(key, name);
    return name;
  };
  for (const g of K.catalog(ws).groups)
    namedList(
      g.id,
      K.options(ws, g.id).map(([v]) => K.label(ws, g.id, v)),
    );
  namedList("goalStages", ["신규 대상자 등록", ...ws.stages]);
  workbook.creator = "Church Data Desk";
  const help = workbook.addWorksheet("작성안내");
  const instructions = [
    [
      "목표",
      "단계·시작일·종료일·목표건수를 입력합니다. 구역별 목표는 구역을, 자료실 전체에서 합산하는 반별 목표는 반을 입력하고 구역을 비웁니다. 같은 구역·반·기간·단계의 목표를 갱신합니다. 단계는 고정 단계ID 또는 현재 표시명을 사용하고 신규 대상자 등록은 *입니다. 목표건수 0은 저장하고 빈칸은 건너뜁니다. 목표 해제는 프로그램에서 합니다.",
    ],
    [
      "공통코드",
      "반·직업 구분·직책·활동 종류·장소는 공통코드 관리에서 추가합니다. 같은 파일의 공통코드 시트로 먼저 등록한 뒤 다른 시트에서 표시명 또는 고정 코드값을 사용할 수도 있습니다. 표시명 변경 전 이름도 유지됩니다.",
    ],
    [
      "조직·구성원",
      "조직을 먼저 등록한 뒤 구성원을 배치하고 대상자 인도자ID에 구성원ID를 적습니다. 조직 시트의 상위조직ID로 지역·구역·반·팀 등 자유로운 구조를 구성합니다. 같은 파일의 시트 순서는 무관합니다.",
    ],
    [
      "조직 책임자",
      "책임자구성원ID는 해당 조직 또는 하위 조직에 소속된 활동 중인 구성원으로 지정합니다. 사용상태는 사용/보관, 구성원 상태는 활동 중/보관입니다.",
    ],
    [
      "인도자ID",
      "등록된 구성원ID를 입력합니다. 이름으로 자동 매칭하지 않습니다. 예: M-0001. 기존 1.0 양식에 이 열이 없으면 기존 연결을 유지하고, 열이 있고 빈 값이면 연결을 해제합니다.",
    ],
    ["매일 입력하는 자료 · 작성 안내", ""],
    [
      "사용 순서",
      "필요한 시트만 입력 → 프로그램에서 엑셀 가져오기 → 오류·변경 미리보기 → 전체 반영",
    ],
    [
      "대상자ID",
      "중복되지 않는 문자 식별번호. 예: P-0001. 동명이인도 다른 ID를 사용하세요. 이후 시트에서 이 ID로 연결합니다.",
    ],
    [
      "기존 대상자",
      "같은 ID의 기본 정보는 갱신됩니다. 날짜·단계·상태는 기존 이력의 시간 순서와 관계없이 정정할 수 있습니다.",
    ],
    [
      "최초단계",
      "신규 대상자의 최초 단계입니다. 기존 대상자는 첫 단계 이력을 정정하며, 이후 단계가 있으면 현재 단계는 유지합니다. 현재 단계 변경은 단계변경 시트에서 입력합니다.",
    ],
    [
      "단계변경",
      "변경ID는 건별로 고유하게 입력합니다. 예: S-0001. 같은 ID로 다시 가져와도 중복 집계하지 않습니다.",
    ],
    [
      "탈락복귀",
      "구분은 탈락 또는 복귀. 원본 대상자와 단계 기록을 삭제하지 않습니다.",
    ],
    [
      "적용시각",
      "YYYY-MM-DD HH:mm (PC 현지시간). 실제 입력 시각은 별도로 기록하며, 기존 이력의 시간 순서와 관계없이 입력·정정할 수 있습니다. 같은 변경ID를 다시 쓰면 해당 이력을 정정합니다.",
    ],
    [
      "활동",
      "한 행은 한 활동자의 활동 기록입니다. 활동ID는 고유하게 입력합니다. 대상자ID는 연결할 때만 입력합니다.",
    ],
    [
      "활동자ID",
      "동명이인을 구분하려면 고유 활동자ID를 입력하세요. 비우면 구역+활동자명으로 활동자를 집계합니다.",
    ],
    [
      "활동 시간",
      "시간은 17, 17:00, 1700, 1710 형식으로 입력할 수 있습니다. 각각 17:00, 17:00, 17:00, 17:10으로 저장합니다. 시작·종료를 모두 비우면 0분이며 종료가 시작보다 빠르면 익일로 계산합니다.",
    ],
    [
      "구역일계",
      "구역별 보고 숫자를 보관합니다. 개인 상세 실적과 자동 합산하지 않습니다. 같은 일자+구역은 갱신합니다.",
    ],
    [
      "민감정보",
      "휴대폰 번호는 선택 입력이며 앞자리 0이 유지되도록 문자로 입력하세요. 이름 대신 식별명을 쓸 수 있습니다.",
    ],
    [
      "수식",
      "수식은 가져오지 않습니다. 수식이 있으면 복사 → 값 붙여넣기로 바꾸세요.",
    ],
    [
      "입력 제한",
      "총 입력 행 최대 10,000행, 파일 15MB. 원래 시트명과 열 이름을 유지하세요. 새 단계·사용자 항목은 프로그램 설정에서 먼저 추가합니다.",
    ],
    [
      "선택값",
      `성별: 남 / 여 / 기타 / 미입력 | 직장인구분(직업 구분): 등록된 공통코드 표시명 또는 코드값 | 단계: ${ws.stages
        .filter((s) => !ws.inactiveStages.includes(s))
        .map((s) => ws.stageNames[s])
        .join(" / ")}`,
    ],
    [
      "대상자 분류",
      "분류1: 개척 / 지인 / 가족. 분류2: 노방 / 소셜링 / 온라인 / 세미나 / 기타. 선택 입력입니다. 분류 열이 없는 이전 양식은 기존 값을 유지하고, 열이 있고 셀이 비어 있으면 해당 분류를 비웁니다.",
    ],
    [
      "예시 · 대상자",
      "P-0001 | 연습 대상 | 1구역 | 1 | 담당 가 | 2026-01-01 | 개척 | 노방 | 미입력 | 25 | 2026-01-01 | 직장인 | 첫 활성 단계",
    ],
    [
      "예시 · 단계변경",
      "S-0001 | P-0001 | 변경 전 단계명 | 변경 후 단계명 | 2026-01-02 14:00 | 일정 확정",
    ],
    [
      "주의",
      "이 양식은 암호화되지 않습니다. 입력 파일·백업을 접근 가능한 사람과 장치에만 보관하세요.",
    ],
  ];
  instructions.forEach((r) => help.addRow(r));
  help.getColumn(1).width = 24;
  help.getColumn(2).width = 110;
  help.getRow(1).height = 36;
  help.eachRow((row) => {
    row.height = row.number === 1 ? 36 : 43;
    row.eachCell((c) => {
      c.font = { name: "맑은 고딕", size: 11 };
      c.alignment = { wrapText: true, vertical: "middle" };
    });
  });
  help.getRow(1).eachCell((c) => {
    c.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FF194B3B" },
    };
    c.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 16 };
  });
  for (const [name, base] of Object.entries(SHEETS)) {
    if (D.HEADERS[name]) continue;
    const headers =
      name === "대상자"
        ? [...base, ...ws.fields.map((f) => `추가:${f.label}`)]
        : base;
    const sheet = workbook.addWorksheet(name, {
      views: [{ state: "frozen", ySplit: 1 }],
    });
    sheet.addRow(headers);
    sheet.getRow(1).height = 29;
    headers.forEach((label, i) => {
      const col = sheet.getColumn(i + 1);
      col.width =
        label.includes("메모") || label.includes("사유")
          ? 38
          : label.includes("시각")
            ? 23
            : 18;
      col.numFmt = label === "복신일" ? "yyyy-mm-dd" : "@";
    });
    sheet.getRow(1).eachCell((c) => {
      c.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FF194B3B" },
      };
      c.font = { name: "맑은 고딕", bold: true, color: { argb: "FFFFFFFF" } };
      c.alignment = { vertical: "middle" };
    });
    sheet.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: 1, column: headers.length },
    };
    for (let n = 2; n <= 21; n++) {
      sheet.getRow(n).height = 24;
      headers.forEach((_, i) => {
        const cell = sheet.getCell(n, i + 1);
        cell.border = {
          bottom: { style: "hair", color: { argb: "FFE2EADD" } },
        };
        cell.font = { name: "맑은 고딕", size: 11 };
      });
    }
    const selections = {
      분류1: M.PERSON_CLASSIFICATIONS.classification1,
      분류2: M.PERSON_CLASSIFICATIONS.classification2,
      성별: ["미입력", "남", "여", "기타"],
      구분: ["탈락", "복귀"],
      사용상태: ["사용", "보관"],
      상태: ["활동 중", "보관"],
    };
    for (const [label, values] of Object.entries(selections)) {
      const index = headers.indexOf(label) + 1;
      if (index)
        for (let row = 2; row <= 1001; row++)
          sheet.getCell(row, index).dataValidation = {
            type: "list",
            allowBlank: true,
            formulae: [`"${values.join(",")}"`],
            showErrorMessage: true,
            error: "선택값을 확인해 주세요.",
          };
    }
    const linked = {
      반: "className",
      직장인구분: "employment",
      직책: "position",
      활동종류: "activityKind",
      활동장소: "activityPlace",
      단계: "goalStages",
    };
    for (const f of ws.fields)
      if (name === "대상자" && f.type === "select") {
        const listKey = f.codeGroupId || `field_${f.id}`;
        if (!f.codeGroupId) namedList(listKey, f.options);
        linked[`추가:${f.label}`] = listKey;
      }
    for (const [label, key] of Object.entries(linked)) {
      const index = headers.indexOf(label) + 1,
        list = lists.get(key);
      if (index && list)
        for (let row = 2; row <= 1001; row++)
          sheet.getCell(row, index).dataValidation = {
            type: "list",
            allowBlank: true,
            formulae: [list],
            showErrorMessage: true,
            error:
              "등록된 선택값을 사용해 주세요. 새 값은 공통코드 관리에서 추가하세요.",
          };
    }
    if (name === "목표") {
      sheet.getColumn(3).numFmt = "yyyy-mm-dd";
      sheet.getColumn(4).numFmt = "yyyy-mm-dd";
      sheet.getColumn(5).numFmt = "#,##0";
      for (let row = 2; row <= 1001; row++)
        sheet.getCell(row, 5).dataValidation = {
          type: "whole",
          operator: "between",
          allowBlank: true,
          formulae: [0, M.MAX_GOAL_TARGET],
          showErrorMessage: true,
          error: `0~${M.MAX_GOAL_TARGET.toLocaleString("ko-KR")} 사이의 정수를 입력하세요.`,
        };
    }
  }
  // Keep human instructions first; the lookup sheet is internal to dropdowns.
  lookup.orderNo = 1000;
  workbook.worksheets.forEach((s, i) => {
    if (s !== lookup) s.orderNo = i;
  });
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
function equivalent(a, b) {
  const clean = (v) =>
    Object.fromEntries(
      Object.entries(v).filter(
        ([k]) => !["id", "createdAt", "updatedAt"].includes(k),
      ),
    );
  return JSON.stringify(clean(a)) === JSON.stringify(clean(b));
}
async function previewImport(ws, buffer, actor, options = {}) {
  checkZip(buffer);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer, {
    ignoreNodes: ["drawing", "legacyDrawing", "extLst"],
  });
  if (options.dailyAreaFile !== undefined) {
    const dailyArea = require("./daily-area-import.cjs").select(workbook, options.dailyAreaFile);
    if (dailyArea) return { dailyArea };
  }
  if (options.mode === "person-update")
    return require("./person-updates.cjs").preview(ws, workbook, actor, {
      str,
      day,
      stageID,
    });
  const duplicate = Preview.duplicateCollector();
  const errors = [],
    warnings = [],
    counts = {
      "신규 대상자": 0,
      "대상자 정보 갱신": 0,
      "단계 변경": 0,
      "탈락·복귀": 0,
      "활동 신규": 0,
      "활동 수정": 0,
      "구역 일계": 0,
      "중복 건너뜀": 0,
      "조직·구성원": 0,
      공통코드: 0,
      목표: 0,
    },
    draft = M.copy(ws),
    rowsBySheet = {};
  let total = 0;
  for (const sheet of workbook.worksheets) {
    if (sheet.name === "_선택목록") {
      if (
        !["hidden", "veryHidden"].includes(sheet.state) ||
        sheet.rowCount > 501 ||
        sheet.columnCount > 100
      )
        errors.push("선택 목록 시트 형식을 확인해 주세요.");
      sheet.eachRow((row) =>
        row.eachCell((cell) => {
          if (cell.value && typeof cell.value === "object")
            errors.push("선택 목록의 수식·링크 셀은 허용하지 않습니다.");
        }),
      );
      continue;
    }
    if (sheet.name === "작성안내") continue;
    if (!IMPORT_SHEETS[sheet.name]) {
      if (sheet.actualRowCount > 0)
        errors.push(
          `알 수 없는 시트: ${sheet.name}. 입력 템플릿을 사용해 주세요.`,
        );
      continue;
    }
    if (sheet.actualRowCount > 10001) {
      errors.push(`${sheet.name}: 시트당 최대 10,000행입니다.`);
      continue;
    }
    const headers = [];
    const personSheet = ["대상자", "찾기건"].includes(sheet.name);
    sheet
      .getRow(1)
      .eachCell(
        { includeEmpty: true },
        (cell, i) => {
          const label = str(cell.value);
          headers[i - 1] = label;
          if (personSheet && isPhoneHeader(label)) headers[i - 1] = PHONE_HEADER;
          if (personSheet && label === "복신") headers[i - 1] = "복신일";
        },
      );
    const allowed =
      sheet.name === "대상자"
        ? [...SHEETS[sheet.name], ...ws.fields.map((f) => `추가:${f.label}`)]
        : sheet.name === "활동기록"
          ? [...IMPORT_SHEETS[sheet.name], "회차ID"]
          : sheet.name === "활동일보"
            ? [...IMPORT_SHEETS[sheet.name], "휴식분"]
            : IMPORT_SHEETS[sheet.name];
    if (
      new Set(headers).size !== headers.length ||
      headers.some((h) => !allowed.includes(h)) ||
      IMPORT_SHEETS[sheet.name].some(
        (h) =>
          h !== "인도자ID" &&
          !(
            personSheet &&
            ["만픽일", "찾A일", "복신일", "분류1", "분류2", PHONE_HEADER].includes(h)
          ) &&
          !(sheet.name === "목표" && ["반", "기간단위"].includes(h)) &&
          !(["활동", "활동기록"].includes(sheet.name) && h === "분류2") &&
          !headers.includes(h),
      )
    ) {
      errors.push(`${sheet.name}: 열 이름이 템플릿과 다르거나 중복됩니다.`);
      continue;
    }
    rowsBySheet[sheet.name] = [];
    sheet.eachRow((row, index) => {
      if (
        index === 1 ||
        !row.values.some((v) => v !== null && v !== undefined && v !== "")
      )
        return;
      total++;
      if (total > 10000) return;
      try {
        const data = {};
        headers.forEach((h, i) => {
          const v = row.getCell(i + 1).value;
          if (v && typeof v === "object" && !(v instanceof Date) && !v.richText)
            throw new Error("수식·링크·오류 셀을 값으로 바꿔 주세요.");
          // All import paths receive the visible text, never ExcelJS rich-text objects.
          data[h] = v && typeof v === "object" && v.richText ? str(v) : v;
        });
        rowsBySheet[sheet.name].push({ index, data });
      } catch (e) {
        errors.push(`${sheet.name} ${index}행: ${e.message}`);
      }
    });
  }
  if (total > 10000)
    errors.push("한 번에 가져올 수 있는 총 입력 행은 10,000행입니다.");
  if (!total) errors.push("가져올 입력 행이 없습니다.");
  const seenPeople = new Map(),
    seenActivity = new Map(),
    seenEvents = new Map(),
    seenDaily = new Map();
  const recordOnce = (seen, key, sheet, index, data, message) => {
    const first = seen.get(key);
    if (first)
      duplicate.add(sheet, index, data, first.data, {
        matchedRow: first.index,
        matchedSheet: sheet,
        reason: message,
        blocking: true,
      });
    M.assert(!first, message);
    seen.set(key, { index, data });
  };
  const handleRow = (sheet, row, fn) => {
    try {
      const before = counts["중복 건너뜀"];
      const existing = fn(row.data, row.index);
      if (counts["중복 건너뜀"] > before)
        duplicate.add(
          sheet,
          row.index,
          row.data,
          existing,
          existing ? {} : { reason: "목표 건수가 비어 있어 건너뜁니다." },
        );
    } catch (e) {
      errors.push(`${sheet} ${row.index}행: ${e.message}`);
    }
  };
  const handle = (sheet, fn) => {
    for (const row of rowsBySheet[sheet] || []) handleRow(sheet, row, fn);
  };
  const findPerson = (value) => {
    const code = str(value);
    M.assert(code, "대상자ID를 입력해 주세요.");
    const p = draft.people.find((p) => p.code === code);
    M.assert(p, `대상자ID를 찾을 수 없습니다: ${code}`);
    return p;
  };
  try {
    const simple = require("./simple-roster.cjs").apply(
      draft,
      rowsBySheet,
      actor,
      duplicate.add,
    );
    counts["조직·구성원"] += simple.changed;
    counts["중복 건너뜀"] += simple.skipped;
  } catch (e) {
    errors.push(e.message);
  }
  try {
    const seenCodes = new Map();
    const rows = (rowsBySheet["공통코드"] || []).map(({ data: d, index }) => {
      recordOnce(
        seenCodes,
        JSON.stringify([str(d.그룹ID), str(d.코드값)]),
        "공통코드",
        index,
        d,
        "파일 안에서 코드 그룹·코드값이 중복됩니다.",
      );
      const state = str(d["사용상태"]) || "사용",
        groupState = str(d["그룹상태"]) || "사용";
      M.assert(
        ["사용", "보관"].includes(state) &&
          ["사용", "보관"].includes(groupState),
        "공통코드 상태는 사용/보관으로 입력해 주세요.",
      );
      let aliases = [];
      if (str(d["이전표시명JSON"])) {
        aliases = JSON.parse(str(d["이전표시명JSON"]));
        M.assert(
          Array.isArray(aliases) && aliases.every((v) => typeof v === "string"),
          "이전표시명JSON은 문자 배열로 입력해 주세요.",
        );
      }
      return {
        groupId: str(d["그룹ID"]),
        groupLabel: str(d["그룹명"]),
        value: str(d["코드값"]),
        label: str(d["표시명"]),
        aliases,
        active: state === "사용",
        groupActive: groupState === "사용",
        source: { index, data: d },
        order: str(d["정렬순서"]) === "" ? undefined : Number(d["정렬순서"]),
      };
    });
    const result = K.importRows(draft, rows, (row, existing) =>
      duplicate.add("공통코드", row.source.index, row.source.data, existing),
    );
    result.changes.forEach((d) =>
      M.audit(draft, actor, "엑셀 공통코드 변경", d.after.id, d.before, {
        ...d.after,
        groupId: d.groupId,
      }),
    );
    counts["공통코드"] = result.changes.length;
    counts["중복 건너뜀"] += result.skipped;
  } catch (e) {
    errors.push(`공통코드: ${e.message}`);
  }
  try {
    const seenNodes = new Map(),
      seenMembers = new Map();
    const nodes = (rowsBySheet["조직"] || []).map(({ data: d, index }) => {
      recordOnce(
        seenNodes,
        str(d.조직ID),
        "조직",
        index,
        d,
        `조직ID가 중복됩니다: ${str(d.조직ID)}`,
      );
      const state = str(d["사용상태"]) || "사용";
      M.assert(
        ["사용", "보관"].includes(state),
        "조직 사용상태는 사용/보관으로 입력해 주세요.",
      );
      return {
        code: str(d["조직ID"]),
        name: str(d["조직명"]),
        type: str(d["조직유형"]),
        parentCode: str(d["상위조직ID"]),
        leaderCode: str(d["책임자구성원ID"]),
        leaderTitle: str(d["책임자호칭"]) || "책임자",
        reportRegion: str(d["데이터구역명"]),
        active: state === "사용",
      };
    });
    const members = (rowsBySheet["구성원"] || []).map(({ data: d, index }) => {
      recordOnce(
        seenMembers,
        str(d.구성원ID),
        "구성원",
        index,
        d,
        `구성원ID가 중복됩니다: ${str(d.구성원ID)}`,
      );
      const state = str(d["상태"]) || "활동 중";
      M.assert(
        ["활동 중", "보관"].includes(state),
        "구성원 상태는 활동 중/보관으로 입력해 주세요.",
      );
      return {
        code: str(d["구성원ID"]),
        name: str(d["이름"]),
        unitCode: str(d["소속조직ID"]),
        position: str(d["직책"]),
        className: str(d["반"]),
        employment: str(d["직장인구분"]) || "미입력",
        status: state === "보관" ? "inactive" : "active",
        notes: str(d["메모"]),
      };
    });
    const changes = O.importRows(draft, nodes, members);
    for (const c of changes)
      M.audit(
        draft,
        actor,
        c.kind === "nodes" ? "엑셀 조직 변경" : "엑셀 구성원 변경",
        c.after.id,
        c.before,
        c.after,
      );
    counts["조직·구성원"] += changes.length;
    counts["중복 건너뜀"] += nodes.length + members.length - changes.length;
    const changed = new Set(changes.map(({ after }) => after.id));
    for (const [sheet, seen, records] of [
      ["조직", seenNodes, draft.organization.nodes],
      ["구성원", seenMembers, draft.organization.members],
    ]) {
      for (const existing of records) {
        const input = seen.get(existing.code);
        if (input && !changed.has(existing.id))
          duplicate.add(sheet, input.index, input.data, existing);
      }
    }
  } catch (e) {
    errors.push(`조직·구성원: ${e.message}`);
  }
  const simpleRecords = require("./simple-records.cjs").apply(
    draft,
    rowsBySheet,
    actor,
    { str, day, clock, stageID, duplicate: duplicate.add },
  );
  errors.push(...simpleRecords.errors);
  for (const [key, value] of Object.entries(simpleRecords.counts))
    counts[key] += value;
  const suppliedMilestones = new Map();
  handle("대상자", (d, index) => {
    const code = M.text(str(d["대상자ID"]), 60, true);
    recordOnce(
      seenPeople,
      code,
      "대상자",
      index,
      d,
      `파일 안에서 대상자ID가 중복됩니다: ${code}`,
    );
    const before = draft.people.find((p) => p.code === code) || null,
      initialStage = str(d["최초단계"]) ? stageID(draft, d["최초단계"]) : null,
      stage =
        before?.stage ||
        initialStage ||
        draft.stages.find((s) => !draft.inactiveStages.includes(s));
    const custom = { ...(before?.custom || {}) };
    let introducerId = before?.introducerId || "";
    if (Object.hasOwn(d, "인도자ID")) {
      const memberCode = str(d["인도자ID"]),
        member = O.get(draft).members.find((m) => m.code === memberCode);
      M.assert(
        !memberCode || member,
        `인도자ID를 찾을 수 없습니다: ${memberCode}`,
      );
      introducerId = member?.id || "";
    }
    for (const f of draft.fields) {
      const key = `추가:${f.label}`;
      if (!Object.hasOwn(d, key)) continue;
      const v = d[key];
      custom[f.id] =
        f.type === "number"
          ? str(v) === ""
            ? ""
            : Number(v)
          : f.type === "date"
            ? day(v, false)
            : f.type === "boolean"
              ? ["예", "true", "1", "Y"].includes(str(v))
              : str(v);
    }
    const p = M.validatePerson(
      {
        code,
        name: str(d["이름"]),
        region:
          str(d["구역"]) ||
          (Object.hasOwn(d, "인도자ID") && introducerId
            ? O.regionOf(
                O.get(draft),
                O.get(draft).members.find((m) => m.id === introducerId).unitId,
              )
            : ""),
        className: str(d["반"]),
        worker: str(d["담당자"]),
        introducerId,
        date: day(d["찾은날짜"]),
        ...(Object.hasOwn(d, "분류1") ? { classification1: str(d.분류1) } : {}),
        ...(Object.hasOwn(d, "분류2") ? { classification2: str(d.분류2) } : {}),
        gender: str(d["성별"]) || "미입력",
        phone: readPhone(d[PHONE_HEADER]) || before?.phone,
        age: str(d["나이"]),
        ageAsOf: day(d["나이기준일"], false) || day(d["찾은날짜"]),
        employment: str(d["직장인구분"]) || "미입력",
        stage,
        notes: str(d["메모"]),
        custom,
      },
      draft,
      before,
    );
    let initialCorrection = null;
    if (before && initialStage && p.transitions[0].to !== initialStage) {
      initialCorrection = M.copy(p.transitions[0]);
      p.transitions[0].to = initialStage;
      p.transitions[0].toName = draft.stageNames[initialStage] || initialStage;
      if (p.transitions.length === 1) p.stage = initialStage;
    }
    if (!before) {
      M.transition(
        p,
        null,
        p.stage,
        p.date + "T00:00",
        actor,
        "엑셀 최초 등록",
        draft.stageNames,
      );
    }
    const dates = {
      manpikDate: d.만픽일 ? day(d.만픽일) : "",
      findADate: d.찾A일 ? day(d.찾A일) : "",
      bokshinDate: d.복신일 ? day(d.복신일) : "",
    };
    const stageDateChanges = S.apply(p, dates, draft);
    suppliedMilestones.set(code, dates);
    if (before && equivalent(before, p)) {
      counts["중복 건너뜀"]++;
      return before;
    }
    if (before) {
      draft.people[draft.people.indexOf(before)] = p;
      counts["대상자 정보 갱신"]++;
    } else {
      draft.people.push(p);
      counts["신규 대상자"]++;
    }
    const delta = M.personChanges(before, p);
    if (!before || Object.keys(delta.after).length)
      M.audit(
        draft,
        actor,
        before ? "엑셀 대상자 수정" : "엑셀 대상자 등록",
        p.id,
        delta.before,
        delta.after,
      );
    if (initialCorrection)
      M.audit(
        draft,
        actor,
        "엑셀 최초 단계 정정",
        p.id,
        initialCorrection,
        p.transitions[0],
      );
    S.audit(draft, actor, p, stageDateChanges);
  });
  const stageRows = (rowsBySheet["단계변경"] || []).slice().sort((a, b) => {
    try {
      return datetime(a.data["적용시각"]).localeCompare(
        datetime(b.data["적용시각"]),
      );
    } catch {
      return a.index - b.index;
    }
  });
  rowsBySheet["단계변경"] = stageRows;
  const processStage = (d, index) => {
    const code = M.text(str(d["변경ID"]), 60, true),
      key = `stage:${code}`;
    recordOnce(
      seenEvents,
      key,
      "단계변경",
      index,
      d,
      `변경ID가 중복됩니다: ${code}`,
    );
    const p = findPerson(d["대상자ID"]),
      to = stageID(draft, d["변경후단계"]),
      effective = datetime(d["적용시각"]),
      effectiveDay = effective.slice(0, 10),
      reason = M.text(str(d["변경사유"]), 2000),
      existing = draft.people
        .flatMap((p) => p.transitions.map((t) => ({ p, t })))
        .find((x) => x.t.code === code);
    if (existing)
      M.assert(existing.p.id === p.id, `다른 대상자의 변경ID입니다: ${code}`);
    const field = Object.keys(S.FIELDS).find(
      (key) => S.stageId(draft, key) === to,
    );
    const first = p.transitions.find((event) => event.to === to);
    const suppliedDay = field && suppliedMilestones.get(p.code)?.[field];
    if (suppliedDay && (!first || first === existing?.t)) {
      const { label } = Milestones.fields.find((milestone) => milestone.field === field);
      M.assert(
        suppliedDay === effectiveDay,
        `대상자 시트의 ${label}(${suppliedDay})과 단계변경 시트의 적용일(${effectiveDay})이 다릅니다. 날짜를 맞춰 주세요.`,
      );
    }
    if (existing) {
      const from = str(d["변경전단계"])
        ? stageID(draft, d["변경전단계"])
        : existing.t.from;
      if (
        existing.t.from === from &&
        existing.t.to === to &&
        existing.t.effectiveLocal === effective &&
        existing.t.reason === reason
      ) {
        counts["중복 건너뜀"]++;
        return { ...existing.t, name: p.name, personCode: p.code };
      }
      const linkedMilestone =
        field &&
        first === existing.t &&
        p.stageDates?.[field] === existing.t.effectiveLocal.slice(0, 10);
      const before = {
        stage: p.stage,
        event: M.copy(existing.t),
        ...(linkedMilestone ? { stageDates: M.copy(p.stageDates) } : {}),
      };
      Object.assign(existing.t, {
        from,
        to,
        effectiveLocal: effective,
        reason,
        fromName: from ? draft.stageNames[from] || from : "",
        toName: draft.stageNames[to] || to,
      });
      if (linkedMilestone) p.stageDates[field] = effectiveDay;
      if (p.transitions.at(-1).id === existing.t.id) p.stage = to;
      p.updatedAt = M.now();
      M.audit(draft, actor, "엑셀 단계 이력 정정", p.id, before, {
        stage: p.stage,
        event: existing.t,
        ...(linkedMilestone ? { stageDates: p.stageDates } : {}),
      });
      counts["단계 변경"]++;
      return;
    }
    const from = str(d["변경전단계"])
      ? stageID(draft, d["변경전단계"])
      : p.stage;
    if (from === to && field === "bokshinDate" && first) {
      counts["중복 건너뜀"]++;
      return { ...first, name: p.name, personCode: p.code };
    }
    const before = p.stage,
      ev = M.transition(
        p,
        from,
        to,
        effective,
        actor,
        reason,
        draft.stageNames,
      );
    ev.code = code;
    p.stage = to;
    p.updatedAt = M.now();
    M.audit(draft, actor, "엑셀 단계 변경", p.id, { stage: before }, ev);
    counts["단계 변경"]++;
  };
  rowsBySheet["탈락복귀"] = (rowsBySheet["탈락복귀"] || [])
    .slice()
    .sort((a, b) => {
      try {
        return datetime(a.data["적용시각"]).localeCompare(
          datetime(b.data["적용시각"]),
        );
      } catch {
        return a.index - b.index;
      }
    });
  const processLife = (d, index) => {
    const code = M.text(str(d["변경ID"]), 60, true),
      key = `life:${code}`;
    recordOnce(
      seenEvents,
      key,
      "탈락복귀",
      index,
      d,
      `변경ID가 중복됩니다: ${code}`,
    );
    const p = findPerson(d["대상자ID"]),
      kind = str(d["구분"]);
    M.assert(["탈락", "복귀"].includes(kind), "구분은 탈락 또는 복귀입니다.");
    const to = kind === "탈락" ? "dropped" : "active",
      effective = datetime(d["적용시각"]),
      reason = M.text(str(d["사유"]), 2000),
      existing = draft.people
        .flatMap((p) => p.lifecycle.map((t) => ({ p, t })))
        .find((x) => x.t.code === code);
    if (existing) {
      M.assert(existing.p.id === p.id, `다른 대상자의 변경ID입니다: ${code}`);
      if (
        existing.t.to === to &&
        existing.t.effectiveLocal === effective &&
        existing.t.reason === reason
      ) {
        counts["중복 건너뜀"]++;
        return { ...existing.t, name: p.name, personCode: p.code };
      }
      const before = { status: p.status, event: M.copy(existing.t) };
      Object.assign(existing.t, { to, effectiveLocal: effective, reason });
      if (p.lifecycle.at(-1).id === existing.t.id) p.status = to;
      p.updatedAt = M.now();
      M.audit(draft, actor, "엑셀 탈락·복귀 이력 정정", p.id, before, {
        status: p.status,
        event: existing.t,
      });
      counts["탈락·복귀"]++;
      return;
    }
    const ev = M.lifecycleChange(p, to, effective, actor, reason);
    ev.code = code;
    M.audit(draft, actor, `엑셀 ${kind}`, p.id, null, ev);
    counts["탈락·복귀"]++;
  };
  const events = [
    ...(rowsBySheet["단계변경"] || []).map((row) => ({
      ...row,
      sheet: "단계변경",
    })),
    ...(rowsBySheet["탈락복귀"] || []).map((row) => ({
      ...row,
      sheet: "탈락복귀",
    })),
  ].sort((a, b) => {
    try {
      return (
        datetime(a.data["적용시각"]).localeCompare(
          datetime(b.data["적용시각"]),
        ) || a.index - b.index
      );
    } catch {
      return a.index - b.index;
    }
  });
  for (const row of events)
    handleRow(
      row.sheet,
      row,
      row.sheet === "단계변경" ? processStage : processLife,
    );
  handle("활동", (d, index) => {
    const code = M.text(str(d["활동ID"]), 60, true);
    recordOnce(
      seenActivity,
      code,
      "활동",
      index,
      d,
      `활동ID가 중복됩니다: ${code}`,
    );
    const owner = str(d["대상자ID"]) ? findPerson(d["대상자ID"]) : null,
      list = owner ? owner.activities : draft.activityLogs;
    const existing = [
      ...draft.activityLogs.map((a) => ({ a, p: null })),
      ...draft.people.flatMap((p) => p.activities.map((a) => ({ a, p }))),
    ].find((x) => x.a.code === code);
    M.assert(
      !existing || existing.p?.id === owner?.id,
      "기존 활동의 대상자 연결을 바꿀 수 없습니다. 새 활동ID를 사용해 주세요.",
    );
    const before = existing?.a || null,
      after = M.validateActivity(
        {
          code,
          date: day(d["활동일"]),
          region: str(d["구역"]) || owner?.region || "",
          workerId: str(d["활동자ID"]),
          worker: M.text(str(d["활동자명"]), 100, true),
          start: clock(d["시작"]),
          end: clock(d["종료"]),
          place: str(d["활동장소"]),
          kind: str(d["활동종류"]) || "대화",
          notes: str(d["메모"]),
          ...(Object.hasOwn(d, "분류2")
            ? { classification2: str(d.분류2) }
            : {}),
        },
        before,
        draft,
      );
    if (before && equivalent(before, after)) {
      counts["중복 건너뜀"]++;
      return before;
    }
    if (before) {
      list[list.indexOf(before)] = after;
      counts["활동 수정"]++;
    } else {
      list.push(after);
      counts["활동 신규"]++;
    }
    M.audit(
      draft,
      actor,
      before ? "엑셀 활동 수정" : "엑셀 활동 등록",
      owner?.id || after.id,
      before,
      after,
    );
  });
  handle("구역일계", (d, index) => {
    const region = M.text(str(d["구역"]), 60, true),
      date = day(d["일자"]),
      key = JSON.stringify([region, date]);
    recordOnce(
      seenDaily,
      key,
      "구역일계",
      index,
      d,
      "파일 안에서 같은 일자·구역이 중복됩니다.",
    );
    const before =
        draft.dailyReports.find(
          (r) => r.region === region && r.date === date,
        ) || null,
      after = {
        id: before?.id || M.uuid(),
        region,
        date,
        found: integer(d["찾B건수"], "찾B건수"),
        advanced: integer(d["단계향상건수"], "단계향상건수"),
        dropped: integer(d["탈락건수"], "탈락건수"),
        notes: M.text(str(d["메모"]), 2000),
      };
    if (before && equivalent(before, after)) {
      counts["중복 건너뜀"]++;
      return before;
    }
    if (before) draft.dailyReports[draft.dailyReports.indexOf(before)] = after;
    else draft.dailyReports.push(after);
    M.audit(draft, actor, "엑셀 구역 일계 입력", after.id, before, after);
    counts["구역 일계"]++;
  });
  const seenGoals = new Map();
  D.applyRows(
    draft,
    rowsBySheet,
    actor,
    counts,
    errors,
    warnings,
    duplicate.add,
  );
  handle("목표", (d, index) => {
    if (str(d["목표건수"]) === "") {
      counts["중복 건너뜀"]++;
      return;
    }
    const stage = str(d["단계"]);
    M.assert(stage, "목표 단계를 입력해 주세요.");
    const goal = G.normalize(draft, {
      region: str(d["구역"]),
      stageId: ["*", "신규 대상자 등록"].includes(stage)
        ? "*"
        : stageID(draft, stage),
      from: day(d["시작일"]),
      to: day(d["종료일"]),
      target: d["목표건수"],
      className: str(d["반"]),
      periodUnit: str(d["기간단위"]),
    });
    const key = G.key(goal);
    recordOnce(
      seenGoals,
      key,
      "목표",
      index,
      d,
      "파일 안에서 같은 구역·반·기간·단계의 목표가 중복됩니다.",
    );
    if (G.save(draft, goal, actor, goal.region ? "엑셀 구역 목표 설정" : "엑셀 반별 목표 설정")) counts["목표"]++;
    else {
      counts["중복 건너뜀"]++;
      return draft.goals.find((g) => G.key(g) === key);
    }
  });
  if (!errors.length)
    try {
      M.validateWorkspace(draft);
    } catch (e) {
      errors.push(e.message);
    }
  if (counts["대상자 정보 갱신"])
    warnings.push(
      "같은 대상자ID의 기본 정보가 갱신됩니다. 휴대폰 번호의 빈칸은 기존 값을 유지하며 그 외 기본 정보의 빈칸은 빈 값으로 반영됩니다.",
    );
  if (counts["구역 일계"])
    warnings.push("구역 일계는 개인 상세 기록과 별도로 저장합니다.");
  const peopleById = new Map(draft.people.map((p) => [p.id, p]));
  const changes = draft.history
    .slice(ws.history.length, ws.history.length + Preview.PREVIEW_LIMIT)
    .map((h) => ({
      action: h.action,
      target: peopleById.get(h.target)?.code || h.target,
      displayName:
        peopleById.get(h.target)?.name ||
        h.after?.name ||
        h.after?.worker ||
        "",
      before: Preview.fields(h.before),
      after: Preview.fields(h.after),
    }));
  return {
    draft,
    errors,
    warnings,
    counts,
    changes,
    totalChanges: draft.history.length - ws.history.length,
    ...duplicate.result(),
  };
}
async function createOrganizationWorkbook(ws) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await createTemplate(ws));
  const org = O.get(ws),
    nodeCode = (id) => org.nodes.find((n) => n.id === id)?.code || "",
    memberCode = (id) => org.members.find((m) => m.id === id)?.code || "";
  org.nodes.forEach((n, i) => {
    wb.getWorksheet("조직").getRow(i + 2).values = [
      n.code,
      n.name,
      n.type,
      nodeCode(n.parentId),
      memberCode(n.leaderId),
      n.leaderTitle,
      n.reportRegion,
      n.active ? "사용" : "보관",
    ];
  });
  org.members.forEach((m, i) => {
    wb.getWorksheet("구성원").getRow(i + 2).values = [
      m.code,
      m.name,
      nodeCode(m.unitId),
      K.label(ws, "position", m.position),
      K.label(ws, "className", m.className),
      K.label(ws, "employment", m.employment),
      m.status === "active" ? "활동 중" : "보관",
      m.notes,
    ];
  });
  return wb.xlsx.writeBuffer();
}
async function createCodeWorkbook(ws) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await createTemplate(ws));
  const sheet = wb.getWorksheet("공통코드");
  let row = 2;
  for (const g of K.catalog(ws).groups) {
    if (!g.items.length) {
      sheet.getRow(row++).values = [
        g.id,
        g.label,
        "",
        "",
        "",
        "사용",
        0,
        g.active ? "사용" : "보관",
      ];
      continue;
    }
    for (const i of g.items)
      sheet.getRow(row++).values = [
        g.id,
        g.label,
        i.value,
        i.label,
        JSON.stringify(i.aliases),
        i.active ? "사용" : "보관",
        i.order,
        g.active ? "사용" : "보관",
      ];
  }
  return wb.xlsx.writeBuffer();
}
async function createGoalWorkbook(ws, { from, to }) {
  M.date(from);
  M.date(to);
  M.assert(from <= to, "목표 기간을 확인해 주세요.");
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await createTemplate(ws));
  const sheet = wb.getWorksheet("목표"),
    regions = [
      ...new Set(
        [
          ...O.get(ws)
            .nodes.filter((n) => n.active && n.reportRegion)
            .map((n) => n.reportRegion),
          ...ws.people.map((p) => p.region),
          ...ws.dailyReports.map((d) => d.region),
          ...ws.goals.map((g) => g.region),
        ].filter(Boolean),
      ),
    ].sort((a, b) => a.localeCompare(b, "ko", { numeric: true }));
  let row = 2;
  const stages = ws.stages.filter(
    (s) =>
      !ws.inactiveStages.includes(s) ||
      ws.goals.some((g) => g.stageId === s && g.from === from && g.to === to),
  );
  for (const region of regions)
    for (const stageId of ["*", ...stages]) {
      const g = ws.goals.find(
        (g) =>
          g.region === region &&
          !g.className &&
          (g.stageId || "*") === stageId &&
          g.from === from &&
          g.to === to,
      );
      sheet.getRow(row++).values = [
        region,
        stageId,
        new Date(`${from}T00:00:00Z`),
        new Date(`${to}T00:00:00Z`),
        g?.target ?? null,
        "",
        g?.periodUnit || "",
      ];
    }
  M.assert(
    row - 2 <= 10000,
    "목표 양식이 10,000행을 초과합니다. 빈 입력 템플릿의 목표 시트에 필요한 구역만 작성해 주세요.",
  );
  for (const g of ws.goals.filter(
    (g) => g.className && g.from === from && g.to === to,
  ))
    sheet.getRow(row++).values = [
      g.region,
      g.stageId || "*",
      new Date(`${from}T00:00:00Z`),
      new Date(`${to}T00:00:00Z`),
      g.target,
      K.label(ws, "className", g.className),
      g.periodUnit || "",
    ];
  // Stage IDs survive a display-name change and can be imported repeatedly.
  sheet.getColumn(2).width = 25;
  return Buffer.from(await wb.xlsx.writeBuffer());
}
async function createPersonUpdateTemplate() {
  const wb = new ExcelJS.Workbook();
  const { TEMPLATE_HEADERS, DATE_HEADERS } = require("./person-updates.cjs");
  const sheet = wb.addWorksheet("Sheet1", {
    views: [{ state: "frozen", ySplit: 1 }],
  });
  sheet.addRow(TEMPLATE_HEADERS);
  sheet.getRow(1).height = 36;
  sheet.getRow(1).alignment = { vertical: "middle", wrapText: true };
  sheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  sheet.getRow(1).fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FF176B58" },
  };
  sheet.columns.forEach((col, i) => {
    col.width = 18;
    col.numFmt = DATE_HEADERS.includes(TEMPLATE_HEADERS[i]) ? "yyyy-mm-dd" : "@";
  });
  const guide = wb.addWorksheet("작성안내");
  guide.addRows([
    [
      "대상자 찾기",
      "대상자ID 또는 대상자명·인도자·인도자구역으로 찾습니다. 휴대폰 번호로 같은 이름을 구분할 수 있습니다. 인도자가 없으면 대상자명과 휴대폰 번호를 사용합니다. 기존 찾기날짜는 유지합니다.",
    ],
    ["단계·교사·휴대폰 번호", "단계와 교사, 휴대폰 번호는 값이 있을 때 갱신합니다. 휴대폰 번호는 문자로 입력하세요."],
    [
      "탈락일",
      "날짜가 있으면 탈락으로 반영합니다. 빈칸은 기존 상태와 탈락일을 유지합니다.",
    ],
    [
      "단계별 날짜",
      "처음 해당 단계가 된 날짜입니다. YYYY-MM-DD 또는 Excel 날짜 셀을 사용합니다. 빈칸이면 기존 값을 유지합니다.",
    ],
    [
      "사유",
      "사유 열의 빈칸은 기존 사유를 비웁니다. 사유를 갱신하지 않으려면 해당 열을 제거하세요.",
    ],
  ]);
  guide.getColumn(1).width = 22;
  guide.getColumn(2).width = 100;
  guide.eachRow((row) => {
    row.alignment = { wrapText: true, vertical: "middle" };
    row.height = 40;
  });
  return Buffer.from(await wb.xlsx.writeBuffer());
}
async function createFindingTemplate(source) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(source);
  const sheet = wb.worksheets[0];
  const headers = sheet.getRow(1).values.slice(1);
  for (const label of ["만픽일", "찾A일", "복신일", PHONE_HEADER]) {
    if (!headers.includes(label)) headers.push(label);
    const column = headers.indexOf(label) + 1;
    sheet.getCell(1, column).value = label;
    sheet.getCell(1, column).style = { ...sheet.getCell(1, 12).style };
    sheet.getColumn(column).width = 18;
    sheet.getColumn(column).numFmt = label === PHONE_HEADER ? "@" : "yyyy-mm-dd";
  }
  const lastColumn = sheet.getColumn(headers.length).letter;
  sheet.autoFilter = `A1:${lastColumn}1`;
  sheet.pageSetup.printArea = `A1:${lastColumn}${Math.max(2, sheet.rowCount)}`;
  return Buffer.from(await wb.xlsx.writeBuffer());
}
async function createActivityTemplate(source) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(source);
  const sheet = wb.worksheets[0],
    headers = sheet.getRow(1).values.slice(1);
  if (!headers.includes("분류2")) headers.push("분류2");
  const column = headers.indexOf("분류2") + 1;
  sheet.getCell(1, column).value = "분류2";
  sheet.getCell(1, column).style = { ...sheet.getCell(1, 1).style };
  sheet.getColumn(column).width = 18;
  for (let row = 2; row <= 1001; row++)
    sheet.getCell(row, column).dataValidation = {
      type: "list",
      allowBlank: true,
      formulae: [`"${M.PERSON_CLASSIFICATIONS.classification2.join(",")}"`],
      showErrorMessage: true,
      error: "분류2를 선택해 주세요.",
    };
  sheet.autoFilter = `A1:${sheet.getColumn(headers.length).letter}1`;
  return Buffer.from(await wb.xlsx.writeBuffer());
}
module.exports = {
  cellText: str,
  createActivityTemplate,
  createPersonUpdateTemplate,
  createFindingTemplate,
  SHEETS,
  createTemplate,
  createOrganizationWorkbook,
  createCodeWorkbook,
  createGoalWorkbook,
  previewImport,
  checkZip,
};
