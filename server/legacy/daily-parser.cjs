"use strict";
const M = require("./model.cjs");
const Milestones = require("./ui/person-milestones.js");
function parse(text, ws, context, helpers) {
  M.text(text, 1000000);
  const { date, clock } = helpers,
    rows = { 활동일보: [], 찾기일보: [] },
    errors = [];
  let report = context.date ? date(context.date) : "",
    region = context.region || "",
    currentStage = "",
    status = "",
    hasTeacher = false,
    hasReason = false,
    ignoredRetained = 0,
    activityMode = false,
    lastWorker = "";
  const roster = ws.organization?.members || [];
  const cleanToken = (s) => (s === "-" ? "" : s.replace(/_/g, " "));
  const memberToken = (s) => s.replace(/\([^)]*\)\s*$/, "").trim();
  const isMember = (s) => {
    const token = memberToken(s),
      bracket = token.match(/^(.*?)\[([^\]]+)\]$/);
    return roster.some(
      (m) =>
        (m.status === "active" || context.changesOnly) &&
        (bracket
          ? m.code === bracket[2] && (!bracket[1] || m.name === bracket[1])
          : m.code === token || m.name === token),
    );
  };
  const activities = String(context.activityText || "").trim();
  const input =
    (activities
      ? `${/^활동자\s*[:：]/.test(activities) ? "" : "활동자: "}${activities}\n`
      : "") + text;
  input.split(/\r?\n/).forEach((raw, index) => {
    let s = raw
      .trim()
      .replace(/^[\p{Extended_Pictographic}\uFE0F\s<>❗]+/u, "")
      .replace(/[<>]$/g, "");
    if (!s) return;
    s = s.replace(/^(\d{1,2})월\s*(\d{1,2})일/, "$1/$2");
    try {
      let m;
      if ((m = s.match(/^(\d{4}-\d{2}-\d{2})(?:\s*일보)?$/))) {
        M.assert(
          !context.date || context.date === m[1],
          "원문의 보고일이 선택한 날짜와 다릅니다. 원문 날짜 제목을 지우거나 날짜 선택을 바꾸세요.",
        );
        report = date(m[1]);
        activityMode = false;
        currentStage = "";
        status = "";
        lastWorker = "";
        return;
      }
      if ((m = s.match(/^(?:구역\s*[:：]\s*)?([^\s]+구역)(?:\s*일일보고)?$/))) {
        M.assert(
          !context.region || context.region === m[1],
          "원문의 구역이 선택한 구역과 다릅니다.",
        );
        region = m[1];
        activityMode = false;
        currentStage = "";
        status = "";
        lastWorker = "";
        return;
      }
      if (/^날짜(?:\s|$)/.test(s)) {
        hasTeacher = /상담사|교사/.test(s);
        hasReason = /탈락사유|사유/.test(s);
        return;
      }
      if (/^(?:총|합계)\s*[:：]?\s*\d+\s*(?:건|명)/.test(s)) return;
      if (
        (m = s.match(/^(?:[ㅇ○o]\s*)?(신규\s*[/·]\s*유지|신규|유지|탈락)\s*$/))
      ) {
        status = m[1].replace(/\s/g, "");
        activityMode = false;
        return;
      }
      if (
        /^(찾기(?:\s*건수)?|합자)\s*[:：]/.test(s) ||
        /^찾기\s*건수\s*[:：]?$/.test(s)
      ) {
        activityMode = false;
        return;
      }
      const stageMatch = s.match(
        /^(찾\s*[AB]|만픽|콜링|합\s*[AB]|영따|복\s*[ABC]|복음방|복신|신카접수|센터등록)(?=\s|[:：(]|$)/,
      );
      const customStage = ws.stages.find((k) =>
        [k, ws.stageNames[k]].some(
          (v) => s === v || s.startsWith(v + ":") || s.startsWith(v + " :"),
        ),
      );
      if (stageMatch || customStage) {
        const label = stageMatch
          ? stageMatch[1].replace(/\s/g, "")
          : customStage;
        const compact = (v) => v.replace(/\s/g, "");
        const milestone = Milestones.fieldForStageLabel(label);
        currentStage =
          (milestone?.field === "bokshinDate" &&
            Milestones.stageId(ws, milestone.field)) ||
          ws.stages.find(
            (k) =>
              compact(k) === compact(label) ||
              compact(ws.stageNames[k]) === compact(label),
          ) || label;
        status = "";
        activityMode = false;
        return;
      }
      if ((m = s.match(/^활동자\s*[:：]\s*(.*)$/))) {
        activityMode = true;
        s = m[1];
        if (!s) return;
      }
      if (!/^\d/.test(s) && /\(\s*\d{1,2}:\d{2}\s*[-~–—]/.test(s))
        activityMode = true;
      if (activityMode && !/^\d{1,4}[-/.]\d/.test(s)) {
        M.assert(report && region, "보고일과 구역을 먼저 선택하세요.");
        let end = 0,
          found = false;
        const re = /([^,，;；()]*)\(([^()]+)\)/g;
        while ((m = re.exec(s))) {
          M.assert(
            /^[\s,，;；]*$/.test(s.slice(end, m.index)),
            "활동 구간 사이에는 쉼표를 사용하세요.",
          );
          found = true;
          end = re.lastIndex;
          const who = m[1].trim() || lastWorker;
          M.assert(who, "첫 활동 구간 앞에는 이름을 적으세요.");
          lastWorker = who;
          for (const part of m[2].split(/\s*\/\s*/)) {
            const t = part.match(
              /^(\d{1,2}:\d{2})\s*[-~–—]\s*(\d{1,2}:\d{2})$/,
            );
            M.assert(
              t,
              "활동은 이름(13:00-13:30), (16:00-19:00) 형식으로 적으세요.",
            );
            rows.활동일보.push({
              활동일: report,
              구역: region,
              활동자: who,
              시작: clock(t[1]),
              종료: clock(t[2]),
              활동ID: "",
              _line: index + 1,
            });
          }
        }
        M.assert(
          found && /^[\s,，;；]*$/.test(s.slice(end)),
          "활동 구간을 확인하세요.",
        );
        return;
      }
      if (context.changesOnly) {
        const explicit = [
          ...s.matchAll(/(?:^|\s)(신규|유지|탈락)(?=\s|$)/g),
        ].at(-1)?.[1];
        if ((explicit || status) === "유지") {
          ignoredRetained++;
          return;
        }
      }
      M.assert(report && region, "보고일과 구역을 먼저 선택하세요.");
      M.assert(
        /^\d{1,4}[-/.]\d/.test(s),
        "일보의 제목 또는 대상자 행으로 읽을 수 없습니다.",
      );
      const parts = s
          .replace(
            /(?<!\S)(?:\+82[- ]?10|01[016789])[- ]?\d{3,4}[- ]?\d{4}(?=\s|$)/g,
            " ",
          )
          .split(/\s+/)
          .filter(Boolean)
          .map(cleanToken),
        foundDate = date(parts.shift(), report),
        review = [];
      let rowStatus = ["신규", "유지", "탈락"].includes(status) ? status : "",
        explicitCode = "";
      for (let i = parts.length - 1; i >= 0; i--) {
        if (/^(신규|유지|탈락)$/.test(parts[i]))
          rowStatus = parts.splice(i, 1)[0];
        else if (parts[i].startsWith("대상자ID="))
          explicitCode = parts.splice(i, 1)[0].slice(6);
        else if (
          /^(오픈|비오픈)$/.test(parts[i]) ||
          /^0[\d-]{8,}$/.test(parts[i])
        )
          parts.splice(i, 1);
      }
      let genderIndex = parts.findIndex((t) =>
        ["남", "여", "기타", "미입력"].includes(t),
      );
      let tool = "",
        name = "",
        gender = "",
        age = "",
        residence = "",
        place = "",
        time = "",
        worker = "",
        teacher = "",
        reason = "";
      if (genderIndex >= 0) {
        const front = parts.slice(0, genderIndex),
          tail = parts.slice(genderIndex + 1);
        gender = parts[genderIndex];
        const earlierMember = front.findIndex(isMember);
        if (front.length === 2) [tool, name] = front;
        else if (front.length === 3 && earlierMember >= 0) {
          worker = memberToken(front.splice(earlierMember, 1)[0]);
          [name, tool] = front;
          review.push("원문의 도구·대상자 순서를 확인하세요.");
        } else {
          tool = front[0] || "";
          name = front[1] || "";
          review.push("도구·대상자 위치를 확인하세요.");
        }
        if (
          tail[0] === "" ||
          (/^\d{1,3}$/.test(tail[0] || "") && Number(tail[0]) <= 120)
        )
          age = tail.shift();
        let workerIndex = tail.findIndex(isMember);
        if (!worker && workerIndex >= 0)
          worker = memberToken(tail[workerIndex]);
        if (!worker) {
          workerIndex = tail.length - 1;
          worker = memberToken(tail[workerIndex] || "");
        }
        const location = workerIndex >= 0 ? tail.slice(0, workerIndex) : tail;
        const afterWorker = workerIndex >= 0 ? tail.slice(workerIndex + 1) : [];
        if (hasTeacher && afterWorker.length) teacher = afterWorker.shift();
        if (hasReason || rowStatus === "탈락")
          reason = afterWorker
            .join(" ")
            .replace(/^(?:탈락)?사유\s*[:：]?\s*/, "");
        if (rowStatus === "탈락" && !reason && workerIndex >= 0)
          reason = tail[workerIndex]?.match(/\(([^)]+)\)\s*$/)?.[1] || "";
        if (location.length === 3 && location.at(-1) === "") location.pop();
        if (
          location.length &&
          /^(?:(?:[01]?\d|2[0-3])(?::[0-5]\d|시(?:[0-5]?\d분)?)?|(?:[01]?\d|2[0-3])[0-5]\d)$/.test(
            location.at(-1),
          )
        )
          time = clock(location.pop(), true);
        residence = location[0] || "";
        place = location[1] || "";
        if (location.length > 2)
          review.push("거주지·찾기장소 항목을 확인하세요.");
      } else {
        const at = parts.findIndex(isMember);
        name = parts[0] || "";
        worker = at >= 0 ? memberToken(parts[at]) : "";
        tool = parts.length >= 4 ? parts.at(-1) : "";
        if (hasTeacher && at >= 0 && at + 1 < parts.length - 1)
          teacher = parts[at + 1];
        review.push("축약된 행입니다. 추출한 대상자·도구·인도자를 확인하세요.");
      }
      if (!currentStage) review.push("단계를 선택하세요.");
      if (!rowStatus) review.push("신규·유지·탈락 중 하나를 선택하세요.");
      if (!name || !worker) review.push("대상자와 인도자를 확인하세요.");
      rows.찾기일보.push({
        보고일: report,
        구역: region,
        단계: currentStage,
        구분: rowStatus,
        찾은날짜: foundDate,
        도구: tool,
        대상자: name,
        성별: gender,
        나이: age,
        거주지: residence,
        찾기장소: place,
        찾기시간: time,
        인도자: worker,
        대상자ID: explicitCode,
        ...(context.changesOnly ? { 교사: teacher, 사유: reason } : {}),
        _line: index + 1,
        _review: review,
        _raw: raw.trim(),
      });
    } catch (e) {
      errors.push(`${index + 1}줄: ${e.message}`);
    }
  });
  if (
    !rows.활동일보.length &&
    !rows.찾기일보.length &&
    !(context.changesOnly && ignoredRetained)
  )
    errors.push("변환할 활동 또는 찾기 데이터가 없습니다.");
  if (rows.활동일보.length + rows.찾기일보.length > 10000)
    errors.push("한 번에 10,000행까지 변환할 수 있습니다.");
  return { rows, errors, ignoredRetained };
}
module.exports = { parse };
