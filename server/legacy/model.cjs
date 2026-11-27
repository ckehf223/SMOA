"use strict";
const { randomUUID, createHash } = require("node:crypto");
const O = require("./organization.cjs");
const K = require("./codes.cjs");
const Classification = require("./classification-scope.cjs");
const { readPhone } = require("./person-phone.cjs");
const { fields: personMilestones } = require("./ui/person-milestones.js");
const STAGES = [
  "찾B", "콜링", "만픽", "찾A", "합 B", "복음방", "신카접수", "센터등록",
];
const MAX_STAGES = 23;
const MAX_GOAL_TARGET = 23_000_000;
const PERSON_CLASSIFICATIONS = {
  classification1: ["개척", "지인", "가족"],
  classification2: ["노방", "소셜링", "온라인", "세미나", "기타"],
};
const TYPES = ["text", "number", "date", "select", "boolean"];
const uuid = () => randomUUID();
const now = () => new Date().toISOString();
const copy = (value) => structuredClone(value);
const hash = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
function assert(ok, message) {
  if (!ok) throw new Error(message);
}
function text(value, max = 200, required = false) {
  assert(
    typeof value === "string" && value.length <= max,
    `문자 항목은 ${max}자 이내로 입력해 주세요.`,
  );
  const clean = value.trim();
  assert(!required || clean.length, "필수 항목을 입력해 주세요.");
  return clean;
}
function id(value) {
  assert(
    typeof value === "string" &&
      /^[a-zA-Z0-9_-]{1,80}$/.test(value) &&
      !["__proto__", "prototype", "constructor"].includes(value),
    "잘못된 식별자입니다.",
  );
  return value;
}
function date(value, required = true) {
  if (!value && !required) return "";
  assert(
    typeof value === "string" &&
      /^\d{4}-\d{2}-\d{2}$/.test(value) &&
      new Date(value + "T00:00:00Z").toISOString().slice(0, 10) === value,
    "날짜를 확인해 주세요.",
  );
  return value;
}
function time(value, required = false) {
  if (!value && !required) return "";
  assert(
    typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value),
    "시간을 확인해 주세요.",
  );
  return value;
}
function minutes(start, end) {
  if (!start || !end) return 0;
  const toMins = (v) => Number(v.slice(0, 2)) * 60 + Number(v.slice(3));
  return (toMins(end) - toMins(start) + 1440) % 1440;
}
function band(start) {
  if (!start) return "미입력";
  const hour = Number(start.slice(0, 2));
  return hour < 6 ? "새벽" : hour < 12 ? "오전" : hour < 18 ? "오후" : "저녁";
}
function validateFields(fields) {
  assert(
    Array.isArray(fields) && fields.length <= 30,
    "사용자 항목은 최대 30개입니다.",
  );
  const ids = new Set(),
    labels = new Set();
  return fields.map((f) => {
    const fid = id(f.id);
    assert(!ids.has(fid), "중복된 항목입니다.");
    ids.add(fid);
    assert(TYPES.includes(f.type), "지원하지 않는 항목 유형입니다.");
    const label = text(f.label, 60, true);
    assert(!labels.has(label), "사용자 항목 이름이 중복됩니다.");
    labels.add(label);
    return {
      id: fid,
      label: text(f.label, 60, true),
      type: f.type,
      ...(f.codeGroupId ? { codeGroupId: id(f.codeGroupId) } : {}),
      options:
        f.type === "select"
          ? [
              ...new Set(
                (Array.isArray(f.options) ? f.options : []).map((o) =>
                  text(o, 80, true),
                ),
              ),
            ].slice(0, 50)
          : [],
    };
  });
}
function customValues(input, fields, ws, existing) {
  const result = {};
  for (const f of fields) {
    const v = input?.[f.id];
    if (v === undefined || v === null || v === "") {
      result[f.id] = f.type === "boolean" ? false : "";
      continue;
    }
    if (f.type === "number") {
      assert(
        typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= 1e12,
        `${f.label}: 숫자를 확인해 주세요.`,
      );
      result[f.id] = v;
    } else if (f.type === "boolean") {
      assert(typeof v === "boolean", "체크 항목이 올바르지 않습니다.");
      result[f.id] = v;
    } else if (f.type === "date") result[f.id] = date(v);
    else {
      result[f.id] = text(v, 2000);
      if (f.type === "select" && f.codeGroupId)
        result[f.id] = K.resolve(
          ws,
          f.codeGroupId,
          result[f.id],
          existing?.[f.id],
        );
      else if (f.type === "select")
        assert(
          f.options.includes(result[f.id]),
          `${f.label}: 선택 항목을 확인해 주세요.`,
        );
    }
  }
  return result;
}
function validatePerson(p, ws, existing) {
  assert(p && typeof p === "object", "대상자 정보를 확인해 주세요.");
  const intro = O.introducer(ws, p.introducerId, existing);
  const linkedMember = O.get(ws).members.find(
    (m) => m.id === intro.introducerId,
  );
  const dateUnknown =
    (p.dateUnknown === true || existing?.dateUnknown === true) && !p.date;
  const phone = readPhone(p.phone ?? existing?.phone);
  const result = {
    id: existing ? existing.id : uuid(),
    code: text(
      p.code ||
        existing?.code ||
        `P-${uuid().replace(/-/g, "").slice(0, 12).toUpperCase()}`,
      60,
      true,
    ),
    name: text(p.name, 100, true),
    gender: text(p.gender || "미입력", 20),
    age: p.age === "" || p.age == null ? "" : Number(p.age),
    ageAsOf: date(p.ageAsOf || p.date),
    time: time(p.time ?? existing?.time),
    ...Object.fromEntries(
      Object.entries(PERSON_CLASSIFICATIONS).map(([key, choices], index) => {
        const value = text(p[key] ?? existing?.[key] ?? choices[0], 20);
        assert(
          !value || choices.includes(value),
          `분류${index + 1}: 선택 항목을 확인해 주세요.`,
        );
        return [key, value];
      }),
    ),
    place: text(p.place ?? existing?.place ?? "", 200),
    tool: text(p.tool ?? existing?.tool ?? "", 200),
    residence: text(p.residence ?? existing?.residence ?? "", 200),
    ...(phone || existing?.phone !== undefined ? { phone } : {}),
    teacher: text(p.teacher ?? existing?.teacher ?? "", 100),
    reason: text(p.stageReason ?? p.reason ?? existing?.reason ?? "", 2000),
    worker: text(p.worker ?? (!existing ? linkedMember?.name : "") ?? "", 100),
    ...intro,
    region: text(
      p.region ||
        (!existing && intro.introducerId
          ? O.regionOf(
              O.get(ws),
              O.get(ws).members.find((m) => m.id === intro.introducerId)
                ?.unitId,
            )
          : "") ||
        "",
      60,
    ),
    className: K.resolve(
      ws,
      "className",
      p.className ?? (!existing ? linkedMember?.className : "") ?? "",
      existing?.className,
    ),
    employment: K.resolve(
      ws,
      "employment",
      p.employment || K.preferred(ws, "employment", "미입력"),
      existing?.employment,
    ),
    stage: text(p.stage || ws.stages[0], 60, true),
    date: date(p.date, !dateUnknown),
    ...(dateUnknown ? { dateUnknown: true } : {}),
    appointment: text(p.appointment || "", 30),
    notes: text(p.notes || "", 10000),
    custom: customValues(p.custom, ws.fields, ws, existing?.custom),
    ...(existing?.socialing ? { socialing: copy(existing.socialing) } : {}),
    ...(existing?.stageDates ? { stageDates: copy(existing.stageDates) } : {}),
    createdAt: existing?.createdAt || now(),
    updatedAt: now(),
    activities: existing ? copy(existing.activities) : [],
    transitions: existing ? copy(existing.transitions || []) : [],
    lifecycle: existing ? copy(existing.lifecycle || []) : [],
    status: existing?.status || "active",
  };
  assert(ws.stages.includes(result.stage), "단계를 확인해 주세요.");
  if (result.socialing) require("./socialing.cjs").validProfile(result.socialing, result.date);
  if (result.stageDates) {
    assert(
      typeof result.stageDates === "object" &&
        !Array.isArray(result.stageDates),
      "단계일 형식을 확인해 주세요.",
    );
    for (const [key, value] of Object.entries(result.stageDates)) {
      assert(
        personMilestones.some(({ field }) => field === key),
        "알 수 없는 단계일입니다.",
      );
      date(value);
    }
  }
  assert(
    ["남", "여", "기타", "미입력"].includes(result.gender),
    "성별 구분을 확인해 주세요.",
  );
  assert(
    result.age === "" ||
      (Number.isInteger(result.age) && result.age >= 0 && result.age <= 120),
    "나이는 0~120의 정수로 입력해 주세요.",
  );
  assert(
    !ws.people.some(
      (other) => other.id !== result.id && other.code === result.code,
    ),
    "이미 사용 중인 대상자 식별번호입니다.",
  );
  assert(
    !existing || result.code === existing.code,
    "생성한 대상자 식별번호는 변경할 수 없습니다.",
  );
  if (result.appointment)
    assert(
      /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/.test(result.appointment) &&
        date(result.appointment.slice(0, 10)),
      "일정 날짜와 시간을 확인해 주세요.",
    );
  return result;
}
function validateActivity(a, existing, ws) {
  const start = time(a.start),
    end = time(a.end);
  const sessionKey = a.sessionKey ?? existing?.sessionKey;
  const classification2 = text(
    a.classification2 ?? existing?.classification2 ?? "노방",
    20,
  );
  assert(
    !classification2 ||
      PERSON_CLASSIFICATIONS.classification2.includes(classification2),
    "분류2: 선택 항목을 확인해 주세요.",
  );
  assert(
    sessionKey === undefined ||
      sessionKey === "" ||
      (typeof sessionKey === "string" && /^AP-[a-f0-9]{32}$/.test(sessionKey)),
    "활동 회차 정보를 확인하세요.",
  );
  assert(
    !existing || !a.code || a.code === existing.code,
    "생성한 활동 식별번호는 변경할 수 없습니다.",
  );
  return {
    id: existing?.id || uuid(),
    date: date(a.date),
    start,
    end,
    minutes: minutes(start, end),
    classification2,
    ...(a.sessionKey !== undefined || existing?.sessionKey !== undefined
      ? { sessionKey: text(a.sessionKey ?? existing.sessionKey, 100) }
      : {}),
    ...(a.className !== undefined || existing?.className !== undefined
      ? { className: a.className ?? existing.className }
      : {}),
    ...Object.fromEntries(
      ["areaId", "areaName", "unitPath"]
        .filter((k) => a[k] !== undefined || existing?.[k] !== undefined)
        .map((k) => [
          k,
          text(a[k] ?? existing[k], k === "unitPath" ? 1000 : 100),
        ]),
    ),
    code: text(
      a.code ||
        existing?.code ||
        `A-${uuid().replace(/-/g, "").slice(0, 12).toUpperCase()}`,
      60,
      true,
    ),
    region: text(a.region || "", 60),
    workerId: text(a.workerId || "", 60),
    place: ws
      ? K.resolve(ws, "activityPlace", a.place || "", existing?.place)
      : text(a.place || "", 200),
    worker: text(a.worker || "", 100),
    kind: ws
      ? K.resolve(
          ws,
          "activityKind",
          a.kind || K.preferred(ws, "activityKind", "대화"),
          existing?.kind,
        )
      : text(a.kind || "대화", 60, true),
    notes: text(a.notes || "", 5000),
    createdAt: existing?.createdAt || now(),
    updatedAt: now(),
  };
}
function migrateActivityMinutes(a) {
  // Earlier 1.3.0 builds stored an unnecessary deduction. Retain the recorded
  // interval and audit chain while restoring its derived duration on load.
  if (!Object.hasOwn(a, "breakMinutes")) return;
  const span = minutes(time(a.start), time(a.end)),
    pause = a.breakMinutes;
  assert(
    Number.isInteger(pause) &&
      pause >= 0 &&
      pause <= span &&
      (a.minutes === span || a.minutes === span - pause),
    "기존 활동 시간이 맞지 않습니다.",
  );
  if (pause === 0) return;
  a.minutes = span;
  delete a.breakMinutes;
}
function assertNoActivityOverlap(ws, a) {
  if (!a.start || !a.end || !minutes(a.start, a.end)) return;
  const span = (v) => {
      const start = Date.parse(`${v.date}T${v.start}:00Z`);
      return [start, start + minutes(v.start, v.end) * 60000];
    },
    [from, to] = span(a);
  for (const other of [
    ...ws.activityLogs,
    ...ws.people.flatMap((p) => p.activities),
  ]) {
    if (other.id === a.id || !other.start || !other.end) continue;
    const same =
      a.workerId && other.workerId
        ? a.workerId === other.workerId
        : a.worker === other.worker && a.region === other.region;
    if (!same) continue;
    if (a.sessionKey && other.sessionKey && a.sessionKey !== other.sessionKey)
      continue;
    const [x, y] = span(other);
    assert(
      from >= y || to <= x,
      "이 활동자의 기존 활동시간과 겹칩니다. 기존 활동을 수정하거나 시간 구간을 확인하세요.",
    );
  }
}
function transition(person, from, to, effective, actor, reason, names) {
  assert(
    typeof effective === "string" &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(effective),
    "단계 적용 날짜와 시간을 입력해 주세요.",
  );
  date(effective.slice(0, 10));
  time(effective.slice(11), true);
  const event = {
    id: uuid(),
    from,
    to,
    effectiveLocal: effective,
    recordedAt: now(),
    actor: text(actor, 100, true),
    fromName: from ? names?.[from] || from : "",
    toName: names?.[to] || to,
    reason: text(reason || (from ? "" : "최초 등록"), 2000),
    region: person.region,
    className: person.className,
    worker: person.worker,
    memberId: person.introducerId || "",
    workerId: person.introducerSnapshot?.code || "",
    employment: person.employment,
  };
  person.transitions.push(event);
  return event;
}
function audit(ws, actor, action, target, before, after) {
  const entry = {
    id: uuid(),
    at: now(),
    actor,
    action,
    target,
    before: before === undefined ? null : copy(before),
    after: after === undefined ? null : copy(after),
    previous: ws.history.at(-1)?.hash || "GENESIS",
  };
  entry.hash = hash(entry);
  ws.history.push(entry);
  ws.updatedAt = entry.at;
  ws.revision++;
}
function personChanges(before, after) {
  const fields = (p) => {
    if (!p) return null;
    const result = {};
    for (const [key, value] of Object.entries(p))
      if (
        ![
          "activities",
          "transitions",
          "lifecycle",
          "createdAt",
          "updatedAt",
        ].includes(key)
      )
        result[key] = value;
    return result;
  };
  const old = fields(before),
    next = fields(after);
  if (!before)
    return {
      before: null,
      after: { ...next, initialStageEvent: after.transitions[0] },
    };
  const previous = {},
    changed = {};
  for (const key of Object.keys(next))
    if (JSON.stringify(old[key]) !== JSON.stringify(next[key])) {
      previous[key] = old[key] ?? null;
      changed[key] = next[key];
    }
  if (before.stage !== after.stage) {
    previous.stageEvent = before.transitions.at(-1);
    changed.stageEvent = after.transitions.at(-1);
  }
  return { before: previous, after: changed };
}
function verifyHistory(history) {
  assert(
    Array.isArray(history) &&
      (history.length <= 100000 ||
        (history.length === 100001 &&
          history.some((entry) => entry?.action === "복음방 단계 통합"))),
    "이력 형식을 확인해 주세요.",
  );
  let previous = "GENESIS";
  for (const entry of history) {
    const { hash: stored, ...body } = entry;
    assert(
      body.previous === previous && hash(body) === stored,
      "변경 이력의 무결성 검증에 실패했습니다.",
    );
    previous = stored;
  }
}
function newWorkspace(name = "전도 활동 자료실") {
  return {
    id: uuid(),
    name: text(name, 100, true),
    gospelStageVersion: 1,
    stages: [...STAGES],
    stageNames: Object.fromEntries(STAGES.map((s) => [s, s])),
    inactiveStages: [],
    fields: [],
    goals: [],
    people: [],
    activityLogs: [],
    regionalActivities: [],
    socialing: require("./socialing.cjs").defaults(),
    callingRecords: [],
    dailyReports: [],
    findingReports: [],
    organization: O.empty(),
    commonCodes: K.defaults(),
    history: [],
    revision: 0,
    createdAt: now(),
    updatedAt: now(),
  };
}
function validateWorkspace(ws) {
  assert(ws && typeof ws === "object", "자료실 형식을 확인해 주세요.");
  if (!Object.hasOwn(ws, "findingReports")) ws.findingReports = [];
  if (!Object.hasOwn(ws, "organization")) ws.organization = O.empty();
  if (ws.dailyAreaActivityOrder !== undefined)
    text(ws.dailyAreaActivityOrder, 500000);
  if (ws.dailyAreaSlashLayouts !== undefined)
    require("./daily-area-slash-layouts.cjs").validateLayouts(ws.dailyAreaSlashLayouts);
  if (ws.dailyActivityRosterRules !== undefined) {
    const rules = ws.dailyActivityRosterRules;
    assert(rules && typeof rules === "object" && !Array.isArray(rules), "활동자 제외·이름 통합 설정을 확인해 주세요.");
    text(rules.excludedText, 500000);
    text(rules.aliasesText, 500000);
  }
  K.ensure(ws);
  O.validate(ws.organization, ws);
  require("./regional-activity.cjs").validate(ws);
  id(ws.id);
  text(ws.name, 100, true);
  assert(
    Array.isArray(ws.stages) &&
      ws.stages.length > 0 &&
      ws.stages.length <= MAX_STAGES &&
      new Set(ws.stages).size === ws.stages.length,
    `단계는 중복 없이 1~${MAX_STAGES}개로 구성해 주세요.`,
  );
  ws.stages.forEach((s) => text(s, 60, true));
  assert(
    ws.stageNames &&
      typeof ws.stageNames === "object" &&
      Array.isArray(ws.inactiveStages) &&
      ws.inactiveStages.length < ws.stages.length,
    "단계 설정을 확인해 주세요.",
  );
  ws.stages.forEach((s) => text(ws.stageNames[s], 60, true));
  ws.inactiveStages.forEach((s) =>
    assert(ws.stages.includes(s), "보관된 단계를 확인해 주세요."),
  );
  assert(
    new Set(ws.stages.map((s) => ws.stageNames[s])).size === ws.stages.length &&
      new Set(ws.inactiveStages).size === ws.inactiveStages.length,
    "단계 이름 또는 보관 설정이 중복됩니다.",
  );
  validateFields(ws.fields);
  ws.fields.forEach((f) => {
    if (f.codeGroupId)
      assert(
        f.type === "select" && K.group(ws, f.codeGroupId),
        "선택 항목의 공통코드 그룹을 확인해 주세요.",
      );
  });
  assert(
    Array.isArray(ws.activityLogs) &&
      ws.activityLogs.length <= 100000 &&
      Array.isArray(ws.dailyReports) &&
      ws.dailyReports.length <= 100000,
    "활동·일계 형식을 확인해 주세요.",
  );
  ws.activityLogs.forEach((a) => {
    id(a.id);
    migrateActivityMinutes(a);
    const v = validateActivity(a, a, ws);
    assert(v.minutes === a.minutes, "활동 시간이 맞지 않습니다.");
  });
  const dailyKeys = new Set();
  assert(
    Array.isArray(ws.findingReports) && ws.findingReports.length <= 100000,
    "찾기 일보는 최대 100,000행입니다.",
  );
  const findingKeys = new Set();
  for (const r of ws.findingReports) {
    id(r.id);
    date(r.date);
    date(r.foundDate, r.dateUnknown !== true);
    time(r.time);
    assert(
      r.foundDate <= r.date &&
        ws.stages.includes(r.stage) &&
        ["신규", "유지", "탈락"].includes(r.status),
      "찾기 일보 날짜·단계·상태를 확인하세요.",
    );
    const key = JSON.stringify([r.date, r.personCode]);
    assert(!findingKeys.has(key), "같은 보고일의 대상자가 중복됩니다.");
    findingKeys.add(key);
    for (const label of [
      "personCode",
      "region",
      "name",
      "worker",
      "memberCode",
    ])
      text(r[label], 100, true);
    id(r.memberId);
    text(r.className, 100);
    text(r.unitPath, 1000);
    assert(
      ["남", "여", "기타", "미입력"].includes(r.gender),
      "일보 성별을 확인하세요.",
    );
    assert(
      r.age === "" || (Number.isInteger(r.age) && r.age >= 0 && r.age <= 120),
      "일보 나이를 확인하세요.",
    );
    for (const label of ["tool", "residence", "place"]) text(r[label], 200);
  }
  ws.dailyReports.forEach((d) => {
    id(d.id);
    text(d.region, 60, true);
    date(d.date);
    const key = JSON.stringify([d.region, d.date]);
    assert(!dailyKeys.has(key), "중복된 구역 일계입니다.");
    dailyKeys.add(key);
    for (const field of ["found", "advanced", "dropped"])
      assert(
        Number.isInteger(d[field]) && d[field] >= 0 && d[field] <= 1000000,
        "일계 수치를 확인해 주세요.",
      );
  });
  assert(
    Array.isArray(ws.goals) && ws.goals.length <= 10000,
    "목표 형식을 확인해 주세요.",
  );
  const goalKeys = new Set();
  for (const goal of ws.goals) {
    id(goal.id);
    const goalRegion = text(goal.region, 60);
    assert(
      goalRegion || (goal.region === "" && goal.className),
      "목표 구역 또는 반을 확인하세요.",
    );
    date(goal.from);
    date(goal.to);
    if (goal.className)
      K.resolve(ws, "className", goal.className, goal.className);
    assert(
      !goal.periodUnit || ["week", "month", "custom"].includes(goal.periodUnit),
      "목표 기간 단위를 확인하세요.",
    );
    assert(
      goal.from <= goal.to &&
        Number.isInteger(goal.target) &&
        goal.target >= 0 &&
        goal.target <= MAX_GOAL_TARGET &&
        (!goal.stageId ||
          goal.stageId === "*" ||
          ws.stages.includes(goal.stageId)),
      "목표 기간과 수치를 확인해 주세요.",
    );
    const key = JSON.stringify([
      goal.region,
      goal.from,
      goal.to,
      goal.stageId || "*",
      goal.className || "",
    ]);
    assert(!goalKeys.has(key), "중복된 목표입니다.");
    goalKeys.add(key);
  }
  assert(
    Array.isArray(ws.people) && ws.people.length <= 30000,
    "자료실별 대상자는 최대 30,000명입니다.",
  );
  const ids = new Set(),
    codes = new Set(),
    activityCodes = new Set(ws.activityLogs.map((a) => a.code));
  assert(
    activityCodes.size === ws.activityLogs.length,
    "중복된 활동 식별번호입니다.",
  );
  for (const p of ws.people) {
    id(p.id);
    assert(!ids.has(p.id), "중복된 대상자 식별자입니다.");
    ids.add(p.id);
    assert(
      Array.isArray(p.activities) && p.activities.length <= 10000,
      "활동 기록 형식을 확인해 주세요.",
    );
    validatePerson(p, ws, p);
    assert(!codes.has(p.code), "중복된 대상자 식별번호입니다.");
    codes.add(p.code);
    assert(
      ["active", "dropped"].includes(p.status) &&
        Array.isArray(p.lifecycle) &&
        p.lifecycle.length <= 10000,
      "탈락·복귀 이력을 확인해 주세요.",
    );
    for (const ev of p.lifecycle) {
      id(ev.id);
      assert(
        ["active", "dropped"].includes(ev.from) &&
          ["active", "dropped"].includes(ev.to) &&
          typeof ev.effectiveLocal === "string" &&
          /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/.test(ev.effectiveLocal),
        "탈락·복귀 이력 형식을 확인해 주세요.",
      );
      date(ev.effectiveLocal.slice(0, 10));
    }
    assert(
      Array.isArray(p.transitions) &&
        // 서버가 만든 범위 제한 보기(ws.serverScope.scoped)에서만, 보이는 단계 이동이 0건일 수 있다. 원본 검증은 그대로 엄격하다.
        (p.transitions.length > 0 || ws.serverScope?.scoped === true) &&
        p.transitions.length <= 10000,
      "단계 이력을 확인해 주세요.",
    );
    const transitionIds = new Set();
    for (const t of p.transitions) {
      id(t.id);
      assert(!transitionIds.has(t.id), "중복된 단계 이력입니다.");
      transitionIds.add(t.id);
      assert(
        (t.from === null || ws.stages.includes(t.from)) &&
          ws.stages.includes(t.to) &&
          typeof t.effectiveLocal === "string" &&
          /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/.test(t.effectiveLocal),
        "단계 이력 형식을 확인해 주세요.",
      );
      date(t.effectiveLocal.slice(0, 10));
    }
    const acts = new Set();
    for (const a of p.activities) {
      id(a.id);
      assert(
        !acts.has(a.id) && !activityCodes.has(a.code),
        "중복된 활동 식별번호입니다.",
      );
      acts.add(a.id);
      activityCodes.add(a.code);
      migrateActivityMinutes(a);
      const valid = validateActivity(a, a, ws);
      assert(valid.minutes === a.minutes, "활동 시간이 맞지 않습니다.");
    }
  }
  require("./socialing.cjs").validate(ws);
  require("./calling.cjs").validate(ws);
  verifyHistory(ws.history);
  assert(
    Number.isInteger(ws.revision) && ws.revision === ws.history.length,
    "자료 버전과 이력이 맞지 않습니다.",
  );
  return ws;
}
function validateDocument(doc) {
  assert(
    [1, 2, 3].includes(doc?.schemaVersion) &&
      Array.isArray(doc.workspaces) &&
      doc.workspaces.length > 0 &&
      doc.workspaces.length <= 20,
    "지원하지 않는 자료 형식입니다.",
  );
  const ids = new Set();
  doc.workspaces.forEach((ws) => {
    validateWorkspace(ws);
    assert(!ids.has(ws.id), "중복된 자료실 식별자입니다.");
    ids.add(ws.id);
  });
  assert(ids.has(doc.activeWorkspaceId), "활성 자료실을 찾을 수 없습니다.");
  assert(
    Number.isInteger(doc.settings?.idleMinutes) &&
      doc.settings.idleMinutes >= 1 &&
      doc.settings.idleMinutes <= 30,
    "자동 잠금 시간을 확인해 주세요.",
  );
  text(doc.settings.operator, 100, true);
  assert(
    doc.settings.weekStart === undefined ||
      (Number.isInteger(doc.settings.weekStart) &&
        doc.settings.weekStart >= 0 &&
        doc.settings.weekStart <= 6),
    "주간 시작 요일을 확인해 주세요.",
  );
  doc.schemaVersion = 3;
  return doc;
}
function newDocument(name, operator, demo = false) {
  const ws = newWorkspace(name);
  const doc = {
    schemaVersion: 3,
    workspaces: [ws],
    activeWorkspaceId: ws.id,
    settings: {
      idleMinutes: 5,
      weekStart: 0,
      operator: text(operator, 100, true),
    },
  };
  if (demo) {
    ws.name = "연습용 자료실 · 가상 데이터";
    for (let i = 0; i < 24; i++) {
      const d = new Date();
      d.setDate(d.getDate() - (i % 14));
      const localDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const p = validatePerson(
        {
          name: `연습 대상 ${String(i + 1).padStart(2, "0")}`,
          date: localDate,
          stage: STAGES[i % STAGES.length],
          worker: ["연습 담당 가", "연습 담당 나", "연습 담당 다"][i % 3],
          region: `${(i % 10) + 1}구역`,
          className: String((i % 3) + 1),
          employment: ["직장인", "학생", "기타"][i % 3],
          notes: "기능 확인용 가상 데이터입니다. 실제 인물이 아닙니다.",
        },
        ws,
      );
      transition(
        p,
        null,
        p.stage,
        localDate + "T09:00",
        operator,
        "연습용 최초 등록",
      );
      const a = validateActivity({
        date: localDate,
        start: ["10:00", "14:00", "19:00"][i % 3],
        end: ["10:30", "15:00", "19:45"][i % 3],
        worker: p.worker,
        kind: ["대화", "콜링", "만남"][i % 3],
      });
      p.activities.push(a);
      ws.people.push(p);
    }
    audit(ws, operator, "연습 데이터 생성", ws.id, null, { people: 24 });
  }
  return doc;
}
function current(doc) {
  return doc.workspaces.find((w) => w.id === doc.activeWorkspaceId);
}
function normalizeFilters(input = {}) {
  const f = {};
  for (const key of [
    "search",
    "worker",
    "region",
    "className",
    "employment",
    "stage",
    "timeBand",
    "transitionFrom",
    "transitionTo",
    "place",
    "status",
    "introducerId",
    "orgUnitId",
  ])
    f[key] = text(input[key] || "", 200);
  f.basis = ["activity", "transition"].includes(input.basis)
    ? input.basis
    : "registered";
  f.from = date(input.from || "", false);
  f.to = date(input.to || "", false);
  assert(
    !f.from || !f.to || f.from <= f.to,
    "검색 시작일은 종료일보다 늦을 수 없습니다.",
  );
  for (const key of ["minMinutes", "maxMinutes"]) {
    f[key] =
      input[key] === "" || input[key] == null ? null : Number(input[key]);
    assert(
      f[key] === null ||
        (Number.isFinite(f[key]) && f[key] >= 0 && f[key] <= 1439),
      "활동 시간은 0~1439분으로 입력해 주세요.",
    );
  }
  f.classification2 = Classification.filter(input.classification2);
  assert(
    f.minMinutes === null ||
      f.maxMinutes === null ||
      f.minMinutes <= f.maxMinutes,
    "최소 활동 시간은 최대 시간보다 클 수 없습니다.",
  );
  return f;
}
function query(ws, input = {}) {
  const f = normalizeFilters(input),
    inDate = (d) => (!f.from || d >= f.from) && (!f.to || d <= f.to);
  const firstDaily = new Map();
  for (const r of ws.findingReports || [])
    if (
      !firstDaily.has(r.personCode) ||
      r.date < firstDaily.get(r.personCode).date
    )
      firstDaily.set(r.personCode, r);
  for (const key of ["className", "employment"])
    if (f[key]) f[key] = K.find(ws, key, f[key])?.value || f[key];
  const activityCondition = (a) =>
    Classification.matches(Classification.activity(a), f.classification2) &&
    inDate(a.date) &&
    (!f.timeBand || band(a.start) === f.timeBand) &&
    (f.minMinutes === null || a.minutes >= f.minMinutes) &&
    (f.maxMinutes === null || a.minutes <= f.maxMinutes) &&
    (!f.place ||
      K.label(ws, "activityPlace", a.place)
        .toLocaleLowerCase()
        .includes(f.place.toLocaleLowerCase()));
  const activityRequired =
    (f.basis === "activity" && Boolean(f.from || f.to)) ||
    Boolean(f.timeBand || f.place) ||
    f.minMinutes !== null ||
    f.maxMinutes !== null;
  const term = f.search.toLocaleLowerCase();
  const org = O.get(ws),
    memberMap = new Map(org.members.map((m) => [m.id, m]));
  if (f.orgUnitId)
    assert(
      org.nodes.some((n) => n.id === f.orgUnitId),
      "검색 조직을 찾을 수 없습니다.",
    );
  const matchesFacets = (p, includeClassification = true) => {
    if (
      includeClassification &&
      !Classification.matches(Classification.person(p), f.classification2)
    )
      return false;
    if (
      term &&
      ![
        p.name,
        p.code,
        p.worker,
        memberMap.get(p.introducerId)?.name,
        memberMap.get(p.introducerId)?.code,
        p.region,
        K.label(ws, "className", p.className),
        K.label(ws, "employment", p.employment),
        stageName(ws, p.stage),
        p.notes,
        p.place,
        p.tool,
        p.classification1,
        p.classification2,
        p.residence,
        p.phone,
        p.teacher,
        p.reason,
        ...Object.values(p.custom),
      ]
        .join(" ")
        .toLocaleLowerCase()
        .includes(term)
    )
      return false;
    if (f.status && p.status !== f.status) return false;
    if (f.introducerId && p.introducerId !== f.introducerId) return false;
    if (
      f.orgUnitId &&
      !O.within(org, memberMap.get(p.introducerId)?.unitId, f.orgUnitId)
    )
      return false;
    if (
      (f.worker && p.worker !== f.worker) ||
      (f.region && (p.region || "미입력") !== f.region) ||
      (f.className && p.className !== f.className) ||
      (f.employment && p.employment !== f.employment) ||
      (f.stage && p.stage !== f.stage)
    )
      return false;
    return true;
  };
  const population = ws.people.filter((p) => matchesFacets(p));
  const matchesPeriod = (p) => {
    if (f.basis === "registered" && !inDate(p.date)) return false;
    if (
      (f.basis === "transition" || f.transitionFrom || f.transitionTo) &&
      !p.transitions.some(
        (t) =>
          t.from !== t.to &&
          (!f.transitionFrom || t.from === f.transitionFrom) &&
          (!f.transitionTo || t.to === f.transitionTo) &&
          (f.basis !== "transition" || inDate(t.effectiveLocal.slice(0, 10))),
      )
    )
      return false;
    return !activityRequired || p.activities.some(activityCondition);
  };
  const people = population.filter(matchesPeriod);
  const activityPeople = f.classification2
    ? ws.people.filter((p) => matchesFacets(p, false) && matchesPeriod(p))
    : people;
  const activities = [
    ...activityPeople.flatMap((p) =>
      p.activities.filter(activityCondition).map((a) => ({
        ...a,
        region: a.region || p.region,
        personId: p.id,
        personCode: p.code,
        personName: p.name,
        className: p.className,
        employment: p.employment,
        stage: p.stage,
      })),
    ),
    ...ws.activityLogs
      .filter(
        (a) =>
          activityCondition(a) &&
          (!f.region || (a.region || "미입력") === f.region) &&
          (!f.worker || a.worker === f.worker) &&
          (!f.search ||
            [a.code, a.worker, a.workerId, a.place, a.notes]
              .join(" ")
              .toLocaleLowerCase()
              .includes(term)) &&
          !f.className &&
          !f.stage &&
          !f.employment &&
          !f.status &&
          !f.introducerId &&
          !f.orgUnitId &&
          !f.transitionFrom &&
          !f.transitionTo,
      )
      .map((a) => ({
        ...a,
        personId: null,
        personCode: "",
        personName: "",
        className: "",
        employment: "",
        stage: "",
      })),
  ];
  const transitions = people.flatMap((p) =>
    p.transitions
      .filter(
        (t) =>
          t.from !== null && t.from !== t.to &&
          (!f.transitionFrom || t.from === f.transitionFrom) &&
          (!f.transitionTo || t.to === f.transitionTo) &&
          (f.basis !== "transition" || inDate(t.effectiveLocal.slice(0, 10))),
      )
      .map((t) => ({ ...t, personId: p.id, personName: p.name })),
  );
  const matchingGoals = ws.goals.filter(
    (g) =>
      !g.className &&
      g.from === f.from &&
      g.to === f.to &&
      (!f.region || g.region === f.region),
  );
  const goals = matchingGoals.filter((g) => !g.stageId || g.stageId === "*");
  const wholeGoalScope =
    ![
      "introducerId",
      "orgUnitId",
      "search",
      "worker",
      "className",
      "employment",
      "stage",
      "status",
      "place",
      "timeBand",
      "transitionFrom",
      "transitionTo",
      "classification2",
    ].some((key) => Boolean(f[key])) &&
    f.minMinutes === null &&
    f.maxMinutes === null;
  const regions = [
    ...new Set([
      ...people.map((p) => p.region || "미입력"),
      ...goals.map((g) => g.region),
    ]),
  ]
    .sort((a, b) => a.localeCompare(b, "ko", { numeric: true }))
    .map((label) => {
      const found = people.filter(
          (p) => (p.region || "미입력") === label,
        ).length,
        target = goals.find((g) => g.region === label)?.target ?? null;
      return {
        label,
        value: found,
        target,
        shortfall: target === null ? null : Math.max(0, target - found),
        rate: target === null || target === 0 ? null : (found / target) * 100,
      };
    });
  const stageCohorts = require("./stage-cohort.cjs").measure(ws, {
    from: f.from,
    to: f.to,
    people: population.filter((p) =>
      ((!f.transitionFrom && !f.transitionTo) || p.transitions.some((t) =>
        t.from !== t.to &&
        (!f.transitionFrom || t.from === f.transitionFrom) &&
        (!f.transitionTo || t.to === f.transitionTo),
      )) && (!activityRequired || p.activities.some(activityCondition)),
    ),
  }).overall;
  const summary = {
    people: people.length,
    activities: activities.length,
    minutes: activities.reduce((sum, a) => sum + a.minutes, 0),
    workers: new Set(
      activities
        .filter((a) => a.worker || a.workerId)
        .map((a) => a.workerId || `${a.region}\u0000${a.worker}`),
    ).size,
    stages: ws.stages.map((stage) => ({
      id: stage,
      label: stageName(ws, stage),
      inactive: ws.inactiveStages.includes(stage),
      value: people.filter((p) => p.stage === stage).length,
    })),
    classes: group(
      people,
      (p) => K.label(ws, "className", p.className) || "미입력",
    ),
    regions,
    bands: ["새벽", "오전", "오후", "저녁", "미입력"].map((label) => ({
      label,
      value: activities.filter((a) => band(a.start) === label).length,
    })),
    daily: group(activities, (a) => a.date).sort((a, b) =>
      a.label.localeCompare(b.label),
    ),
    foundDaily: group(
      people.filter((p) => p.date && !p.dateUnknown),
      (p) => p.date,
    ).sort((a, b) => a.label.localeCompare(b.label)),
    transitionCount: transitions.length,
    movements: group(
      transitions,
      (t) => `${stageName(ws, t.from)} → ${stageName(ws, t.to)}`,
    ),
    cohort: stageCohorts.stages.map((stage) => ({
      ...stage,
      label: `${stage.fromLabel} → ${stage.label}`,
      value: stage.count,
    })),
    target: goals.length ? goals.reduce((sum, g) => sum + g.target, 0) : null,
    shortfall: goals.length
      ? regions.reduce((sum, r) => sum + (r.shortfall || 0), 0)
      : null,
    inventory: ws.stages.map((stage) => {
      const attainment = require("./person-stages.cjs").attainmentFor(ws, stage);
      const asOf = (p) =>
        p.transitions
          .filter((t) =>
            t.from !== t.to && (!f.to || t.effectiveLocal.slice(0, 10) <= f.to),
          )
          .at(-1);
      const alive = (p) =>
        (p.lifecycle
          .filter((t) => !f.to || t.effectiveLocal.slice(0, 10) <= f.to)
          .at(-1)?.to || "active") === "active";
      return {
        id: stage,
        label: stageName(ws, stage),
        stock: population.filter((p) => alive(p) && asOf(p)?.to === stage)
          .length,
        retained: f.from
          ? population.filter((p) => {
              const t = asOf(p);
              return (
                alive(p) &&
                t?.to === stage &&
                t.effectiveLocal.slice(0, 10) < f.from &&
                !p.lifecycle.some(
                  (ev) =>
                    ev.to === "dropped" &&
                    inDate(ev.effectiveLocal.slice(0, 10)),
                )
              );
            }).length
          : null,
        entered: population.filter((p) => {
          const entry = attainment(p, firstDaily.get(p.code));
          return entry && inDate(entry.date);
        }).length,
        left: population.filter((p) =>
          p.transitions.some(
            (t) =>
              t.from === stage &&
              t.to !== stage &&
              inDate(t.effectiveLocal.slice(0, 10)),
          ),
        ).length,
        restored: population.filter((p) =>
          p.lifecycle.some(
            (ev) =>
              ev.to === "active" &&
              inDate(ev.effectiveLocal.slice(0, 10)) &&
              p.transitions
                .filter((t) => t.effectiveLocal <= ev.effectiveLocal)
                .at(-1)?.to === stage,
          ),
        ).length,
        target:
          wholeGoalScope && matchingGoals.some((g) => g.stageId === stage)
            ? matchingGoals
                .filter((g) => g.stageId === stage)
                .reduce((sum, g) => sum + g.target, 0)
            : null,
      };
    }),
    reported: ws.dailyReports
      .filter((d) => inDate(d.date) && (!f.region || d.region === f.region))
      .reduce(
        (s, d) => ({
          found: s.found + d.found,
          advanced: s.advanced + d.advanced,
          dropped: s.dropped + d.dropped,
          days: s.days + 1,
        }),
        { found: 0, advanced: 0, dropped: 0, days: 0 },
      ),
    dropoutCount: population.filter((p) =>
      p.lifecycle.some(
        (ev) => ev.to === "dropped" && inDate(ev.effectiveLocal.slice(0, 10)),
      ),
    ).length,
    goalComparable:
      f.basis === "registered" &&
      !f.introducerId &&
      !f.orgUnitId &&
      !f.search &&
      !f.worker &&
      !f.className &&
      !f.employment &&
      !f.stage &&
      !f.status &&
      !f.place &&
      !f.timeBand &&
      f.minMinutes === null &&
      f.maxMinutes === null &&
      !f.transitionFrom &&
      !f.transitionTo,
  };
  const reportRows = ws.dailyReports.filter(
    (d) => inDate(d.date) && (!f.region || d.region === f.region),
  );
  const reportGoals = matchingGoals.filter((g) => g.stageId === ws.stages[0]);
  const reportRegions = [
    ...new Set([
      ...reportRows.map((d) => d.region),
      ...reportGoals.map((g) => g.region),
    ]),
  ].sort((a, b) => a.localeCompare(b, "ko", { numeric: true }));
  summary.reported.regions = reportRegions.map((label) => {
    const rows = reportRows.filter((d) => d.region === label),
      value = rows.reduce((sum, d) => sum + d.found, 0),
      goal = reportGoals.find((g) => g.region === label),
      target = goal?.target ?? null;
    return {
      label,
      value,
      target,
      shortfall: target === null ? null : Math.max(0, target - value),
      rate: target ? (value / target) * 100 : null,
      advanced: rows.reduce((sum, d) => sum + d.advanced, 0),
      dropped: rows.reduce((sum, d) => sum + d.dropped, 0),
    };
  });
  summary.reported.daily = [...new Set(reportRows.map((d) => d.date))]
    .sort()
    .map((label) => ({
      label,
      value: reportRows
        .filter((d) => d.date === label)
        .reduce((sum, d) => sum + d.found, 0),
    }));
  const periodActivities = [
    ...ws.activityLogs.map((a) => ({ a, region: a.region })),
    ...ws.people.flatMap((p) =>
      p.activities.map((a) => ({ a, region: a.region || p.region })),
    ),
  ].filter(
    ({ a, region }) =>
      inDate(a.date) && (!f.region || (region || "미입력") === f.region),
  );
  summary.periodActivity = {
    count: periodActivities.length,
    minutes: periodActivities.reduce((sum, { a }) => sum + a.minutes, 0),
    workers: new Set(
      periodActivities
        .filter(({ a }) => a.worker || a.workerId)
        .map(({ a, region }) => a.workerId || `${region}\u0000${a.worker}`),
    ).size,
  };
  return { people, activities, transitions, summary, filters: f };
}
function group(items, key) {
  const groups = new Map();
  items.forEach((item) => {
    const k = key(item);
    groups.set(k, (groups.get(k) || 0) + 1);
  });
  return [...groups].map(([label, value]) => ({ label, value }));
}
function stageName(ws, id) {
  return ws.stageNames?.[id] || id || "최초 등록";
}
function lifecycleChange(person, to, effectiveLocal, actor, reason) {
  assert(["active", "dropped"].includes(to), "탈락·복귀 상태를 선택해 주세요.");
  assert(
    typeof effectiveLocal === "string" &&
      /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/.test(effectiveLocal),
    "적용 시각을 확인해 주세요.",
  );
  date(effectiveLocal.slice(0, 10));
  const ev = {
    id: uuid(),
    from: person.status,
    to,
    effectiveLocal,
    recordedAt: now(),
    actor: text(actor, 100, true),
    reason: text(reason || "", 2000),
    region: person.region,
  };
  person.lifecycle.push(ev);
  person.status = to;
  person.updatedAt = now();
  return ev;
}
module.exports = {
  STAGES,
  MAX_STAGES,
  MAX_GOAL_TARGET,
  PERSON_CLASSIFICATIONS,
  TYPES,
  uuid,
  now,
  copy,
  hash,
  assert,
  text,
  id,
  date,
  time,
  minutes,
  band,
  validateFields,
  validatePerson,
  validateActivity,
  assertNoActivityOverlap,
  transition,
  lifecycleChange,
  stageName,
  audit,
  personChanges,
  verifyHistory,
  newWorkspace,
  validateWorkspace,
  validateDocument,
  newDocument,
  current,
  query,
  normalizeFilters,
  group,
};
