import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { HttpError } from './security.js';
import { scopeFor } from './permissions.js';

/**
 * 업무 자료의 단일 원본(store.workspace)과 그 범위 제한 복사본을 다루는 통합 계층.
 * 원본은 기존 SMOA 4.0.41 작업 영역(server/legacy)과 같은 형식이며, 기능 모듈은
 * scopedWorkspace()로 복사본을 받아 고친 뒤 commitWorkspace()로만 되돌린다.
 */
const require = createRequire(import.meta.url);
const M = require('./legacy/model.cjs');
const O = require('./legacy/organization.cjs');

export const OPTIONS = {
  genders: ['미입력', '남', '여', '기타'],
  classification1: ['개척', '지인', '가족'],
  classification2: ['노방', '소셜링', '온라인', '세미나', '기타'],
};

// ---- 단계 ID: 웹 단계(s1…)와 기존 단계 ID의 고정 대응. 표시 이름은 workspace.stageNames가 정한다.
export const FIXED_STAGES = [...M.STAGES];

export function legacyStageId(webId) {
  const m = /^s(\d{1,3})$/.exec(String(webId));
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 1 && n <= FIXED_STAGES.length ? FIXED_STAGES[n - 1] : `s${n}`;
}

export function webStageId(legacyId) {
  const i = FIXED_STAGES.indexOf(legacyId);
  return i >= 0 ? `s${i + 1}` : legacyId;
}

export function stageList(ws) {
  return ws.stages.map((id) => ({ id: webStageId(id), name: ws.stageNames[id] ?? id, active: !ws.inactiveStages.includes(id) }));
}

// ---- 날짜
export const seoulDateOf = (ms) => new Date(ms + 9 * 3_600_000).toISOString().slice(0, 10);
/** 한국 시각 'YYYY-MM-DDTHH:MM' (기존 단계 이력의 적용 시각 형식) */
export const seoulLocal = (ms) => new Date(ms + 9 * 3_600_000).toISOString().slice(0, 16);

// ---- 오류 변환
/** 기존 알고리즘이 던지는 검증 오류(Error)는 400으로, 그 밖의 오류는 그대로 던진다. 항상 던진다. */
export function domainError(error) {
  if (error instanceof HttpError) throw error;
  if (error && error.constructor === Error && typeof error.message === 'string') throw new HttpError(400, error.message.slice(0, 300));
  throw error;
}

const forbidden = (msg = '배정된 구역 밖의 자료는 보거나 바꿀 수 없습니다.') => new HttpError(403, msg);
const badRequest = (msg) => new HttpError(400, msg);

// ---- 연락처 보호: 키 이름으로 판단해 끝 네 자리만 남기거나(조회) 완전히 제거한다(저장·이력).
const PHONE_KEY = /phone|연락처|휴대폰|핸드폰|전화/i;
const last4 = (v) => (typeof v === 'string' || typeof v === 'number' ? String(v).replace(/\D/g, '').slice(-4) : '');

// 자유 문장 속 한국 전화번호 모양(010-1234-5678 등)은 끝 네 자리만 남긴다. 식별자·해시 값은 건드리지 않는다.
const PHONE_TEXT = /(?<![\w-])0\d{1,2}[-.\s]?\d{3,4}[-.\s]?(\d{4})(?![\w])/g;
const NO_TEXT_MASK = new Set(['id', 'hash', 'previous', 'code', 'sessionKey', 'personId', 'memberId', 'target']);
export const sanitizePhoneText = (s) => (typeof s === 'string' ? s.replace(PHONE_TEXT, '***-****-$1') : s);

function deepCopy(value, mode, key = '') {
  if (typeof value === 'string') return mode === 'last4' && !NO_TEXT_MASK.has(key) ? sanitizePhoneText(value) : value;
  if (Array.isArray(value)) return value.map((x) => deepCopy(x, mode, key));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === '__proto__') continue;
      if (PHONE_KEY.test(k)) {
        if (mode === 'last4') out[k] = last4(v);
        continue;
      }
      out[k] = deepCopy(v, mode, k);
    }
    return out;
  }
  return value;
}
const maskedCopy = (v) => deepCopy(v, 'last4'); // 연락처는 끝 네 자리만
const strippedCopy = (v) => deepCopy(v, 'drop'); // 연락처 키 제거

/**
 * 가려진 값(연락처 키·문장 속 번호)이 원본의 같은 위치에 있었다면 원본 값을 되돌린다.
 * 보이는 쪽에서 새로 쓴 연락처는 받지 않는다(strippedCopy가 이미 제거했다).
 */
function restoreProtected(out, before) {
  if (typeof out === 'string') return typeof before === 'string' && out !== before && sanitizePhoneText(before) === out ? before : out;
  if (Array.isArray(out)) {
    if (!Array.isArray(before)) return out;
    const byId = new Map(before.filter((x) => x && typeof x === 'object' && x.id !== undefined).map((x) => [x.id, x]));
    return out.map((item, i) => restoreProtected(item, item && typeof item === 'object' && item.id !== undefined ? byId.get(item.id) : before[i]));
  }
  if (out && typeof out === 'object') {
    if (!before || typeof before !== 'object' || Array.isArray(before)) return out;
    const next = { ...out };
    for (const k of Object.keys(before)) if (PHONE_KEY.test(k)) next[k] = before[k];
    for (const k of Object.keys(next)) if (!PHONE_KEY.test(k)) next[k] = restoreProtected(next[k], before[k]);
    return next;
  }
  return out;
}

