"use strict";
const M = require("./model.cjs"),
  D = require("./daily.cjs"),
  O = require("./organization.cjs"),
  S = require("./person-stages.cjs"),
  Milestones = require("./ui/person-milestones.js"),
  PersonUpdates = require("./person-updates.cjs");
const NEW_HEADERS = [
  "날짜",
  "분류1",
  "분류2",
  "사용도구",
  "단계",
  "대상자명",
  "성별",
  "나이",
  "거주지",
  "찾기장소",
  "시간",
  "인도자",
  "사유",
  "교사",
];
const UPDATE_HEADERS = PersonUpdates.TEMPLATE_HEADERS.filter(
  (header) => header !== "대상자ID",
);
const compact = (v) =>
  String(v || "")
    .normalize("NFC")
    .replace(/\s/g, "");
function preview(ws, text, context = {}) {
  const report = M.date(context.date),
    region = M.text(context.region, 60, true),
    parsed = D.parse(text, ws, {
      ...context,
      activityText: "",
      changesOnly: true,
    }),
    errors = [...parsed.errors],
    warnings = [],
    newRows = [],
    updateRows = [],
    counts = {
      "신규 찾B": 0,
      "단계 향상": 0,
      탈락: 0,
      "유지 제외": parsed.ignoredRetained,
      "이미 등록된 신규": 0,
      "기존 대상자 일치 없음": 0,
      "중복 제외": 0,
    },
    seen = new Map();
  const findings = parsed.rows.찾기일보,
    org = O.get(ws),
    members = org.members,
    matchTarget = PersonUpdates.targetMatcher(ws);
  const districtOf = (person) => person.region ||
    O.regionOf(org, members.find((member) => member.id === person.introducerId)?.unitId);
  if (context.findings !== undefined) {
    M.assert(
      Array.isArray(context.findings) &&
        context.findings.length === findings.length,
      "검토 행 수가 원문과 다릅니다. 다시 확인하세요.",
    );
    findings.forEach((row, i) => {
      for (const key of [...D.HEADERS.찾기일보, "교사", "사유"])
        if (Object.hasOwn(context.findings[i], key))
          row[key] = M.text(String(context.findings[i][key] ?? ""), 2000);
      row.보고일 = report;
      row.구역 = region;
    });
  }
  for (const row of findings) {
    try {
      if (row.구분 === "유지") {
        counts["유지 제외"]++;
        continue;
      }
      M.assert(
        ["신규", "탈락"].includes(row.구분),
        "신규/유지가 함께 있는 행은 신규인지 유지인지 검토 표에서 선택하세요.",
      );
      M.text(row.대상자, 100, true);
      M.text(row.인도자, 100, true);
      M.date(row.찾은날짜);
      const milestone = Milestones.fieldForStageLabel(row.단계);
      const milestoneStage = milestone && S.stageId(ws, milestone.field);
      const stage =
        (milestone?.field === "bokshinDate" && milestoneStage) ||
        ws.stages.find((k) =>
          [k, M.stageName(ws, k)].some((v) => compact(v) === compact(row.단계)),
        ) || milestoneStage;
      M.assert(
        stage,
        `단계 '${row.단계}'를 설정하거나 검토 표에서 선택하세요.`,
      );
      const foundStage =
        compact(stage) === "찾B" || compact(M.stageName(ws, stage)) === "찾B";
      const isNew = row.구분 === "신규" && foundStage;
      const introMembers = members.filter(
          (m) => m.code === row.인도자 || m.name === row.인도자,
        ),
        local = introMembers.filter(
          (m) => O.regionOf(org, m.unitId) === region,
        ),
        intro =
          local.length === 1
            ? local[0]
            : introMembers.length === 1
              ? introMembers[0]
              : null,
        introName = intro?.name || row.인도자;
      const identity = { code: row.대상자ID, name: row.대상자, introducer: introName };
      let candidates = isNew
        ? ws.people.filter(
          (p) =>
            p.date === row.찾은날짜 &&
            compact(p.name) === compact(row.대상자) &&
            (row.대상자ID
              ? p.code === row.대상자ID
              : [
                  p.worker,
                  p.introducerSnapshot?.name,
                  members.find((m) => m.id === p.introducerId)?.name,
                ].some((v) => compact(v) === compact(introName))),
        )
        : matchTarget({ ...identity, district: region })
            .filter((p) => compact(p.name) === compact(row.대상자));
      if (!isNew && !candidates.length && !identity.code) {
        const withoutDistrict = matchTarget(identity);
        if (withoutDistrict.length === 1 && !districtOf(withoutDistrict[0]))
          candidates = withoutDistrict;
      }
      M.assert(
        candidates.length <= 1,
        isNew
          ? "동일한 이름·찾은 날짜·인도자가 여러 명입니다. 대상자를 구분해 주세요."
          : "동일한 이름·인도자·인도자구역이 여러 명입니다. 대상자를 구분해 주세요.",
      );
      const existing = candidates[0];
      if (isNew && existing) {
        counts["이미 등록된 신규"]++;
        warnings.push(`${row._line}줄: 이미 등록된 신규 찾B는 제외했습니다.`);
        continue;
      }
      if (isNew && !context.findings && row._review?.length)
        errors.push(
          `${row._line}줄: ${row._review.join(" ")} 검토 후 다시 확인하세요.`,
        );
      if (!intro)
        warnings.push(
          `${row._line}줄: 인도자 '${introName}'의 명부 연결을 엑셀 가져오기 전에 확인하세요.`,
        );
      const patch = isNew
        ? {
            날짜: row.찾은날짜,
            분류1: "",
            분류2: "",
            사용도구: row.도구,
            단계: M.stageName(ws, stage),
            대상자명: row.대상자,
            성별: row.성별,
            나이: row.나이,
            거주지: row.거주지,
            찾기장소: row.찾기장소,
            시간: row.찾기시간,
            인도자: introName,
            사유: row.사유 || "",
            교사: row.교사 || "",
          }
        : {
            단계: M.stageName(
              ws,
              row.구분 === "탈락" && existing ? existing.stage : stage,
            ),
            대상자명: existing?.name || row.대상자,
            성별: existing?.gender || row.성별,
            나이: existing?.age ?? row.나이,
            거주지: existing?.residence || row.거주지,
            인도자: introName,
            인도자구역: existing ? districtOf(existing) : region,
            교사: row.교사 || existing?.teacher || "",
            찾기날짜: existing?.date || row.찾은날짜,
            ...Object.fromEntries(
              Milestones.fields.map(({ field, header }) => {
                const knownDate = existing ? S.value(existing, field, ws) : "";
                const reportedDate =
                  row.구분 === "신규" && S.stageId(ws, field) === stage
                    ? report
                    : "";
                return [header, knownDate || reportedDate];
              }),
            ),
            탈락일: row.구분 === "탈락" ? report : "",
            사유: row.사유 || existing?.reason || "",
            단계변경일: row.구분 === "신규" ? report : "",
          };
      const id = JSON.stringify([
          patch.대상자명,
          patch.날짜 || patch.찾기날짜,
          introName,
        ]),
        signature = M.hash(patch);
      if (seen.has(id)) {
        M.assert(
          seen.get(id) === signature,
          "같은 대상자의 변경 내용이 서로 다릅니다. 일보를 확인하세요.",
        );
        counts["중복 제외"]++;
        continue;
      }
      seen.set(id, signature);
      if (!isNew && !existing) {
        counts["기존 대상자 일치 없음"]++;
        warnings.push(
          `${row._line}줄: 기존 대상자가 일치하지 않습니다. 업데이트 파일의 대상자명·인도자·인도자구역을 확인하세요.`,
        );
      }
      if (isNew) {
        newRows.push(patch);
        counts["신규 찾B"]++;
      } else {
        updateRows.push(patch);
        counts[row.구분 === "탈락" ? "탈락" : "단계 향상"]++;
      }
    } catch (e) {
      errors.push(`${row._line}줄: ${e.message}`);
    }
  }
  return {
    counts,
    errors,
    warnings: [...new Set(warnings)],
    findings,
    newRows,
    updateRows,
    activities: [],
    date: report,
    region,
  };
}
async function workbook(kind, rows) {
  const ExcelJS = require("exceljs"),
    w = new ExcelJS.Workbook(),
    headers = kind === "new" ? NEW_HEADERS : UPDATE_HEADERS,
    s = w.addWorksheet(kind === "new" ? "찾기건" : "Sheet1", {
      views: [{ state: "frozen", ySplit: 1 }],
    });
  s.addRow(headers);
  const dateHeaders = new Set(["날짜", ...PersonUpdates.DATE_HEADERS]);
  for (const row of rows)
    s.addRow(
      headers.map((h) =>
        dateHeaders.has(h) && row[h]
          ? new Date(row[h] + "T00:00:00Z")
          : (row[h] ?? ""),
      ),
    );
  headers.forEach((h, i) => {
    if (dateHeaders.has(h)) s.getColumn(i + 1).numFmt = "yyyy-mm-dd";
  });
  s.columns.forEach((c) => (c.width = 18));
  s.getColumn(2).width = 22;
  s.getRow(1).height = kind === "new" ? 28 : 36;
  s.getRow(1).eachCell((c) => {
    c.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FF194B3B" },
    };
    c.font = { name: "맑은 고딕", bold: true, color: { argb: "FFFFFFFF" } };
    if (kind !== "new") c.alignment = { vertical: "middle", wrapText: true };
  });
  s.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: rows.length + 1, column: headers.length },
  };
  return Buffer.from(await w.xlsx.writeBuffer());
}
async function archive(root, result, protectedDirectory, extraFiles = []) {
  const fs = require("node:fs/promises"),
    path = require("node:path"),
    directory = path.resolve(root),
    protectedRoot = path.resolve(protectedDirectory).toLowerCase();
  M.assert(!result.errors.length, result.errors.join("\n"));
  M.assert(
    directory.toLowerCase() !== protectedRoot &&
      !directory.toLowerCase().startsWith(protectedRoot + path.sep),
    "프로그램 저장소 밖의 보관 폴더를 선택하세요.",
  );
  const prepared = [...extraFiles];
  for (const [kind, rows, title] of [
    ["new", result.newRows, "찾B 신규건"],
    ["update", result.updateRows, "찾기건 추가 업데이트"],
  ])
    if (rows.length)
      prepared.push({ kind, title, bytes: await workbook(kind, rows) });
  const files = [];
  try {
    for (const p of prepared) {
      const folder = path.join(directory, result.date);
      await fs.mkdir(folder, { recursive: true });
      const safe =
        (p.fileStem || result.region)
          .replace(/[<>:"/\\|?*\x00-\x1F]/g, "-")
          .replace(/[. ]+$/g, "") || "구역";
      const stem = p.fileStem ? safe : `${safe}-${p.title}`;
      let saved = false;
      for (let n = 1; n < 10000; n++) {
        const file = path.join(
          folder,
          `${stem}${n > 1 ? `-${String(n).padStart(2, "0")}` : ""}.xlsx`,
        );
        let handle;
        try {
          handle = await fs.open(file, "wx");
        } catch (e) {
          if (e.code === "EEXIST") continue;
          throw e;
        }
        files.push({
          date: result.date,
          region: result.region,
          fileName: path.basename(file),
          path: file,
          kind: p.kind,
        });
        try {
          await handle.writeFile(p.bytes);
          await handle.sync();
        } finally {
          await handle.close();
        }
        saved = true;
        break;
      }
      M.assert(
        saved,
        "동일 이름의 파일이 너무 많습니다. 다른 보관 폴더를 선택하세요.",
      );
    }
    return { directory, files };
  } catch (e) {
    for (const f of files) await fs.unlink(f.path).catch(() => {});
    throw e;
  }
}
module.exports = { NEW_HEADERS, UPDATE_HEADERS, preview, workbook, archive };
