"use strict";
const O = require("./organization.cjs");
const K = require("./codes.cjs");
const M = require("./model.cjs");
const Performance = require("./performance.cjs");
const Activity = require("./diagnostic-activity.cjs");

const missing = "미입력", unclear = "확인 필요";
const ratio = (count, total) => total ? count / total : null;
const clean = (value) => String(value ?? "").trim().normalize("NFC");
const roleCounts = () => ({ fullTime: 0, halfTime: 0, employed: 0, other: 0, unknown: 0 });
const roles = new Map([["전일자", "fullTime"], ["반일자", "halfTime"], ["직장인", "employed"], [missing, "unknown"]]);
function coding(ws) {
  const classes = new Map(), employment = new Map();
  const classToken = (value) => clean(value).replace(/^(\d+)\s*반$/, "$1");
  const roleToken = (value) => clean(value).replace(/\s/g, "");
  for (const c of K.group(ws, "className")?.items || []) {
    const tokens = [c.value, c.label, ...(c.aliases || [])].map(classToken);
    const key = tokens.includes("0") ? "0" : classToken(c.value);
    for (const token of tokens) classes.set(token, { key, label: c.label });
  }
  for (const c of K.group(ws, "employment")?.items || []) {
    const tokens = [c.value, c.label, ...(c.aliases || [])].map(roleToken);
    const field = tokens.map((token) => roles.get(token)).find(Boolean) || "other";
    for (const token of tokens) employment.set(token, field);
  }
  return {
    classOf(value) {
      const token = classToken(value), { key, label } = classes.get(token) || { key: token, label: token };
      return { key, label: /^\d+$/.test(label) ? `${label}반` : label || "반 미입력" };
    },
    roleOf(value) {
      const token = roleToken(value);
      return token ? employment.get(token) || roles.get(token) || "other" : "unknown";
    },
  };
}

// Only known administrative labels can leave this parser. Never display parts of free-text addresses.
const geography = [
  ["서울", "서울시 서울특별시", "종로구 중구 용산구 성동구 광진구 동대문구 중랑구 성북구 강북구 도봉구 노원구 은평구 서대문구 마포구 양천구 강서구 구로구 금천구 영등포구 동작구 관악구 서초구 강남구 송파구 강동구"],
  ["부산", "부산시 부산광역시", "중구 서구 동구 영도구 부산진구 동래구 남구 북구 해운대구 사하구 금정구 강서구 연제구 수영구 사상구 기장군"],
  ["대구", "대구시 대구광역시", "중구 동구 서구 남구 북구 수성구 달서구 달성군 군위군"],
  ["인천", "인천시 인천광역시", "중구 동구 미추홀구 연수구 남동구 부평구 계양구 서구 강화군 옹진군 영종구 제물포구 검단구"],
  ["광주", "광주광역시", "동구 서구 남구 북구 광산구"],
  ["대전", "대전시 대전광역시", "동구 중구 서구 유성구 대덕구"],
  ["울산", "울산시 울산광역시", "중구 남구 동구 북구 울주군"],
  ["세종", "세종시 세종특별자치시", ""],
  ["경기", "경기도", "수원시 용인시 고양시 화성시 성남시 부천시 남양주시 안산시 평택시 안양시 시흥시 파주시 김포시 의정부시 광주시 하남시 광명시 군포시 양주시 오산시 이천시 안성시 구리시 의왕시 포천시 여주시 동두천시 과천시 양평군 가평군 연천군"],
  ["강원", "강원도 강원특별자치도", "춘천시 원주시 강릉시 동해시 태백시 속초시 삼척시 홍천군 횡성군 영월군 평창군 정선군 철원군 화천군 양구군 인제군 고성군 양양군"],
  ["충북", "충청북도", "청주시 충주시 제천시 보은군 옥천군 영동군 증평군 진천군 괴산군 음성군 단양군"],
  ["충남", "충청남도", "천안시 공주시 보령시 아산시 서산시 논산시 계룡시 당진시 금산군 부여군 서천군 청양군 홍성군 예산군 태안군"],
  ["전북", "전라북도 전북특별자치도", "전주시 군산시 익산시 정읍시 남원시 김제시 완주군 진안군 무주군 장수군 임실군 순창군 고창군 부안군"],
  ["전남", "전라남도", "목포시 여수시 순천시 나주시 광양시 담양군 곡성군 구례군 고흥군 보성군 화순군 장흥군 강진군 해남군 영암군 무안군 함평군 영광군 장성군 완도군 진도군 신안군"],
  ["경북", "경상북도", "포항시 경주시 김천시 안동시 구미시 영주시 영천시 상주시 문경시 경산시 의성군 청송군 영양군 영덕군 청도군 고령군 성주군 칠곡군 예천군 봉화군 울진군 울릉군"],
  ["경남", "경상남도", "창원시 진주시 통영시 사천시 김해시 밀양시 거제시 양산시 의령군 함안군 창녕군 고성군 남해군 하동군 산청군 함양군 거창군 합천군"],
  ["제주", "제주도 제주특별자치도", "제주시 서귀포시"],
];
const provinces = new Map(), areas = new Map();
for (const [province, aliases, names] of geography) {
  const municipalities = new Set(names.split(" ").filter(Boolean));
  for (const token of [province, ...aliases.split(" ")]) provinces.set(token, { province, municipalities });
  for (const name of municipalities) areas.set(name, areas.has(name) ? null : `${province} ${name}`);
}
function residenceOf(value) {
  const raw = clean(value);
  if (!raw || raw === missing) return missing;
  const [first, second] = raw.split(/[\s,]+/);
  // "광주" can mean either the metropolitan city or 경기 광주시.
  if (first === "광주" || first === "광주시")
    return provinces.get("광주").municipalities.has(second) ? `광주 ${second}` : unclear;
  const area = provinces.get(first);
  if (area) return area.municipalities.has(second) ? `${area.province} ${second}` : area.province;
  return areas.get(first) || unclear;
}
function ageOf(value) {
  if (value == null || clean(value) === "" || value === missing) return missing;
  if (!/^\d{1,3}$/.test(clean(value)) || Number(value) > 120) return unclear;
  return Number(value) < 10 ? "10세 미만" : `${Math.floor(Number(value) / 10) * 10}대`;
}
function genderOf(value) {
  const gender = clean(value);
  if (!gender || gender === missing) return missing;
  return ["남", "여", "기타"].includes(gender) ? gender : unclear;
}
function distribution(counts, total, compare) {
  const unknown = counts.get(missing) || 0, ambiguous = counts.get(unclear) || 0;
  const order = (s) => s === missing ? 2 : s === unclear ? 1 : 0;
  return {
    recorded: total - unknown - ambiguous, unknown, unclear: ambiguous,
    rows: [...counts].sort(([a], [b]) => order(a) - order(b) || compare(a, b))
      .map(([label, count]) => ({ label, count, share: ratio(count, total) })),
  };
}

