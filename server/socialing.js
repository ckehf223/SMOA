import { createRequire } from 'node:module';
import { scopeFor } from './permissions.js';
import { HttpError } from './security.js';
import { commitWorkspace, scopedWorkspace } from './domain.js';
import { areaStatus, cleanFields, deepClean, guard, pageOf, periodMeta, pick, stamp, tableWorkbook, text, xlsxResponse } from './calling.js';

/**
 * 소셜링 관리·통계 API.
 * 모임(프로그램)은 전체 공통이라 모든 허용 사용자가 볼 수 있고, 등록·수정은 관리자만 한다.
 * 외부유입은 담당 구역(구역 이름 → store.districts) 안에서만 등록·수정·전환할 수 있다.
 */

const require = createRequire(import.meta.url);
const Socialing = require('./legacy/socialing.cjs');
const Organization = require('./legacy/organization.cjs');

const STATUS_LABELS = { pending: '외부유입', linked: '찾B 이후', dropped: '탈락', reported: '일보 기록' };
const INTAKE_FIELDS = ['requestId', 'personId', 'programId', 'date', 'name', 'region', 'introducerId', 'notes'];
const LIST_LIMIT = 100;
const collator = new Intl.Collator('ko', { numeric: true });

/** 화면에 내보내는 필드만 고른다. 연락처는 이 자료에 없고 포함하지도 않는다. */
const socialRow = (r) => cleanFields({
  id: r.id ?? '',
  personId: r.personId ?? '',
  programId: r.programId ?? '',
  programName: r.programName ?? '',
  name: r.name ?? '',
  date: r.date ?? '',
  foundDate: r.foundDate ?? '',
  findADate: r.findADate ?? '',
  stage: r.stage ?? '',
  region: r.region ?? '',
  introducerId: r.introducerId ?? '',
  worker: r.worker ?? '',
  notes: r.notes ?? '',
  status: r.status ?? '',
}, ['programName', 'name', 'region', 'worker', 'notes', 'stage']);

const programList = (programs) => programs.map((p) => ({ id: p.id, name: p.name }));

