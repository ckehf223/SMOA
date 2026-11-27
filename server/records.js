import { createRequire } from 'node:module';
import { scopeFor } from './permissions.js';
import { HttpError } from './security.js';
import { seoulDate } from './people.js';
import { commitWorkspace, domainError, scopedWorkspace } from './domain.js';
import { bufferOf, createPreviewStore, scopeInfo, sessionOf } from './daily.js';

/**
 * 활동 기록·지역활동·단계 이동·변경 이력 API (화면 id: activities, regionalActivity, stages, history).
 * 모든 요청은 scopedWorkspace(요청자 구역으로 잘린 사본)에서만 계산하고, 쓰기는 commitWorkspace로 반영한다.
 * 이 파일의 공용 도우미(legacy, guard, 구역 검사, 연락처 가리기, 엑셀 응답)는 analytics.js도 사용한다.
 */

const require = createRequire(import.meta.url);
const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const PAGE_SIZE = 50;
const loaded = new Map();

/** server/legacy 의 CommonJS 도메인 모듈을 처음 쓸 때 불러온다. (.cjs → .js 순) */
export function legacy(name) {
  if (!loaded.has(name)) {
    let file;
    for (const ext of ['cjs', 'js']) {
      try {
        file = require.resolve(`./legacy/${name}.${ext}`);
        break;
      } catch {
        /* 다음 확장자를 시도 */
      }
    }
    if (!file) throw new Error(`도메인 모듈 ${name}을(를) 찾을 수 없습니다.`);
    loaded.set(name, require(file));
  }
  return loaded.get(name);
}

/** 기존 도메인 검증 오류만 HTTP 400으로 바꾼다. 이미 HttpError인 것은 그대로 둔다. */
export function guard(fn) {
  try {
    return fn();
  } catch (err) {
    if (err instanceof HttpError) throw err;
    domainError(err);
    throw err;
  }
}

export const isAdmin = (ctx) => ctx.user.role === 'admin';

/** 요청자가 볼 수 있는 구역 이름 집합. 구역 ID는 store.districts 로 이름에 연결한다. */
export function allowedRegions(store, ctx) {
  const scope = scopeFor(store, ctx.user);
  return new Set(store.districts.filter((d) => scope.has(d.id)).map((d) => d.name));
}

/** 필터로 받은 구역이 배정 범위 밖이면 거절한다. (관리자는 전체) */
export function checkRegion(store, ctx, region) {
  if (!region || isAdmin(ctx)) return;
  if (!allowedRegions(store, ctx).has(region)) throw new HttpError(403, '접근할 수 없는 구역입니다.');
}

/** 쿼리에서 허용한 키만 문자열로 읽는다. */
export function pick(query, keys, max = 100) {
  const out = {};
  for (const key of keys) {
    const value = query.get(key);
    if (value == null || value === '') continue;
    if (value.length > max) throw new HttpError(400, `${key} 값이 너무 깁니다.`);
    out[key] = value.trim();
  }
  return out;
}

export function weekStartOf(store, query) {
  const raw = query.get('weekStart');
  if (raw != null && raw !== '') {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0 || n > 6) throw new HttpError(400, '주 시작 요일을 확인해 주세요.');
    return n;
  }
  const saved = store.settings?.weekStart;
  return Number.isInteger(saved) && saved >= 0 && saved <= 6 ? saved : 0;
}

export const todayOf = (store) => seoulDate(store.now());

export function pageOf(query, total) {
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(pages, Math.max(1, Number.parseInt(query.get('page'), 10) || 1));
  return { page, pages, pageSize: PAGE_SIZE, start: (page - 1) * PAGE_SIZE };
}

/* ---------- 연락처 가리기 ---------- */

const PHONE_KEY = /phone|tel|mobile|contact|연락|전화|휴대/i;
const PHONE_TEXT = /(?<!\d)(?:\+?82[-.\s]?|0)\d{1,2}[-.\s]?\d{3,4}[-.\s]?(\d{4})(?!\d)/g;

export function maskPhone(value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  return digits.length >= 4 ? `****${digits.slice(-4)}` : '';
}

export const maskText = (s) => s.replace(PHONE_TEXT, '****$1');

/** 응답·엑셀로 나가는 모든 값에서 연락처 원문을 끝 네 자리만 남기고 가린다. (깊은 복사본을 돌려준다) */
export function redact(value, key = '') {
  if (Array.isArray(value)) return value.map((v) => redact(v, key));
  if (value && typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return value; // Date 등은 그대로 둔다.
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v, k)]));
  }
  if (PHONE_KEY.test(key) && (typeof value === 'string' || typeof value === 'number')) return maskPhone(value);
  if (typeof value === 'string' && !/id$/i.test(key)) return maskText(value);
  return value;
}

/* ---------- 엑셀 응답 ---------- */

const safeCell = (v) => (typeof v === 'string' && /^[=+\-@\t\r]/.test(v) ? `'${v}` : v);

