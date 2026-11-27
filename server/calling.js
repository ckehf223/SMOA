import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
import { scopeFor } from './permissions.js';
import { HttpError } from './security.js';
import { seoulDate } from './people.js';
import { commitWorkspace, scopedWorkspace } from './domain.js';

/**
 * 콜링 관리·통계 API.
 * - 모든 라우트는 screen/action을 선언하고, 자료는 scopedWorkspace(사용자 구역 범위 복제본)로만 읽고 쓴다.
 * - 쓰기는 복제본에 기존 콜링 규칙(legacy/calling.cjs)을 적용한 뒤 commitWorkspace로 검증·병합한다.
 * - 엑셀·일보 가져오기는 서버가 만든 사용자별 미리보기(토큰)만 반영한다. 브라우저가 보낸 행은 신뢰하지 않는다.
 */

const require = createRequire(import.meta.url);
const Calling = require('./legacy/calling.cjs');
const CallingWorkbook = require('./legacy/calling-workbook.cjs');
const CallingReport = require('./legacy/calling-report.cjs');
const { PREVIEW_LIMIT } = require('./legacy/import-preview.cjs');

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const PAGE_SIZE = 20;
const PREVIEW_TTL_MS = 15 * 60_000;
const PAIR_LIMIT = 300;
const HANGUL = /[가-힣]/;

// ───────── 공용 도우미 (소셜링 API도 함께 사용한다) ─────────

/** 기존 규칙이 던진 일반 Error는 입력 오류(400)로 바꾼다. 프로그램 오류(TypeError 등)는 그대로 둔다. */
export function toHttp(error, fallback) {
  if (error instanceof HttpError) return error;
  if (error && error.constructor === Error) {
    return new HttpError(400, HANGUL.test(error.message) || !fallback ? error.message : fallback);
  }
  return error;
}

export function guard(fn, fallback) {
  try {
    return fn();
  } catch (error) {
    throw toHttp(error, fallback);
  }
}

export async function guardAsync(fn, fallback) {
  try {
    return await fn();
  } catch (error) {
    throw toHttp(error, fallback);
  }
}

const areaKey = (value) => String(value ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, '').replace(/^(\d+)구역$/, '$1');

/** 구역 이름(예: "1구역", "1")을 store.districts의 구역 ID로 바꾼다. 알 수 없으면 null. */
export function districtIdOfArea(store, area) {
  const key = areaKey(area);
  if (!key) return null;
  return store.districts.find((d) => areaKey(d.name) === key)?.id ?? null;
}

/** 'in' 담당 구역 / 'out' 담당 밖 구역 / 'unknown' 구역으로 읽을 수 없는 이름 */
export function areaStatus(store, scope, area) {
  const id = districtIdOfArea(store, area);
  if (!id) return 'unknown';
  return scope.has(id) ? 'in' : 'out';
}

export const scopeKey = (store, user) => [...scopeFor(store, user)].sort().join('|');

/** 지정한 필드만 골라 낸다(알 수 없는 필드와 id는 받지 않는다). */
export function pick(body, keys) {
  const out = {};
  for (const key of keys) if (body[key] !== undefined) out[key] = body[key];
  return out;
}

export const text = (value) => (typeof value === 'string' ? value : '');

// 전화번호처럼 보이는 숫자열(예: 010-1234-5678, 01012345678, +82 10 1234 5678)은 끝 네 자리만 남긴다.
const PHONE_LIKE = /(?<![\w-])\+?\d{2,4}[\s.-]?\d{3,4}[\s.-]?\d{4}(?![\d-])/g;

export function maskPhones(value) {
  if (typeof value !== 'string' || value.length < 9) return value;
  return value.replace(PHONE_LIKE, (match) => `***-${match.slice(-4)}`);
}

/** 자유 문구 필드만 골라 전화번호를 가린 사본을 만든다. id 같은 식별자는 건드리지 않는다. */
export function cleanFields(row, keys) {
  const out = { ...row };
  for (const key of keys) if (typeof out[key] === 'string') out[key] = maskPhones(out[key]);
  return out;
}

