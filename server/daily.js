import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
import { scopeFor } from './permissions.js';
import { HttpError } from './security.js';
import { cumulativeRoute, scopedCumulative } from './cumulative.js';

/**
 * 구역 일보 화면 API (/api/daily).
 * - 원문 변환·정리본 통합문서·가져오기는 기존 SMOA 4.0.41 순수 모듈(server/legacy)을 그대로 사용한다.
 * - 모든 자료는 scopedWorkspace(사용자 구역 범위 복제본)에서만 읽고, 변환 결과와 통합문서에는 연락처 끝 네 자리만 남긴다.
 * - 가져오기는 사용자·구역·자료 revision에 묶인 서버 메모리 미리보기를 거쳐 commitWorkspace로만 반영한다.
 */

const require = createRequire(import.meta.url);

export const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const ROW_LIMIT = 300;
const PREVIEW_TTL_MS = 10 * 60_000;
const MAX_TEXT = 200_000;

// ───────────────────────── 공용 도우미 (reports.js도 사용) ─────────────────────────

/** 원본 순수 모듈 불러오기. 아직 없으면 서버가 죽지 않도록 503으로 알린다. */
export function legacy(name) {
  try {
    return require(`./legacy/${name}`);
  } catch (err) {
    if (err?.code === 'MODULE_NOT_FOUND') throw new HttpError(503, '필요한 업무 모듈을 아직 사용할 수 없습니다.');
    throw err;
  }
}

let domainLoad;
/** server/domain.js (통합 단계에서 제공). 실패하면 다음 호출에서 다시 시도한다. */
export function domain() {
  domainLoad ??= import('./domain.js').catch((err) => {
    domainLoad = undefined;
    console.error('자료 영역 모듈을 불러오지 못했습니다:', err?.name);
    throw new HttpError(503, '자료 영역 연결이 아직 준비되지 않았습니다.');
  });
  return domainLoad;
}

const PHONE_RE = /(?<!\d)(?:\+?82[-.\s]?)?\(?0?\d{1,3}\)?[-.\s]?\d{3,4}[-.\s]?\d{4}(?!\d)/g;

/** 문장 속 전화번호를 끝 네 자리만 남기고 가린다. 날짜(2026-11-03 등)는 건드리지 않는다. */
export function redact(text) {
  return String(text).replace(PHONE_RE, (m) => {
    const digits = m.replace(/\D/g, '');
    if (digits.length < 8 || digits.length > 15) return m;
    if (digits.length === 8 && !/^\d{4}[-.\s]\d{4}$/.test(m)) return m;
    if (/^\d{4}[-./]\d{1,2}[-./]\d{1,2}$/.test(m.trim())) return m;
    return `끝 4자리 ${digits.slice(-4)}`;
  });
}

/** 연락처 칸 값: 숫자가 4자리 이상이면 끝 네 자리만, 아니면 빈 값. */
export function maskContact(value) {
  if (value == null || value === '') return '';
  const digits = String(value).replace(/\D/g, '');
  return digits.length >= 4 ? `끝 4자리 ${digits.slice(-4)}` : '';
}

const ID_KEY = /^(id|code|hash|previous)$|Id$|ID$/;
const PHONE_KEY = /phone|연락처|휴대폰|핸드폰|전화/i;

/** 응답에 실리는 모든 문자열에서 전화번호를 가린다. 식별자 열은 그대로 둔다. */
export function redactDeep(value, key = '') {
  if (typeof value === 'string') {
    if (PHONE_KEY.test(key)) return value.startsWith('끝 4자리') ? value : maskContact(value);
    return ID_KEY.test(key) ? value : redact(value);
  }
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, key));
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v, k)]));
  }
  return value;
}

/** 원본 모듈이 던지는 검증 오류(일반 Error)는 400으로, 코드 오류(TypeError 등)는 그대로 500으로 둔다. */
export function legacyError(err) {
  if (err instanceof HttpError) return err;
  if (err instanceof TypeError || err instanceof RangeError || err instanceof ReferenceError || err instanceof SyntaxError) return err;
  return new HttpError(400, redact(String(err?.message || '요청을 처리하지 못했습니다.')).slice(0, 500));
}
export async function guarded(fn) {
  try {
    return await fn();
  } catch (err) {
    throw legacyError(err);
  }
}

export function districtKey(value) {
  const token = String(value ?? '').normalize('NFC').replace(/\s/g, '');
  const m = /^(\d+)(?:구역)?$/u.exec(token);
  return m ? `${Number(m[1])}구역` : token;
}

/** 사용자 구역 범위. admin이 아니면 store.districts 이름으로만 구역을 인정한다. */
export function scopeInfo(store, user) {
  const ids = scopeFor(store, user);
  const districts = store.districts.filter((d) => ids.has(d.id));
  return {
    admin: user.role === 'admin',
    districts,
    keys: new Set(districts.map((d) => districtKey(d.name))),
    signature: `${user.role}|${[...ids].sort().join(',')}`,
  };
}

/** 미리보기·조회에 묶는 세션 정보: 로그인 토큰 + 사용자 ID + 역할·구역 서명. */
export function sessionOf(ctx, info) {
  if (!ctx.token || !ctx.user?.id) throw new HttpError(401, '로그인이 필요합니다.');
  return { token: ctx.token, userId: ctx.user.id, signature: info.signature };
}
export const inScope = (info, label) => info.admin || (Boolean(label) && info.keys.has(districtKey(label)));

const TEXT_FIELDS = ['name', 'notes', 'place', 'tool', 'residence', 'teacher', 'reason', 'worker'];

/**
 * 조회·내보내기 전용 복제본: 연락처는 끝 네 자리만, 자유 입력 칸의 번호는 가리고, 구역 밖 행은 제거한다.
 * 이 복제본은 절대 commit에 쓰지 않는다(원본 연락처가 지워진 채 저장되면 안 된다).
 */