export async function sheetBuffer(sheets) {
  const { default: ExcelJS } = await import('exceljs');
  const wb = new ExcelJS.Workbook();
  wb.creator = 'SMOA';
  for (const { name, columns, rows } of sheets) {
    const ws = wb.addWorksheet(name);
    ws.columns = columns.map((c) => ({ header: c.header, key: c.key, width: c.width ?? 14 }));
    ws.getRow(1).font = { bold: true };
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    for (const row of rows) ws.addRow(Object.fromEntries(Object.entries(row).map(([k, v]) => [k, safeCell(v)])));
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export function xlsxResponse(body, name, store) {
  const stamp = todayOf(store).replaceAll('-', '');
  return {
    raw: true,
    status: 200,
    headers: { 'Content-Type': XLSX_TYPE, 'Content-Disposition': `attachment; filename="smoa-${name}-${stamp}.xlsx"` },
    body,
  };
}

/* ---------- 활동 기록 ---------- */

const ACTIVITY_FILTERS = ['search', 'worker', 'region', 'place', 'timeBand', 'classification2', 'from', 'to', 'minMinutes', 'maxMinutes'];

function activityFilters(ctx, store) {
  const input = pick(ctx.query, ACTIVITY_FILTERS, 100);
  checkRegion(store, ctx, input.region);
  if (input.search && input.search.replace(/\D/g, '').length >= 5) throw new HttpError(400, '연락처로는 검색할 수 없습니다.');
  // 분류2는 항상 명시해서 보낸다. (빠지면 기존 계산이 노방만 본다.)
  return { ...input, classification2: input.classification2 ?? '', basis: 'activity' };
}

function activityRow(ws, a, K) {
  return {
    id: a.id,
    personId: a.personId ?? '',
    personCode: a.personCode ?? '',
    personName: a.personName ?? '',
    code: a.code,
    date: a.date,
    start: a.start,
    end: a.end,
    minutes: a.minutes,
    classification2: a.classification2 ?? '노방',
    region: a.region || '',
    worker: a.worker || '',
    workerId: a.workerId || '',
    place: K.label(ws, 'activityPlace', a.place),
    placeValue: a.place || '',
    kind: K.label(ws, 'activityKind', a.kind),
    kindValue: a.kind || '',
    notes: a.notes || '',
    updatedAt: a.updatedAt,
  };
}

function activityList(store, ctx) {
  const M = legacy('model');
  const K = legacy('codes');
  const ws = scopedWorkspace(store, ctx.user);
  const filters = activityFilters(ctx, store);
  const result = guard(() => M.query(ws, filters));
  const rows = result.activities
    .map((a) => redact(activityRow(ws, a, K)))
    .sort((a, b) => b.date.localeCompare(a.date) || (b.start || '').localeCompare(a.start || '') || a.code.localeCompare(b.code));
  const summary = {
    count: rows.length,
    minutes: rows.reduce((sum, r) => sum + (r.minutes || 0), 0),
    workers: new Set(rows.filter((r) => r.worker || r.workerId).map((r) => r.workerId || `${r.region}\u0000${r.worker}`)).size,
  };
  return { rows, summary, filters };
}

function activityOptions(store, ctx) {
  const M = legacy('model');
  const K = legacy('codes');
  const O = legacy('organization');
  const ws = scopedWorkspace(store, ctx.user);
  const org = O.get(ws);
  const members = [];
  for (const m of org.members) {
    if (m.status !== 'active') continue;
    let region;
    try {
      if (!O.ancestors(org, m.unitId).every((n) => n.active)) continue;
      region = O.regionOf(org, m.unitId);
    } catch {
      continue;
    }
    members.push({ id: m.id, code: m.code, name: m.name, region: region || '', className: m.className || '' });
  }
  members.sort((a, b) => a.region.localeCompare(b.region, 'ko', { numeric: true }) || a.name.localeCompare(b.name, 'ko'));
  const q = (ctx.query.get('q') ?? '').trim().toLowerCase();
  const people = ws.people
    .filter((p) => !q || [p.code, p.name].some((v) => String(v).toLowerCase().includes(q)))
    .slice(0, 300)
    .map((p) => ({ id: p.id, code: p.code, name: p.name, region: p.region || '' }));
  const list = (key) => K.options(ws, key).map(([value, label]) => ({ value, label }));
  return {
    members: members.map((m) => redact(m)),
    people: redact(people),
    places: list('activityPlace'),
    kinds: list('activityKind'),
    classification2: M.PERSON_CLASSIFICATIONS.classification2,
  };
}

/** 활동 등록·수정. 대상자 연결 활동은 대상자 안에, 아니면 독립 활동 기록으로 저장한다. */
function saveActivity(store, ctx, id) {
  const M = legacy('model');
  const O = legacy('organization');
  const b = ctx.body;
  const ws = scopedWorkspace(store, ctx.user);
  const actor = ctx.user.displayName;
  const owner = b.personId ? ws.people.find((p) => p.id === b.personId) : null;
  if (b.personId && !owner) throw new HttpError(404, '대상자를 찾을 수 없습니다.');
  const list = owner ? owner.activities : ws.activityLogs;
  const before = id ? list.find((a) => a.id === id) : null;
  if (id && !before) throw new HttpError(404, '활동을 찾을 수 없습니다.');
  if (before && b.updatedAt !== undefined && b.updatedAt !== before.updatedAt) throw new HttpError(409, '다른 곳에서 수정된 활동입니다. 목록을 새로 불러온 뒤 다시 수정해 주세요.');

  const after = guard(() => {
    // 보내지 않은 항목이 기존 값을 지우지 않도록 undefined는 뺀다.
    const sent = { date: b.date, start: b.start ?? '', end: b.end ?? '', classification2: b.classification2, place: b.place ?? '', kind: b.kind ?? '', notes: b.notes ?? '' };
    let input = Object.fromEntries(Object.entries(sent).filter(([, v]) => v !== undefined));
    if (b.memberId === '__existing' && before) {
      input = { ...before, ...input, worker: before.worker, workerId: before.workerId, region: before.region };
    } else {
      const org = O.get(ws);
      const member = org.members.find((m) => m.id === b.memberId);
      M.assert(member && (member.status === 'active' || member.code === before?.workerId), '등록된 활동자를 선택하세요.');
      const region = O.regionOf(org, member.unitId);
      if (!isAdmin(ctx) && !allowedRegions(store, ctx).has(region)) throw new HttpError(403, '배정된 구역의 활동자가 아닙니다.');
      input = { ...input, worker: member.name, workerId: member.code, region, className: member.className, ...O.reportDimensions(ws, member, region) };
    }
    const next = M.validateActivity(input, before, ws);
    M.assertNoActivityOverlap(ws, next);
    const all = [...ws.activityLogs, ...ws.people.flatMap((p) => p.activities)];
    M.assert(!all.some((a) => a.code === next.code && a.id !== next.id), '이미 사용 중인 활동 식별번호입니다.');
    return next;
  });
  guard(() => M.assert(before || list.length < 100000, '활동 기록 제한을 초과했습니다.'));
  if (before) list[list.indexOf(before)] = after;
  else list.push(after);
  if (owner) owner.updatedAt = M.now();
  M.audit(ws, actor, before ? '활동 수정' : '활동 등록', owner?.id || after.id, before, after);
  commitWorkspace(store, ctx.user, ws);
  return { id: after.id, code: after.code };
}

/** 활동 삭제(1~10,000건). 선택 후 수정된 활동은 거절한다. */
function removeActivities(store, ctx) {
  const M = legacy('model');
  const rows = ctx.body.rows;
  if (!Array.isArray(rows) || !rows.length || rows.length > 10000) throw new HttpError(400, '삭제할 활동을 1~10,000건 선택해 주세요.');
  const ws = scopedWorkspace(store, ctx.user);
  const seen = new Set();
  const picked = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object' || typeof row.id !== 'string' || (row.personId != null && typeof row.personId !== 'string')) throw new HttpError(400, '삭제할 활동 정보를 확인해 주세요.');
    const personId = row.personId || '';
    const key = `${personId}\u0000${row.id}`;
    if (seen.has(key)) throw new HttpError(400, '삭제할 활동이 중복 선택되었습니다.');
    seen.add(key);
    const owner = personId ? ws.people.find((p) => p.id === personId) : null;
    if (personId && !owner) throw new HttpError(404, '활동이 연결된 대상자를 찾을 수 없습니다. 목록을 새로 불러오세요.');
    const list = owner ? owner.activities : ws.activityLogs;
    const target = list.find((a) => a.id === row.id);
    if (!target) throw new HttpError(409, '선택한 활동이 변경되었거나 삭제되었습니다. 목록을 새로 불러오세요.');
    if (row.updatedAt !== undefined && row.updatedAt !== target.updatedAt) throw new HttpError(409, '선택한 활동이 수정되었습니다. 목록을 새로 불러온 뒤 다시 선택해 주세요.');
    picked.push({ owner, list, target });
  }
  for (const { owner, list, target } of picked) {
    list.splice(list.indexOf(target), 1);
    if (owner) owner.updatedAt = M.now();
    M.audit(ws, ctx.user.displayName, '활동 삭제', owner?.id || target.id, target, null);
  }
  commitWorkspace(store, ctx.user, ws);
  return { deleted: picked.length };
}

async function activityExport(store, ctx) {
  const { rows } = activityList(store, ctx);
  const body = await sheetBuffer([{
    name: '활동 기록',
    columns: [
      { header: '활동번호', key: 'code', width: 18 }, { header: '날짜', key: 'date' }, { header: '시작', key: 'start', width: 8 },
      { header: '종료', key: 'end', width: 8 }, { header: '분', key: 'minutes', width: 8 }, { header: '분류2', key: 'classification2', width: 10 },
      { header: '구역', key: 'region' }, { header: '활동자', key: 'worker', width: 16 }, { header: '대상자', key: 'person', width: 18 },
      { header: '장소', key: 'place', width: 18 }, { header: '활동 종류', key: 'kind', width: 14 }, { header: '비고', key: 'notes', width: 40 },
    ],
    rows: rows.map((r) => ({ ...r, person: r.personName ? `${r.personName} (${r.personCode})` : '' })),
  }]);
  ctx.recheck();
  return xlsxResponse(body, 'activities', store);
}

/* ---------- 지역활동(월별·일자별 활동구분) ---------- */

function regionalInput(store, ctx) {
  const q = ctx.query;
  const input = pick(q, ['month', 'date', 'from', 'to'], 20);
  Object.assign(input, pick(q, ['region'], 60));
  checkRegion(store, ctx, input.region);
  input.weekStart = weekStartOf(store, q);
  if (q.get('code')) {
    const code = Number(q.get('code'));
    if (!Number.isInteger(code) || code < 1 || code > 4) throw new HttpError(400, '활동 상태는 1~4에서 선택해 주세요.');
    input.code = code;
  }
  if (input.from || input.to) {
    input.from ??= input.to;
    input.to ??= input.from;
    delete input.month;
    delete input.date;
  } else if (input.month && !input.date) {
    // 월만 지정하면 오늘 날짜를 끼워 넣지 않는다. (다른 달 조회가 400이 되던 문제)
  } else {
    input.date ??= todayOf(store);
    input.month ??= input.date.slice(0, 7);
  }
  return input;
}

function regionalSummary(store, ctx) {
  const ws = scopedWorkspace(store, ctx.user);
  const RA = legacy('regional-activity');
  const input = regionalInput(store, ctx);
  return { input, result: redact(guard(() => RA.summary(ws, input))) };
}

async function regionalExport(store, ctx) {
  const { result } = regionalSummary(store, ctx);
  const sheets = [];
  const names = { 1: '적극적 활동자', 2: '전도비 후원자', 3: '소극적 활동자', 4: '비활동자' };
  if (result.members) {
    sheets.push({
      name: '구성원별 활동구분',
      columns: [
        { header: '구역', key: 'region' }, { header: '이름', key: 'name', width: 16 }, { header: '구성원 번호', key: 'memberCode', width: 16 },
        { header: `${result.previousMonth} 활동구분`, key: 'prev', width: 16 }, { header: `${result.month} 활동구분`, key: 'cur', width: 16 },
        { header: result.date ? `${result.date} 활동구분` : '선택일 활동구분', key: 'day', width: 18 },
      ],
      rows: result.members.map((m) => ({
        region: m.region, name: m.name, memberCode: m.memberCode,
        prev: names[m.previousCode] ?? '', cur: names[m.currentCode] ?? '', day: names[m.dayCode] ?? '',
      })),
    });
    sheets.push({
      name: '구역별 집계',
      columns: [
        { header: '구역', key: 'region' }, { header: '명부 인원', key: 'roster', width: 10 }, { header: '이번 달 기록', key: 'recorded', width: 12 },
        { header: '활동', key: 'active', width: 8 }, { header: '비활동', key: 'inactive', width: 8 }, { header: '미입력', key: 'unrecorded', width: 8 },
        { header: '활동 비율(%)', key: 'rate', width: 12 },
      ],
      rows: result.districts.map((d) => ({
        region: d.region, roster: d.current.rosterMembers, recorded: d.current.recorded, active: d.current.active,
        inactive: d.current.inactive, unrecorded: d.current.unrecorded, rate: d.current.activeRate === null ? '' : Math.round(d.current.activeRate * 10) / 10,
      })),
    });
  } else {
    sheets.push({
      name: '기간별 활동구분',
      columns: [
        { header: '구역', key: 'region' }, { header: '이름', key: 'name', width: 16 }, { header: '구성원 번호', key: 'memberCode', width: 16 },
        { header: '활동구분', key: 'label', width: 16 }, { header: '기록일', key: 'date' },
      ],
      rows: result.records.map((r) => ({ region: r.region, name: r.name, memberCode: r.memberCode, label: names[r.code] ?? '', date: r.date ?? r.month ?? '' })),
    });
  }
  const body = await sheetBuffer(sheets);
  ctx.recheck();
  return xlsxResponse(body, 'regional-activity', store);
}

/** 쓰기 대상 구성원의 구역이 요청자 범위 안인지 확인한다. */
function checkMembers(store, ctx, ws, ids) {
  if (isAdmin(ctx)) return;
  const O = legacy('organization');
  const org = O.get(ws);
  const allowed = allowedRegions(store, ctx);
  for (const id of ids) {
    const member = org.members.find((m) => m.id === id);
    if (!member) throw new HttpError(404, '등록된 구성원을 선택해 주세요.');
    if (!allowed.has(O.regionOf(org, member.unitId))) throw new HttpError(403, '배정된 구역의 구성원이 아닙니다.');
  }
}

function saveRegional(store, ctx) {
  const RA = legacy('regional-activity');
  const b = ctx.body;
  const rows = Array.isArray(b.rows) ? b.rows : [b];
  const ws = scopedWorkspace(store, ctx.user);
  checkMembers(store, ctx, ws, rows.map((r) => r?.memberId));
  const count = guard(() => RA.saveMany(ws, { month: b.month, date: b.date, rows: rows.map((r) => ({ memberId: r?.memberId, code: r?.code, date: r?.date, month: r?.month })) }, ctx.user.displayName));
  if (count > 0) commitWorkspace(store, ctx.user, ws);
  return { saved: count };
}

function removeRegional(store, ctx) {
  const RA = legacy('regional-activity');
  const ws = scopedWorkspace(store, ctx.user);
  checkMembers(store, ctx, ws, [ctx.body.memberId]);
  const removed = guard(() => RA.remove(ws, { month: ctx.body.month, date: ctx.body.date, memberId: ctx.body.memberId }, ctx.user.displayName));
  if (removed) commitWorkspace(store, ctx.user, ws);
  return { removed };
}

/* ---------- 지역활동기록 엑셀 가져오기 (미리보기 → 한 번의 일괄 반영) ---------- */

const IMPORT_KIND = 'regional-import';
const MONTH_RE = /^(?!0000)\d{4}-(0[1-9]|1[0-2])$/;
const IMPORT_ROW_LIMIT = 200;
const IMPORT_ERROR_LIMIT = 300;
const FILE_ERROR = '엑셀 파일을 읽지 못했습니다. .xlsx 형식과 활동기록 시트를 확인해 주세요.';
const HIDDEN_RECORD = '같은 기간의 기존 기록이 배정 구역 밖에 있어 이 구역에서는 변경할 수 없습니다.';

/** 파일 이름만 남기고 제어 문자를 지운다. (응답·구역 일보 파일 판별에만 쓴다.) */
function cleanFileName(value) {
  return String(value ?? '').split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 200);
}

