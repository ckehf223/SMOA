import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { HttpError } from './security.js';
import { OPTIONS } from './store.js';
import { commitWorkspace, domainError, legacyStageId, projectPerson, sanitizePhoneText, scopedWorkspace, seoulLocal } from './domain.js';

const require = createRequire(import.meta.url);
const M = require('./legacy/model.cjs');
const { isPhoneHeader } = require('./legacy/person-phone.cjs');
const O = require('./legacy/organization.cjs');
const PS = require('./legacy/person-stages.cjs');
const PM = require('./legacy/ui/person-milestones.js');

const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const CODE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{2,29}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
export const STATUSES = ['active', 'dropped'];
export const bad = (msg) => new HttpError(400, msg);

export function text(v, label, max, required = false) {
  if (v != null && typeof v !== 'string') throw bad(`${label}: 문자로 입력해 주세요.`);
  const s = (v ?? '').trim();
  if (required && !s) throw bad(`${label}: 필수 항목입니다.`);
  if (s.length > max) throw bad(`${label}: ${max}자 이하로 입력해 주세요.`);
  if (CONTROL.test(s)) throw bad(`${label}: 사용할 수 없는 문자가 있습니다.`);
  return s;
}

function choice(v, label, list, fallback) {
  const s = v == null || v === '' ? fallback : v;
  if (!list.includes(s)) throw bad(`${label}: 선택 항목을 확인해 주세요.`);
  return s;
}

/** 한국 날짜(YYYY-MM-DD). 한국은 UTC+9이고 서머타임이 없다. */
export function seoulDate(ms) {
  return new Date(ms + 9 * 3_600_000).toISOString().slice(0, 10);
}

export function validDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** 기록하는 날짜는 오늘(한국 시각)을 넘을 수 없다. */
function pastDate(value, label, store) {
  if (typeof value !== 'string' || !validDate(value)) throw bad(`${label}: YYYY-MM-DD 형식의 올바른 날짜를 입력해 주세요.`);
  if (value > seoulDate(store.now())) throw bad(`${label}: 오늘 이후 날짜는 기록할 수 없습니다.`);
  return value;
}

/**
 * 대상자 한 명의 버전. 중첩 기록(단계 이력·활동·탈락 이력)까지 포함한 원본 전체의 해시라서,
 * 화면을 연 뒤 어디서든 이 대상자가 바뀌면 달라진다. 내용은 알 수 없고 비교에만 쓴다.
 */
export const personRevision = (canonical) => createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 32);

/** 화면에서 받은 버전이 현재 원본과 같은지 확인한다. 필수가 아니면 값이 없을 때 건너뛴다(기존 API 호환). */
export function checkRevision(store, id, supplied, required) {
  if (supplied === undefined || supplied === null || supplied === '') {
    if (required) throw bad('대상자 버전 정보가 없습니다. 화면을 새로 고친 뒤 다시 시도해 주세요.');
    return;
  }
  const canonical = store.workspace.people.find((p) => p.id === id);
  if (typeof supplied !== 'string' || !canonical || personRevision(canonical) !== supplied) {
    throw new HttpError(409, '다른 곳에서 이 대상자의 정보가 바뀌었습니다. 화면을 새로 고친 뒤 다시 시도해 주세요.');
  }
}

export function toPublic(p) {
  const { id, code, name, gender, age, districtId, stageId, status, classification1, classification2, registeredDate, worker, notes, updatedAt } = p;
  return { id, code, name, gender, age, districtId, stageId, status, classification1, classification2, registeredDate, worker, notes, updatedAt };
}

/** 원본 대상자 → 웹 투영(+ 진행·탈락 상태). */
export const projectWithStatus = (store, canonical) => ({ ...projectPerson(store, canonical), status: canonical.status });

