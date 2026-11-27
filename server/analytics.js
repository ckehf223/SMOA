import { scopedWorkspace } from './domain.js';
import { checkRegion, guard, legacy, pick, redact, sheetBuffer, todayOf, weekStartOf, xlsxResponse } from './records.js';

/**
 * 분석 화면 API (화면 id: findingStats, regionData, memberData, classData, diagnostics, stagePerformance).
 * 계산은 모두 요청자 구역으로 잘린 scopedWorkspace 사본에서 하고, 요청에 담긴 구역 조건도 배정 범위를 다시 확인한다.
 * 응답과 엑셀에는 연락처 원문이 없다. (redact: 끝 네 자리만)
 */

const COMMON = ['from', 'to', 'region', 'classification2'];

/** 분류2는 항상 명시한다. (빠지면 기존 계산이 노방만 본다.) */
function common(store, ctx, extra = []) {
  const input = pick(ctx.query, [...COMMON, ...extra], 100);
  checkRegion(store, ctx, input.region);
  return { ...input, classification2: input.classification2 ?? '' };
}

function filterOptions(ws) {
  const K = legacy('codes');
  const M = legacy('model');
  const list = (key) => K.options(ws, key).map(([value, label]) => ({ value, label }));
  return { classes: list('className'), employments: list('employment'), classification2: M.PERSON_CLASSIFICATIONS.classification2 };
}

/**
 * 조회 기간 바로가기(금주·금월·전체). 주 시작 요일은 서버 설정을 따르고, 끝날은 오늘을 넘지 않게 맞춘다.
 * 화면이 요일 규칙을 따로 알 필요가 없도록 응답에 함께 담는다.
 */
function periodPresets(store, ctx) {
  const today = todayOf(store);
  const weekStart = weekStartOf(store, ctx.query);
  const { calendarRange } = legacy('regional-analytics');
  const upToToday = ({ from, to }) => ({ from, to: to > today ? today : to });
  return [
    { label: '금주', ...upToToday(calendarRange(today, 'week', weekStart)) },
    { label: '금월', ...upToToday(calendarRange(today, 'month', weekStart)) },
    { label: '전체', from: '', to: '' },
  ];
}

/** 엑셀 응답: 만드는 동안 권한이 바뀌었는지 다시 확인한 뒤에만 내려 준다. */
async function workbookResponse(ctx, store, name, build) {
  const body = await build();
  ctx.recheck();
  return xlsxResponse(body, name, store);
}

/* ---------- 찾기·주관자 통계 ---------- */

function findingInput(store, ctx) {
  const input = common(store, ctx, ['statsLeaderEmployment']);
  if (ctx.query.get('view') === 'leaders') input.leaderOverview = true;
  return input;
}

function findingSummary(store, ctx) {
  const ws = scopedWorkspace(store, ctx.user);
  const result = guard(() => legacy('finding-stats').summary(ws, findingInput(store, ctx)));
  return { ws, result };
}

/* ---------- 구역·개인·반 데이터 ---------- */

/**
 * 메뉴로 처음 열 때(원본 app.js의 첫 조건 = 금주) 화면은 period=week만 보낸다.
 * 이때 시작·종료일이 모두 비어 있으면 금주 바로가기와 같은 기간을 쓴다. 응답의 from/to로 화면이 폼을 채운다.
 * 날짜를 하나라도 보냈거나 period가 없으면(전체·상세 이동 포함) 받은 그대로 둔다.
 */
function performanceInput(store, ctx) {
  const input = common(store, ctx, ['statsMember', 'statsClass', 'statsEmployment']);
  if (ctx.query.get('period') === 'week' && !input.from && !input.to) {
    const week = periodPresets(store, ctx).find((p) => p.label === '금주');
    if (week) Object.assign(input, { from: week.from, to: week.to });
  }
  return input;
}

function performanceSummary(store, ctx, kind) {
  const ws = scopedWorkspace(store, ctx.user);
  const input = performanceInput(store, ctx);
  const result = guard(() => legacy('performance').summary(ws, input, kind));
  return { ws, input, result };
}