/** 원본 가져오기 모듈의 한국어 검증 오류는 그대로, 파일 해석 오류는 안내 문구로 400을 만든다. */
function importError(err) {
  if (err instanceof HttpError) return err;
  const message = String(err?.message ?? '');
  if (err?.constructor === Error && /[가-힣]/.test(message)) return new HttpError(400, maskText(message).slice(0, 300));
  console.error('지역활동기록 엑셀을 읽지 못했습니다:', err?.name);
  return new HttpError(400, FILE_ERROR);
}

/**
 * 정본(store.workspace) 기준으로 가져올 행의 구역을 다시 확인한다. (관리자는 제외)
 * - 구성원의 가장 가까운 구역 표시가 요청자 배정 구역 밖이거나 기록 구역이 밖이면 403으로 전체를 거절한다.
 * - 같은 기간의 기존 기록이 배정 구역 밖에 숨어 있으면 그 행은 blocked로 나눈다. (커밋 단계의 403을 미리 막는다.)
 */
function confineImportRows(store, ctx, rows) {
  if (isAdmin(ctx)) return { rows, blocked: [] };
  const O = legacy('organization');
  const allowed = allowedRegions(store, ctx);
  const org = O.get(store.workspace);
  const members = new Map(org.members.map((m) => [m.id, m]));
  const homeOf = (id) => {
    const member = members.get(id);
    if (!member) return '';
    try {
      return O.regionOf(org, member.unitId);
    } catch {
      return '';
    }
  };
  const hidden = new Set();
  for (const r of store.workspace.regionalActivities ?? []) {
    if (r.region && !allowed.has(r.region)) hidden.add(`${r.date || r.month}/${r.memberId}`);
  }
  const kept = [];
  const blocked = [];
  for (const row of rows) {
    const home = homeOf(row.memberId);
    if (!home || !allowed.has(home) || (row.region && !allowed.has(row.region))) {
      throw new HttpError(403, '배정된 구역 밖 구성원의 기록은 가져올 수 없습니다.');
    }
    (hidden.has(`${row.date || row.month}/${row.memberId}`) ? blocked : kept).push(row);
  }
  return { rows: kept, blocked };
}