/** 허용된 필드만 읽는다(알 수 없는 필드·id는 무시). 구역은 사용자 범위 안에서만, 단계는 공통코드 ID로만 허용한다. */
export function validatePerson(input, store, scope, existing) {
  const age = input.age;
  let ageValue = null;
  if (age !== '' && age != null) {
    ageValue = typeof age === 'number' || typeof age === 'string' ? Number(age) : NaN;
    if (!Number.isInteger(ageValue) || ageValue < 0 || ageValue > 120) throw bad('나이: 0~120 사이 정수로 입력해 주세요.');
  }
  if (typeof input.districtId !== 'string' || !store.districts.some((d) => d.id === input.districtId)) {
    throw bad('구역: 선택 항목을 확인해 주세요.');
  }
  if (!scope.has(input.districtId)) throw new HttpError(403, '배정된 구역이 아닙니다.');
  const stage = store.stages.find((s) => s.id === input.stageId);
  if (!stage || (!stage.active && existing?.stageId !== stage.id)) throw bad('단계: 선택 항목을 확인해 주세요.');

  // 수정 요청에 등록일이 없으면 기존 값을 유지한다(원본에 날짜가 없던 대상자는 빈 값 그대로).
  const registeredDate = input.registeredDate || (existing ? existing.registeredDate : seoulDate(store.now()));
  if (!(existing && registeredDate === '') && !validDate(registeredDate)) throw bad('등록일: YYYY-MM-DD 형식의 올바른 날짜를 입력해 주세요.');

  let code = existing?.code;
  if (!existing) {
    code = text(input.code, '식별번호', 30);
    if (code) {
      if (!CODE_RE.test(code) || /^\d{4}$/.test(code)) throw bad('식별번호: 영문·숫자·-·_ 3~30자로 입력하고, 네 자리 숫자만으로는 만들 수 없습니다.');
      if (codeTaken(store, code)) throw new HttpError(409, '이미 사용 중인 식별번호입니다.');
    } else {
      do code = `P-${String(++store.counters.person).padStart(4, '0')}`;
      while (codeTaken(store, code));
    }
  }

  return {
    code,
    name: text(input.name, '이름', 100, true),
    gender: choice(input.gender, '성별', OPTIONS.genders, OPTIONS.genders[0]),
    age: ageValue,
    districtId: input.districtId,
    stageId: stage.id,
    classification1: choice(input.classification1, '분류1', OPTIONS.classification1, OPTIONS.classification1[0]),
    classification2: choice(input.classification2, '분류2', OPTIONS.classification2, OPTIONS.classification2[0]),
    registeredDate,
    worker: text(input.worker, '담당자', 100),
    notes: text(input.notes, '비고', 2000),
    ...optionalFields(input, store),
  };
}

const OPTIONAL_TEXT = [
  ['place', '찾기 장소', 200],
  ['tool', '사용 도구', 200],
  ['residence', '거주지', 200],
  ['teacher', '교사', 100],
  ['stageReason', '사유', 2000],
  ['className', '반', 60],
  ['introducerId', '인도자', 80],
];

/**
 * 선택 항목: 요청에 키가 있을 때만 결과에 담는다(없으면 기존 값을 건드리지 않는다).
 * 빈 문자열은 "비우기"를 뜻한다. 연락처는 이 경로로 받지 않는다.
 */
function optionalFields(input, store) {
  const out = {};
  for (const [key, label, max] of OPTIONAL_TEXT) if (input[key] !== undefined) out[key] = text(input[key], label, max);
  if (input.registeredTime !== undefined) {
    const time = text(input.registeredTime, '찾은 시간', 5);
    if (time && !TIME_RE.test(time)) throw bad('찾은 시간: HH:MM 형식으로 입력해 주세요.');
    out.registeredTime = time;
  }
  if (input.stageApplyDate) out.stageApplyDate = pastDate(input.stageApplyDate, '단계 적용일', store);
  const milestones = {};
  for (const { field, label } of PM.fields) {
    const value = input[field];
    if (value === undefined || value === null || value === '') continue;
    if (!PM.stageId(store.workspace, field)) throw bad(`${label}: 이 자료실에 해당 단계가 없습니다.`);
    milestones[field] = pastDate(value, label, store);
  }
  if (Object.keys(milestones).length) out.milestones = milestones;
  if (input.revision !== undefined && input.revision !== null) out.revision = text(input.revision, '대상자 버전', 64);
  if (input.custom !== undefined) out.custom = customPayload(input.custom, store.workspace.fields ?? []);
  return out;
}