// 연락처 키 검사는 업무 자료에만 적용한다. 설정(가져오기 열 배치 등)에는 'phone' 같은 이름의 설정 키가 있을 수 있다.
const BUSINESS_KEYS = new Set(['people', 'goals', 'activityLogs', 'findingReports', 'dailyReports', 'regionalActivities', 'callingRecords', 'socialing', 'organization', 'history']);
function finishCopy(ws) {
  const out = {};
  for (const [k, v] of Object.entries(ws)) out[k] = BUSINESS_KEYS.has(k) ? maskedCopy(v) : structuredClone(v);
  return out;
}

// ---- 조직 도우미
export const regionLabel = (node) => node.reportRegion || (/구역/.test(node.type) ? node.name : '');

/** 역할 + 접근 구역 ID의 서명. 초안을 만든 뒤 권한이 바뀌었는지(넓어진 경우 포함) 가려내는 데 쓴다. */
const scopeSignature = (store, user) => `${user.role}:${[...scopeFor(store, user)].sort().join(',')}`;

function visibilityOf(store, ws, user) {
  if (user.role === 'admin') return { admin: true, role: 'admin', signature: scopeSignature(store, user) };
  const scope = scopeFor(store, user);
  const regions = new Set(store.districts.filter((d) => scope.has(d.id)).map((d) => d.name));
  const org = ws.organization ?? { nodes: [], members: [] };
  const byId = new Map(org.nodes.map((n) => [n.id, n]));
  // 가장 가까운 구역 표시가 그 조직의 구역이다. 더 먼 상위 구역은 하위의 다른 구역을 보이게 하지 않는다.
  const inside = (node) => {
    for (let cur = node, depth = 0; cur && depth < 14; cur = byId.get(cur.parentId), depth++) {
      const label = regionLabel(cur);
      if (label) return regions.has(label);
    }
    return false;
  };
  const nodeIds = new Set(org.nodes.filter(inside).map((n) => n.id));
  // 구조 표시용 상위 조직: 보이는 조직의 상위 사슬만(책임자는 가린다).
  const shownNodeIds = new Set(nodeIds);
  for (const id of nodeIds) for (let cur = byId.get(byId.get(id)?.parentId), depth = 0; cur && depth < 14; cur = byId.get(cur.parentId), depth++) shownNodeIds.add(cur.id);
  const members = org.members.filter((m) => nodeIds.has(m.unitId));
  return {
    admin: false,
    regions,
    nodeIds,
    shownNodeIds,
    role: user.role,
    signature: scopeSignature(store, user),
    memberIds: new Set(members.map((m) => m.id)),
    memberCodes: new Set(members.map((m) => m.code)),
    personIds: new Set(ws.people.filter((p) => regions.has(p.region)).map((p) => p.id)),
  };
}

/** 컬렉션별 "이 구역 사용자에게 보이는 행" 규칙. 구역 표시가 없거나 배정 밖이면 보이지 않는다. */
const RULES = {
  people: (v, p) => v.regions.has(p.region),
  activityLogs: (v, a) => v.regions.has(a.region) || (!a.region && v.memberCodes.has(a.workerId)),
  findingReports: (v, r) => v.regions.has(r.region),
  dailyReports: (v, d) => v.regions.has(d.region),
  // 구역 없는 반별 목표는 조직 단위가 명시되어 보이는 조직일 때만 귀속이 분명하다(반 이름만으로는 전체 대상).
  goals: (v, g) => (g.region ? v.regions.has(g.region) : Boolean(g.orgUnitId || g.unitId) && v.nodeIds.has(g.orgUnitId || g.unitId)),
  regionalActivities: (v, r) => v.regions.has(r.region) || (!r.region && v.memberIds.has(r.memberId)),
  // 기록에 적힌 구역이 있으면 그 구역이 우선하고, 구역이 없을 때만 연결된 대상자의 구역을 쓴다.
  callingRecords: (v, c) => (c.area ? v.regions.has(c.area) : Boolean(c.personId) && v.personIds.has(c.personId)),
  pending: (v, e) => v.regions.has(e.region),
};

/** 대상자 안의 활동·단계 이동·탈락 이력은 기록된 구역(없으면 대상자의 현재 구역)으로 판단한다. */
const nestedVisible = (v, item, fallbackRegion) => v.regions.has((item && item.region) || fallbackRegion);
const NESTED = ['activities', 'transitions', 'lifecycle'];

/** 대상자의 범위 제한 보기: 인도자 가림 + 보이지 않는 구역의 중첩 기록 제거. */
function scopePerson(p, v) {
  const out = { ...hideIntroducer(p, v) };
  for (const key of NESTED) if (Array.isArray(p[key])) out[key] = p[key].filter((item) => nestedVisible(v, item, p.region));
  return out;
}