export function viewClone(ws, info) {
  const view = structuredClone(ws);
  for (const p of view.people ?? []) {
    p.phone = maskContact(p.phone);
    for (const f of TEXT_FIELDS) if (typeof p[f] === 'string') p[f] = redact(p[f]);
    for (const [k, v] of Object.entries(p.custom ?? {})) if (typeof v === 'string') p.custom[k] = redact(v);
    for (const a of p.activities ?? []) if (typeof a.notes === 'string') a.notes = redact(a.notes);
  }
  for (const a of view.activityLogs ?? []) if (typeof a.notes === 'string') a.notes = redact(a.notes);
  if (!info.admin) {
    const ok = (r) => inScope(info, r);
    view.people = (view.people ?? []).filter((p) => ok(p.region));
    view.activityLogs = (view.activityLogs ?? []).filter((a) => ok(a.region));
    view.dailyReports = (view.dailyReports ?? []).filter((r) => ok(r.region));
    view.findingReports = (view.findingReports ?? []).filter((r) => ok(r.region));
    view.goals = (view.goals ?? []).filter((g) => ok(g.region));
    for (const node of view.organization?.nodes ?? []) node.leaderId = '';
  }
  return view;
}

/**
 * 서버 메모리 미리보기: 로그인 세션(토큰)·사용자·역할/구역 서명에 묶이고 만료되며 사용자당 개수가 제한된다.
 * session = sessionOf(ctx, info). revision은 store.workspace(정본)의 revision이다.
 */
export function createPreviewStore(now, { ttlMs = PREVIEW_TTL_MS, perUser = 4 } = {}) {
  const map = new Map();
  const prune = () => {
    const t = now();
    for (const [k, v] of map) if (v.expires <= t) map.delete(k);
  };
  return {
    put(session, revision, kind, data) {
      prune();
      const mine = [...map.entries()].filter(([, v]) => v.userId === session.userId).map(([k]) => k);
      while (mine.length >= perUser) map.delete(mine.shift());
      const id = randomUUID();
      const expires = now() + ttlMs;
      map.set(id, { token: session.token, userId: session.userId, signature: session.signature, revision, kind, data, expires });
      return { id, expiresAt: new Date(expires).toISOString() };
    },
    get(session, id, kind) {
      prune();
      const v = typeof id === 'string' ? map.get(id) : undefined;
      if (!v || v.token !== session.token || v.userId !== session.userId || v.kind !== kind) {
        throw new HttpError(404, '미리보기가 없거나 만료되었습니다. 처음부터 다시 확인해 주세요.');
      }
      if (v.signature !== session.signature) {
        map.delete(id);
        throw new HttpError(409, '접근 구역이 바뀌어 이 미리보기를 사용할 수 없습니다. 다시 확인해 주세요.');
      }
      return v;
    },
    delete: (id) => map.delete(id),
  };
}

/**
 * 임시 명부 규칙(사용자별 설정)으로 미리보기를 계산하되, 결과 초안과 작업 영역 복제본에는 원래 전역 값을 되돌린다.
 * 사용자 설정이 commit을 통해 전역 설정으로 새어 들어가지 않도록 한다. run(ws)의 반환값에 draft가 있으면 함께 복원한다.
 */
export function withRosterRules(ws, rules, run) {
  const had = Object.hasOwn(ws, 'dailyActivityRosterRules');
  const original = had ? structuredClone(ws.dailyActivityRosterRules) : undefined;
  const restore = (target) => {
    if (!target || typeof target !== 'object') return;
    if (had) target.dailyActivityRosterRules = structuredClone(original);
    else delete target.dailyActivityRosterRules;
  };
  ws.dailyActivityRosterRules = rules;
  let outcome;
  try {
    outcome = run(ws);
  } finally {
    restore(ws);
  }
  restore(outcome?.draft);
  return outcome;
}

/** 입력 글에서 일보 구조를 찾지 못했을 때의 400 메시지(파서 안내 포함, 연락처 가림). */
export function noReportError(warnings = []) {
  const hint = warnings.slice(0, 3).map((w) => redact(String(w))).join(' / ');
  return new HttpError(400, `일보 구조를 찾지 못했습니다. "1구역 일보"처럼 구역 제목과 날짜 줄이 있는지 확인해 주세요.${hint ? ` (${hint})` : ''}`.slice(0, 500));
}

/** binary:true 경로의 본문(XLSX). 앱이 Buffer로 넘기는 위치를 모두 확인한다. */
export function bufferOf(ctx) {
  for (const c of [ctx.body, ctx.buffer, ctx.rawBody, ctx.file]) {
    if (Buffer.isBuffer(c) && c.length) return c;
    if (c instanceof Uint8Array && c.length) return Buffer.from(c);
  }
  throw new HttpError(400, '엑셀 파일(.xlsx)을 선택해 주세요.');
}

export function xlsxResponse(filename, buffer) {
  return {
    raw: true,
    status: 200,
    headers: { 'Content-Type': XLSX_TYPE, 'Content-Disposition': `attachment; filename="${filename}"` },
    body: Buffer.from(buffer),
  };
}

export const seoulDate = (ms) => new Date(ms + 9 * 3_600_000).toISOString().slice(0, 10);

const cellPlain = (v) => (v && Array.isArray(v.richText) ? v.richText.map((r) => r.text).join('') : v);
const headerKey = (v) => String(cellPlain(v) ?? '').normalize('NFC').replace(/\s+/g, '').toUpperCase();
const PHONE_HEADERS = new Set(['연락처', '휴대폰번호', '휴대폰', '핸드폰번호', '핸드폰', '전화번호']);

/** 업로드된 통합문서에서 연락처 열을 지우고 그 밖의 칸의 전화번호는 가린다. 지워진 칸 수를 돌려준다. */
export function sanitizeWorkbook(workbook) {
  let phoneCells = 0;
  for (const sheet of workbook.worksheets) {
    const phoneCols = new Set();
    sheet.getRow(1).eachCell((cell, col) => {
      if (PHONE_HEADERS.has(headerKey(cell.value).replace(/^대상자/u, ''))) phoneCols.add(col);
    });
    sheet.eachRow((row, n) => {
      row.eachCell((cell, col) => {
        if (n > 1 && phoneCols.has(col)) {
          if (cell.value != null && cell.value !== '') phoneCells++;
          cell.value = null;
          return;
        }
        const v = cellPlain(cell.value);
        if (typeof v === 'string') {
          const masked = redact(v);
          if (masked !== cell.value) cell.value = masked;
        }
      });
    });
  }
  return phoneCells;
}

/** 압축 구조 검사 → 읽기 → 연락처 제거. 반환: { workbook, phoneCells } */
export async function loadWorkbook(buffer, { allowPrinterSettings = true } = {}) {
  legacy('importer.cjs').checkZip(buffer, { allowPrinterSettings });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer, { ignoreNodes: ['drawing', 'legacyDrawing', 'extLst', 'pageSetup'] });
  return { workbook, phoneCells: sanitizeWorkbook(workbook) };
}