function duplicateRow(d) {
  const incoming = d.incoming?.fields ?? {};
  return {
    row: d.row,
    matchedRow: d.matchedRow ?? null,
    name: incoming.name ?? d.incoming?.label ?? '',
    memberCode: incoming.memberCode ?? '',
    region: incoming.region ?? '',
    date: incoming.date ?? '',
    month: incoming.month ?? '',
    code: incoming.code ?? null,
    existingCode: d.existing?.fields?.code ?? null,
    blocking: Boolean(d.blocking),
    reason: d.reason ?? '',
  };
}

function regionalImportHandlers(store) {
  const previews = createPreviewStore(store.now, {});

  /** 엑셀 → 미리보기. 정본은 바꾸지 않으며 반영할 행은 서버 메모리에만 보관한다. */
  async function preview(ctx) {
    const info = scopeInfo(store, ctx.user);
    const session = sessionOf(ctx, info);
    const buffer = bufferOf(ctx);
    const month = (ctx.query.get('month') ?? '').trim();
    if (month && !MONTH_RE.test(month)) throw new HttpError(400, '기록 월을 YYYY-MM 형식으로 선택해 주세요.');
    const region = (ctx.query.get('region') ?? '').trim();
    if (region.length > 60) throw new HttpError(400, '구역 이름이 너무 깁니다.');
    checkRegion(store, ctx, region);
    const fileName = cleanFileName(ctx.query.get('name'));

    // 파일을 읽는 동안 자료가 바뀌면 거절해야 하므로 정본 revision과 범위 사본을 같은 시점에 잡는다.
    const revision = store.workspace.revision;
    const ws = scopedWorkspace(store, ctx.user);
    let result;
    try {
      result = await legacy('regional-activity-import').preview(ws, buffer, { month: month || undefined, region, dailyAreaFile: fileName || '지역활동기록.xlsx' });
    } catch (err) {
      throw importError(err);
    }
    ctx.recheck();
    if (store.workspace.revision !== revision) throw new HttpError(409, '미리보기 중 자료가 바뀌었습니다. 파일을 다시 선택해 주세요.');
    if (result.dailyArea) throw new HttpError(400, '구역 일보 정리본입니다. 구역 일보 화면에서 가져와 주세요.');

    const confined = confineImportRows(store, ctx, result.rows);
    const rows = confined.rows;
    const errors = [...result.errors, ...confined.blocked.map((r) => ({ row: r.row, message: HIDDEN_RECORD }))].sort((a, b) => a.row - b.row);
    const counts = { ...result.counts };
    for (const r of confined.blocked) counts[r.action] -= 1;
    counts.valid = rows.length;
    counts.errors = errors.length;
    const dates = rows.map((r) => r.date).filter(Boolean).sort();
    const firstDate = dates[0] ?? null;
    const lastDate = dates.at(-1) ?? null;
    const canCommit = rows.length > 0 && errors.length === 0;

    const saved = canCommit
      ? previews.put(session, revision, IMPORT_KIND, {
        dateMode: result.dateMode,
        month: result.dateMode ? undefined : result.month,
        lastDate,
        rows: rows.map(({ memberId, code, date }) => ({ memberId, code, ...(date ? { date } : {}) })),
      })
      : null;
    const changed = rows.filter((r) => r.action !== 'unchanged');
    return redact({
      importId: saved?.id ?? '',
      expiresAt: saved?.expiresAt ?? '',
      fileName,
      sheet: result.sheet,
      month: result.month,
      region: result.region,
      dateMode: result.dateMode,
      firstDate,
      lastDate,
      counts,
      canCommit,
      rows: changed.slice(0, IMPORT_ROW_LIMIT).map((r) => ({
        row: r.row, date: r.date ?? '', name: r.name, memberCode: r.memberCode, region: r.region, code: r.code, previousCode: r.previousCode, action: r.action,
      })),
      totalChanged: changed.length,
      errors: errors.slice(0, IMPORT_ERROR_LIMIT),
      totalErrors: errors.length,
      duplicates: result.duplicates.map(duplicateRow),
      totalDuplicates: Math.max(result.totalDuplicates, counts.unchanged),
    });
  }

  /**
   * 미리보기 반영. 세션·구역 서명(previews.get)과 정본 revision을 확인하고, 구역을 다시 검사한 뒤
   * 단 한 번의 commitWorkspace로 반영한다. 확인부터 커밋까지 await가 없어 중간에 다른 요청이 끼어들 수 없다.
   */
  function apply(ctx) {
    const info = scopeInfo(store, ctx.user);
    const id = ctx.body?.importId;
    const saved = previews.get(sessionOf(ctx, info), id, IMPORT_KIND);
    try {
      if (store.workspace.revision !== saved.revision) throw new HttpError(409, '미리보기가 만료되었거나 자료가 바뀌었습니다. 파일을 다시 선택해 주세요.');
      ctx.recheck();
      const staged = saved.data;
      const keyed = staged.rows.map((r) => ({ ...r, month: staged.month ?? r.date.slice(0, 7), region: '' }));
      if (confineImportRows(store, ctx, keyed).blocked.length) throw new HttpError(409, HIDDEN_RECORD);
      const ws = scopedWorkspace(store, ctx.user);
      const payload = { ...(staged.dateMode ? {} : { month: staged.month }), rows: staged.rows };
      const applied = guard(() => legacy('regional-activity').saveMany(ws, payload, ctx.user.displayName));
      if (applied > 0) commitWorkspace(store, ctx.user, ws);
      return { applied, unchanged: staged.rows.length - applied, total: staged.rows.length, dateMode: staged.dateMode, lastDate: staged.lastDate ?? '' };
    } finally {
      previews.delete(id);
    }
  }

  return { preview, apply };
}