// 감사 이력에 다른 구역이 명시된 값(before/after 어디든)이 있으면 대상이 지금 보이더라도 내주지 않는다.
const REGION_KEYS = new Set(['region', 'area', 'areaName', 'regionName', 'reportRegion']);
function hasHiddenRegion(value, v, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 12) return false;
  if (Array.isArray(value)) return value.some((x) => hasHiddenRegion(x, v, depth + 1));
  return Object.entries(value).some(([k, x]) => (REGION_KEYS.has(k) && typeof x === 'string' && x !== '' && !v.regions.has(x)) || hasHiddenRegion(x, v, depth + 1));
}

// 감사 이력의 조직 참조(구성원 소속, 발령 전·후 조직, 조직의 상위). 배정 조직이 아니면 대상이 지금 보여도 내주지 않는다.
const UNIT_KEYS = new Set(['unitId', 'orgUnitId', 'fromUnitId', 'toUnitId']);
const isOrgNode = (x) => 'leaderId' in x || 'reportRegion' in x || 'leaderTitle' in x;
function hasHiddenUnit(value, v, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 12) return false;
  if (Array.isArray(value)) return value.some((x) => hasHiddenUnit(x, v, depth + 1));
  const nodeShape = isOrgNode(value);
  return Object.entries(value).some(([k, x]) => {
    if (typeof x === 'string' && x !== '') {
      if (UNIT_KEYS.has(k)) return !v.nodeIds.has(x); // 알 수 없는 옛 조직도 배정 밖으로 본다.
      if (k === 'parentId' && nodeShape) return !v.shownNodeIds.has(x); // 상위 조직은 구조 표시 범위까지만 허용한다.
      return false;
    }
    return hasHiddenUnit(x, v, depth + 1);
  });
}

/**
 * 보이는 이력만 골라 사슬을 다시 잇는다. 연락처를 가린 뒤의 값으로 해시를 새로 계산하므로
 * 4.0.41 검증(M.validateWorkspace)을 그대로 통과한다. 항목 ID는 원본 그대로 둔다.
 */
function rechain(entries) {
  let previous = 'GENESIS';
  return entries.map((e) => {
    const body = { ...e };
    delete body.hash;
    body.previous = previous;
    body.hash = M.hash(body);
    previous = body.hash;
    return body;
  });
}
const LIMITS = { people: 30000, activityLogs: 100000, findingReports: 100000, dailyReports: 100000, goals: 10000, regionalActivities: 100000, callingRecords: 100000, pending: 30000 };
const PROTECTED = ['id', 'name', 'gospelStageVersion', 'stages', 'stageNames', 'inactiveStages', 'fields', 'commonCodes'];
const ADMIN_SETTINGS = ['dailyAreaActivityOrder', 'dailyAreaSlashLayouts', 'dailyActivityRosterRules'];

const json = (v) => JSON.stringify(v);

function scopedOrganization(ws, v) {
  const org = ws.organization ?? { nodes: [], members: [] };
  const members = org.members.filter((m) => v.nodeIds.has(m.unitId));
  const memberIds = new Set(members.map((m) => m.id));
  return {
    nodes: org.nodes
      .filter((n) => v.shownNodeIds.has(n.id))
      // 상위 조직의 책임자와 보이지 않는 하위 조직 구성원이 책임자인 경우는 알려 주지 않는다.
      .map((n) => (v.nodeIds.has(n.id) && memberIds.has(n.leaderId) ? n : { ...n, leaderId: '' })),
    members,
  };
}

/** 보이지 않는 인도자(다른 구역 구성원)는 빈 값으로 가린다. */
function hideIntroducer(row, v) {
  if (row.introducerId && !v.memberIds.has(row.introducerId)) return { ...row, introducerId: '', introducerSnapshot: null };
  return row;
}

/**
 * 4.0.41 호환 작업 영역의 분리된 복사본. 관리자는 전체, 그 밖의 사용자는 배정 구역의 자료만 담는다.
 * 연락처 값은 끝 네 자리만 남긴다. revision은 원본과 같아 commitWorkspace()가 최신 여부를 확인한다.
 */
