import { createRequire } from 'node:module';
import { can, scopeFor } from './permissions.js';
import { HttpError } from './security.js';
import { commitWorkspace, domainError, sanitizePhoneText, scopedWorkspace, webStageId } from './domain.js';
import { STATUSES, bad, checkRevision, isContactField, personRevision, projectWithStatus, text, toPublic, validDate } from './people.js';

const require = createRequire(import.meta.url);
const M = require('./legacy/model.cjs');
const O = require('./legacy/organization.cjs');
const K = require('./legacy/codes.cjs');
const PM = require('./legacy/ui/person-milestones.js');
const PersonStatus = require('./legacy/person-status.cjs');

const LOCAL_RE = /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/;
const NESTED = ['activities', 'transitions', 'lifecycle'];
const MAX_INTRODUCERS = 1000;

const districtIdOf = (store, person) => store.districts.find((d) => d.name === person.region)?.id ?? '';
const last4 = (v) => (v ? String(v).replace(/\D/g, '').slice(-4) : '');

/** 구역 범위 안의 원본 대상자. 범위 밖이면 존재 여부도 알려 주지 않는다(404). */
function canonicalInScope(store, user, id) {
  const canonical = store.workspace.people.find((p) => p.id === id);
  if (!canonical || !scopeFor(store, user).has(districtIdOf(store, canonical))) throw new HttpError(404, '대상자를 찾을 수 없습니다.');
  return canonical;
}

/** 범위 밖 구역에서 기록된 활동·이력이 이 대상자에게 있는지. 관리자는 항상 false. */
const hasHiddenRecords = (canonical, scoped) => NESTED.some((key) => (canonical[key]?.length ?? 0) > (scoped[key]?.length ?? 0));

const safeText = (v) => sanitizePhoneText(String(v ?? ''));
const isSafe = (v) => safeText(v) === v;

/**
 * 사용자 정의 항목의 화면용 정의(설정 이름·유형·선택지만). 코드 그룹 항목의 선택지는 범위 사본의 공통코드에서
 * 사용 중인 항목만 내보내고, 기존 값이 보관 항목이면 상세의 값으로 화면이 따로 보여 준다.
 * 연락처로 지정된 항목은 값을 바꿀 수 없다(contact).
 */
function customDefinitions(ws) {
  return (ws.fields ?? []).map((f) => {
    const options = f.type !== 'select' ? []
      : f.codeGroupId ? K.options(ws, f.codeGroupId, '').map(([value, label]) => ({ value, label }))
        : f.options.map((o) => ({ value: o, label: o }));
    return {
      id: f.id,
      label: safeText(f.label),
      type: f.type,
      contact: isContactField(f),
      codeGroup: Boolean(f.codeGroupId),
      options: options.filter((o) => isSafe(o.value)).map((o) => ({ value: o.value, label: safeText(o.label) })),
    };
  });
}

/** 대상자의 사용자 항목 값(범위 사본 기준). 연락처 항목은 끝 네 자리만, 자유 문장은 전화번호 모양을 가린다. */
function customValues(ws, p) {
  return customDefinitions(ws).map((def) => {
    const field = ws.fields.find((f) => f.id === def.id);
    const raw = p.custom?.[def.id];
    const base = { id: def.id, label: def.label, type: def.type, contact: def.contact, codeGroup: def.codeGroup };
    if (def.contact) return { ...base, value: '', display: '', last4: def.type === 'text' || def.type === 'number' ? last4(raw) : '' };
    let value = raw ?? (def.type === 'boolean' ? false : '');
    if (def.type === 'number' && typeof value !== 'number') value = '';
    if (def.type === 'boolean') value = value === true;
    if (typeof value === 'string') value = sanitizePhoneText(value);
    let display = '';
    if (def.type === 'boolean') display = value ? '예' : '아니오';
    else if (value !== '') display = def.codeGroup ? safeText(K.label(ws, field.codeGroupId, value)) : safeText(value);
    return { ...base, value, display, last4: '' };
  });
}

/**
 * 대상자 상세. 범위 제한 복사본(연락처는 끝 네 자리, 보이지 않는 구역의 이력·인도자는 제외)에서만 만든다.
 * 보이지 않는 이력을 대신할 가짜 이벤트는 만들지 않는다.
 */