/** 구역 열이 있는 시트에서 권한 밖 구역의 행을 비운다(관리자는 제외). blankIsForeign: 구역이 빈 행도 제외. */
export function dropOutOfScopeRows(workbook, info, columns, blankIsForeign = new Set()) {
  if (info.admin) return 0;
  let dropped = 0;
  for (const sheet of workbook.worksheets) {
    const header = columns[sheet.name];
    if (!header) continue;
    let col = 0;
    sheet.getRow(1).eachCell((cell, i) => {
      if (headerKey(cell.value) === headerKey(header)) col = i;
    });
    if (!col) continue;
    const width = Math.max(sheet.columnCount, col);
    sheet.eachRow((row, n) => {
      if (n <= 1) return;
      const label = String(cellPlain(row.getCell(col).value) ?? '').trim();
      const foreign = label ? !info.keys.has(districtKey(label)) : blankIsForeign.has(sheet.name);
      if (!foreign) return;
      for (let c = 1; c <= width; c++) row.getCell(c).value = null;
      dropped++;
    });
  }
  return dropped;
}

/** 반영 직전 기준본: 원본 복제본을 한 번 검증해 정규화 차이로 인한 오탐을 막는다. */
export function validatedBaseline(ws) {
  const baseline = structuredClone(ws);
  try {
    legacy('model.cjs').validateWorkspace(baseline);
  } catch {
    /* 검증 실패 시 원본 그대로 비교한다 */
  }
  return baseline;
}

const CHANGEABLE = new Set([
  'people', 'activityLogs', 'dailyReports', 'findingReports', 'regionalActivities', 'history', 'revision', 'updatedAt',
  'dailyActivityRosterRules', 'dailyAreaActivityOrder', 'dailyAreaSlashLayouts',
]);

/**
 * 미리보기 초안이 허용된 범위만 바꿨는지 확인한다.
 * - 조직·공통코드·목표·단계 같은 전역 설정은 바뀌면 안 된다.
 * - 바뀐 대상자·활동·일계·일보 행은 사용자 구역 안이어야 한다.
 */
export function draftViolations(baseline, draft, info) {
  const errors = [];
  for (const key of new Set([...Object.keys(baseline), ...Object.keys(draft)])) {
    if (CHANGEABLE.has(key)) continue;
    if (JSON.stringify(baseline[key]) !== JSON.stringify(draft[key])) errors.push('조직·공통코드·목표 같은 전역 설정은 이 화면에서 바꿀 수 없습니다.');
  }
  const changedRows = (before, after) => {
    const old = new Map((before ?? []).map((x) => [x.id, JSON.stringify(x)]));
    return (after ?? []).filter((x) => old.get(x.id) !== JSON.stringify(x));
  };
  const kept = new Set((draft.people ?? []).map((p) => p.id));
  if ((baseline.people ?? []).some((p) => !kept.has(p.id))) errors.push('대상자를 삭제하는 가져오기는 허용하지 않습니다.');
  const checks = [
    ['대상자', changedRows(baseline.people, draft.people), 'region'],
    ['활동', changedRows(baseline.activityLogs, draft.activityLogs), 'region'],
    ['구역 일계', changedRows(baseline.dailyReports, draft.dailyReports), 'region'],
    ['찾기 일보', changedRows(baseline.findingReports, draft.findingReports), 'region'],
  ];
  for (const [label, rows, field] of checks) {
    const bad = rows.filter((r) => !inScope(info, r[field])).length;
    if (bad) errors.push(`${label} ${bad}건이 접근 권한이 없거나 구역이 비어 있어 반영할 수 없습니다.`);
  }
  if (!info.admin) {
    const O = legacy('organization.cjs');
    const org = O.get(baseline);
    const members = new Map(org.members.map((m) => [m.id, m]));
    const districtOk = (memberId) => {
      const member = members.get(memberId);
      if (!member) return false;
      const node = [...O.ancestors(org, member.unitId)].reverse().find((n) => n.reportRegion || /구역/.test(n.type));
      return Boolean(node) && [node.name, node.reportRegion].some((l) => l && info.keys.has(districtKey(l)));
    };
    const old = new Map((baseline.regionalActivities ?? []).map((a) => [JSON.stringify(a), true]));
    const bad = (draft.regionalActivities ?? []).filter((a) => !old.has(JSON.stringify(a)) && !districtOk(a.memberId)).length;
    if (bad) errors.push(`활동 기록 ${bad}건이 접근 권한이 없는 구성원이라 반영할 수 없습니다.`);
  }
  return [...new Set(errors)];
}

// ───────────────────────── 일보 전용 ─────────────────────────

const cellOut = (v) => {
  if (v instanceof Date) return Number.isFinite(v.valueOf()) ? v.toISOString().slice(0, 10) : '';
  return v == null ? '' : String(v);
};
const cleanHeader = (h) => String(h).replace(/\s+/g, ' ').trim();

const DAILY_COLUMNS = { 활동자: '구역', 찾기: '구역', 업데이트: '구역' };
const DAILY_BLANK_FOREIGN = new Set(['활동자', '찾기', '업데이트']);
const SCOPE_KEYS = ['activity', 'finding', 'updates'];

function textSetting(value, label) {
  if (value == null) return '';
  if (typeof value !== 'string' || value.length > 100_000) throw new HttpError(400, `${label}은(는) 100,000자 이내의 글로 입력해 주세요.`);
  return value;
}