export function scopedWorkspace(store, user) {
  const ws = store.workspace;
  const v = visibilityOf(store, ws, user);
  if (v.admin) {
    // 관리자도 복사본이다. 연락처를 가린 값으로 이력 사슬을 다시 계산해 단독 검증이 통과하게 한다.
    const copy = finishCopy(ws);
    copy.history = rechain(copy.history);
    copy.revision = copy.history.length;
    return withServerScope(copy, ws, v, false);
  }

  const people = ws.people.filter((p) => RULES.people(v, p)).map((p) => scopePerson(p, v));
  const targets = new Set([...v.personIds, ...v.memberIds, ...v.nodeIds]);
  const rows = {
    goals: ws.goals.filter((g) => RULES.goals(v, g)),
    activityLogs: (ws.activityLogs ?? []).filter((a) => RULES.activityLogs(v, a)),
    findingReports: (ws.findingReports ?? []).filter((r) => RULES.findingReports(v, r)),
    dailyReports: (ws.dailyReports ?? []).filter((d) => RULES.dailyReports(v, d)),
    regionalActivities: (ws.regionalActivities ?? []).filter((r) => RULES.regionalActivities(v, r)),
    callingRecords: (ws.callingRecords ?? []).filter((c) => RULES.callingRecords(v, c)),
  };
  const social = ws.socialing ?? { programs: [], pending: [] };
  const pending = social.pending.filter((e) => RULES.pending(v, e)).map((e) => hideIntroducer(e, v));
  for (const list of [people, rows.goals, rows.activityLogs, rows.findingReports, rows.dailyReports, rows.regionalActivities, rows.callingRecords, pending]) for (const r of list) if (r.id) targets.add(r.id);
  for (const p of people) for (const a of p.activities ?? []) targets.add(a.id);
  const history = ws.history.filter((h) => targets.has(h.target)
    && !hasHiddenRegion(h.before, v) && !hasHiddenRegion(h.after, v)
    && !hasHiddenUnit(h.before, v) && !hasHiddenUnit(h.after, v));

  const scoped = finishCopy({
    ...ws,
    ...rows,
    people,
    socialing: { ...social, pending },
    organization: scopedOrganization(ws, v),
    history,
  });
  for (const key of ADMIN_SETTINGS) delete scoped[key]; // 전체 활동자·열 배치 설정은 구역 사용자에게 주지 않는다.
  scoped.history = rechain(scoped.history);
  scoped.revision = scoped.history.length; // 4.0.41 호환: 범위 안 이력 길이. 원본 버전은 serverScope에 둔다.
  return withServerScope(scoped, ws, v, true);
}

/**
 * 서버 전용 초안 정보. structuredClone/M.copy를 거쳐도 남도록 일반 속성으로 두며,
 * 원본(store.workspace)에는 절대 쓰지 않고 응답으로 내보내지 않는다.
 */
function withServerScope(copy, canon, v, scoped) {
  copy.serverScope = { scoped, baseRevision: canon.revision, signature: v.signature };
  return copy;
}

// ---- 되돌리기(커밋)
function checkShape(draft) {
  if (!draft || typeof draft !== 'object' || Array.isArray(draft)) throw badRequest('작업 영역 형식을 확인해 주세요.');
  for (const key of ['people', 'goals', 'activityLogs', 'findingReports', 'dailyReports', 'history']) {
    if (!Array.isArray(draft[key])) throw badRequest(`${key} 형식을 확인해 주세요.`);
  }
  for (const key of ['regionalActivities', 'callingRecords']) {
    if (draft[key] !== undefined && !Array.isArray(draft[key])) throw badRequest(`${key} 형식을 확인해 주세요.`);
  }
  const s = draft.socialing;
  if (!s || typeof s !== 'object' || !Array.isArray(s.programs) || !Array.isArray(s.pending)) throw badRequest('소셜링 자료 형식을 확인해 주세요.');
  const org = draft.organization;
  if (!org || !Array.isArray(org.nodes) || !Array.isArray(org.members)) throw badRequest('조직 자료 형식을 확인해 주세요.');
  if (!Number.isInteger(draft.revision)) throw badRequest('자료 버전을 확인해 주세요.');
  const over = (list, max) => list.length > max;
  if (over(draft.people, LIMITS.people) || over(draft.goals, LIMITS.goals) || over(draft.activityLogs, LIMITS.activityLogs) || over(draft.findingReports, LIMITS.findingReports) ||
    over(draft.dailyReports, LIMITS.dailyReports) || over(draft.regionalActivities ?? [], LIMITS.regionalActivities) || over(draft.callingRecords ?? [], LIMITS.callingRecords) ||
    over(s.pending, LIMITS.pending) || over(org.nodes, 1000) || over(org.members, 30000) || over(draft.history, 100001)) {
    throw badRequest('자료 수가 한도를 넘었습니다.');
  }
}

/**
 * 행 목록 병합. 원본의 "보이는 행"만 초안으로 바꾸고, 보이지 않는 행은 그대로 둔다.
 * 비관리자가 보이지 않는 행의 ID를 쓰거나 규칙 밖의 행을 만들면 거부한다.
 */
// 행 식별 전략. 기본은 필수 id. 지역활동 기록은 id가 없고 (날짜 또는 월, 구성원 ID)가 자연 식별자다(4.0.41 recordKey).
const ID_KEY = { draft: (d) => { M.id(d.id); return d.id; }, canon: (r) => r.id };
const REGIONAL_KEY = {
  draft(d) {
    const memberId = M.id(d.memberId);
    const okMonth = (s) => typeof s === 'string' && /^(?!0000)\d{4}-(0[1-9]|1[0-2])$/.test(s);
    if (!okMonth(d.month)) throw badRequest('기준월을 YYYY-MM 형식으로 입력해 주세요.');
    let period = d.month;
    if (d.date !== undefined) {
      const t = typeof d.date === 'string' && /^(?!0000)\d{4}-\d{2}-\d{2}$/.test(d.date) ? Date.parse(`${d.date}T00:00:00Z`) : NaN;
      if (!Number.isFinite(t) || new Date(t).toISOString().slice(0, 10) !== d.date) throw badRequest('기록일을 YYYY-MM-DD 형식의 유효한 날짜로 입력해 주세요.');
      if (d.date.slice(0, 7) !== d.month) throw badRequest('기록일이 기준월에 속해야 합니다.');
      period = d.date;
    }
    return `${period}/${memberId}`;
  },
  canon: (r) => `${r.date || r.month}/${r.memberId}`,
};