export function buildDetail(store, user, id) {
  const canonical = canonicalInScope(store, user, id);
  const ws = scopedWorkspace(store, user);
  const p = ws.people.find((x) => x.id === id);
  if (!p) throw new HttpError(404, '대상자를 찾을 수 없습니다.');
  const stageName = (stageId) => ws.stageNames[stageId] ?? stageId;
  const org = O.get(ws);
  const member = p.introducerId ? org.members.find((m) => m.id === p.introducerId) : null;
  let introducer = null;
  if (member) introducer = { id: member.id, code: member.code, name: member.name, className: member.className };
  else if (p.introducerId) introducer = { id: p.introducerId, code: p.introducerSnapshot?.code ?? '', name: p.introducerSnapshot?.name ?? '', className: '' };
  const hidden = hasHiddenRecords(canonical, p);
  const linkedCalls = (ws.callingRecords ?? []).filter((r) => r.personId === id).length;

  return {
    person: {
      id: p.id,
      code: p.code,
      name: p.name,
      districtId: districtIdOf(store, p),
      stageId: webStageId(p.stage),
      status: p.status,
      gender: p.gender,
      age: p.age === '' ? null : p.age,
      ageAsOf: p.ageAsOf,
      classification1: p.classification1,
      classification2: p.classification2,
      registeredDate: p.dateUnknown ? '' : p.date,
      dateUnknown: p.dateUnknown === true,
      registeredTime: p.time ?? '',
      place: p.place ?? '',
      tool: p.tool ?? '',
      residence: p.residence ?? '',
      phoneLast4: last4(p.phone),
      teacher: p.teacher ?? '',
      reason: p.reason ?? '',
      worker: p.worker ?? '',
      className: p.className ?? '',
      introducer,
      introducerHidden: Boolean(canonical.introducerId) && !p.introducerId,
      notes: p.notes ?? '',
      customFields: customValues(ws, p),
      dropoutDate: PersonStatus.dropoutDate(p),
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
      revision: personRevision(canonical),
      milestones: PM.fields
        .map(({ field, label }) => ({ field, label, stageId: PM.stageId(ws, field) }))
        .filter((m) => m.stageId)
        .map((m) => ({ field: m.field, label: m.label, stageId: webStageId(m.stageId), stageName: stageName(m.stageId), date: PM.value(p, m.field, ws), recorded: Boolean(p.stageDates?.[m.field]) })),
    },
    stageHistory: p.transitions
      .filter((t) => t.from !== t.to)
      .map((t) => ({
        id: t.id,
        fromName: t.from ? stageName(t.from) : '',
        toName: stageName(t.to),
        effectiveLocal: t.effectiveLocal,
        timeUnknown: t.timeUnknown === true,
        recordedAt: t.recordedAt,
        actor: t.actor,
        region: t.region ?? '',
        reason: t.reason ?? '',
      }))
      .reverse(),
    lifecycle: p.lifecycle
      .map((t) => ({ id: t.id, to: t.to, effectiveLocal: t.effectiveLocal, timeUnknown: t.timeUnknown === true, recordedAt: t.recordedAt, actor: t.actor, reason: t.reason ?? '' }))
      .reverse(),
    activities: p.activities
      .map((a) => ({ id: a.id, date: a.date, start: a.start, end: a.end, minutes: a.minutes, kind: a.kind, place: a.place, worker: a.worker, classification2: a.classification2, notes: a.notes }))
      .sort((a, b) => `${b.date}${b.start}`.localeCompare(`${a.date}${a.start}`)),
    hiddenRecords: hidden,
    links: { callingRecords: linkedCalls },
    // 범위 밖 구역의 기록이 함께 사라지는 삭제는 관리자만 할 수 있다.
    delete: hidden ? { allowed: false, reason: '배정 구역 밖에서 기록된 활동·이력이 있어 관리자만 삭제할 수 있습니다.' } : { allowed: true, reason: '' },
  };
}