/* ---------- 단계 이동 ---------- */

function stageMovements(store, ctx) {
  const M = legacy('model');
  const K = legacy('codes');
  const ws = scopedWorkspace(store, ctx.user);
  const q = pick(ctx.query, ['date', 'from', 'to', 'region', 'fromStage', 'toStage', 'kind', 'search'], 60);
  checkRegion(store, ctx, q.region);
  guard(() => {
    for (const key of ['date', 'from', 'to']) if (q[key]) M.date(q[key]);
  });
  const today = todayOf(store);
  const from = q.from || q.date || today;
  const to = q.to || q.date || from;
  if (from > to) throw new HttpError(400, '시작일은 종료일보다 늦을 수 없습니다.');
  if (q.kind && !['stage', 'lifecycle'].includes(q.kind)) throw new HttpError(400, '구분을 확인해 주세요.');
  const term = (q.search ?? '').toLowerCase();
  const stageLabel = (id) => (id ? ws.stageNames?.[id] || id : '최초 등록');
  const rows = [];
  for (const p of ws.people) {
    const region = p.region || '';
    if (q.region && (region || '미입력') !== q.region) continue;
    if (term && ![p.name, p.code, p.worker].some((v) => String(v ?? '').toLowerCase().includes(term))) continue;
    const base = { personCode: p.code, personName: p.name, className: K.label(ws, 'className', p.className) };
    if (q.kind !== 'lifecycle') {
      for (const t of p.transitions || []) {
        const day = (t.effectiveLocal || '').slice(0, 10);
        if (t.from === null || t.from === t.to || day < from || day > to) continue;
        if ((q.fromStage && t.from !== q.fromStage) || (q.toStage && t.to !== q.toStage)) continue;
        rows.push({ ...base, id: t.id, kind: 'stage', date: day, time: t.effectiveLocal.slice(11), region: t.region ?? region, from: t.fromName || stageLabel(t.from), to: t.toName || stageLabel(t.to), reason: t.reason || '', actor: t.actor || '', worker: t.worker || p.worker || '' });
      }
    }
    if (q.kind !== 'stage' && !q.fromStage && !q.toStage) {
      for (const ev of p.lifecycle || []) {
        const day = (ev.effectiveLocal || '').slice(0, 10);
        if (day < from || day > to) continue;
        rows.push({ ...base, id: ev.id, kind: 'lifecycle', date: day, time: (ev.effectiveLocal || '').slice(11), region, from: ev.to === 'dropped' ? '진행' : '탈락', to: ev.to === 'dropped' ? '탈락' : '복귀', reason: ev.reason || '', actor: ev.actor || '', worker: p.worker || '' });
      }
    }
  }
  rows.sort((a, b) => `${b.date} ${b.time}`.localeCompare(`${a.date} ${a.time}`) || a.personCode.localeCompare(b.personCode));
  const byMove = new Map();
  for (const r of rows) {
    const key = `${r.from} → ${r.to}`;
    byMove.set(key, (byMove.get(key) || 0) + 1);
  }
  const page = pageOf(ctx.query, rows.length);
  // 기존 기간별 단계 현황(재고)과 단계 향상률(코호트): 요청자 구역 범위의 사본에서 계산한다.
  const period = guard(() => M.query(ws, { from, to, region: q.region ?? '', classification2: '', basis: 'registered' }));
  const inventory = redact(period.summary.inventory.map((r) => ({
    id: r.id, label: r.label, target: r.target, entered: r.entered, retained: r.retained, stock: r.stock, left: r.left, restored: r.restored,
  })));
  const cohort = redact(period.summary.cohort.map((c) => ({ label: c.label, baseCount: c.baseCount, count: c.count, rate: c.rate })));
  return {
    from, to, total: rows.length, inventory, cohort,
    ...page,
    movements: [...byMove].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value),
    stages: ws.stages.map((id) => ({ id, name: stageLabel(id) })),
    regions: [...new Set(ws.people.map((p) => p.region || '미입력'))].sort((a, b) => a.localeCompare(b, 'ko', { numeric: true })),
    rows: redact(rows.slice(page.start, page.start + page.pageSize)),
    all: rows,
  };
}