function mergeRows(name, canonRows, draftRows, v, visible, prep, view = (row) => row, keys = ID_KEY) {
  const canonById = new Map(canonRows.map((r) => [keys.canon(r), r]));
  const draftById = new Map();
  for (const d of draftRows) {
    if (!d || typeof d !== 'object' || Array.isArray(d)) throw badRequest(`${name} 행 형식을 확인해 주세요.`);
    const key = keys.draft(d);
    if (draftById.has(key)) throw badRequest(`${name}: 같은 식별자가 중복되었습니다.`);
    const before = canonById.get(key);
    if (!v.admin) {
      if (before && !visible(v, before)) throw forbidden();
      if (!visible(v, d)) throw forbidden();
    }
    // 가려서 보낸 값 그대로인 행은 원본을 바이트 그대로 둔다(가려진 연락처·문장·숨은 하위 기록 보존).
    if (before && json(maskedCopy(view(before))) === json(d)) {
      draftById.set(key, before);
      continue;
    }
    let row = strippedCopy(d);
    if (prep) row = prep(row, before, d);
    draftById.set(key, before ? restoreProtected(row, before) : row);
  }
  const out = [];
  for (const row of canonRows) {
    const key = keys.canon(row);
    if (!v.admin && !visible(v, row)) out.push(row);
    else if (draftById.has(key)) {
      out.push(draftById.get(key));
      draftById.delete(key);
    }
  }
  for (const row of draftById.values()) out.push(row);
  return out;
}

/** 초안의 인도자가 보이는 구성원이거나 빈 값(가려진 값)이어야 한다. 가려진 기존 값은 원본 것을 되돌린다. */
function introducerPrep(v) {
  return (row, before) => {
    if (v.admin) return row;
    const id = row.introducerId ?? '';
    if (id && !v.memberIds.has(id)) throw forbidden('배정 구역 밖 구성원은 인도자로 지정할 수 없습니다.');
    if (!id && before?.introducerId && !v.memberIds.has(before.introducerId)) return { ...row, introducerId: before.introducerId, introducerSnapshot: before.introducerSnapshot ?? null };
    return row;
  };
}

/**
 * 대상자 안의 활동·단계 이동·탈락 이력 병합. 원본의 보이지 않는 구역 기록은 ID 기준으로 원본 그대로 남기고,
 * 초안의 기록은 보이는 구역일 때만 받는다. 새 기록의 구역이 비어 있으면 대상자의 구역을 따른다.
 */
function mergeNested(key, canonList, rawList, v, canonRegion, draftRegion) {
  const canonById = new Map(canonList.map((x) => [x.id, x]));
  const draftById = new Map();
  for (const item of rawList) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw badRequest('대상자 하위 기록 형식을 확인해 주세요.');
    M.id(item.id);
    if (draftById.has(item.id)) throw badRequest('대상자 하위 기록의 식별자가 중복되었습니다.');
    const before = canonById.get(item.id);
    if (!v.admin) {
      if (before && !nestedVisible(v, before, canonRegion)) throw forbidden();
      if (!nestedVisible(v, item, draftRegion)) throw forbidden('다른 구역의 활동·이력은 기록할 수 없습니다.');
    }
    if (before && json(maskedCopy(before)) === json(item)) draftById.set(item.id, before);
    else draftById.set(item.id, before ? restoreProtected(strippedCopy(item), before) : strippedCopy(item));
  }
  const out = [];
  for (const row of canonList) {
    if (!v.admin && !nestedVisible(v, row, canonRegion)) out.push(row); // 숨은 기록은 그대로
    else if (draftById.has(row.id)) {
      out.push(draftById.get(row.id));
      draftById.delete(row.id);
    }
  }
  for (const row of draftById.values()) out.push(row);
  return out;
}

function checkEntries(draft, canon) {
  const known = new Set(canon.history.map((h) => h.id));
  const fresh = draft.history.filter((h) => !known.has(h?.id));
  const size = (x) => json(x ?? null).length;
  for (const e of fresh) {
    if (!e || typeof e !== 'object' || typeof e.action !== 'string' || !e.action || e.action.length > 100 || typeof e.target !== 'string' || e.target.length > 200) throw badRequest('변경 이력 형식을 확인해 주세요.');
    if (size(e.before) > 400_000 || size(e.after) > 400_000) throw badRequest('변경 이력이 너무 큽니다.');
  }
  return fresh;
}

/**
 * 초안을 검증해 원본에 합친다(동기). 사용자 범위 밖의 행·기록·참조, 공통 설정·단계 변경은 거부하고
 * 초안이 만들어진 뒤 원본이 바뀌었다면 409로 거절한다. 반환: { changed, revision }.
 */
export function commitWorkspace(store, user, draft) {
  try {
    return commit(store, user, draft);
  } catch (error) {
    throw domainError(error);
  }
}