/** 등록·수정 화면의 선택 목록: 구역별 인도자(활동 중), 반 공통코드, 단계별 최초 도달일 항목. 쓰기 권한이 필요하다. */
export function editorOptions(store, user, query) {
  const scope = scopeFor(store, user);
  const districtId = query.get('districtId') ?? '';
  if (districtId && !scope.has(districtId)) throw new HttpError(403, '접근할 수 없는 구역입니다.');
  const ws = scopedWorkspace(store, user);
  const org = O.get(ws);
  const idByName = new Map(store.districts.map((d) => [d.name, d.id]));
  const introducers = org.members
    .filter((m) => m.status === 'active')
    .map((m) => ({ id: m.id, code: m.code, name: m.name, className: m.className, districtId: idByName.get(O.regionOf(org, m.unitId)) ?? '' }))
    .filter((m) => m.districtId && scope.has(m.districtId) && (!districtId || m.districtId === districtId))
    .sort((a, b) => a.name.localeCompare(b.name, 'ko'));
  return {
    introducers: introducers.slice(0, MAX_INTRODUCERS),
    introducersTruncated: introducers.length > MAX_INTRODUCERS,
    classNames: K.options(ws, 'className', '').map(([value, label]) => ({ value, label })),
    customFields: customDefinitions(ws),
    milestones: PM.fields
      .map(({ field, label }) => ({ field, label, stageId: PM.stageId(ws, field) }))
      .filter((m) => m.stageId)
      .map((m) => ({ field: m.field, label: m.label, stageId: webStageId(m.stageId) })),
  };
}

/**
 * 탈락·복귀 기록(4.0.41 person.lifecycle). 적용 시각과 사유를 남기고 이전 이력은 그대로 둔다.
 * 현재 상태와 같은 상태는 받지 않는다. 적용 시각은 올바른 날짜·시간이면 지난 시각도 허용한다.
 */
export function recordLifecycle(store, user, id, body) {
  const canonical = canonicalInScope(store, user, id);
  checkRevision(store, id, body.revision, true);
  const { status, effectiveLocal } = body;
  if (!STATUSES.includes(status)) throw bad('처리할 상태를 선택해 주세요.');
  if (typeof effectiveLocal !== 'string' || !LOCAL_RE.test(effectiveLocal) || !validDate(effectiveLocal.slice(0, 10))) throw bad('적용 시각: 올바른 날짜와 시간을 입력해 주세요.');
  const reason = text(body.reason, '사유', 2000);
  if (canonical.status === status) throw new HttpError(409, status === 'dropped' ? '이미 탈락 처리된 대상자입니다.' : '이미 진행 중인 대상자입니다.');
  // 4.0.41과 같이 날짜 순서는 제한하지 않는다. 지난 날짜의 정정(찾은 날짜 이전 포함)도 기록할 수 있다.
  try {
    const draft = scopedWorkspace(store, user);
    const person = draft.people.find((p) => p.id === id);
    if (!person) throw new HttpError(404, '대상자를 찾을 수 없습니다.');
    const event = M.lifecycleChange(person, status, effectiveLocal, user.displayName, reason);
    person.updatedAt = new Date(store.now()).toISOString();
    M.audit(draft, user.displayName, status === 'dropped' ? '대상자 탈락' : '대상자 복귀', person.id, null, event);
    commitWorkspace(store, user, draft);
  } catch (error) {
    throw domainError(error);
  }
  return projectWithStatus(store, store.workspace.people.find((p) => p.id === id));
}

/**
 * 대상자 삭제(4.0.41 person.delete와 같은 처리). 식별번호를 직접 입력해 확인하고, 화면을 연 뒤 바뀌었다면 거절한다.
 * 삭제 전 내용(연락처 제외)은 변경 이력에 남는다. 연결된 콜링 기록은 지우지 않는다(콜링 관리에서 삭제된 대상자로 표시).
 */
export function removePerson(store, user, id, body) {
  const canonical = canonicalInScope(store, user, id);
  checkRevision(store, id, body.revision, true);
  if (typeof body.confirmCode !== 'string' || body.confirmCode !== canonical.code) throw bad('삭제를 확인하려면 식별번호를 정확히 입력해 주세요.');
  try {
    const draft = scopedWorkspace(store, user);
    const person = draft.people.find((p) => p.id === id);
    if (!person) throw new HttpError(404, '대상자를 찾을 수 없습니다.');
    if (hasHiddenRecords(canonical, person)) throw new HttpError(409, '배정 구역 밖에서 기록된 활동·이력이 있어 관리자만 삭제할 수 있습니다.');
    const linkedCalls = (draft.callingRecords ?? []).filter((r) => r.personId === id).length;
    draft.people = draft.people.filter((p) => p.id !== id);
    M.audit(draft, user.displayName, '대상자 삭제', id, person, null);
    commitWorkspace(store, user, draft);
    return { deleted: { id, code: person.code, name: person.name }, keptCallingRecords: linkedCalls };
  } catch (error) {
    throw domainError(error);
  }
}