/**
 * 구역별 화면의 기간 비교·참여·시간대 지표는 result.districtOverview와 result.comparison에 이미 있다.
 * 둘 다 이 요청의 기간·구역·분류2·반·직업구분으로 계산하므로 날짜만 쓰는 별도 개요는 만들지 않는다.
 */
function performanceView(store, ctx, kind) {
  const { ws, result } = performanceSummary(store, ctx, kind);
  return redact({ ...result, options: filterOptions(ws), presets: periodPresets(store, ctx) });
}

/* ---------- 진단 ---------- */

function diagnosticsView(store, ctx) {
  const ws = scopedWorkspace(store, ctx.user);
  const q = pick(ctx.query, ['anchor', 'kind', 'venueRegion', 'venueWeekday'], 60);
  checkRegion(store, ctx, q.venueRegion);
  const input = { anchor: q.anchor, kind: q.kind, venueRegion: q.venueRegion ?? '', venueWeekday: q.venueWeekday ?? '', weekStart: weekStartOf(store, ctx.query) };
  const result = guard(() => legacy('diagnostics').summary(ws, input, todayOf(store)));
  return redact(result);
}

/** 진단 결과(이미 redact된 것)를 시트로 옮긴다. */
function diagnosticsWorkbook(d) {
  const blank = (v) => (v == null ? '' : v);
  const t = d.activity.totals;
  const q = d.activity.quality;
  return sheetBuffer([
    {
      name: '세 기간 비교',
      columns: [
        { header: '항목', key: 'title', width: 24 }, { header: '단위', key: 'unit', width: 10 }, { header: '이번', key: 'current' }, { header: '직전', key: 'previous' },
        { header: '변화', key: 'delta' }, { header: '표본', key: 'sample' }, { header: '판단', key: 'status', width: 12 }, { header: '설명', key: 'reason', width: 50 },
      ],
      rows: d.review.map((r) => ({ title: r.title, unit: r.unit, current: blank(r.current), previous: blank(r.previous), delta: blank(r.delta), sample: blank(r.sample), status: r.status, reason: r.reason })),
    },
    {
      name: '단계 도달 관찰',
      columns: [
        { header: '구간', key: 'label', width: 20 }, { header: '관찰 일수', key: 'days' }, { header: '도달률', key: 'rate' },
        { header: '도달 인원', key: 'reached' }, { header: '관찰 완료', key: 'mature' }, { header: '관찰 중', key: 'observing' },
      ],
      rows: d.windows.map((w) => ({ label: w.label, days: blank(w.days), rate: blank(w.rate), reached: blank(w.reached), mature: blank(w.mature), observing: blank(w.observing) })),
    },
    {
      name: '장소·시간대',
      columns: [
        { header: '장소', key: 'place', width: 24 }, { header: '시각', key: 'hour' }, { header: '활동 회차', key: 'sessions' }, { header: '고유 활동자', key: 'workers' },
        { header: '순인시간', key: 'hours' }, { header: '전체 찾기', key: 'findings' }, { header: '연결', key: 'matched' }, { header: '미연결', key: 'unmatched' }, { header: '건/인시간', key: 'perHour' },
      ],
      rows: d.activity.cells.map((c) => ({
        place: c.place || '장소 미입력', hour: c.hour == null ? '시각 미입력' : `${String(c.hour).padStart(2, '0')}시`, sessions: blank(c.sessions), workers: blank(c.workers),
        hours: blank(c.minutes == null ? null : c.minutes / 60), findings: blank(c.findings), matched: blank(c.matched), unmatched: blank(c.unmatched), perHour: blank(c.perHour),
      })),
    },
    {
      name: '반별 인력',
      columns: [
        { header: '반', key: 'label', width: 14 }, { header: '명부 인원', key: 'roster' }, { header: '전일자', key: 'fullTime' }, { header: '반일자', key: 'halfTime' },
        { header: '직장인', key: 'employed' }, { header: '기타', key: 'other' }, { header: '미입력', key: 'unknown' }, { header: '참여자', key: 'participants' },
        { header: '순인시간', key: 'streetHours' }, { header: '연결 찾기', key: 'matched' }, { header: '찾기', key: 'findings' }, { header: '관찰 완료', key: 'eligible' },
        { header: '도달', key: 'reached' }, { header: '관찰 중', key: 'pending' }, { header: '도달률', key: 'rate' },
      ],
      rows: d.staffing.rows.map((r) => ({
        label: /^\d+$/.test(r.label ?? '') ? `${r.label}반` : (r.label || '반 미입력'), roster: blank(r.roster), fullTime: blank(r.fullTime), halfTime: blank(r.halfTime),
        employed: blank(r.employed), other: blank(r.other), unknown: blank(r.unknown), participants: blank(r.participants), streetHours: blank(r.streetHours),
        matched: blank(r.matchedFindings), findings: blank(r.findings), eligible: blank(r.eligible), reached: blank(r.reached), pending: blank(r.pending), rate: blank(r.progressRate),
      })),
    },
    {
      name: '활동 기록 품질',
      columns: [
        { header: '기준 기간', key: 'period', width: 24 }, { header: '노방 인시간당 찾기', key: 'perHour', width: 18 }, { header: '활동 회차', key: 'sessions' },
        { header: '연결된 찾기', key: 'matched' }, { header: '연결 못한 찾기', key: 'unmatched' }, { header: '시간 겹침(분)', key: 'conflict' },
        { header: '시각 미입력', key: 'noTime' }, { header: '활동자 미입력', key: 'noWorker' }, { header: '장소 미입력', key: 'noPlace' },
      ],
      rows: [{
        period: `${d.period.from} ~ ${d.period.to}`, perHour: blank(t.perHour), sessions: blank(t.sessions), matched: blank(t.matched), unmatched: blank(t.unmatched),
        conflict: blank(q.conflictMinutes), noTime: blank(q.unknownActivityTime), noWorker: blank(q.unknownWorker), noPlace: blank(q.unknownActivityPlace),
      }],
    },
  ]);
}