function commit(store, user, draft) {
  checkShape(draft);
  const canon = store.workspace;
  const v = visibilityOf(store, canon, user);
  const actor = String(user.displayName ?? '').trim().slice(0, 100) || '사용자';

  for (const key of PROTECTED) {
    if (json(draft[key]) !== json(canon[key])) throw forbidden('단계·공통코드·작업 영역 설정은 관리자 설정 화면에서만 바꿀 수 있습니다.');
  }
  // 서버 전용 초안 정보: 초안을 만든 뒤 원본이 바뀌었거나 권한(역할·구역)이 달라졌다면, 넓어진 경우에도 거절한다.
  // (보이는 범위가 달라지면 초안에 없는 행이 삭제로 오인되기 때문이다.)
  const meta = draft.serverScope;
  if (!v.admin && !(meta && typeof meta === 'object' && meta.scoped === true)) throw new HttpError(409, '자료를 새로 불러온 뒤 다시 시도해 주세요.');
  if (meta !== undefined) {
    if (!meta || typeof meta !== 'object' || !Number.isInteger(meta.baseRevision) || typeof meta.signature !== 'string') throw badRequest('초안 정보를 확인해 주세요.');
    if (meta.signature !== v.signature) throw new HttpError(409, '접근 권한이 바뀌어 초안을 사용할 수 없습니다. 화면을 새로 고쳐 주세요.');
  }
  if (!v.admin) {
    for (const key of ADMIN_SETTINGS) if (draft[key] !== undefined) throw forbidden('가져오기 설정은 관리자만 바꿀 수 있습니다.');
    if (json(draft.socialing.programs) !== json(maskedCopy(canon.socialing.programs))) throw forbidden('소셜링 모임 목록은 관리자만 바꿀 수 있습니다.');
    if (json(draft.organization) !== json(maskedCopy(scopedOrganization(canon, v)))) throw forbidden('조직과 구성원은 관리자 조직 화면에서만 바꿀 수 있습니다.');
  }

  const fresh = checkEntries(draft, canon);
  // 초안의 revision은 범위 안 이력 길이이므로, 원본 버전은 서버 전용 정보의 baseRevision으로 비교한다.
  const baseRevision = meta ? meta.baseRevision : draft.revision - fresh.length;
  if (baseRevision !== canon.revision) throw new HttpError(409, '다른 곳에서 자료가 바뀌었습니다. 화면을 새로 고친 뒤 다시 시도해 주세요.');

  // 대상자: 초안에서 새로 생기거나 바뀌는 사람의 ID도 연결 규칙에 쓴다.
  const intro = introducerPrep(v);
  const people = mergeRows('대상자', canon.people, draft.people, v, RULES.people, (row, before, raw) => {
    const out = intro(row, before);
    for (const key of NESTED) {
      if (raw[key] === undefined) continue;
      if (!Array.isArray(raw[key])) throw badRequest(`대상자 ${key} 형식을 확인해 주세요.`);
      out[key] = mergeNested(key, before?.[key] ?? [], raw[key], v, before ? before.region : raw.region, raw.region);
    }
    if (before && before.phone !== undefined) out.phone = before.phone; // 연락처는 이 경로에서 바꿀 수 없다.
    return out;
  }, (b) => (v.admin ? b : scopePerson(b, v)));
  // 현재 보이는 대상자 ID(원본 기준)만 새 연결 대상으로 쓴다. 이전에 보이던 ID는 구역이 바뀌었으면 제외한다.
  const visiblePersonIds = new Set(v.admin ? [] : people.filter((p) => RULES.people(v, p)).map((p) => p.id));
  for (const id of visiblePersonIds) v.personIds.add(id);

  const calling = mergeRows('콜링', canon.callingRecords ?? [], draft.callingRecords ?? [], v, RULES.callingRecords, (row, before) => {
    if (!v.admin && row.personId && !visiblePersonIds.has(row.personId) && before?.personId !== row.personId) throw forbidden('배정 구역 밖 대상자와 연결할 수 없습니다.');
    return row;
  });
  const merged = structuredClone(canon);
  merged.people = people;
  merged.callingRecords = calling;
  merged.activityLogs = mergeRows('활동', canon.activityLogs ?? [], draft.activityLogs, v, RULES.activityLogs);
  merged.regionalActivities = mergeRows('월별 활동구분', canon.regionalActivities ?? [], draft.regionalActivities ?? [], v, RULES.regionalActivities, undefined, undefined, REGIONAL_KEY);
  merged.dailyReports = mergeRows('일계', canon.dailyReports ?? [], draft.dailyReports, v, RULES.dailyReports);
  merged.findingReports = mergeRows('찾기 일보', canon.findingReports ?? [], draft.findingReports, v, RULES.findingReports);
  merged.goals = mergeRows('목표', canon.goals ?? [], draft.goals, v, RULES.goals);
  merged.socialing = {
    ...structuredClone(canon.socialing),
    pending: mergeRows('소셜링 유입', canon.socialing.pending, draft.socialing.pending, v, RULES.pending, intro, (e) => (v.admin ? e : hideIntroducer(e, v))),
  };
  if (v.admin) {
    merged.socialing.programs = restoreProtected(strippedCopy(draft.socialing.programs), canon.socialing.programs);
    merged.organization = restoreProtected(strippedCopy(draft.organization), canon.organization);
    for (const key of ADMIN_SETTINGS) {
      if (draft[key] === undefined) delete merged[key];
      else merged[key] = structuredClone(draft[key]);
    }
    // 구역 연동 조직(d1…)이 사라지거나 이름이 달라지면 구역 범위가 깨지므로 거부한다.
    for (const d of store.districts) {
      const node = merged.organization.nodes.find((n) => n.id === d.id);
      if (!node || regionLabel(node) !== d.name || !node.active) throw badRequest(`${d.name} 연동 조직은 삭제·이름 변경·보관할 수 없습니다.`);
    }
  }

  const keys = ['people', 'callingRecords', 'activityLogs', 'regionalActivities', 'dailyReports', 'findingReports', 'goals', 'socialing', 'organization', ...ADMIN_SETTINGS];
  const changedKeys = keys.filter((k) => json(merged[k]) !== json(canon[k]));
  if (!changedKeys.length && !fresh.length) return { changed: false, revision: canon.revision };

  // 이력은 원본 사슬 뒤에 다시 이어 붙인다(작성자는 로그인 사용자로 고정).
  for (const e of fresh) M.audit(merged, actor, e.action, e.target, e.before === undefined ? null : strippedCopy(e.before), e.after === undefined ? null : strippedCopy(e.after));
  if (!fresh.length) M.audit(merged, actor, '업무 자료 변경', 'workspace', null, { changed: changedKeys });

  M.validateWorkspace(merged);
  store.workspace = merged;
  return { changed: true, revision: merged.revision };
}