/** 연락처로 지정된 사용자 항목(이름 기준). 이 항목은 웹에서 값을 바꾸지 않고 끝 네 자리만 보여 준다. */
const CONTACT_LABEL = /phone|연락처|휴대폰|핸드폰|전화/i;
export const isContactField = (field) => isPhoneHeader(field.label) || CONTACT_LABEL.test(String(field.label ?? ''));

/** 사용자 항목 한 칸의 입력 형태 검사. 값의 범위와 선택지 검증은 4.0.41 M.validatePerson이 이어서 한다. */
function customValue(field, v) {
  if (v === null || v === '') return ''; // 비우기
  const { label, type } = field;
  if (type === 'number') {
    if (typeof v !== 'number' || !Number.isFinite(v)) throw bad(`${label}: 숫자로 입력해 주세요.`);
    return v;
  }
  if (type === 'boolean') {
    if (typeof v !== 'boolean') throw bad(`${label}: 체크 항목이 올바르지 않습니다.`);
    return v;
  }
  const s = text(v, label, 2000);
  if (sanitizePhoneText(s) !== s) throw bad(`${label}: 연락처 형태의 값은 사용자 항목에 저장할 수 없습니다.`);
  return s;
}

/**
 * 사용자 항목 입력: { 항목ID: 값 } 객체만 받는다. 설정에 없는 항목과 연락처 항목은 거절한다.
 * 요청에 없는 항목은 결과에 담지 않으므로 수정할 때 기존 값이 유지된다(mergedCustom).
 */
function customPayload(value, fields) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw bad('사용자 항목: 올바른 형식이 아닙니다.');
  const out = {};
  for (const [key, v] of Object.entries(value)) {
    const field = fields.find((f) => f.id === key);
    if (!field) throw bad('사용자 항목: 설정되지 않은 항목입니다.');
    if (isContactField(field)) throw bad(`${field.label}: 연락처 항목은 이 화면에서 바꿀 수 없습니다.`);
    out[key] = customValue(field, v);
  }
  return out;
}

/** 수정 시 사용자 항목: 기존 값 위에 요청에 있는 항목만 덮어쓴다(연락처 항목은 항상 기존 값 그대로). */
const mergedCustom = (existing, data) => ({ ...(existing ?? {}), ...(data ?? {}) });

const codeTaken = (store, code) => store.workspace.people.some((p) => p.code.toLowerCase() === code.toLowerCase());

/** 웹 입력(검증 끝난 값) → 기존 4.0.41 대상자 입력 */
function legacyInput(store, data, base = {}) {
  const district = store.districts.find((d) => d.id === data.districtId);
  return {
    ...base,
    code: data.code,
    name: data.name,
    gender: data.gender,
    age: data.age === null ? '' : data.age,
    classification1: data.classification1,
    classification2: data.classification2,
    region: district.name,
    stage: legacyStageId(data.stageId),
    date: data.registeredDate,
    worker: data.worker,
    notes: data.notes,
    // 선택 항목은 요청에 있을 때만 덮어쓴다. 없으면 base(기존 값)가 그대로 남는다.
    ...Object.fromEntries(['place', 'tool', 'residence', 'teacher', 'stageReason', 'className', 'introducerId'].filter((k) => data[k] !== undefined).map((k) => [k, data[k]])),
    ...(data.registeredTime !== undefined ? { time: data.registeredTime } : {}),
  };
}