/** 통계처럼 식별자가 없는 응답 전체의 문자열을 가린다. */
export function deepClean(value) {
  if (typeof value === 'string') return maskPhones(value);
  if (Array.isArray(value)) return value.map(deepClean);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, deepClean(v)]));
  return value;
}

export function pageOf(rows, query) {
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const page = Math.min(pages, Math.max(1, Number.parseInt(query.get('page'), 10) || 1));
  return { total: rows.length, page, pages, pageSize: PAGE_SIZE, items: rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE) };
}

export function xlsxResponse(fileName, body) {
  return {
    raw: true,
    status: 200,
    headers: { 'Content-Type': XLSX_MIME, 'Content-Disposition': `attachment; filename="${fileName}"` },
    body,
  };
}

export const stamp = (store) => seoulDate(store.now()).replaceAll('-', '');

/**
 * 기간 단추(오늘·금주·금월·전체)가 쓰는 기준. 오늘은 한국 표준시 날짜, 주 시작 요일은 관리자 설정(0=일 … 6=토, 기본 0)이다.
 * 날짜 계산은 화면이 하지만 기준값은 서버가 알려 주므로 브라우저 시계·시간대와 무관하다.
 */
export function periodMeta(store) {
  const saved = store.settings?.weekStart;
  return { today: seoulDate(store.now()), weekStart: Number.isInteger(saved) && saved >= 0 && saved <= 6 ? saved : 0 };
}

const safeCell = (v) => (typeof v === 'string' && /^[=+\-@\t\r]/.test(v) ? `'${v}` : v);