// ---- 관리자 설정 경로(단계 등): 원본을 복사해 고치고 검증한 뒤 교체
export function applyCanonical(store, mutator) {
  const next = structuredClone(store.workspace);
  const out = mutator(next);
  try {
    M.validateWorkspace(next);
  } catch (error) {
    throw domainError(error);
  }
  store.workspace = next;
  return out;
}

const stageNameTaken = (ws, name, exceptId) => ws.stages.some((id) => id !== exceptId && String(ws.stageNames[id]).toLowerCase() === name.toLowerCase());

export function addStage(store, actor, name) {
  return applyCanonical(store, (ws) => {
    if (ws.stages.length >= M.MAX_STAGES) throw badRequest(`단계는 최대 ${M.MAX_STAGES}개까지 만들 수 있습니다.`);
    if (stageNameTaken(ws, name)) throw new HttpError(409, '이미 있는 단계 이름입니다.');
    let id;
    do id = `s${store.counters.stage++}`;
    while (ws.stages.includes(id) || FIXED_STAGES.includes(id));
    ws.stages.push(id);
    ws.stageNames[id] = name;
    M.audit(ws, actor, '단계 추가', id, null, { id, name });
    return { id: webStageId(id), name, active: true };
  });
}

export function updateStage(store, actor, webId, { name, active }) {
  const id = legacyStageId(webId);
  if (!id || !store.workspace.stages.includes(id)) throw new HttpError(404, '단계를 찾을 수 없습니다.');
  return applyCanonical(store, (ws) => {
    const before = { name: ws.stageNames[id], active: !ws.inactiveStages.includes(id) };
    const nextName = name ?? before.name;
    const nextActive = active ?? before.active;
    if (stageNameTaken(ws, nextName, id)) throw new HttpError(409, '이미 있는 단계 이름입니다.');
    if (!nextActive && !ws.stages.some((s) => s !== id && !ws.inactiveStages.includes(s))) throw badRequest('사용 중인 단계가 하나 이상 있어야 합니다.');
    ws.stageNames[id] = nextName;
    ws.inactiveStages = ws.inactiveStages.filter((s) => s !== id);
    if (!nextActive) ws.inactiveStages.push(id);
    if (before.name !== nextName || before.active !== nextActive) M.audit(ws, actor, '단계 설정 변경', id, before, { name: nextName, active: nextActive });
    return { id: webId, name: nextName, active: nextActive };
  });
}

// ---- 대상자 투영
export function projectPerson(store, p) {
  return {
    id: p.id,
    code: p.code,
    name: sanitizePhoneText(p.name),
    gender: p.gender,
    age: p.age === '' ? null : p.age,
    districtId: store.districts.find((d) => d.name === p.region)?.id ?? '',
    stageId: webStageId(p.stage),
    classification1: p.classification1,
    classification2: p.classification2,
    registeredDate: p.date || '',
    worker: sanitizePhoneText(p.worker),
    notes: sanitizePhoneText(p.notes),
    updatedAt: p.updatedAt,
  };
}

// ---- 미리보기(가져오기 등 나중에 적용하는 작업): 사용자·범위·만료·버전에 묶는다.
const MAX_PREVIEWS_PER_USER = 20;

export function putPreview(store, user, kind, data, ttlMs = 15 * 60_000) {
  const previews = (store.previews ??= new Map());
  const now = store.now();
  for (const [id, p] of previews) if (p.expires <= now) previews.delete(id);
  const mine = [...previews.values()].filter((p) => p.userId === user.id);
  while (mine.length >= MAX_PREVIEWS_PER_USER) previews.delete(mine.shift().id);
  const id = randomUUID();
  previews.set(id, { id, userId: user.id, kind, data, revision: store.workspace.revision, scope: [...scopeFor(store, user)].sort().join('|'), expires: now + ttlMs });
  return id;
}