/**
 * 새로 연결하는 인도자는 대상자와 같은 구역의 구성원이어야 한다(구역 범위와 인도자 범위가 어긋나지 않게).
 * 기존 연결은 그대로 둔다. 구성원이 없으면 기존 검증이 같은 이유로 거절한다.
 */
function checkIntroducerDistrict(ws, introducerId, regionName, existingId) {
  if (!introducerId || introducerId === existingId) return;
  const org = O.get(ws);
  const member = org.members.find((m) => m.id === introducerId);
  if (member && O.regionOf(org, member.unitId) !== regionName) throw bad('인도자: 대상자와 같은 구역의 구성원을 선택해 주세요.');
}

/** 단계 이동 이력의 적용 시각. 날짜만 알면 00:00으로 두고 시각 미기록으로 표시한다(기존 방식). */
function stageEffective(store, data, from, ws, target) {
  const field = PM.fields.find(({ field: key }) => PM.stageId(ws, key) === target)?.field;
  // 등록(from 없음)에서는 기존 도달일이 없으므로 입력한 최초 도달일을 그대로 쓴다.
  const firstMilestone = field && (!from || !PM.value(from, field, ws)) ? data.milestones?.[field] : '';
  const day = firstMilestone || data.stageApplyDate || '';
  return day ? { at: `${day}T00:00`, timeUnknown: true } : { at: seoulLocal(store.now()), timeUnknown: false };
}

/**
 * 대상자 등록. 사용자 범위의 복사본에서 4.0.41 규칙으로 검증하고 최초 단계 이력과 변경 이력을 남긴 뒤
 * commitWorkspace로 원본에 합친다. 반환: 웹 투영.
 */
export function createPerson(store, user, data) {
  try {
    const draft = scopedWorkspace(store, user);
    const input = legacyInput(store, data);
    input.custom = data.custom ?? {}; // 연락처 항목은 payload에 없으므로 빈 값으로 만들어진다.
    checkIntroducerDistrict(draft, data.introducerId, input.region, null);
    const person = M.validatePerson({ ...input, ageAsOf: data.registeredDate }, draft);
    person.updatedAt = new Date(store.now()).toISOString();
    // 4.0.41: 첫 단계(찾음)로 등록하면 찾은 날짜·시간이 적용 시각이다(시간을 모르면 시각 미기록).
    // 그 밖의 단계로 바로 등록하면 최초 도달일·단계 적용일(00:00, 시각 미기록)을, 날짜가 없으면 저장 시각을 쓴다.
    const initialFinding = person.stage === draft.stages[0];
    const effective = initialFinding
      ? { at: `${data.registeredDate}T${data.registeredTime || '00:00'}`, timeUnknown: !data.registeredTime }
      : stageEffective(store, data, null, draft, person.stage);
    const first = M.transition(person, null, person.stage, effective.at, user.displayName, data.stageReason ?? '', draft.stageNames);
    if (effective.timeUnknown) first.timeUnknown = true;
    const stageDateChanges = PS.apply(person, data.milestones ?? {}, draft);
    draft.people.push(person);
    M.audit(draft, user.displayName, '대상자 등록', person.id, null, M.personChanges(null, person).after);
    PS.audit(draft, user.displayName, person, stageDateChanges);
    commitWorkspace(store, user, draft);
    return projectWithStatus(store, store.workspace.people.find((p) => p.id === person.id));
  } catch (error) {
    throw domainError(error);
  }
}

/**
 * 대상자 수정. 웹 화면에 없는 기존 정보(인도자·단계 이력·활동 등)는 그대로 보존하고,
 * 단계가 바뀌면 실제 변경 시각으로 단계 이동 이력을 남긴다.
 */