async function stageExport(store, ctx) {
  const { all, inventory, cohort } = stageMovements(store, ctx);
  const body = await sheetBuffer([{
    name: '단계 이동',
    columns: [
      { header: '적용일', key: 'date' }, { header: '시각', key: 'time', width: 8 }, { header: '구분', key: 'kindLabel', width: 10 },
      { header: '대상자 번호', key: 'personCode', width: 16 }, { header: '이름', key: 'personName', width: 16 }, { header: '구역', key: 'region' },
      { header: '반', key: 'className', width: 10 }, { header: '이전', key: 'from', width: 12 }, { header: '이후', key: 'to', width: 12 },
      { header: '활동자', key: 'worker', width: 16 }, { header: '사유', key: 'reason', width: 30 }, { header: '기록자', key: 'actor', width: 16 },
    ],
    rows: redact(all).map((r) => ({ ...r, kindLabel: r.kind === 'stage' ? '단계 이동' : '탈락·복귀' })),
  }, {
    name: '기간별 단계 현황',
    columns: [
      { header: '단계', key: 'label', width: 16 }, { header: '기간 목표', key: 'target', width: 10 }, { header: '기간 신규 진입', key: 'entered', width: 14 },
      { header: '유지 보유', key: 'retained', width: 10 }, { header: '기간 말 재고', key: 'stock', width: 12 }, { header: '이탈', key: 'left', width: 8 }, { header: '복귀', key: 'restored', width: 8 },
    ],
    rows: inventory.map((r) => ({ ...r, target: r.target ?? '', retained: r.retained ?? '' })),
  }, {
    name: '단계 향상률',
    columns: [
      { header: '출발 → 도착 단계', key: 'label', width: 24 }, { header: '출발 인원', key: 'baseCount', width: 10 },
      { header: '향상 인원', key: 'count', width: 10 }, { header: '향상률(%)', key: 'rate', width: 10 },
    ],
    rows: cohort.map((c) => ({ ...c, rate: c.rate == null ? '' : Math.round(c.rate * 1000) / 10 })),
  }]);
  ctx.recheck();
  return xlsxResponse(body, 'stage-movements', store);
}