/* ---------- 단계 실적(주간 8주 추이, 상세, 전일자) ---------- */

const STAGE_OPTIONS = ['from', 'to', 'region', 'statsClass', 'statsClassification2', 'source', 'trendEnd'];
const WORKBOOK_OPTIONS = ['stageView', 'grouping', 'strengthGroup', 'trendStage', 'trendDistrict', 'trendCompare'];

/**
 * 단계 실적의 구역 묶음 키. 구역이 비어 있는 기록은 '구역 미입력' 묶음으로 보이는데,
 * 이 묶음은 이미 요청자 범위로 잘린 자료에서만 만들어지므로 구역 배정 검사에서 제외한다.
 */
const MISSING_DISTRICT = '구역 미입력';
const checkDistrict = (store, ctx, value) => {
  if (value !== MISSING_DISTRICT) checkRegion(store, ctx, value);
};

function stageInput(store, ctx, extra = []) {
  const input = pick(ctx.query, [...STAGE_OPTIONS, ...extra], 100);
  checkRegion(store, ctx, input.region);
  if (ctx.query.get('grouping') === 'district') checkDistrict(store, ctx, input.group);
  for (const key of ['trendDistrict', 'trendCompare']) checkDistrict(store, ctx, input[key]);
  if (ctx.query.get('grouping') !== 'class') checkDistrict(store, ctx, input.strengthGroup);
  input.includeCurrent = ctx.query.get('includeCurrent') === 'true';
  return { ...input, weekStart: weekStartOf(store, ctx.query), asOf: todayOf(store) };
}

function stageSummary(store, ctx) {
  const ws = scopedWorkspace(store, ctx.user);
  const input = stageInput(store, ctx, WORKBOOK_OPTIONS);
  const result = guard(() => legacy('stage-performance').summary(ws, input));
  return { ws, input, result };
}