export function updatePerson(store, user, person, data) {
  try {
    const draft = scopedWorkspace(store, user);
    const existing = draft.people.find((p) => p.id === person.id);
    if (!existing) throw new HttpError(404, '대상자를 찾을 수 없습니다.');
    checkRevision(store, existing.id, data.revision, false);
    const input = legacyInput(store, { ...data, code: existing.code }, existing);
    checkIntroducerDistrict(draft, data.introducerId, input.region, existing.introducerId);
    input.custom = mergedCustom(existing.custom, data.custom);
    const ageChanged = (data.age === null ? '' : data.age) !== existing.age;
    input.ageAsOf = ageChanged ? seoulLocal(store.now()).slice(0, 10) : existing.ageAsOf;
    if (existing.dateUnknown && !data.registeredDate) delete input.date;
    // 범위 복사본의 연락처는 끝 네 자리뿐이라 형식 검사를 통과하지 못한다. 연락처는 이 경로에서 바꾸지 않으므로 검증에서 빼고 되돌린다.
    input.phone = '';
    const next = M.validatePerson(input, draft, existing);
    if (existing.phone !== undefined) next.phone = existing.phone;
    if (next.stage !== existing.stage) {
      const { at, timeUnknown } = stageEffective(store, data, existing, draft, next.stage);
      const event = M.transition(next, existing.stage, next.stage, at, user.displayName, data.stageReason ?? '', draft.stageNames);
      if (timeUnknown) event.timeUnknown = true;
    }
    const stageDateChanges = PS.apply(next, data.milestones ?? {}, draft);
    const changes = M.personChanges(existing, next);
    if (!Object.keys(changes.after).length && !stageDateChanges.length) return projectWithStatus(store, store.workspace.people.find((p) => p.id === person.id));
    next.updatedAt = new Date(store.now()).toISOString();
    draft.people[draft.people.indexOf(existing)] = next;
    M.audit(draft, user.displayName, next.stage !== existing.stage ? '대상자 수정·단계 이동' : '대상자 수정', next.id, changes.before, changes.after);
    PS.audit(draft, user.displayName, next, stageDateChanges);
    commitWorkspace(store, user, draft);
    return projectWithStatus(store, store.workspace.people.find((p) => p.id === person.id));
  } catch (error) {
    throw domainError(error);
  }
}

/** 구역 범위(scope)는 항상 먼저 적용한다. 목록·내보내기가 같은 함수를 쓴다. */
export function filterPeople(store, scope, query) {
  const q = (query.get('q') ?? '').trim().toLowerCase();
  const districtId = query.get('districtId') ?? '';
  const stageId = query.get('stageId') ?? '';
  const status = query.get('status') ?? '';
  if (q.length > 100) throw bad('검색어가 너무 깁니다.');
  if (districtId && !scope.has(districtId)) throw new HttpError(403, '접근할 수 없는 구역입니다.');
  if (stageId && !store.stages.some((s) => s.id === stageId)) throw bad('단계를 확인해 주세요.');
  if (status && !STATUSES.includes(status)) throw bad('상태를 확인해 주세요.');
  const states = new Map(store.workspace.people.map((p) => [p.id, p.status]));
  const keysOf = q ? searchKeys(store, scope) : null;
  return store.people
    .filter((p) => scope.has(p.districtId))
    .map((p) => ({ ...p, status: states.get(p.id) ?? 'active' }))
    .filter((p) => !districtId || p.districtId === districtId)
    .filter((p) => !stageId || p.stageId === stageId)
    .filter((p) => !status || p.status === status)
    .filter((p) => !q || keysOf(p).some((v) => v.toLowerCase().includes(q)))
    .sort((a, b) => b.registeredDate.localeCompare(a.registeredDate) || a.code.localeCompare(b.code));
}

/**
 * 대상자 검색 낱말: 이름·식별번호·담당자·비고(기존) + 인도자 이름·번호 + 찾기 장소.
 * 인도자는 요청자 구역 범위 안 구성원일 때만 쓰며(범위 밖 인도자는 상세 화면에서도 가려진다), 연락처와 그 끝 네 자리는 넣지 않는다.
 */