/* ---------- 변경 이력 ---------- */

const FIELD_LABELS = {
  name: '이름', code: '번호', stage: '단계', region: '구역', className: '반', worker: '담당자', date: '날짜', start: '시작', end: '종료',
  minutes: '분', place: '장소', kind: '종류', notes: '비고', status: '상태', gender: '성별', age: '나이', month: '기준월', memberId: '구성원',
  classification1: '분류1', classification2: '분류2', employment: '직업구분', stageEvent: '단계 이력', target: '목표', found: '찾기', advanced: '진행', dropped: '탈락',
};
const SKIP_FIELDS = new Set(['id', 'createdAt', 'updatedAt', 'activities', 'transitions', 'lifecycle', 'custom']);

function shown(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text == null) return '';
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

/** 이전·이후 값의 바뀐 항목만 추려 보여 준다. 배열(일괄 변경)은 건수만 표시한다. */
function diffOf(before, after) {
  const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
  if (!isObj(before) && !isObj(after)) {
    const count = (v) => (Array.isArray(v) ? `${v.length}건` : v == null ? '' : shown(v));
    return [{ field: '내용', before: count(before), after: count(after) }];
  }
  const a = isObj(before) ? before : {};
  const b = isObj(after) ? after : {};
  const out = [];
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (SKIP_FIELDS.has(key) || JSON.stringify(a[key]) === JSON.stringify(b[key])) continue;
    const text = (v) => (v == null ? '' : PHONE_KEY.test(key) ? maskPhone(v) : shown(v));
    out.push({ field: FIELD_LABELS[key] ?? key, before: text(a[key]), after: text(b[key]) });
  }
  return out.slice(0, 40);
}

function entryRegions(entry) {
  const regions = [];
  for (const side of [entry.before, entry.after]) {
    for (const item of Array.isArray(side) ? side : [side]) {
      if (item && typeof item === 'object' && typeof item.region === 'string' && item.region) regions.push(item.region);
    }
  }
  return regions;
}