/** 활동자 제외·이름 변경·활동자 순서·행 형식 설정을 원본 파서로 검증한다. */
function compileSettings(input) {
  const L = legacy('daily-area-slash-layouts.cjs');
  const R = legacy('daily-activity-roster.cjs');
  const W = legacy('daily-area-workbook.cjs');
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const clean = {
    excludedText: textSetting(raw.excludedText, '활동자 제외'),
    aliasesText: textSetting(raw.aliasesText, '활동자 이름 변경'),
    activityOrderText: textSetting(raw.activityOrderText, '활동자 순서'),
    slashLayouts: {},
  };
  const layouts = {};
  const given = raw.slashLayouts;
  if (given != null) {
    if (typeof given !== 'object' || Array.isArray(given)) throw new HttpError(400, '일보 행 형식을 확인해 주세요.');
    for (const [stage, text] of Object.entries(given)) {
      if (!L.stages.includes(stage)) throw new HttpError(400, '일보 행 형식의 단계를 확인해 주세요.');
      if (typeof text !== 'string' || !text.trim()) continue;
      layouts[stage] = L.parseLayout(text);
      clean.slashLayouts[stage] = text.trim();
    }
  }
  return {
    clean,
    layouts,
    policy: R.parseActivityRosterRules({ excludedText: clean.excludedText, aliasesText: clean.aliasesText }),
    order: W.parseActivityOrder(clean.activityOrderText),
    rosterRules: { excludedText: clean.excludedText, aliasesText: clean.aliasesText },
  };
}

/** 파싱된 보고서 중 사용자 구역 안의 것만 남긴다. 반환 allowed는 결과 행 검사에 쓰는 구역 키. */
function confineReports(parsed, view, info) {
  if (info.admin) return { reports: parsed.reports, warnings: [...parsed.warnings], allowed: null, dropped: 0 };
  const O = legacy('organization.cjs');
  const nodes = O.get(view).nodes.filter((n) => n.active && (n.reportRegion || /구역/.test(n.type)));
  const labels = (n) => [n.name, n.reportRegion].filter(Boolean).map(districtKey);
  const allowed = new Set();
  const reports = [];
  const droppedNames = [];
  for (const report of parsed.reports) {
    const key = districtKey(report.district);
    const matches = nodes.filter((n) => labels(n).includes(key));
    const ok = info.keys.has(key) || matches.some((n) => labels(n).some((l) => info.keys.has(l)));
    if (!ok) {
      droppedNames.push(report.district);
      continue;
    }
    reports.push(report);
    allowed.add(key);
    for (const n of matches) for (const l of labels(n)) allowed.add(l);
  }
  const warnings = parsed.warnings.filter((w) => !droppedNames.some((n) => w.startsWith(`${n} `)));
  if (droppedNames.length) warnings.push(`접근 권한이 없거나 조직에서 확인할 수 없는 구역 ${droppedNames.length}곳은 변환에서 제외했습니다.`);
  return { reports, warnings, allowed, dropped: droppedNames.length };
}

/** 보고서 원문에서 읽은 연락처는 끝 네 자리만 남기고, 자유 입력 칸의 번호도 가린다. */
function stripContacts(reports) {
  for (const report of reports) {
    for (const change of report.changes) {
      const digits = String(change.phone ?? '').replace(/\D/g, '');
      change.phone = digits.length >= 4 ? `000-0000-${digits.slice(-4)}` : '';
      for (const f of ['name', 'method', 'residence', 'place', 'introducer', 'teacher', 'reason']) {
        if (typeof change[f] === 'string') change[f] = redact(change[f]);
      }
    }
  }
}

/**
 * 일보 원문 → 구역 범위 안의 변환 결과(collect). 연락처는 끝 네 자리만 남는다.
 * ws는 scopedWorkspace 결과이며, 이 함수는 ws를 바꾸지 않는다.
 */
export function buildConversion(ws, info, { text, year, regionId = '', settings }) {
  const cfg = compileSettings(settings);
  const view = viewClone(ws, info);
  const parsed = legacy('daily-area-report.cjs').parse(text, year, { slashLayouts: cfg.layouts });
  if (!parsed.reports.length) throw noReportError(parsed.warnings);
  const scoped = confineReports(parsed, view, info);
  if (!scoped.reports.length) throw new HttpError(403, '접근 권한이 있는 구역의 일보가 없습니다.');
  stripContacts(scoped.reports);
  const result = legacy('daily-area-workbook.cjs').collect(view, { reports: scoped.reports, warnings: scoped.warnings }, regionId, cfg.order, cfg.policy);
  if (scoped.allowed) {
    const keep = (label) => scoped.allowed.has(districtKey(label));
    result.activityRows = result.activityRows.filter((r) => keep(r[1]));
    result.findingRows = result.findingRows.filter((r) => keep(r['  구역']));
    result.updateRows = result.updateRows.filter((r) => keep(r['  구역']));
  }
  for (const row of [...result.findingRows, ...result.updateRows]) row.연락처 = maskContact(row.연락처) || null;
  // 누적 엑셀 반영 자료도 같은 구역 범위로 줄이고 연락처를 비운다. 응답에는 싣지 않는다.
  Object.assign(result, scopedCumulative(result, scoped.allowed ? (label) => scoped.allowed.has(districtKey(label)) : null, redact));
  return { result, rosterRules: cfg.rosterRules, dropped: scoped.dropped };
}

function tableRows(headers, rows) {
  return {
    headers: headers.map(cleanHeader),
    rows: rows.slice(0, ROW_LIMIT).map((row) => headers.map((h) => (PHONE_KEY.test(h) ? maskContact(row[h]) : cellOut(row[h])))),
    total: rows.length,
  };
}

const NOTICE_HEADERS = ['날짜', '활동자', '활동장소', '시작시간', '종료시간', '활동종류', '활동메모'];

// 앱의 기본 JSON 상한(64KiB) 안에서 한글 원문과 검토 표 값을 함께 보낼 수 있는 크기. 라우트별 상한이 넓어지면 올린다.
export const SMALL_TEXT = 12_000;
const REVIEW_MAX_ROWS = 80;
const REVIEW_CELL = 200;
const REVIEW_LOCKED = new Set(['보고일', '구역', '대상자ID']);

/**
 * 검토 표에서 고친 찾기 행을 서버가 다시 읽은 원문 행에 덮어 쓴다.
 * 행 수가 원문과 같아야 하며, 보고일·구역·대상자ID는 고칠 수 없고, 값은 문자열 200자 이내여야 한다.
 */
export function reviewRows(parsedRows, given, editable) {
  if (given == null) return undefined;
  if (!Array.isArray(given) || given.length !== parsedRows.length || given.length > REVIEW_MAX_ROWS) {
    throw new HttpError(400, '검토 표의 행 수가 원문과 다릅니다. 원문을 다시 확인해 주세요.');
  }
  return given.map((input, i) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, '검토 표 형식을 확인해 주세요.');
    const row = {};
    for (const [k, v] of Object.entries(parsedRows[i])) if (!k.startsWith('_')) row[k] = v == null ? '' : String(v);
    for (const k of editable) {
      if (!Object.hasOwn(input, k)) continue;
      if (typeof input[k] !== 'string' || input[k].length > REVIEW_CELL) throw new HttpError(400, `검토 표의 ${k} 값을 확인해 주세요.`);
      row[k] = input[k];
    }
    return row;
  });
}