export function takePreview(store, user, id, kind, { consume = true } = {}) {
  const p = store.previews?.get(id);
  if (!p || p.userId !== user.id || p.kind !== kind) throw new HttpError(404, '미리보기를 찾을 수 없습니다. 다시 만들어 주세요.');
  if (p.expires <= store.now()) {
    store.previews.delete(id);
    throw new HttpError(410, '미리보기가 만료되었습니다. 다시 만들어 주세요.');
  }
  if (p.scope !== [...scopeFor(store, user)].sort().join('|')) throw forbidden('접근 구역이 바뀌어 미리보기를 사용할 수 없습니다.');
  if (p.revision !== store.workspace.revision) throw new HttpError(409, '미리보기 이후 자료가 바뀌었습니다. 다시 만들어 주세요.');
  if (consume) store.previews.delete(id);
  return p.data;
}

// ---- 가상 데모 작업 영역
export function seedWorkspace(store) {
  const now = store.now();
  const today = seoulDateOf(now);
  const ws = M.newWorkspace('SMOA 연습 자료실 · 가상 자료');
  const ACTOR = '시스템(가상 자료)';
  const stamp = new Date(now).toISOString();

  const node = (id, code, name, type, parentId, leaderId, leaderTitle) => ({
    id, code, name, type, parentId, leaderId, leaderTitle, reportRegion: type === '구역' ? name : '', active: true, createdAt: stamp, updatedAt: stamp,
  });
  const member = (id, code, name, unitId, position, className, employment) => ({
    id, code, name, unitId, position, className, employment, status: 'active', notes: '', createdAt: stamp, updatedAt: stamp,
  });
  const nodes = [node('org-root', 'O-ROOT', '가상 지역', '지역', '', 'm-root', '지역장')];
  const members = [member('m-root', 'M-ROOT', '가상 지역장', 'org-root', '지역장', '', '직장인')];
  store.districts.forEach((d, k) => {
    nodes.push(node(d.id, `O-${d.id.toUpperCase()}`, d.name, '구역', 'org-root', `m-${d.id}-1`, '구역장'));
    for (let j = 1; j <= 4; j++) {
      members.push(member(`m-${d.id}-${j}`, `M-${d.id.toUpperCase()}-0${j}`, j === 1 ? `가상 구역장 ${k + 1}` : `가상 구성원 ${k + 1}-${j}`, d.id, j === 1 ? '구역장' : '구역원', String(((j - 1) % 3) + 1), ['직장인', '학생', '기타', '미입력'][j - 1]));
    }
  });
  ws.organization = { nodes, members };
  O.validate(ws.organization, ws);
  M.audit(ws, ACTOR, '조직 구성 생성', 'org-root', null, { nodes: nodes.length, members: members.length });

  for (let i = 0; i < 24; i++) {
    const d = store.districts[i % 3];
    const m = members.find((x) => x.id === `m-${d.id}-${(Math.floor(i / 3) % 4) + 1}`);
    const date = seoulDateOf(now - i * 4 * 86_400_000);
    const target = FIXED_STAGES[i % FIXED_STAGES.length];
    const p = M.validatePerson({
      code: `DEMO-${String(i + 1).padStart(3, '0')}`,
      name: `가상 대상자 ${String(i + 1).padStart(2, '0')}`,
      gender: OPTIONS.genders[i % 3],
      age: 20 + (i % 30),
      ageAsOf: date,
      classification1: OPTIONS.classification1[i % 3],
      classification2: OPTIONS.classification2[i % 5],
      date,
      region: d.name,
      stage: target,
      worker: m.name,
      introducerId: m.id,
      className: m.className,
      notes: '기능 확인용 가상 자료입니다. 실제 인물이 아닙니다.',
    }, ws);
    const advance = target !== FIXED_STAGES[0] && i % 2 === 0;
    M.transition(p, null, advance ? FIXED_STAGES[0] : target, `${date}T09:00`, ACTOR, '연습용 최초 등록', ws.stageNames);
    if (advance) M.transition(p, FIXED_STAGES[0], target, `${date}T14:00`, ACTOR, '연습용 단계 이동', ws.stageNames);
    p.updatedAt = stamp;
    ws.people.push(p);
    M.audit(ws, ACTOR, '대상자 등록', p.id, null, M.personChanges(null, p).after);
  }

  const month = today.slice(0, 7);
  const last = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)), 0)).getUTCDate();
  for (const d of store.districts) {
    for (const [stageId, target] of [['*', 12], [FIXED_STAGES[2], 4]]) {
      const goal = { id: `g-${d.id}-${stageId === '*' ? 'found' : 'manpik'}`, region: d.name, from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}`, stageId, target, periodUnit: 'month' };
      ws.goals.push(goal);
      M.audit(ws, ACTOR, '구역 목표 설정', goal.id, null, goal);
    }
  }
  return M.validateWorkspace(ws);
}