/* ---------- 삭제 대상자 복원 (변경 이력 화면) ---------- */

const DELETE_ACTION = '대상자 삭제';
const RESTORE_LIST_LIMIT = 100;
const REGION_KEYS = new Set(['region', 'area', 'areaName', 'regionName', 'reportRegion']);
const UNIT_KEYS = new Set(['unitId', 'orgUnitId', 'fromUnitId', 'toUnitId']);
const MEMBER_ID_KEYS = new Set(['introducerId', 'memberId']);

const notFound = () => new HttpError(404, '복원할 수 있는 삭제 대상자를 찾을 수 없습니다.');
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** 기록 조회·대상자 쓰기 권한을 모두 가진 사용자만 복원 기능을 쓸 수 있다. */
function requireRestoreAccess(store, user) {
  if (!can(store, user, 'history', 'read') || !can(store, user, 'people', 'write')) throw new HttpError(403, '이 기능을 사용할 권한이 없습니다.');
}

/**
 * 요청자의 범위 정보. 관리자는 범위 검사를 하지 않는다(구조 검증만 한다).
 * 구역 사용자는 배정 구역 이름과, 범위 제한 사본에서 보이는 구성원·조직으로만 참조를 허용한다.
 */
function restoreContext(store, user) {
  const canonical = store.workspace;
  const base = { canonical, admin: user.role === 'admin', codes: new Set(canonical.people.map((p) => p.code.toLowerCase())), ids: new Set(canonical.people.map((p) => p.id)) };
  if (base.admin) return base;
  const scope = scopeFor(store, user);
  const org = scopedWorkspace(store, user).organization;
  return {
    ...base,
    regions: new Set(store.districts.filter((d) => scope.has(d.id)).map((d) => d.name)),
    memberIds: new Set(org.members.map((m) => m.id)),
    memberCodes: new Set(org.members.map((m) => m.code)),
    unitIds: new Set([...org.members.map((m) => m.unitId), ...[...scope]]),
  };
}

/** 스냅샷 안에 배정 밖 구역·조직·구성원 참조가 하나라도 있으면 true. 알 수 없는 참조도 밖으로 본다. */
function reachesOutside(value, ctx, key = '', depth = 0) {
  if (depth > 12) return true;
  if (Array.isArray(value)) return value.some((x) => reachesOutside(x, ctx, key, depth + 1));
  if (isPlain(value)) return Object.entries(value).some(([k, x]) => reachesOutside(x, ctx, k, depth + 1));
  if (typeof value !== 'string' || value === '') return false;
  if (REGION_KEYS.has(key)) return !ctx.regions.has(value);
  if (UNIT_KEYS.has(key)) return !ctx.unitIds.has(value);
  if (MEMBER_ID_KEYS.has(key)) return !ctx.memberIds.has(value);
  if (key === 'workerId') return !ctx.memberCodes.has(value);
  return false;
}

/** 변경 이력 항목이 정본 이력에 있는 서버 기록이 맞는지(사슬 해시) 확인한다. */
function genuineEntry(history, index) {
  const { hash, ...body } = history[index];
  const previous = index ? history[index - 1].hash : 'GENESIS';
  return body.previous === previous && M.hash(body) === hash;
}

/**
 * id 대상자의 복원 후보. 정본에서 이미 없어졌고, 그 대상자의 가장 마지막 이력이 '대상자 삭제'이며,
 * 시작 구역과 하위 기록의 구역·구성원 참조가 모두 범위 안일 때만 돌려준다.
 * 범위 밖이거나 후보가 아니면 404, 이력이 올바르지 않으면 400, 번호·단계가 충돌하면 409.
 */
function findRecoverable(ctx, id) {
  const history = ctx.canonical.history;
  let index = history.length - 1;
  while (index >= 0 && history[index].target !== id) index -= 1;
  if (index < 0 || ctx.ids.has(id)) throw notFound();
  const entry = history[index];
  const snapshot = entry.before;
  if (entry.action !== DELETE_ACTION || entry.after !== null || !isPlain(snapshot) || snapshot.id !== id) throw notFound();
  if (!ctx.admin && (typeof snapshot.region !== 'string' || !ctx.regions.has(snapshot.region) || reachesOutside(snapshot, ctx))) throw notFound();
  if (!genuineEntry(history, index)) throw bad('삭제 기록을 확인할 수 없어 복원할 수 없습니다.');
  if (typeof snapshot.code !== 'string' || !snapshot.code || typeof snapshot.name !== 'string' || !snapshot.name) throw bad('삭제 기록의 대상자 정보가 올바르지 않아 복원할 수 없습니다.');
  if (ctx.codes.has(snapshot.code.toLowerCase())) throw new HttpError(409, '같은 식별번호의 대상자가 이미 있어 복원할 수 없습니다.');
  if (!ctx.canonical.stages.includes(snapshot.stage)) throw new HttpError(409, '삭제 당시의 단계가 없어져 복원할 수 없습니다.');
  return { entry, snapshot, revision: index + 1 };
}