export function dailyRoutes(store) {
  const previews = createPreviewStore(store.now, {});
  const settingsByUser = new Map();
  const savedSettings = (user) => settingsByUser.get(user.id) ?? { excludedText: '', aliasesText: '', activityOrderText: '', slashLayouts: {} };

  const workspaceFor = async (ctx) => (await domain()).scopedWorkspace(store, ctx.user);
  const canonRevision = () => store.workspace.revision;

  /** 원문 변환: 구역 범위 확인 → 원본 파서·collect → 연락처 제거 → 서버 메모리에 보관 */
  async function convert(ctx) {
    const D = await domain();
    const info = scopeInfo(store, ctx.user);
    const session = sessionOf(ctx, info);
    const { text } = ctx.body;
    if (typeof text !== 'string' || !text.trim()) throw new HttpError(400, '일보 원문을 붙여넣어 주세요.');
    if (text.length > MAX_TEXT) throw new HttpError(400, '일보 원문이 너무 깁니다.');
    const year = ctx.body.year == null || ctx.body.year === '' ? Number(seoulDate(store.now()).slice(0, 4)) : Number(ctx.body.year);
    if (!Number.isInteger(year) || year < 1900 || year > 9999) throw new HttpError(400, '일보의 기준 연도를 확인해 주세요.');
    const regionId = typeof ctx.body.regionId === 'string' ? ctx.body.regionId : '';

    return guarded(() => {
      const revision = canonRevision();
      const ws = D.scopedWorkspace(store, ctx.user);
      const { result, rosterRules, dropped } = buildConversion(ws, info, {
        text, year, regionId, settings: ctx.body.settings ?? savedSettings(ctx.user),
      });
      const W = legacy('daily-area-workbook.cjs');
      const saved = previews.put(session, revision, 'conversion', { result, rosterRules });
      return redactDeep({
        conversionId: saved.id,
        expiresAt: saved.expiresAt,
        date: result.date,
        counts: result.counts,
        summary: result.summary,
        warnings: result.warnings.slice(0, 300),
        totalWarnings: result.warnings.length,
        activity: { headers: W.activityHeaders, rows: result.activityRows.slice(0, ROW_LIMIT).map((r) => r.map(cellOut)), total: result.activityRows.length },
        finding: tableRows(W.findingHeaders, result.findingRows),
        updates: tableRows(W.updateHeaders, result.updateRows),
        droppedDistricts: dropped,
      });
    });
  }

  async function conversionWorkbook(ctx) {
    const info = scopeInfo(store, ctx.user);
    const saved = previews.get(sessionOf(ctx, info), ctx.params[0], 'conversion');
    const buffer = await guarded(() => legacy('daily-area-workbook.cjs').workbook(saved.data.result));
    ctx.recheck();
    return xlsxResponse(`smoa-daily-${saved.data.result.date.replaceAll('-', '')}.xlsx`, buffer);
  }

  /**
   * 정리본 통합문서(변환 결과 또는 업로드)를 읽어 가져오기 미리보기를 만든다. 반영은 apply에서만.
   * revision은 호출자가 비동기 작업 전에 정본에서 읽은 값이며, 읽기 뒤 바뀌었으면 거절한다.
   */
  async function importPreview(ctx, { buffer, fileName, date, scopes, rosterRules, revision }) {
    const D = await domain();
    const info = scopeInfo(store, ctx.user);
    const session = sessionOf(ctx, info);
    const I = legacy('daily-area-import.cjs');
    const { workbook, phoneCells } = await guarded(() => loadWorkbook(buffer));
    const droppedRows = dropOutOfScopeRows(workbook, info, DAILY_COLUMNS, DAILY_BLANK_FOREIGN);
    const source = await guarded(() => I.select(workbook, fileName));
    if (!source) throw new HttpError(400, 'SMOA 구역 일보 정리본(활동자·찾기·업데이트 시트)이 아닙니다.');
    if (!info.admin && source.activityDistricts) source.activityDistricts = source.activityDistricts.filter((d) => info.keys.has(districtKey(d)));
    const chosen = scopes.length ? scopes.filter((s) => source.available.includes(s)) : source.available;
    if (!chosen.length) throw new HttpError(400, '가져올 시트를 선택해 주세요.');

    ctx.recheck();
    if (canonRevision() !== revision) throw new HttpError(409, '파일을 읽는 사이 자료가 바뀌었습니다. 다시 시도해 주세요.');
    const ws = D.scopedWorkspace(store, ctx.user); // 비동기 읽기 뒤 최신 상태로 다시 읽는다.
    return guarded(() => {
      const baseline = validatedBaseline(ws);
      // 사용자별 명부 규칙은 계산에만 쓰고, 초안에는 원래 전역 값을 되돌린다.
      const outcome = withRosterRules(ws, rosterRules, (target) => I.preview(target, source, { date, scopes: chosen }, ctx.user.displayName));
      const violations = outcome.draft ? draftViolations(baseline, outcome.draft, info) : [];
      const errors = [...outcome.errors, ...violations];
      const canApply = Boolean(outcome.canApply) && !violations.length;
      const saved = previews.put(session, revision, 'import', {
        draft: canApply ? outcome.draft : null,
        details: outcome.details,
        counts: outcome.counts,
        date: outcome.date,
      });
      const notes = [];
      if (droppedRows) notes.push(`접근 권한이 없거나 구역이 비어 있는 행 ${droppedRows}건은 제외했습니다.`);
      if (phoneCells) notes.push('연락처 열은 보안 정책상 읽지 않고 지웠습니다. 같은 이름 구분에는 인도자·구역·날짜를 사용합니다.');
      const outcomes = {};
      for (const d of outcome.details) {
        const k = `${d.sheet}|${d.outcome}`;
        outcomes[k] = (outcomes[k] ?? 0) + 1;
      }
      return redactDeep({
        importId: saved.id,
        expiresAt: saved.expiresAt,
        date: outcome.date,
        available: source.available,
        scopes: chosen,
        counts: outcome.counts,
        canApply,
        errors: errors.slice(0, 300),
        totalErrors: errors.length,
        warnings: outcome.warnings,
        totalWarnings: outcome.totalWarnings,
        issues: outcome.issues,
        outcomes: Object.entries(outcomes).map(([k, count]) => ({ sheet: k.split('|')[0], outcome: k.split('|')[1], count })),
        notes,
      });
    });
  }

  const scopesOf = (value) => (typeof value === 'string' ? value.split(',').filter((s) => SCOPE_KEYS.includes(s)) : []);
  const dateOf = (value) => (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : '');

  async function importFromConversion(ctx) {
    const revision = canonRevision(); // 비동기 작업 전에 정본 revision을 잡아 둔다.
    const info = scopeInfo(store, ctx.user);
    const saved = previews.get(sessionOf(ctx, info), ctx.body.conversionId, 'conversion');
    if (saved.revision !== revision) {
      previews.delete(ctx.body.conversionId);
      throw new HttpError(409, '변환 뒤 자료가 바뀌었습니다. 일보를 다시 변환해 주세요.');
    }
    const result = saved.data.result;
    const buffer = await guarded(() => legacy('daily-area-workbook.cjs').workbook(result));
    ctx.recheck();
    const scopes = Array.isArray(ctx.body.scopes) ? ctx.body.scopes.filter((s) => SCOPE_KEYS.includes(s)) : [];
    return importPreview(ctx, { buffer, fileName: `일보분석-${result.date}.xlsx`, date: result.date, scopes, rosterRules: saved.data.rosterRules, revision });
  }

  async function importFromFile(ctx) {
    const revision = canonRevision();
    const buffer = bufferOf(ctx);
    const name = String(ctx.query.get('name') ?? '').split(/[\\/]/).pop().slice(0, 200);
    const settings = savedSettings(ctx.user);
    return importPreview(ctx, {
      buffer,
      fileName: name,
      date: dateOf(ctx.query.get('date')),
      scopes: scopesOf(ctx.query.get('scopes')),
      rosterRules: { excludedText: settings.excludedText, aliasesText: settings.aliasesText },
      revision,
    });
  }

  /** 미리보기 초안 반영: 세션·구역 서명·정본 revision을 다시 확인한 뒤 commitWorkspace로만 반영한다. */
  const applyPreview = (kind, field) => async (ctx) => {
    const D = await domain();
    const info = scopeInfo(store, ctx.user);
    const id = ctx.body[field];
    const saved = previews.get(sessionOf(ctx, info), id, kind);
    if (!saved.data.draft) throw new HttpError(400, '오류가 있거나 바뀌는 내용이 없어 반영할 수 없는 미리보기입니다.');
    if (canonRevision() !== saved.revision) {
      previews.delete(id);
      throw new HttpError(409, '그 사이 자료가 바뀌었습니다. 다시 변환하고 미리보기를 확인해 주세요.');
    }
    ctx.recheck();
    await guarded(() => D.commitWorkspace(store, ctx.user, saved.data.draft));
    previews.delete(id);
    return { applied: true, date: saved.data.date, counts: saved.data.counts };
  };

  function details(ctx) {
    const info = scopeInfo(store, ctx.user);
    const saved = previews.get(sessionOf(ctx, info), ctx.params[0], 'import');
    const page = Number.parseInt(ctx.query.get('page'), 10) || 1;
    return guarded(() => redactDeep(legacy('daily-area-import.cjs').detailsPage(saved.data.details, {
      sheet: String(ctx.query.get('sheet') ?? ''),
      outcome: String(ctx.query.get('outcome') ?? ''),
      page,
    })));
  }

  /** 활동 공지(타임 활동 안내 글) → 활동기록 행 */
  async function notice(ctx) {
    const D = await domain();
    const info = scopeInfo(store, ctx.user);
    const session = sessionOf(ctx, info);
    const { text } = ctx.body;
    if (typeof text !== 'string' || !text.trim()) throw new HttpError(400, '활동 공지 원문을 붙여넣어 주세요.');
    if (text.length > MAX_TEXT) throw new HttpError(400, '활동 공지 원문이 너무 깁니다.');
    const date = dateOf(ctx.body.date);
    if (!date) throw new HttpError(400, '보고일을 선택해 주세요.');
    return guarded(() => {
      const revision = canonRevision();
      const view = viewClone(D.scopedWorkspace(store, ctx.user), info);
      let dropped = 0;
      const lines = text.split(/\r?\n/).filter((line) => {
        const m = /^\s*(\d+구역)\s*[/／]/.exec(line);
        if (!m || m[1] === '0구역' || info.admin || info.keys.has(districtKey(m[1]))) return true;
        dropped++;
        return false;
      });
      const result = legacy('activity-notices.cjs').preview(view, lines.join('\n'), { date });
      const saved = previews.put(session, revision, 'notice', { rows: result.activityRows, date: result.date });
      return redactDeep({
        noticeId: saved.id,
        expiresAt: saved.expiresAt,
        date: result.date,
        counts: result.counts,
        errors: result.errors.slice(0, 300),
        warnings: result.warnings.slice(0, 300),
        headers: [...NOTICE_HEADERS, '타임'],
        rows: result.activityRows.slice(0, ROW_LIMIT).map((r) => [...NOTICE_HEADERS.map((h) => cellOut(r[h])), cellOut(r._타임)]),
        total: result.activityRows.length,
        droppedLines: dropped,
      });
    });
  }

  async function noticeWorkbook(ctx) {
    const info = scopeInfo(store, ctx.user);
    const saved = previews.get(sessionOf(ctx, info), ctx.params[0], 'notice');
    const buffer = await guarded(() => legacy('activity-notices.cjs').workbook(saved.data.rows));
    ctx.recheck();
    return xlsxResponse(`smoa-activity-notice-${saved.data.date.replaceAll('-', '')}.xlsx`, buffer);
  }

  /** 기존 텍스트·변경 건 입력의 공통 입력 검사. 구역을 고른 경우 반드시 접근 권한을 확인한다(403). */
  function textInput(body, info, { regionRequired = false, dateRequired = false } = {}) {
    const { text } = body;
    if (typeof text !== 'string' || !text.trim()) throw new HttpError(400, '일보 원문을 붙여넣어 주세요.');
    if (text.length > SMALL_TEXT) throw new HttpError(400, `일보 원문은 ${SMALL_TEXT.toLocaleString('ko-KR')}자 이내로 입력해 주세요.`);
    const region = typeof body.region === 'string' ? body.region.trim() : '';
    if (region.length > 60) throw new HttpError(400, '구역 이름이 너무 깁니다.');
    if (regionRequired && !region) throw new HttpError(400, '구역을 선택해 주세요.');
    if (region && !inScope(info, region)) throw new HttpError(403, '접근 권한이 없는 구역입니다.');
    const rawDate = typeof body.date === 'string' ? body.date.trim() : '';
    if (rawDate && !dateOf(rawDate)) throw new HttpError(400, '보고일을 확인해 주세요.');
    if (dateRequired && !rawDate) throw new HttpError(400, '보고일을 선택해 주세요.');
    if (!info.admin) {
      // 구성원을 찾지 못해 행이 만들어지지 않더라도, 원문이 권한 밖 구역을 가리키면 거부한다(파서와 같은 제목 규칙).
      for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim().replace(/^[\p{Extended_Pictographic}️\s<>❗]+/u, '').replace(/[<>]$/g, '');
        const m = /^(?:구역\s*[:：]\s*)?([^\s]+구역)(?:\s*일일보고)?$/u.exec(line);
        if (m && !info.keys.has(districtKey(m[1]))) throw new HttpError(403, '접근 권한이 없는 구역의 일보가 들어 있습니다.');
      }
    }
    return { text, region, date: rawDate };
  }

  /** 원문에서 읽은 행의 구역이 모두 접근 권한 안인지 확인한다. 한 곳이라도 밖이면 403. */
  function assertRowsInScope(info, rows) {
    for (const row of rows) {
      if (row.구역 && !inScope(info, row.구역)) throw new HttpError(403, '접근 권한이 없는 구역의 일보가 들어 있습니다.');
    }
  }

  const reviewKeys = (extra = []) => [...legacy('daily.cjs').HEADERS.찾기일보.filter((h) => !REVIEW_LOCKED.has(h)), ...extra];
  const reviewTable = (rows, headers) => ({
    headers: headers.map(cleanHeader),
    keys: headers,
    rows: rows.slice(0, ROW_LIMIT).map((r) => headers.map((h) => cellOut(r[h]))),
    reviews: rows.slice(0, ROW_LIMIT).map((r) => (Array.isArray(r._review) ? r._review.map(String) : [])),
    total: rows.length,
    editable: rows.length <= REVIEW_MAX_ROWS,
  });

  /** 기존 텍스트 일보: 원문 → 활동·찾기 행 미리보기 → (오류 없을 때) 초안을 서버에 보관, 반영은 text-apply에서만. */
  async function textPreview(ctx) {
    const D = await domain();
    const info = scopeInfo(store, ctx.user);
    const session = sessionOf(ctx, info);
    const { text, region, date } = textInput(ctx.body, info);
    ctx.recheck();
    return guarded(() => {
      const revision = canonRevision();
      const ws = D.scopedWorkspace(store, ctx.user);
      const L = legacy('daily.cjs');
      const context = { date, region };
      const parsed = L.parse(text, ws, context);
      assertRowsInScope(info, [...parsed.rows.활동일보, ...parsed.rows.찾기일보]);
      const editable = reviewKeys();
      const findings = reviewRows(parsed.rows.찾기일보, ctx.body.findings, editable);
      const baseline = validatedBaseline(ws);
      const result = L.previewText(ws, text, ctx.user.displayName, findings ? { ...context, findings } : context);
      const violations = draftViolations(baseline, result.draft, info);
      const errors = [...result.errors, ...violations];
      const canApply = !errors.length && result.draft.revision !== ws.revision;
      const reportDate = result.rows.찾기일보[0]?.보고일 ?? result.rows.활동일보[0]?.활동일 ?? date;
      const saved = previews.put(session, revision, 'text', { draft: canApply ? result.draft : null, counts: result.counts, date: String(reportDate ?? '') });
      return redactDeep({
        previewId: saved.id,
        expiresAt: saved.expiresAt,
        date: String(reportDate ?? ''),
        counts: result.counts,
        canApply,
        errors: errors.slice(0, 300),
        totalErrors: errors.length,
        warnings: result.warnings.slice(0, 300),
        activity: tableRows(L.HEADERS.활동일보, result.rows.활동일보),
        findings: reviewTable(result.rows.찾기일보, L.HEADERS.찾기일보),
        editableKeys: editable,
      });
    });
  }

  /** 기존 찾기 일보 변경 건(신규 찾B·단계 향상·탈락): 미리보기와 엑셀 2종. 디렉터리 보관과 누적 통합문서는 다루지 않는다. */
  async function changesPreview(ctx) {
    const D = await domain();
    const info = scopeInfo(store, ctx.user);
    const session = sessionOf(ctx, info);
    const { text, region, date } = textInput(ctx.body, info, { regionRequired: true, dateRequired: true });
    ctx.recheck();
    return guarded(() => {
      const revision = canonRevision();
      const ws = D.scopedWorkspace(store, ctx.user);
      const C = legacy('daily-changes.cjs');
      const parsed = legacy('daily.cjs').parse(text, ws, { date, region, activityText: '', changesOnly: true });
      assertRowsInScope(info, parsed.rows.찾기일보);
      const editable = reviewKeys(['교사', '사유']);
      const findings = reviewRows(parsed.rows.찾기일보, ctx.body.findings, editable);
      const result = C.preview(ws, text, findings ? { date, region, findings } : { date, region });
      const ok = !result.errors.length && result.newRows.length + result.updateRows.length > 0;
      const clean = (rows) => rows.map((r) => redactDeep(Object.fromEntries(Object.entries(r).filter(([k]) => !PHONE_KEY.test(k)))));
      const newRows = clean(result.newRows);
      const updateRows = clean(result.updateRows);
      const saved = previews.put(session, revision, 'changes', { ok, newRows, updateRows, date: result.date });
      return redactDeep({
        changesId: saved.id,
        expiresAt: saved.expiresAt,
        date: result.date,
        region: result.region,
        counts: result.counts,
        errors: result.errors.slice(0, 300),
        totalErrors: result.errors.length,
        warnings: result.warnings.slice(0, 300),
        canExport: ok,
        findings: reviewTable(result.findings, [...legacy('daily.cjs').HEADERS.찾기일보, '교사', '사유']),
        editableKeys: editable,
        newTable: tableRows(C.NEW_HEADERS, newRows),
        updateTable: tableRows(C.UPDATE_HEADERS.filter((h) => !PHONE_KEY.test(h)), updateRows),
      });
    });
  }

  async function changesWorkbook(ctx) {
    const info = scopeInfo(store, ctx.user);
    const saved = previews.get(sessionOf(ctx, info), ctx.params[0], 'changes');
    const kind = ctx.query.get('kind');
    if (kind !== 'new' && kind !== 'update') throw new HttpError(400, '내려받을 파일 종류를 확인해 주세요.');
    if (!saved.data.ok) throw new HttpError(400, '오류가 있거나 내보낼 변경 건이 없습니다.');
    const rows = kind === 'new' ? saved.data.newRows : saved.data.updateRows;
    if (!rows.length) throw new HttpError(400, '해당하는 변경 건이 없습니다.');
    const buffer = await guarded(() => legacy('daily-changes.cjs').workbook(kind, rows));
    ctx.recheck();
    return xlsxResponse(`smoa-daily-changes-${kind}-${saved.data.date.replaceAll('-', '')}.xlsx`, buffer);
  }

  /** 기간별 활동·전도 분석: 구역 범위 안의 복제본만 집계하고 행 단위 자료는 싣지 않는다. */
  async function analytics(ctx) {
    const D = await domain();
    const info = scopeInfo(store, ctx.user);
    const M = legacy('model.cjs');
    return guarded(() => {
      const from = M.date(ctx.query.get('from') || '', false);
      const to = M.date(ctx.query.get('to') || '', false);
      const region = M.text(ctx.query.get('region') || '', 60);
      if (from && to && from > to) throw new HttpError(400, '조회 기간을 확인해 주세요.');
      if (region && !inScope(info, region)) throw new HttpError(403, '접근 권한이 없는 구역입니다.');
      ctx.recheck();
      const view = viewClone(D.scopedWorkspace(store, ctx.user), info);
      const a = legacy('daily.cjs').analytics(view, { from, to, region });
      const cap = (list) => list.slice(0, ROW_LIMIT);
      const workers = [...a.workers].sort((x, y) => y.minutes - x.minutes || String(x.name).localeCompare(String(y.name), 'ko'));
      return redactDeep({
        filters: { from, to, region },
        reports: a.reports,
        reportedNew: a.reportedNew,
        retained: a.retained,
        dropped: a.dropped,
        creations: a.creations,
        activityCount: a.activities.length,
        activityMinutes: a.activities.reduce((sum, x) => sum + (Number(x.minutes) || 0), 0),
        totalWorkers: workers.length,
        workers: cap(workers).map(({ name, region: area, days, minutes, count, unknownTimeCount }) => ({ name, region: area, days, minutes, count, unknownTimeCount })),
        byWorker: cap(a.byWorker),
        byHour: cap(a.byHour),
        byRegion: cap(a.byRegion),
        byClass: cap(a.byClass),
        dimensions: Object.fromEntries(Object.entries(a.dimensions).map(([k, list]) => [k, cap(list)])),
      });
    });
  }

  return [
    {
      method: 'GET',
      path: '/api/daily/info',
      screen: 'daily',
      action: 'read',
      handler: async (ctx) => {
        const ws = await workspaceFor(ctx);
        const L = legacy('daily-area-slash-layouts.cjs');
        const O = legacy('organization.cjs');
        const info = scopeInfo(store, ctx.user);
        const view = viewClone(ws, info);
        return redactDeep({
          year: Number(seoulDate(store.now()).slice(0, 4)),
          today: seoulDate(store.now()),
          areas: O.get(view).nodes.filter((n) => n.active && /지역/.test(n.type) && !/구역/.test(n.type)).map((n) => ({ id: n.id, name: n.name })),
          districts: info.districts.map((d) => d.name),
          stages: L.stages,
          fieldLabels: Object.values(L.fieldLabels),
          defaultLayouts: L.describeLayouts().defaults,
          settings: savedSettings(ctx.user),
          maxTextLength: MAX_TEXT,
          maxSmallTextLength: SMALL_TEXT,
          reviewMaxRows: REVIEW_MAX_ROWS,
        });
      },
    },
    {
      method: 'PUT',
      path: '/api/daily/settings',
      screen: 'daily',
      action: 'write',
      handler: (ctx) => guarded(() => {
        const settings = compileSettings(ctx.body);
        settingsByUser.set(ctx.user.id, settings.clean);
        return { settings: settings.clean };
      }),
    },
    { method: 'POST', path: '/api/daily/convert', screen: 'daily', action: 'read', handler: convert },
    { method: 'GET', path: '/api/daily/conversions/:id/workbook', screen: 'daily', action: 'export', handler: conversionWorkbook },
    { method: 'POST', path: '/api/daily/import-preview', screen: 'daily', action: 'write', handler: importFromConversion },
    { method: 'POST', path: '/api/daily/import-file', screen: 'daily', action: 'write', binary: true, handler: importFromFile },
    { method: 'GET', path: '/api/daily/imports/:id/details', screen: 'daily', action: 'read', handler: details },
    { method: 'POST', path: '/api/daily/apply', screen: 'daily', action: 'write', handler: applyPreview('import', 'importId') },
    { method: 'POST', path: '/api/daily/text-preview', screen: 'daily', action: 'read', handler: textPreview },
    { method: 'POST', path: '/api/daily/text-apply', screen: 'daily', action: 'write', handler: applyPreview('text', 'previewId') },
    { method: 'POST', path: '/api/daily/changes-preview', screen: 'daily', action: 'read', handler: changesPreview },
    { method: 'GET', path: '/api/daily/changes/:id/workbook', screen: 'daily', action: 'export', handler: changesWorkbook },
    { method: 'GET', path: '/api/daily/analytics', screen: 'daily', action: 'read', handler: analytics },
    { method: 'POST', path: '/api/daily/notice', screen: 'daily', action: 'read', handler: notice },
    { method: 'GET', path: '/api/daily/notices/:id/workbook', screen: 'daily', action: 'export', handler: noticeWorkbook },
    cumulativeRoute(store, { previews, scopeInfo, sessionOf, guarded, xlsxResponse, redact }),
  ];
}