function stageDetails(store, ctx) {
  const ws = scopedWorkspace(store, ctx.user);
  const input = stageInput(store, ctx, ['grouping', 'group', 'stage']);
  return redact(guard(() => legacy('stage-performance').details(ws, input)));
}

function fullTimeSummary(store, ctx) {
  const ws = scopedWorkspace(store, ctx.user);
  const q = pick(ctx.query, ['anchor', 'region', 'search'], 60);
  checkRegion(store, ctx, q.region);
  return guard(() => legacy('full-time-performance').query(ws, { ...q, weekStart: weekStartOf(store, ctx.query), asOf: todayOf(store) }));
}

/* ---------- 라우트 ---------- */

const PERFORMANCE_VIEWS = [
  ['regionData', 'region-data', 'region'],
  ['memberData', 'member-data', 'member'],
  ['classData', 'class-data', 'class'],
];

export function analyticsRoutes(store) {
  const routes = [
    {
      method: 'GET', path: '/api/analytics/finding-stats', screen: 'findingStats', action: 'read',
      handler: (ctx) => {
        const { ws, result } = findingSummary(store, ctx);
        return redact({ ...result, options: filterOptions(ws), presets: periodPresets(store, ctx) });
      },
    },
    {
      method: 'GET', path: '/api/analytics/finding-stats/export', screen: 'findingStats', action: 'export',
      handler: (ctx) => workbookResponse(ctx, store, 'finding-stats', () => legacy('finding-stats').workbook(redact(findingSummary(store, ctx).result))),
    },

    { method: 'GET', path: '/api/analytics/diagnostics', screen: 'diagnostics', action: 'read', handler: (ctx) => diagnosticsView(store, ctx) },
    {
      method: 'GET', path: '/api/analytics/diagnostics/export', screen: 'diagnostics', action: 'export',
      handler: (ctx) => workbookResponse(ctx, store, 'diagnostics', () => diagnosticsWorkbook(diagnosticsView(store, ctx))),
    },

    { method: 'GET', path: '/api/analytics/stage-performance', screen: 'stagePerformance', action: 'read', handler: (ctx) => redact(stageSummary(store, ctx).result) },
    { method: 'GET', path: '/api/analytics/stage-performance/details', screen: 'stagePerformance', action: 'read', handler: (ctx) => stageDetails(store, ctx) },
    {
      method: 'GET', path: '/api/analytics/stage-performance/export', screen: 'stagePerformance', action: 'export',
      handler: (ctx) => {
        const { input, result } = stageSummary(store, ctx);
        const options = Object.fromEntries(WORKBOOK_OPTIONS.filter((k) => input[k]).map((k) => [k, input[k]]));
        return workbookResponse(ctx, store, input.stageView === 'trend' ? 'stage-trend' : 'stage-strength', () => legacy('stage-performance-workbook').workbook(redact(result), options));
      },
    },
    // 전일자(전일제) 전도현황은 기존 메뉴에서 개인별 데이터에 속하므로 개인별 데이터 권한으로 막는다.
    { method: 'GET', path: '/api/analytics/full-time', screen: 'memberData', action: 'read', handler: (ctx) => redact(fullTimeSummary(store, ctx)) },
    {
      method: 'GET', path: '/api/analytics/full-time/export', screen: 'memberData', action: 'export',
      handler: (ctx) => workbookResponse(ctx, store, 'full-time', () => legacy('full-time-performance').workbook(redact(fullTimeSummary(store, ctx)))),
    },
  ];
  for (const [kind, slug, label] of PERFORMANCE_VIEWS) {
    routes.push(
      { method: 'GET', path: `/api/analytics/${slug}`, screen: kind, action: 'read', handler: (ctx) => performanceView(store, ctx, kind) },
      {
        method: 'GET', path: `/api/analytics/${slug}/export`, screen: kind, action: 'export',
        handler: (ctx) => workbookResponse(ctx, store, `${label}-data`, () => legacy('performance').workbook(redact(performanceSummary(store, ctx, kind).result))),
      },
    );
  }
  return routes;
}