/** 시트 목록({name, headers, rows})을 엑셀 파일로 만든다. 수식처럼 보이는 문자열은 무력화한다. */
export async function tableWorkbook(sheets) {
  const wb = new ExcelJS.Workbook();
  for (const sheet of sheets) {
    const ws = wb.addWorksheet(sheet.name);
    ws.columns = sheet.headers.map((header, i) => ({ header, width: sheet.widths?.[i] ?? 16 }));
    ws.getRow(1).font = { bold: true };
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    for (const row of sheet.rows) ws.addRow(row.map((v) => safeCell(maskPhones(v))));
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** 사용자별 미리보기 보관함. 사용자당 하나만 두고, 만료·구역 범위 변경·다른 사용자 접근을 거부한다. */
export class PreviewBox {
  constructor(store, ttlMs = PREVIEW_TTL_MS) {
    this.store = store;
    this.ttlMs = ttlMs;
    this.items = new Map();
  }

  sweep() {
    const now = this.store.now();
    for (const [token, item] of this.items) if (item.expires <= now) this.items.delete(token);
  }

  /** 소유 확인 값: 현재 로그인 세션 토큰 + 사용자 ID + 역할 + 담당 구역. 다시 로그인하면 이전 미리보기는 쓸 수 없다. */
  ownerKey(user, session) {
    return [session, user.id, user.role, scopeKey(this.store, user)].join('\n');
  }

  stage(user, session, data) {
    this.sweep();
    for (const [token, item] of this.items) if (item.userId === user.id) this.items.delete(token);
    const token = randomUUID();
    this.items.set(token, { ...data, userId: user.id, owner: this.ownerKey(user, session), expires: this.store.now() + this.ttlMs });
    return token;
  }

  clearFor(user) {
    for (const [token, item] of this.items) if (item.userId === user.id) this.items.delete(token);
  }

  get(user, session, token) {
    this.sweep();
    const item = typeof token === 'string' && typeof session === 'string' && session ? this.items.get(token) : undefined;
    if (!item || item.userId !== user.id || item.owner !== this.ownerKey(user, session)) {
      throw new HttpError(410, '미리보기가 만료되었거나 없습니다. 파일을 다시 선택해 미리보기를 만들어 주세요.');
    }
    return item;
  }

  drop(token) {
    this.items.delete(token);
  }
}

// ───────── 콜링 ─────────

const FREE_TEXT = ['personName', 'introducer', 'caller', 'result', 'originalResult', 'notes', 'roundLabel'];
const MAX_REPORT_TEXT = 300_000; // 라우터의 일보 본문 한도(1.25MiB) 안에서 한글 3바이트 기준으로 여유를 둔 글자 수
const ROUND_FIELDS = ['requestId', 'personId', 'caller', 'date', 'time', 'round', 'resultText', 'notes'];

function filtersOf(query, withRound) {
  const get = (key) => query.get(key) ?? '';
  return { search: get('search'), from: get('from'), to: get('to'), caller: get('caller'), ...(withRound ? { round: get('round') } : {}) };
}

/** 화면에 내보내는 필드만 고른다. 연락처 등 그 밖의 대상자 정보는 포함하지 않는다. */
const callingRow = (r) => cleanFields({
  id: r.id ?? '',
  sheet: r.sheet ?? '',
  line: r.row ?? 0,
  personId: r.personId ?? '',
  personName: r.personName ?? '',
  personCode: r.personCode ?? '',
  introducer: r.introducer ?? '',
  area: r.area ?? '',
  findingDate: r.findingDate ?? '',
  caller: r.caller ?? '',
  date: r.date ?? '',
  time: r.time ?? '',
  round: r.round,
  roundLabel: Calling.roundLabel(r.round),
  result: r.result ?? '',
  originalResult: r.originalResult ?? r.reportedResult ?? '',
  notes: r.notes ?? '',
  personDeleted: Boolean(r.personDeleted),
  personUnlinked: r.personUnlinked ?? !r.personId,
}, FREE_TEXT);

const cleanErrors = (errors = []) => errors.map((e) => cleanFields(e, ['message']));
const withRoundLabel = (r) => deepClean({ ...r, roundLabel: Calling.roundLabel(r.round) });
const roundOptions = (rounds) => rounds.map(([value, label]) => ({ value, label }));

export function callingRoutes(store) {
  const previews = new PreviewBox(store);
  const actorOf = (ctx) => ctx.user.displayName;
  const readWs = (ctx) => scopedWorkspace(store, ctx.user);
  const isAdmin = (ctx) => ctx.user.role === 'admin';

  /** 복제본에 변경을 적용하고 commitWorkspace로 검증·병합한다. 변경이 없으면(false) 저장하지 않는다. */
  function mutate(ctx, apply) {
    return guard(() => {
      const ws = readWs(ctx);
      const out = apply(ws);
      if (out !== false) commitWorkspace(store, ctx.user, ws);
      return out;
    });
  }

  /** 대상자 미연결 행은 담당 구역으로 읽히는 구역일 때만 남긴다. 나머지는 오류로 알린다. */
  function restrictUnlinked(ctx, result) {
    if (isAdmin(ctx)) return result;
    const scope = scopeFor(store, ctx.user);
    const rows = [];
    const errors = [...result.errors];
    let errorCount = result.errorCount;
    let unlinkedCount = result.unlinkedCount;
    for (const row of result.rows) {
      if (row.personId || areaStatus(store, scope, row.area) === 'in') {
        rows.push(row);
        continue;
      }
      errorCount++;
      unlinkedCount--;
      if (errors.length < PREVIEW_LIMIT) {
        errors.push({ sheet: row.sheet, row: row.row, message: `‘${row.personName}’ 기록의 구역이 담당 구역이 아니거나 확인되지 않습니다.` });
      }
    }
    return { ...result, rows, errors, errorCount, unlinkedCount, validCount: rows.length };
  }

  const previewReply = (result, extra) => {
    const { rows, ...summary } = result;
    return { ...summary, errors: cleanErrors(summary.errors), rows: rows.slice(0, PREVIEW_LIMIT).map(callingRow), ...extra };
  };

  async function previewWorkbook(ctx) {
    const buffer = ctx.body;
    if (!Buffer.isBuffer(buffer) || !buffer.length) throw new HttpError(400, '엑셀 파일을 선택해 주세요.');
    const migration = ctx.query.get('migration') === '1';
    previews.clearFor(ctx.user);
    const ws = readWs(ctx);
    const revision = store.workspace.revision; // 파일을 읽기 전에 원본 버전을 잡아 둔다.
    const loaded = await guardAsync(() => CallingWorkbook.preview(ws, buffer, { migration }), '엑셀 파일을 읽을 수 없습니다. 콜링 양식의 .xlsx 파일인지 확인해 주세요.');
    ctx.recheck(); // 읽는 동안 세션·권한이 바뀌었다면 결과를 돌려주지 않는다.
    const result = restrictUnlinked(ctx, loaded);
    const effectiveMigration = migration && !result.reportWorkbook;
    const canApply = !result.errorCount && result.validCount > 0;
    const token = canApply
      ? previews.stage(ctx.user, ctx.token, { revision, rows: result.rows, migration: effectiveMigration, source: result.reportWorkbook ? 'report' : 'excel' })
      : '';
    return previewReply(result, { migration, token, canApply, report: false });
  }

  function previewReport(ctx) {
    const body = ctx.body;
    previews.clearFor(ctx.user);
    const ws = readWs(ctx);
    const revision = store.workspace.revision;
    const date = text(body.date);
    if (text(body.text).length > MAX_REPORT_TEXT) throw new HttpError(400, `콜링 일보는 ${MAX_REPORT_TEXT.toLocaleString('ko-KR')}자까지 붙여넣을 수 있습니다. 나눠서 가져와 주세요.`);
    const parsed = guard(() => CallingReport.parse(text(body.text), { date, year: text(body.year) || (date ? '' : seoulDate(store.now()).slice(0, 4)), caller: text(body.caller) }));

    // 담당 밖 구역의 일보 행은 엑셀 저장 대상에서도 제외하고 오류로 알린다.
    const scope = scopeFor(store, ctx.user);
    const scopeErrors = [];
    const parsedRows = parsed.rows.filter((row) => {
      if (isAdmin(ctx) || areaStatus(store, scope, row.area) !== 'out') return true;
      scopeErrors.push({ sheet: row.sheet, row: row.row, message: `‘${row.area}’은(는) 담당 구역이 아닙니다.` });
      return false;
    });
    const matched = restrictUnlinked(ctx, guard(() => CallingWorkbook.previewRows(ws, parsedRows)));
    const errors = [...parsed.errors, ...scopeErrors, ...matched.errors].sort((a, b) => a.row - b.row);
    const parseErrors = parsed.errorCount + scopeErrors.length;
    const errorCount = parseErrors + matched.errorCount;
    const canExport = !parseErrors && parsedRows.length > 0;
    const canApply = !errorCount && matched.rows.length > 0;
    const dates = new Set(parsedRows.map((row) => row.date));
    const reportDate = dates.size === 1 ? parsedRows[0].date : '';
    const token = canExport || canApply
      ? previews.stage(ctx.user, ctx.token, { revision, rows: canApply ? matched.rows : [], reportRows: parsedRows, reportDate, migration: false, source: 'report' })
      : '';
    const byLine = new Map(matched.rows.map((row) => [row.row, row]));
    const shown = parsedRows.slice(0, PREVIEW_LIMIT).map((row) => callingRow(byLine.get(row.row) ?? row));
    const { rows: _rows, errors: _e, errorCount: _c, totalRows, ...summary } = matched;
    return {
      ...summary,
      rows: shown,
      errors: cleanErrors(errors.slice(0, PREVIEW_LIMIT)),
      errorCount,
      totalRows: parsed.totalRows ?? totalRows,
      report: true,
      reportDate,
      exportCount: parsedRows.length,
      canExport,
      canApply,
      token,
    };
  }

  function applyPreview(ctx) {
    const staged = previews.get(ctx.user, ctx.token, ctx.body.token);
    if (!staged.rows.length) throw new HttpError(400, '등록할 콜링 기록을 확인해 주세요.');
    const count = guard(() => {
      const ws = readWs(ctx);
      if (store.workspace.revision !== staged.revision) throw new HttpError(409, '미리보기 이후 자료가 바뀌었습니다. 파일을 다시 선택해 미리보기를 만들어 주세요.');
      if (!isAdmin(ctx)) {
        const scope = scopeFor(store, ctx.user);
        for (const row of staged.rows) {
          if (!row.personId && areaStatus(store, scope, row.area) !== 'in') throw new HttpError(403, '담당 구역이 아닌 기록은 반영할 수 없습니다.');
        }
      }
      const added = Calling.saveMany(ws, staged.rows, actorOf(ctx), { migration: staged.migration, source: staged.source });
      if (added > 0) commitWorkspace(store, ctx.user, ws);
      return added;
    });
    previews.drop(ctx.body.token);
    return { count };
  }

  function statsOf(ctx) {
    const ws = readWs(ctx);
    return guard(() => Calling.query(ws, { ...filtersOf(ctx.query, true), includeRows: false }));
  }

  const pct = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : '');

  return [
    {
      method: 'GET',
      path: '/api/calling/records',
      screen: 'callingManage',
      action: 'read',
      handler: (ctx) => {
        const ws = readWs(ctx);
        const filters = filtersOf(ctx.query, false);
        const q = guard(() => Calling.query(ws, { ...filters, includeRows: true }));
        const page = pageOf(q.rows, ctx.query);
        const connected = q.rows.filter((r) => r.result === '만픽');
        return {
          ...page,
          items: page.items.map(callingRow),
          callers: q.callers.map(maskPhones),
          rounds: roundOptions(q.rounds).map((o) => ({ ...o, label: maskPhones(o.label) })),
          totals: q.totals,
          period: periodMeta(store),
          report: {
            text: maskPhones(guard(() => Calling.reportText(ws, filters))),
            byRound: q.byRound.map(withRoundLabel),
            pairs: connected.slice(0, PAIR_LIMIT).map((r) => ({ caller: maskPhones(r.caller), introducer: maskPhones(r.introducer ?? '') })),
            pairsTotal: connected.length,
          },
        };
      },
    },
    {
      method: 'GET',
      path: '/api/calling/people',
      screen: 'callingManage',
      action: 'write',
      handler: (ctx) => ({ items: guard(() => Calling.people(readWs(ctx), { search: ctx.query.get('search') ?? '' })) }),
    },
    {
      method: 'POST',
      path: '/api/calling/records',
      screen: 'callingManage',
      action: 'write',
      handler: (ctx) => {
        const input = pick(ctx.body, ROUND_FIELDS);
        return { saved: mutate(ctx, (ws) => Calling.save(ws, input, actorOf(ctx))) !== false };
      },
    },
    {
      method: 'PUT',
      path: '/api/calling/records/:id',
      screen: 'callingManage',
      action: 'write',
      handler: (ctx) => {
        const id = ctx.params[0];
        const input = { ...pick(ctx.body, ROUND_FIELDS), id };
        return {
          saved: mutate(ctx, (ws) => {
            if (!ws.callingRecords?.some((r) => r.id === id)) throw new HttpError(404, '콜링 기록을 찾을 수 없습니다.');
            return Calling.save(ws, input, actorOf(ctx));
          }) !== false,
        };
      },
    },
    {
      method: 'DELETE',
      path: '/api/calling/records/:id',
      screen: 'callingManage',
      action: 'write',
      handler: (ctx) => {
        const id = ctx.params[0];
        mutate(ctx, (ws) => {
          if (!ws.callingRecords?.some((r) => r.id === id)) throw new HttpError(404, '콜링 기록을 찾을 수 없습니다.');
          Calling.remove(ws, { id }, actorOf(ctx));
        });
        return { deleted: true };
      },
    },
    {
      method: 'GET',
      path: '/api/calling/records/export',
      screen: 'callingManage',
      action: 'export',
      handler: async (ctx) => {
        const rows = guard(() => Calling.query(readWs(ctx), { ...filtersOf(ctx.query, false), includeRows: true }).rows);
        const body = await CallingWorkbook.createExport(rows.map((r) => cleanFields(r, FREE_TEXT)));
        ctx.recheck();
        return xlsxResponse(`smoa-calling-${stamp(store)}.xlsx`, body);
      },
    },
    {
      method: 'GET',
      path: '/api/calling/template',
      screen: 'callingManage',
      action: 'write',
      handler: async () => xlsxResponse('smoa-calling-template.xlsx', await CallingWorkbook.createTemplate()),
    },
    {
      method: 'POST',
      path: '/api/calling/import/preview',
      screen: 'callingManage',
      action: 'write',
      binary: true,
      handler: previewWorkbook,
    },
    {
      method: 'POST',
      path: '/api/calling/report/preview',
      screen: 'callingManage',
      action: 'read', // 저장 상태를 바꾸지 않는다. 엑셀 저장 토큰을 받는 유일한 경로라 읽기 권한으로 연다.
      handler: previewReport,
    },
    {
      method: 'POST',
      path: '/api/calling/import/apply',
      screen: 'callingManage',
      action: 'write',
      handler: applyPreview,
    },
    {
      method: 'POST',
      path: '/api/calling/report/export',
      screen: 'callingManage',
      action: 'export',
      handler: async (ctx) => {
        const staged = previews.get(ctx.user, ctx.token, ctx.body.token);
        if (!staged.reportRows?.length) throw new HttpError(400, '저장할 콜링 일보가 없습니다.');
        const body = await CallingWorkbook.createExport(staged.reportRows.map((r) => cleanFields(r, FREE_TEXT)), { report: true });
        ctx.recheck();
        return xlsxResponse(`smoa-calling-report-${staged.reportDate || stamp(store)}.xlsx`, body);
      },
    },
    {
      method: 'GET',
      path: '/api/calling/stats',
      screen: 'callingStats',
      action: 'read',
      handler: (ctx) => {
        const q = statsOf(ctx);
        return deepClean({
          totals: q.totals,
          missingTime: q.missingTime,
          byHour: q.byHour,
          byCaller: q.byCaller,
          byRound: q.byRound.map(withRoundLabel),
          byCallerHour: q.byCallerHour,
          byCallerRound: q.byCallerRound.map(withRoundLabel),
          lag: q.lag,
          callers: q.callers,
          rounds: roundOptions(q.rounds),
          period: periodMeta(store),
        });
      },
    },
    {
      method: 'GET',
      path: '/api/calling/stats/export',
      screen: 'callingStats',
      action: 'export',
      handler: async (ctx) => {
        const q = statsOf(ctx);
        const hour = (h) => `${String(h).padStart(2, '0')}:00-${String(h + 1).padStart(2, '0')}:00`;
        const counts = (r) => [r.count, r.successes, pct(r.rate)];
        const countHeads = ['콜링 건수', '만픽 건수', '만픽률(%)'];
        const body = await tableWorkbook([
          {
            name: '요약',
            headers: ['항목', '값'],
            rows: [['전체 콜링', q.totals.count], ['만픽', q.totals.successes], ['만픽률(%)', pct(q.totals.rate)], ['대상자 수', q.totals.targets], ['콜링자 수', q.totals.callerCount], ['시간 미입력', q.missingTime]],
            widths: [20, 14],
          },
          { name: '시간대별', headers: ['시간대', ...countHeads], rows: q.byHour.map((r) => [hour(r.hour), ...counts(r)]) },
          { name: '콜링자별', headers: ['콜링자', ...countHeads], rows: q.byCaller.map((r) => [r.caller, ...counts(r)]) },
          { name: '차수별', headers: ['차수', ...countHeads], rows: q.byRound.map((r) => [Calling.roundLabel(r.round), ...counts(r)]) },
          { name: '콜링자·시간대별', headers: ['콜링자', '시간대', ...countHeads], rows: q.byCallerHour.map((r) => [r.caller, hour(r.hour), ...counts(r)]) },
          { name: '콜링자·차수별', headers: ['콜링자', '차수', ...countHeads], rows: q.byCallerRound.map((r) => [r.caller, Calling.roundLabel(r.round), ...counts(r)]) },
          {
            name: '찾B 이후 소요일',
            headers: ['구분', '대상자 수', '비율(%)'],
            rows: [['평균(일)', pct(q.lag.average), ''], ['중앙값(일)', pct(q.lag.median), ''], ['80% 도달(일)', q.lag.p80 ?? '', ''], ...q.lag.within.map((w) => [w.days === 0 ? '당일' : `${w.days}일 이내`, w.count, pct(w.rate)])],
          },
        ]);
        ctx.recheck();
        return xlsxResponse(`smoa-calling-stats-${stamp(store)}.xlsx`, body);
      },
    },
  ];
}