function historyList(store, ctx, everything = false) {
  const M = legacy('model');
  const ws = scopedWorkspace(store, ctx.user);
  const q = pick(ctx.query, ['from', 'to', 'actor', 'action', 'search'], 60);
  guard(() => {
    if (q.from) M.date(q.from);
    if (q.to) M.date(q.to);
  });
  if (q.from && q.to && q.from > q.to) throw new HttpError(400, '시작일은 종료일보다 늦을 수 없습니다.');
  const allowed = isAdmin(ctx) ? null : allowedRegions(store, ctx);
  const people = new Map(ws.people.map((p) => [p.id, p]));
  const term = (q.search ?? '').toLowerCase();
  const seoulDay = (iso) => seoulDate(Date.parse(iso));
  const visible = (ws.history || []).filter((e) => !allowed || entryRegions(e).every((r) => allowed.has(r)));
  const actions = [...new Set(visible.map((e) => e.action))].sort((a, b) => a.localeCompare(b, 'ko'));
  const matches = visible.filter((e) => {
    const day = seoulDay(e.at);
    if ((q.from && day < q.from) || (q.to && day > q.to)) return false;
    if (q.actor && e.actor !== q.actor) return false;
    if (q.action && e.action !== q.action) return false;
    if (term) {
      const person = people.get(e.target);
      if (![e.actor, e.action, person?.name, person?.code, e.target].some((v) => String(v ?? '').toLowerCase().includes(term))) return false;
    }
    return true;
  });
  const ordered = matches.slice().reverse();
  const page = everything ? { page: 1, pages: 1, pageSize: ordered.length, start: 0 } : pageOf(ctx.query, ordered.length);
  const items = ordered.slice(page.start, everything ? 20000 : page.start + page.pageSize).map((e) => {
    const person = people.get(e.target);
    return redact({
      id: e.id,
      at: e.at,
      actor: e.actor,
      action: e.action,
      target: person ? `${person.code} ${person.name}` : String(e.target ?? '').slice(0, 80),
      changes: diffOf(e.before, e.after),
    });
  });
  return {
    total: ordered.length,
    ...page,
    items,
    actions,
    actors: [...new Set(visible.map((e) => e.actor))].sort((a, b) => String(a).localeCompare(String(b), 'ko')),
    scoped: !isAdmin(ctx),
  };
}

async function historyExport(store, ctx) {
  const { items } = historyList(store, ctx, true);
  const body = await sheetBuffer([{
    name: '변경 이력',
    columns: [
      { header: '일시', key: 'at', width: 22 }, { header: '작업자', key: 'actor', width: 16 }, { header: '작업', key: 'action', width: 16 },
      { header: '대상', key: 'target', width: 24 }, { header: '변경 내용', key: 'changes', width: 80 },
    ],
    rows: items.map((e) => ({
      at: new Date(e.at).toLocaleString('sv', { timeZone: 'Asia/Seoul' }),
      actor: e.actor, action: e.action, target: e.target,
      // 연락처 항목 값은 이미 redact로 끝 네 자리만 남아 있다.
      changes: e.changes.map((c) => `${c.field}: ${c.before || '(없음)'} → ${c.after || '(없음)'}`).join('\n'),
    })),
  }]);
  ctx.recheck();
  return xlsxResponse(body, 'history', store);
}

/* ---------- 라우트 ---------- */

export function recordsRoutes(store) {
  const regionalImport = regionalImportHandlers(store);
  return [
    { method: 'GET', path: '/api/activities', screen: 'activities', action: 'read', handler: (ctx) => {
      const { rows, summary } = activityList(store, ctx);
      const page = pageOf(ctx.query, rows.length);
      return { total: rows.length, ...page, summary, items: rows.slice(page.start, page.start + page.pageSize) };
    } },
    { method: 'GET', path: '/api/activities/options', screen: 'activities', action: 'read', handler: (ctx) => activityOptions(store, ctx) },
    { method: 'GET', path: '/api/activities/export', screen: 'activities', action: 'export', handler: (ctx) => activityExport(store, ctx) },
    { method: 'POST', path: '/api/activities', screen: 'activities', action: 'write', handler: (ctx) => saveActivity(store, ctx, null) },
    { method: 'PUT', path: '/api/activities/:id', screen: 'activities', action: 'write', handler: (ctx) => saveActivity(store, ctx, ctx.params[0]) },
    { method: 'POST', path: '/api/activities/delete', screen: 'activities', action: 'write', handler: (ctx) => removeActivities(store, ctx) },

    { method: 'GET', path: '/api/regional-activity', screen: 'regionalActivity', action: 'read', handler: (ctx) => regionalSummary(store, ctx).result },
    { method: 'GET', path: '/api/regional-activity/export', screen: 'regionalActivity', action: 'export', handler: (ctx) => regionalExport(store, ctx) },
    { method: 'POST', path: '/api/regional-activity/save', screen: 'regionalActivity', action: 'write', handler: (ctx) => saveRegional(store, ctx) },
    { method: 'POST', path: '/api/regional-activity/remove', screen: 'regionalActivity', action: 'write', handler: (ctx) => removeRegional(store, ctx) },
    { method: 'POST', path: '/api/regional-activity/import-preview', screen: 'regionalActivity', action: 'write', binary: true, handler: regionalImport.preview },
    { method: 'POST', path: '/api/regional-activity/import-apply', screen: 'regionalActivity', action: 'write', handler: regionalImport.apply },

    { method: 'GET', path: '/api/stage-movements', screen: 'stages', action: 'read', handler: (ctx) => {
      const { all, ...rest } = stageMovements(store, ctx);
      return rest;
    } },
    { method: 'GET', path: '/api/stage-movements/export', screen: 'stages', action: 'export', handler: (ctx) => stageExport(store, ctx) },

    { method: 'GET', path: '/api/history', screen: 'history', action: 'read', handler: (ctx) => historyList(store, ctx) },
    { method: 'GET', path: '/api/history/export', screen: 'history', action: 'export', handler: (ctx) => historyExport(store, ctx) },
  ];
}