function searchKeys(store, scope) {
  const source = new Map(store.workspace.people.map((p) => [p.id, p]));
  const districtOf = new Map(store.districts.map((d) => [d.name, d.id]));
  const members = new Map();
  try {
    const org = O.get(store.workspace);
    for (const m of org.members) {
      let region = '';
      try {
        region = O.regionOf(org, m.unitId);
      } catch {
        continue;
      }
      if (scope.has(districtOf.get(region))) members.set(m.id, m);
    }
  } catch {
    // 조직 자료를 읽을 수 없으면 인도자 없이 기존 항목으로만 찾는다.
  }
  const text = (v) => (typeof v === 'string' ? v : '');
  // 자유 입력 칸 속 전화번호는 가린 형태(***-****-1234)마저 지워 끝 네 자리로도 찾히지 않게 한다.
  const noPhone = (v) => text(sanitizePhoneText(text(v))).replace(/\*{3}-\*{4}-\d{4}/g, ' ');
  return (p) => {
    const raw = source.get(p.id);
    const introducer = raw?.introducerId ? members.get(raw.introducerId) : null;
    return [p.name, p.code, p.worker, p.notes, raw?.place, introducer?.name, introducer?.code].map(noPhone);
  };
}

export function dashboard(store, scope) {
  const rows = store.people.filter((p) => scope.has(p.districtId));
  const month = seoulDate(store.now()).slice(0, 7);
  const count = (fn) => rows.filter(fn).length;
  return {
    total: rows.length,
    thisMonth: count((p) => p.registeredDate.startsWith(month)),
    byStage: store.stages
      .map((s) => ({ id: s.id, name: s.name, active: s.active, count: count((p) => p.stageId === s.id) }))
      .filter((s) => s.active || s.count > 0),
    byDistrict: store.districts.filter((d) => scope.has(d.id)).map((d) => ({ id: d.id, name: d.name, count: count((p) => p.districtId === d.id) })),
  };
}

const safeCell = (v) => (typeof v === 'string' && /^[=+\-@\t\r]/.test(v) ? `'${v}` : v);

/** 엑셀 내보내기: 연락처 등 개인 연락 정보는 이 화면 자료에 없다. 수식처럼 보이는 문자열은 무력화한다. */
export async function buildWorkbook(store, rows) {
  // 아래 await 전에 값을 복사해 둔다. 그 사이 자료가 바뀌어도 내보내는 내용은 같다.
  const lines = rows.map((p) => ({
    code: safeCell(p.code),
    name: safeCell(p.name),
    gender: p.gender,
    age: p.age,
    district: store.districts.find((d) => d.id === p.districtId)?.name ?? '',
    stage: safeCell(store.stages.find((s) => s.id === p.stageId)?.name ?? ''),
    status: p.status === 'dropped' ? '탈락' : '진행',
    c1: p.classification1,
    c2: p.classification2,
    date: p.registeredDate,
    worker: safeCell(p.worker),
    notes: safeCell(p.notes),
  }));
  const { default: ExcelJS } = await import('exceljs');
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('대상자');
  ws.columns = [
    { header: '식별번호', key: 'code', width: 14 },
    { header: '이름', key: 'name', width: 20 },
    { header: '성별', key: 'gender', width: 8 },
    { header: '나이', key: 'age', width: 8 },
    { header: '구역', key: 'district', width: 10 },
    { header: '단계', key: 'stage', width: 12 },
    { header: '분류1', key: 'c1', width: 10 },
    { header: '분류2', key: 'c2', width: 10 },
    { header: '등록일', key: 'date', width: 12 },
    { header: '담당자', key: 'worker', width: 18 },
    { header: '비고', key: 'notes', width: 40 },
    { header: '상태', key: 'status', width: 8 },
  ];
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  for (const line of lines) ws.addRow(line);
  return Buffer.from(await wb.xlsx.writeBuffer());
}