function ranks(values) {
  const order = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
  const result = [];
  for (let start = 0; start < order.length;) {
    let end = start + 1;
    while (end < order.length && order[end].value === order[start].value) end++;
    for (let i = start; i < end; i++) result[order[i].index] = (start + end - 1) / 2;
    start = end;
  }
  return result;
}
function associations(groups, available) {
  const samples = [...groups.values()].filter((row) => row.region && row.classKey &&
    row.observed && row.roster > 0 && row.unknown === 0);
  const regionCount = new Set(samples.map((row) => row.region)).size, minimum = 5;
  return [["fullTime", "전일자 수"], ["halfTime", "반일자 수"]].map(([field, label]) => {
    let rho = null, reason = "";
    if (!available) reason = "반별 상세 실적을 확인할 수 없습니다.";
    else if (samples.length < minimum || regionCount < 2)
      reason = `명부 직업이 모두 입력되고 활동 또는 찾기가 기록된 구역·반 ${samples.length}개입니다. 2개 이상 구역에서 구역·반 5개 이상이 필요합니다.`;
    else {
      const x = ranks(samples.map((group) => group[field])), y = ranks(samples.map((group) => group.findings));
      const center = (samples.length - 1) / 2;
      let product = 0, xx = 0, yy = 0;
      for (let i = 0; i < samples.length; i++) {
        const dx = x[i] - center, dy = y[i] - center;
        product += dx * dy; xx += dx * dx; yy += dy * dy;
      }
      if (xx && yy) rho = product / Math.sqrt(xx * yy);
      else reason = `${xx ? "고유 찾B 인원" : label}에 차이가 없어 순위상관을 계산할 수 없습니다.`;
    }
    return { field, label, outcomeLabel: "기간 고유 찾B 인원", unit: "구역·반", sampleSize: samples.length, regionCount, minimum, rho, reason };
  });
}