const summaryOf = ({ entry, snapshot, revision }) => ({ id: snapshot.id, code: snapshot.code, name: sanitizePhoneText(snapshot.name), at: entry.at, revision });

/** 복원할 수 있는 삭제 대상자 목록(최근 삭제순). 이름·번호·삭제 시각·이력 번호만 내보낸다. */
export function listRecoverable(store, user) {
  requireRestoreAccess(store, user);
  const ctx = restoreContext(store, user);
  const history = ctx.canonical.history;
  const seen = new Set();
  const items = [];
  for (let i = history.length - 1; i >= 0 && items.length < RESTORE_LIST_LIMIT; i--) {
    const target = history[i].target;
    if (seen.has(target)) continue;
    seen.add(target);
    if (history[i].action !== DELETE_ACTION) continue;
    try {
      items.push(summaryOf(findRecoverable(ctx, target)));
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
    }
  }
  return { items };
}

/**
 * 삭제 대상자 복원. 같은 id·식별번호로 삭제 기록의 내용(연락처 제외)을 범위 제한 사본에 되돌려 놓고
 * commitWorkspace(구역·참조 검증, M.validateWorkspace, 이력 기록)로 반영한다. 연결된 콜링 기록은 그대로 다시 이어진다.
 * 복원하면 대상자가 다시 있으므로 같은 요청을 되풀이하면 404로 거절한다. 목록을 본 뒤 이력이 달라졌다면 409.
 */
export function restoreDeleted(store, user, id, body) {
  requireRestoreAccess(store, user);
  const found = findRecoverable(restoreContext(store, user), id);
  if (!Number.isInteger(body?.revision) || body.revision !== found.revision) throw new HttpError(409, '삭제 기록이 바뀌었습니다. 목록을 새로 불러와 주세요.');
  try {
    const draft = scopedWorkspace(store, user);
    const person = structuredClone(found.snapshot);
    for (const key of Object.keys(person)) if (/phone|연락처|휴대폰|핸드폰|전화/i.test(key)) delete person[key];
    person.updatedAt = new Date(store.now()).toISOString();
    draft.people.push(person);
    M.audit(draft, user.displayName, '대상자 복원', id, null, M.personChanges(null, person).after);
    commitWorkspace(store, user, draft);
  } catch (error) {
    throw domainError(error);
  }
  return { restored: { id, code: found.snapshot.code, name: sanitizePhoneText(found.snapshot.name) } };
}

/** 대상자 상세·탈락/복귀·삭제·삭제 복원 API. 화면 접근과 동작 권한은 app.js의 중앙 가드가 먼저 확인한다. */
export function personDetailRoutes(store) {
  return [
    { method: 'GET', path: '/api/history/recoverable', screen: 'history', action: 'read', handler: (ctx) => listRecoverable(store, ctx.user) },
    { method: 'POST', path: '/api/history/recoverable/:id/restore', screen: 'history', action: 'read', handler: (ctx) => restoreDeleted(store, ctx.user, ctx.params[0], ctx.body) },
    { method: 'GET', path: '/api/people/options', screen: 'people', action: 'write', handler: (ctx) => editorOptions(store, ctx.user, ctx.query) },
    { method: 'GET', path: '/api/people/:id/detail', screen: 'people', action: 'read', handler: (ctx) => buildDetail(store, ctx.user, ctx.params[0]) },
    { method: 'POST', path: '/api/people/:id/lifecycle', screen: 'people', action: 'write', handler: (ctx) => ({ person: toPublic(recordLifecycle(store, ctx.user, ctx.params[0], ctx.body)) }) },
    { method: 'DELETE', path: '/api/people/:id', screen: 'people', action: 'write', handler: (ctx) => removePerson(store, ctx.user, ctx.params[0], ctx.body) },
  ];
}