export function socialingRoutes(store) {
  const readWs = (ctx) => scopedWorkspace(store, ctx.user);
  const isAdmin = (ctx) => ctx.user.role === 'admin';
  const actorOf = (ctx) => ctx.user.displayName;

  function mutate(ctx, apply) {
    return guard(() => {
      const ws = readWs(ctx);
      const out = apply(ws);
      if (out !== false) commitWorkspace(store, ctx.user, ws);
      return out;
    });
  }

  /** 조회 조건에 담당 밖 구역이 들어오면 거부한다(자료는 이미 범위로 제한되지만 명시적으로 막는다). */
  function checkRegion(ctx, region) {
    if (!region || isAdmin(ctx)) return;
    if (areaStatus(store, scopeFor(store, ctx.user), region) === 'out') throw new HttpError(403, '담당 구역이 아닙니다.');
  }

  function queryOf(ctx, keys) {
    const input = {};
    for (const key of keys) input[key] = ctx.query.get(key) ?? '';
    checkRegion(ctx, input.region);
    return guard(() => Socialing.query(readWs(ctx), input));
  }

  /** 새로 만들거나 바뀐 외부유입의 구역이 담당 구역인지 저장 전에 확인한다. */
  function checkIntakeScope(ctx, ws, before) {
    if (isAdmin(ctx)) return;
    const scope = scopeFor(store, ctx.user);
    for (const entry of ws.socialing?.pending ?? []) {
      if (before.get(entry.id) === JSON.stringify(entry)) continue;
      if (areaStatus(store, scope, entry.region) !== 'in') {
        throw new HttpError(403, '담당 구역의 외부유입만 등록·수정할 수 있습니다. 구역을 확인해 주세요.');
      }
    }
  }

  const snapshot = (ws) => new Map((ws.socialing?.pending ?? []).map((e) => [e.id, JSON.stringify(e)]));

  function saveIntake(ctx, id) {
    const input = { ...pick(ctx.body, INTAKE_FIELDS), ...(id ? { id } : {}) };
    return mutate(ctx, (ws) => {
      const before = snapshot(ws);
      const result = Socialing.saveIntake(ws, input, actorOf(ctx));
      checkIntakeScope(ctx, ws, before);
      return result;
    });
  }

  const requireAdmin = (ctx) => {
    if (!isAdmin(ctx)) throw new HttpError(403, '소셜링 모임의 등록·수정은 관리자만 할 수 있습니다.');
  };

  const rosterRows = (q) => q.rows.map(socialRow);
  const pct = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : '');
  const ROSTER_KEYS = ['from', 'to', 'programId', 'search', 'status', 'region'];
  const STATS_KEYS = ['from', 'to', 'programId', 'region'];

  return [
    {
      method: 'GET',
      path: '/api/socialing/roster',
      screen: 'socialingManage',
      action: 'read',
      handler: (ctx) => {
        const q = queryOf(ctx, ROSTER_KEYS);
        const page = pageOf(rosterRows(q), ctx.query);
        return { ...page, programs: deepClean(programList(q.programs)).map((p, i) => ({ ...p, id: q.programs[i].id })), regions: deepClean(q.regions), period: periodMeta(store) };
      },
    },
    {
      method: 'GET',
      path: '/api/socialing/roster/export',
      screen: 'socialingManage',
      action: 'export',
      handler: async (ctx) => {
        const rows = rosterRows(queryOf(ctx, ROSTER_KEYS));
        const body = await tableWorkbook([
          {
            name: '소셜링 명단',
            headers: ['이름', '모임', '유입일', '찾은 날짜', '찾A 날짜', '현재 단계', '구역', '인도자', '진행상태', '메모'],
            rows: rows.map((r) => [r.name, r.programName || '모임 미지정', r.date, r.foundDate, r.findADate, r.stage, r.region, r.worker, STATUS_LABELS[r.status] ?? '', r.notes]),
            widths: [18, 18, 12, 12, 12, 14, 12, 16, 12, 40],
          },
        ]);
        ctx.recheck();
        return xlsxResponse(`smoa-socialing-roster-${stamp(store)}.xlsx`, body);
      },
    },
    {
      method: 'GET',
      path: '/api/socialing/stats',
      screen: 'socialingStats',
      action: 'read',
      handler: (ctx) => {
        const q = queryOf(ctx, STATS_KEYS);
        // groups에는 모임 ID가 들어 있어 이름·구역만 가린다. 통계 값에는 식별자가 없다.
        return {
          programs: deepClean(programList(q.programs)).map((p, i) => ({ ...p, id: q.programs[i].id })),
          totals: q.totals,
          groups: q.groups.map((g) => cleanFields(g, ['programName'])),
          trend: q.trend,
          regions: deepClean(q.regions),
          period: periodMeta(store),
        };
      },
    },
    {
      method: 'GET',
      path: '/api/socialing/stats/export',
      screen: 'socialingStats',
      action: 'export',
      handler: async (ctx) => {
        const q = queryOf(ctx, STATS_KEYS);
        const body = await tableWorkbook([
          {
            name: '요약',
            headers: ['항목', '값'],
            rows: [['신규 외부유입', q.totals.inflows], ['찾B 실적', q.totals.findings], ['찾A 실적', q.totals.findAs], ['유입 중 전환', q.totals.converted], ['미전환', q.totals.pending], ['전환율(%)', pct(q.totals.conversionRate)]],
            widths: [20, 14],
          },
          {
            name: '모임별',
            headers: ['모임', '신규 유입', '유입 중 전환', '미전환', '전환율(%)', '찾B 실적', '찾A 실적'],
            rows: q.groups.map((g) => [g.programName, g.inflows, g.converted, g.pending, pct(g.conversionRate), g.findings, g.findAs]),
            widths: [20, 12, 12, 10, 12, 12, 12],
          },
          { name: '월별', headers: ['월', '신규 유입', '찾B', '찾A'], rows: q.trend.map((t) => [t.month, t.inflows, t.findings, t.findAs]) },
        ]);
        ctx.recheck();
        return xlsxResponse(`smoa-socialing-stats-${stamp(store)}.xlsx`, body);
      },
    },
    {
      method: 'POST',
      path: '/api/socialing/programs',
      screen: 'socialingManage',
      action: 'write',
      handler: (ctx) => {
        requireAdmin(ctx);
        const input = pick(ctx.body, ['name']);
        return { saved: mutate(ctx, (ws) => Socialing.saveProgram(ws, input, actorOf(ctx))) !== false };
      },
    },
    {
      method: 'PUT',
      path: '/api/socialing/programs/:id',
      screen: 'socialingManage',
      action: 'write',
      handler: (ctx) => {
        requireAdmin(ctx);
        const input = { ...pick(ctx.body, ['name']), id: ctx.params[0] };
        return { saved: mutate(ctx, (ws) => Socialing.saveProgram(ws, input, actorOf(ctx))) !== false };
      },
    },
    {
      method: 'POST',
      path: '/api/socialing/intakes',
      screen: 'socialingManage',
      action: 'write',
      handler: (ctx) => ({ saved: saveIntake(ctx, '') !== false }),
    },
    {
      method: 'PUT',
      path: '/api/socialing/intakes/:id',
      screen: 'socialingManage',
      action: 'write',
      handler: (ctx) => ({ saved: saveIntake(ctx, ctx.params[0]) !== false }),
    },
    {
      method: 'DELETE',
      path: '/api/socialing/intakes/:id',
      screen: 'socialingManage',
      action: 'write',
      handler: (ctx) => {
        mutate(ctx, (ws) => Socialing.removeIntake(ws, { id: ctx.params[0] }, actorOf(ctx)));
        return { deleted: true };
      },
    },
    {
      method: 'GET',
      path: '/api/socialing/intakes/:id/candidates',
      screen: 'socialingManage',
      action: 'write',
      handler: (ctx) => {
        const ws = readWs(ctx);
        const intake = (ws.socialing?.pending ?? []).find((e) => e.id === ctx.params[0]);
        if (!intake) throw new HttpError(404, '외부유입 기록을 찾을 수 없습니다.');
        const items = ws.people
          .filter((p) => (p.classification2 === '소셜링' || p.socialing) && !p.socialing?.date && !p.dateUnknown && p.date >= intake.date)
          .sort((a, b) => collator.compare(a.name, b.name))
          .slice(0, LIST_LIMIT)
          .map((p) => ({ id: p.id, name: p.name, region: p.region ?? '', date: p.date, code: p.code ?? '' }));
        return { items, intakeDate: intake.date };
      },
    },
    {
      method: 'POST',
      path: '/api/socialing/intakes/:id/promote',
      screen: 'socialingManage',
      action: 'write',
      handler: (ctx) => {
        const input = { id: ctx.params[0], personId: text(ctx.body.personId), date: text(ctx.body.date) };
        return { saved: mutate(ctx, (ws) => Socialing.promote(ws, input, actorOf(ctx))) !== false };
      },
    },
    {
      method: 'GET',
      path: '/api/socialing/introducers',
      screen: 'socialingManage',
      action: 'write',
      handler: (ctx) => {
        const ws = readWs(ctx);
        const org = Organization.get(ws);
        const search = (ctx.query.get('search') ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, '');
        const regionOf = (m) => {
          try {
            return Organization.regionOf(org, m.unitId);
          } catch {
            return '';
          }
        };
        const items = org.members
          .filter((m) => m.status === 'active' && (!search || String(m.name).normalize('NFKC').toLowerCase().replace(/\s+/g, '').includes(search)))
          .sort((a, b) => collator.compare(a.name, b.name))
          .slice(0, LIST_LIMIT)
          .map((m) => ({ id: m.id, name: m.name, region: regionOf(m) }));
        return { items };
      },
    },
  ];
}