function diagnosticGroups(ws, scope, facts = Performance.facts(ws), cohorts = new Map()) {
  const { classOf, roleOf } = coding(ws), classes = new Map(), pairs = new Map(), active = new Map();
  const rowOf = (value) => {
    const { key, label } = classOf(value);
    if (key === "0") return null;
    if (!classes.has(key)) classes.set(key, {
      key, label, roster: 0, ...roleCounts(), participants: 0, participantsByRole: roleCounts(),
      streetHours: 0, findings: 0, matchedFindings: 0, eligible: 0, reached: 0, pending: 0,
      unknownActivityTimes: 0, unlinkedActivities: 0, seen: new Set(),
    });
    return classes.get(key);
  };
  const pairOf = (region, row) => {
    const key = JSON.stringify([region, row.key]);
    if (!pairs.has(key)) pairs.set(key, { region, classKey: row.key, roster: 0, ...roleCounts(), observed: false, findings: 0 });
    return pairs.get(key);
  };
  const org = O.get(ws), units = new Map();
  for (const member of org.members) {
    if (member.status !== "active") continue;
    if (!units.has(member.unitId)) {
      const visible = O.ancestors(org, member.unitId).every((unit) => unit.active);
      units.set(member.unitId, visible ? O.regionOf(org, member.unitId) : null);
    }
    const region = units.get(member.unitId);
    if (region === null) continue;
    const row = rowOf(member.className);
    if (!row) continue;
    const role = roleOf(member.employment), pair = pairOf(region, row);
    active.set(`member:${member.code}`, { role, key: row.key });
    row.roster++; row[role]++;
    pair.roster++; pair[role]++;
  }
  const to = scope.asOf && scope.asOf < scope.to ? scope.asOf : scope.to;
  const inRange = (date) => date && date >= scope.from && date <= to;
  const stamp = (date, time = "00:00") => Date.parse(`${date}T${time}:00Z`);
  const low = stamp(scope.from), high = stamp(to) + 86400000;
  for (const activity of facts.activities) {
    const minutes = M.minutes(activity.start, activity.end);
    const start = minutes ? stamp(activity.date, activity.start) : NaN;
    const end = start + minutes * 60000;
    if (!inRange(activity.date) && !(start < high && end > low && high > low)) continue;
    const row = rowOf(activity.className);
    if (!row) continue;
    pairOf(activity.region, row).observed = true;
    if (activity.classification2 !== "노방") continue;
    const worker = activity.worker.key, member = active.get(worker);
    if (member && member.key === row.key && !row.seen.has(worker)) {
      row.seen.add(worker); row.participants++; row.participantsByRole[member.role]++;
    }
    if (!member || member.key !== row.key) row.unlinkedActivities++;
    if (!minutes) row.unknownActivityTimes++;
  }
  const venue = scope.activity || Activity.summary(ws, scope, facts).activity;
  for (const detail of venue.details) {
    const row = rowOf(detail.className);
    if (!row) continue;
    row.streetHours += detail.minutes / 60;
    row.matchedFindings += detail.matched;
  }
  const hasReportedFindings = (ws.dailyReports || []).some((row) => row.found > 0 && inRange(row.date));
  const available = scope.source !== "reported" && (!hasReportedFindings || facts.findings.some((f) => inRange(f.date)));
  const ageCounts = new Map(), genderCounts = new Map(), residenceCounts = new Map();
  const increment = (map, key) => map.set(key, (map.get(key) || 0) + 1);
  const counted = new Set();
  for (const finding of facts.findings) {
    if (!available || !inRange(finding.date) || !finding.code || counted.has(finding.code)) continue;
    counted.add(finding.code);
    const record = finding.person || finding.firstReport || {};
    increment(ageCounts, ageOf(finding.age));
    increment(genderCounts, genderOf(record.gender));
    increment(residenceCounts, residenceOf(record.residence));
    const row = rowOf(finding.className);
    if (!row) continue;
    row.findings++;
    const pair = pairOf(finding.region, row);
    pair.observed = true; pair.findings++;
    if (!Array.isArray(scope.cohortGroups)) {
      const status = cohorts.get(finding.code);
      if (status === "pending") row.pending++;
      if (status === "reached" || status === "notReached") row.eligible++;
      if (status === "reached") row.reached++;
    }
  }
  if (available) for (const historical of scope.cohortGroups || []) {
    const row = rowOf(historical.className);
    if (!row) continue;
    row.eligible += historical.mature; row.reached += historical.reached; row.pending += historical.observing;
  }
  const rows = [...classes.values()].sort((a, b) =>
    Number(!a.key) - Number(!b.key) || a.label.localeCompare(b.label, "ko", { numeric: true })
  ).map(({ seen, ...row }) => ({
    ...row, findings: available ? row.findings : null,
    matchedFindings: available ? row.matchedFindings : null,
    perStreetHour: available ? ratio(row.matchedFindings, row.streetHours) : null,
    eligible: available ? row.eligible : null, reached: available ? row.reached : null,
    pending: available ? row.pending : null, progressRate: available ? ratio(row.reached, row.eligible) : null,
  }));
  const total = counted.size, korean = (a, b) => a.localeCompare(b, "ko", { numeric: true });
  return {
    staffing: {
      rows, associations: associations(pairs, available),
      basis: "명부와 직업은 현재 활동 상태 기준입니다. 참여는 기록 당시 반과 현재 반이 일치하는 노방 고유 명부 인원입니다. 인시간은 장소·시간대 표와 같은 활동 기록에서 구하고, 찾기는 같은 활동자·구역·반·장소의 시간대에 연결합니다. 상관은 구역·반별 현재 구성과 기간 고유 찾B 인원의 순위 관계이며 반 규모와 활동 여건의 영향이 포함됩니다.",
    },
    demographics: {
      available, total: available ? total : null,
      age: distribution(ageCounts, total, (a, b) => (a === "10세 미만" ? 0 : parseInt(a)) - (b === "10세 미만" ? 0 : parseInt(b))),
      gender: distribution(genderCounts, total, korean),
      residence: distribution(residenceCounts, total, (a, b) => residenceCounts.get(b) - residenceCounts.get(a) || korean(a, b)),
    },
  };
}
module.exports = { diagnosticGroups };
