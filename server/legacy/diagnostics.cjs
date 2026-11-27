"use strict";
const Model = require("./model.cjs");
const { calendarRange } = require("./regional-analytics.cjs");
const Performance = require("./performance.cjs");
const Activity = require("./diagnostic-activity.cjs");
const { diagnosticGroups } = require("./diagnostic-groups.cjs");

function comparisonPeriod(anchor, kind, weekStart, offset, elapsed) {
  const period = calendarRange(anchor, kind, weekStart, offset);
  if (elapsed !== null) {
    const end = new Date(Date.parse(period.from) + elapsed).toISOString().slice(0, 10);
    if (end < period.to) period.to = end;
  }
  return period;
}

function compare(title, unit, records, threshold, shortSample) {
  const [current, previous, earlier] = records;
  const delta = current.value === null || previous.value === null ? null : current.value - previous.value;
  let status = "추가 관찰", reason;
  if (current.problem || previous.problem) {
    status = "자료 보완";
    reason = current.problem || previous.problem;
  } else if (delta === null || current.pending || previous.pending) {
    reason = "분모가 없거나 관찰 중인 인원이 있습니다. 관찰이 끝난 뒤 같은 기준으로 비교하세요.";
  } else if (records.some(row => row.base < threshold || row.value === null || row.problem || row.pending)) {
    reason = shortSample;
  } else if (delta > 0 && previous.value > earlier.value) {
    status = "유지 후보";
    reason = "세 기간의 값이 연속으로 높아졌습니다. 활동 조건과 기록 범위가 비슷했는지 확인하세요.";
  } else if (delta < 0 && previous.value < earlier.value) {
    status = "점검 후보";
    reason = "세 기간의 값이 연속으로 낮아졌습니다. 달라진 시간·장소·참여 구성을 살펴보세요.";
  } else {
    status = delta === 0 ? "같은 값" : "추가 관찰";
    reason = "두 번의 기간 비교에서 같은 방향의 변화가 이어지지 않았습니다.";
  }
  return { title, unit, current: current.value, previous: previous.value, delta,
    sample: current.sample, priorSample: previous.sample, status, reason };
}

function review(scopes) {
  const placeRecords = scopes.map(({ activity }) => {
    const { totals, quality } = activity;
    const hours = totals.minutes / 60;
    const problem = quality.conflictMinutes || quality.unknownActivityTime || quality.unknownWorker ||
      quality.unknownActivityPlace || totals.unmatched;
    return { value: totals.perHour, base: totals.sessions, sample: `${totals.matched}건 / ${hours.toLocaleString("ko-KR", {maximumFractionDigits: 2})}인시간`,
      problem: problem ? "장소·시각·활동자 또는 활동 구간 연결을 확인할 기록이 있습니다." : "" };
  });
  const rows = [compare("노방 인시간당 찾기", "건/인시간", placeRecords, 3, "비교할 세 기간에 각각 3회차 이상이 쌓이면 변화 방향을 살펴봅니다.")];
  for (const [index, window] of scopes[0].windows.entries()) {
    const records = scopes.map(s => {
      const stage = s.windows[index];
      return { value: stage.rate, base: stage.mature, pending: stage.observing,
        sample: `${stage.reached}명 / ${stage.mature}명`, problem: "" };
    });
    rows.push(compare(`${window.label} · ${window.days}일`, "%", records, 10,
      "비교할 세 기간에 관찰을 마친 인원이 각각 10명 이상일 때 변화 방향을 표시합니다."));
  }
  return rows;
}

function summary(ws, input = {}, asOf = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
}).format(new Date())) {
  const kind = input.kind || "week", anchor = Model.date(input.anchor || asOf);
  Model.assert(["week", "month"].includes(kind), "주별 또는 월별 기간을 선택하세요.");
  Model.assert(anchor <= asOf, "오늘까지의 기간을 선택하세요.");
  const weekStart = input.weekStart ?? 0;
  Model.assert(Number.isInteger(weekStart) && weekStart >= 0 && weekStart <= 6, "주 시작일을 확인하세요.");
  const full = calendarRange(anchor, kind, weekStart);
  const elapsed = full.to > asOf ? Date.parse(asOf) - Date.parse(full.from) : null;
  const ranges = [0, -1, -2].map(offset => comparisonPeriod(anchor, kind, weekStart, offset, elapsed));
  const facts = Performance.facts(ws);
  const scopes = ranges.map(range => Activity.summary(ws, { ...range, asOf, source: "detail" }, facts));
  const { cohortStatuses, ...current } = scopes[0];
  const groups = diagnosticGroups(ws, { ...ranges[0], asOf, source: "detail", activity: current.activity,
    cohortGroups: current.windows[0].groups }, facts, cohortStatuses);
  const regions = [...new Set(current.activity.details.map(row => row.region).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, "ko", { numeric: true }));
  const region = Model.text(input.venueRegion ?? "", 100);
  if (region && !regions.includes(region)) regions.push(region);
  const rawWeekday = input.venueWeekday ?? "";
  Model.assert(rawWeekday === "" || /^[0-6]$/.test(String(rawWeekday)), "요일을 확인하세요.");
  const weekday = rawWeekday === "" ? "" : Number(rawWeekday);
  const activity = region || weekday !== ""
    ? Activity.filteredActivity(ws, { ...ranges[0], asOf, region, weekday }, facts, cohortStatuses)
    : current.activity;
  return { period: { ...ranges[0], kind, asOf, periodEnd: full.to }, previous: ranges[1], earlier: ranges[2],
    ...current, ...groups, activity, venueOptions: { region, regions, weekday }, review: review(scopes) };
}
module.exports = { summary };
