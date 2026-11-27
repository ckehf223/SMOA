import { h } from './common.js';
import { num } from './records.js';
import { countPlot, hourComparisonPlot, svgEl } from './analytics-charts.js';

/**
 * 구역별·개인별·반별 데이터와 전일자 전도현황의 본문.
 * 기존 SMOA 4.0.41 district-overview.js · performance.js · full-time-performance.js의 화면 순서·제목·표를 DOM으로 옮겼다.
 * 값은 모두 서버(GET /api/analytics/*-data, /api/analytics/full-time) 응답을 그대로 쓴다. 조회·폼은 analytics.js가 맡는다.
 * 막대 길이·색은 CSS 변수(style.setProperty)로만 넘긴다. (CSP: style 속성 문자열을 쓰지 않는다)
 */

for (const href of ['/assets/status.css', '/assets/performance.css']) {
  if (typeof document !== 'undefined' && !document.querySelector(`link[href="${href}"]`)) {
    document.head.append(h('link', { rel: 'stylesheet', href }));
  }
}

/* ---------- 원본 표기 규칙 ---------- */

const dash = '—';
const DAY = 86400000;
export const perfRate = (v) => (Number.isFinite(v) ? `${v.toFixed(2)}건` : dash);
export const perfPercent = (v) => (Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : dash);
export const perfTime = (minutes) => `${Math.floor((minutes ?? 0) / 60)}시간 ${Math.round((minutes ?? 0) % 60)}분`;
export const classificationLabel = (value) => (value === '__unclassified__' ? '미입력' : value || '전체 분류');
const count = (v) => num(v ?? 0);
const classLabel = (label) => (/^\d+$/.test(label ?? '') ? `${label}반` : label);
const byLabel = (a, b) => String(a.label ?? '').localeCompare(String(b.label ?? ''), 'ko', { numeric: true });

let uid = 0;
const nextId = (prefix) => `${prefix}-${++uid}`;

/* ---------- 작은 조각 ---------- */

/** 원본 .panel: 머리(제목·설명·오른쪽 조각) + 본문 */
function panel({ id, title, desc, extra, cls = '', tag = 'h2' }, ...body) {
  const titleId = id ? `${id}-title` : nextId('perf-title');
  return h('section', { class: `panel ${cls}`.trim(), id, 'aria-labelledby': titleId },
    h('div', { class: 'panel-head' }, h('div', null, h(tag, { id: titleId }, title), desc ? h('p', null, desc) : null), extra),
    ...body);
}
const panelBody = (...kids) => h('div', { class: 'panel-body' }, ...kids);
const tinyNote = (...kids) => h('div', { class: 'panel-body tiny' }, ...kids);
const emptyBox = (text) => h('div', { class: 'empty' }, text);
const emptyPanel = (text) => h('div', { class: 'panel' }, emptyBox(text));

/** 표 전용 가로·세로 스크롤 영역 */
function scroll(label, table, cls = '') {
  return h('div', { class: `table-scroll ${cls}`.trim(), tabindex: '0', role: 'region', 'aria-label': label }, table);
}
const colHead = (column) => (typeof column === 'string'
  ? h('th', { scope: 'col' }, column)
  : h('th', { scope: 'col', class: column.numeric ? 'numeric' : null, 'aria-label': column.aria ?? null }, column.label));
const rowHead = (content, attrs) => h('th', { scope: 'row', ...attrs }, content);
const cell = (content, numeric = false, attrs) => h('td', { class: numeric ? 'numeric' : null, ...attrs }, content);
const emptyRow = (columns, text) => h('tr', null, h('td', { colspan: String(columns) }, text));

/** 막대 길이(0~100%)를 CSS 변수로 넘긴다. */
function withPercent(el, percent) {
  el.style.setProperty('--percent', `${Math.max(0, Math.min(100, Number.isFinite(percent) ? percent : 0))}%`);
  return el;
}

function metric(label, value, foot) {
  return h('article', { class: 'metric' },
    h('div', { class: 'metric-head' }, label), h('div', { class: 'metric-value' }, value), h('div', { class: 'metric-foot' }, foot));
}

/** 그래프는 좁은 화면에서 영역 안에서만 가로로 스크롤한다. */
const plotScroll = (label, plot) => h('div', { class: 'perf-plot-scroll', tabindex: '0', role: 'region', 'aria-label': label }, plot);

/* =====================================================================
 * 구역별 데이터 (district-overview.js)
 * ===================================================================== */

const districtLevel = (value, scale = 1) => (value == null ? null : Math.min(4, Math.ceil((value / (scale || 1)) * 4)));

function districtNumber(value, text, detail = '', level = null, tooltip = '') {
  return h('td', { class: 'numeric', title: tooltip || null },
    h('span', { class: 'district-value', 'data-district-level': level == null ? null : String(level) },
      text, detail ? h('small', null, detail) : null));
}

function districtParticipation({ rate, workers, members }) {
  return districtNumber(rate, perfPercent(rate), members ? `${num(workers)}/${num(members)}명` : '명부 없음', districtLevel(rate));
}

/** 구역 이름 칸. drill이면 원본 perf-region처럼 그 구역으로 범위를 좁힌다. */
function districtIdentity(row, go) {
  const canDrill = go && row.key && row.key !== '구역 미입력';
  return rowHead(canDrill
    ? h('button', { type: 'button', class: 'small ghost district-link', 'aria-label': `${row.label} 구역으로 좁히기`, onclick: () => go({ region: row.key }) }, row.label)
    : row.label);
}

function districtTable(id, heading, description, columns, rows, total) {
  const line = (row) => h('tr', null, columns.map(({ cell: make }) => make(row)));
  return h('section', { class: 'panel district-panel', 'aria-labelledby': `${id}-title` },
    h('div', { class: 'panel-head' }, h('div', null, h('h2', { id: `${id}-title` }, heading), h('p', null, description))),
    h('div', { class: 'table-scroll district-table-scroll', role: 'region', tabindex: '0', 'aria-labelledby': `${id}-title` },
      h('table', { id },
        h('thead', null, h('tr', null, columns.map(colHead))),
        h('tbody', null, rows.length ? rows.map(line) : emptyRow(columns.length, '선택 조건에 해당하는 구역이 없습니다.')),
        total ? h('tfoot', null, line(total)) : null)));
}

function districtFindingChange(r) {
  const before = r.comparison;
  const rows = r.districtOverview.findingChange || [];
  const peak = rows.reduce((m, row) => Math.max(m, Math.abs(row.delta ?? 0)), 1);
  const signed = (n) => (n > 0 ? `+${num(n)}` : num(n));
  const direction = (n) => (n < 0 ? 'down' : n > 0 ? 'up' : 'even');
  const bar = (row) => h('div', { class: 'district-change-cell' },
    h('span', { class: 'district-change-track', 'aria-hidden': 'true' },
      withPercent(h('i', { 'data-direction': direction(row.delta) }), (Math.abs(row.delta) / peak) * 50)),
    h('strong', { 'data-direction': direction(row.delta) }, `${signed(row.delta)}건`));
  const headers = ['구역', { label: '조회 기간', numeric: true },
    ...(before ? [{ label: '직전 기간', numeric: true }, { label: '증감', numeric: true }] : []), { label: '현재 비중', numeric: true }];
  const table = h('table', { id: 'district-finding-change-table' },
    h('thead', null, h('tr', null, headers.map(colHead))),
    h('tbody', null, rows.map((row) => h('tr', null,
      rowHead(row.region),
      cell(`${num(row.current)}건`, true),
      before ? [cell(`${num(row.previous)}건`, true), cell(bar(row), true)] : null,
      cell(perfPercent(row.share), true)))));
  return h('section', { class: 'panel district-panel', id: 'district-finding-change', 'aria-labelledby': 'district-finding-change-title' },
    h('div', { class: 'panel-head' }, h('div', null,
      h('h2', { id: 'district-finding-change-title' }, before ? '구역별 찾기 증감' : '구역별 찾기 비중'),
      h('p', null, before ? '직전 같은 일수와 비교해 찾기 건수가 많이 달라진 구역부터 표시합니다.' : '조회 범위의 전체 찾기에서 각 구역이 차지하는 비중입니다.'))),
    h('div', { class: 'district-change-layout' },
      h('div', { class: 'district-change-summary' },
        h('span', null, '조회 기간 찾기'),
        h('strong', { class: 'district-change-total' }, num(r.totals.findings), h('small', null, '건')),
        before
          ? [h('strong', { class: 'district-change-net', 'data-direction': direction(before.findingsDelta) }, `직전보다 ${signed(before.findingsDelta)}건`),
            h('span', { class: 'district-change-baseline' }, `직전 ${num(before.findings)}건`, h('br'), `${before.from} ~ ${before.to}`)]
          : h('span', { class: 'district-change-baseline' }, '시작일과 종료일을 선택하면 직전 기간과 비교합니다.')),
      rows.length
        ? h('div', { class: 'table-scroll district-table-scroll', tabindex: '0', role: 'region', 'aria-labelledby': 'district-finding-change-title' }, table)
        : h('div', { class: 'panel-body district-change-empty' },
          emptyBox(before ? '두 기간 모두 조회 조건에 해당하는 찾기 기록이 없습니다.' : '조회 조건에 해당하는 찾기 기록이 없습니다.'))));
}

const MIX_SEGMENTS = [['street', '노방만'], ['both', '노방·소셜링 모두'], ['club', '소셜링만'], ['none', '두 활동 기록 없음']];

function districtParticipationMix(r) {
  const rows = r.rows.filter((row) => row.districtOverview?.participation.combined.members);
  return panel({ id: 'district-participation-mix', cls: 'district-panel', title: '구역별 노방·소셜링 참여 구성',
    desc: '현재 명부를 기준으로 조회 기간에 두 활동에 모두 참여한 인원과 한쪽에만 참여한 인원을 비교합니다.' },
  rows.length
    ? h('div', { class: 'panel-body district-mix-body' },
      h('ul', { class: 'district-mix-legend' }, MIX_SEGMENTS.map(([kind, label]) => h('li', { class: `district-mix-${kind}` }, label))),
      h('ul', { class: 'district-mix-rows' }, rows.map((row) => {
        const { street, club, combined } = row.districtOverview.participation;
        const both = street.workers + club.workers - combined.workers;
        const counts = [street.workers - both, both, club.workers - both, combined.members - combined.workers];
        return h('li', { class: 'district-mix-row' },
          h('div', { class: 'district-mix-row-head' }, h('strong', null, row.label),
            h('span', null, `참여 ${num(combined.workers)} / ${num(combined.members)}명 · ${perfPercent(combined.rate)}`)),
          h('div', { class: 'district-mix-track', 'aria-hidden': 'true' },
            MIX_SEGMENTS.map(([kind], i) => withPercent(h('i', { class: `district-mix-${kind}` }, null), (100 * counts[i]) / combined.members))),
          h('dl', { class: 'district-mix-counts' }, MIX_SEGMENTS.map(([kind, label], i) =>
            h('div', { class: `district-mix-${kind}` }, h('dt', null, label), h('dd', null, `${num(counts[i])}명`)))));
      })))
    : panelBody(emptyBox('조회 조건에 해당하는 구역 명부가 없습니다.')));
}

function districtSummaryTable(r, total, go) {
  const part = (key) => (row) => districtParticipation(row.districtOverview.participation[key]);
  return districtTable('perf-overview', '구역별 핵심 지표',
    '참여율은 현재 명부 기준입니다. 합산 참여는 노방 또는 소셜링에 참여한 사람을 한 번만 셉니다. 구역 이름을 눌러 범위를 좁힐 수 있습니다.',
    [
      { label: '구역', cell: (row) => districtIdentity(row, row === total ? null : go) },
      { label: '명부', numeric: true, cell: (row) => { const members = row.districtOverview.participation.combined.members; return districtNumber(members, `${num(members)}명`); } },
      { label: '노방 참여', numeric: true, cell: part('street') },
      { label: '소셜링 참여', numeric: true, cell: part('club') },
      { label: '합산 참여', numeric: true, cell: part('combined') },
      { label: '노방 효율', numeric: true, cell: (row) => { const m = row.districtOverview.streetMetrics; return districtNumber(m.perHour, perfRate(m.perHour), perfTime(m.minutes)); } },
      { label: '찾기 실적', numeric: true, cell: (row) => districtNumber(row.metrics.findings, `${num(row.metrics.findings)}건`) },
    ], r.rows, total);
}

function districtHourlyMap(r, total) {
  const hours = r.districtOverview.streetMetrics.hours;
  const indexes = hours.flatMap((hour, i) => (hour.minutes || hour.findings ? [i] : []));
  if (!indexes.length) {
    return panel({ cls: 'district-panel', title: '시간대별 노방 효율' },
      h('div', { class: 'panel-body district-empty' }, '조회 기간에 시간대가 기록된 노방 활동이나 찾기가 없습니다.'));
  }
  const scale = Math.max(0, ...r.rows.flatMap((row) => row.districtOverview.streetMetrics.hours.map((hour) => hour.perPersonHour ?? 0)));
  return districtTable('district-hour-map', '시간대별 노방 효율',
    '활동시간에 연결된 찾기 ÷ 순활동 인시간. 진할수록 효율이 높고, —는 해당 시간대의 순활동시간이 없는 경우입니다.',
    [
      { label: '구역', cell: (row) => districtIdentity(row, null) },
      ...indexes.map((i) => ({
        label: hours[i].label,
        numeric: true,
        cell: (row) => {
          const x = row.districtOverview.streetMetrics.hours[i];
          return districtNumber(x.perPersonHour, perfRate(x.perPersonHour),
            x.minutes ? perfTime(x.minutes) : x.findings ? `찾기 ${num(x.findings)}건` : '',
            districtLevel(x.perPersonHour, scale),
            `${x.label} · 활동 ${num(x.workers)}명 · 순활동 ${perfTime(x.minutes)} · 활동시간 내 찾기 ${num(x.matchedFindings)}건`);
        },
      })),
    ], r.rows, total);
}

function districtStageMap(r, total) {
  return districtTable('perf-stages', '단계향상률 지도',
    '조회 기간에 출발 단계에 처음 도달한 대상자 중 다음 단계에 도달한 비율입니다. 같은 날의 단계 향상과 조회 기간이 끝난 뒤의 향상도 포함합니다. 건수는 다음 단계 도달 / 출발 단계 도달 순입니다.',
    [
      { label: '구역', cell: (row) => districtIdentity(row, null) },
      ...(r.cohort?.stages ?? []).map(({ fromLabel, label }, i) => ({
        label: `${fromLabel} → ${label}`,
        numeric: true,
        cell: (row) => {
          const s = row.cohort?.stages?.[i] ?? {};
          return districtNumber(s.rate, perfPercent(s.rate), s.baseCount ? `${num(s.count)} / ${num(s.baseCount)}건` : '', districtLevel(s.rate));
        },
      })),
    ], r.rows, total);
}

/** 구역별 데이터 본문. ctx.go({ region })로 같은 화면에서 구역을 좁힌다. */
export function regionPage(r, ctx) {
  const overview = r.districtOverview;
  if (!overview) return emptyPanel('구역 현황을 계산할 자료가 없습니다.');
  const { combined, street, club } = overview.participation;
  const sm = overview.streetMetrics;
  const total = { label: '조회 합계', metrics: r.totals, cohort: r.cohort, districtOverview: overview };
  const details = h('details', { class: 'panel district-details', open: ctx.detailsOpen?.() ?? false },
    h('summary', null, '기간 실적과 기록 상세'),
    periodStages(r, null),
    performanceDetail(r.totals, r.region || '전체 구역', r));
  details.addEventListener('toggle', () => ctx.setDetailsOpen?.(details.open));
  return h('div', { class: 'performance-page district-performance-page' },
    h('p', { class: 'district-scope' }, `${r.from || '전체 시작'} ~ ${r.to || '전체'} · ${r.region || '전체 구역'}`,
      h('span', null, `찾기·단계 분류2 ${classificationLabel(r.classification2)}`)),
    h('section', { class: 'metrics perf-metrics district-metrics', 'aria-label': '조회 범위 핵심 지표' },
      metric('노방 참여율', perfPercent(street.rate), `명부 ${num(street.members)}명 중 ${num(street.workers)}명`),
      metric('소셜링 참여율', perfPercent(club.rate), `명부 ${num(club.members)}명 중 ${num(club.workers)}명`),
      metric('노방·소셜링 합산 참여율', perfPercent(combined.rate), `고유 참여자 ${num(combined.workers)}명`),
      metric('노방 1인·1시간당 찾기', perfRate(sm.perHour), `순활동 ${perfTime(sm.minutes)} · 연결 ${num(sm.matchedFindings)}건`)),
    districtFindingChange(r),
    districtParticipationMix(r),
    districtSummaryTable(r, total, ctx.go),
    districtHourlyMap(r, total),
    districtStageMap(r, total),
    details);
}

/* =====================================================================
 * 공통 상세 (performance.js)
 * ===================================================================== */

/** 단계향상률 (#perf-stages) */
function stagesTable(r) {
  const stages = r.cohort?.stages ?? [];
  const values = (cohort) => (cohort?.stages ?? []).map(({ count: c, baseCount, rate }) => cell([
    h('strong', null, perfPercent(rate)),
    baseCount ? h('small', { class: 'perf-percent' }, `${num(c)} / ${num(baseCount)}건`) : null,
  ], true));
  return panel({ cls: 'chart-spacing', title: '단계향상률', desc: '선택 기간에 출발 단계에 처음 도달한 대상자의 이후 향상' },
    scroll('단계향상률', h('table', { id: 'perf-stages' },
      h('thead', null, h('tr', null, colHead('구분'), stages.map(({ fromLabel, label }) => colHead({ label: `${fromLabel} → ${label}`, numeric: true })))),
      h('tbody', null, r.rows.map(({ label, cohort }) => h('tr', null, rowHead(label), values(cohort)))),
      h('tfoot', null, h('tr', null, rowHead('전체'), values(r.cohort))))),
    tinyNote('건수는 향상 / 기준입니다. 기간 종료 뒤 도달도 포함하며 같은 사람은 단계마다 한 번 집계합니다.'));
}

/** 기간 내 단계별 실적 (#perf-period-stages). drill이 있으면(반별) 반 이름을 눌러 개인별 실적으로 간다. */
function periodStages(r, drill) {
  if (!r.stages) return null;
  const classView = r.kind === 'classData';
  const values = (stages) => stages.map((s) => {
    const goalScope = classView && s.comparedActual != null && s.comparedActual !== s.actual ? `비교 실적 ${num(s.comparedActual)} · ` : '';
    return cell([
      h('strong', null, `${num(s.actual)}건`),
      s.target != null ? h('small', { class: 'perf-percent' }, `${goalScope}목표 ${num(s.target)} · ${perfPercent(s.rate)}`) : null,
    ], true);
  });
  const name = (row) => (classView && drill
    ? h('button', { type: 'button', class: 'small ghost', 'aria-label': `${row.label} 개인별 실적 보기`, onclick: () => drill(row) }, row.label)
    : row.label);
  return panel({ cls: 'chart-spacing', title: '기간 내 단계별 실적',
    desc: `선택 기간에 해당 단계에 처음 도달한 대상자 · 같은 단계 반복 제외${classView && drill ? ' · 반 이름을 누르면 개인별 실적으로 이동합니다.' : ''}` },
  scroll('기간 내 단계별 실적', h('table', { id: 'perf-period-stages' },
    h('thead', null, h('tr', null, colHead(classView ? '반' : '구분'), r.stages.map((s) => colHead({ label: s.label, numeric: true })))),
    h('tbody', null, r.rows.length
      ? r.rows.map((row) => h('tr', null, rowHead(name(row)), values(row.stages || [])))
      : emptyRow(r.stages.length + 1, '선택 조건에 명부나 기록이 없습니다.')),
    h('tfoot', null, h('tr', null, rowHead('전체'), values(r.stages))))),
  tinyNote(`목표는 각 단계의 상신일을 기준으로 같은 기간·조직의 등록 목표와 비교합니다. ${classView && !r.region ? '반별 목표가 등록된 기간·단계에는 그 목표를 우선 적용합니다. ' : ''}분류를 한정하면 목표 달성률을 표시하지 않습니다.`));
}

/** 조회 기간 안의 날짜를 모두 채운 일자별 찾기 (원본: 3660일 이내일 때) */
function daySeries(days, from, to) {
  const series = (days ?? []).map((d) => ({ label: d.date, value: d.findings }));
  const start = from || series[0]?.label;
  const end = to || series.at(-1)?.label;
  if (start && end && Date.parse(end) - Date.parse(start) <= 3660 * DAY) {
    const counts = new Map(series.map((x) => [x.label, x.value]));
    series.length = 0;
    for (let t = Date.parse(`${start}T00:00:00Z`); t <= Date.parse(`${end}T00:00:00Z`); t += DAY) {
      const label = new Date(t).toISOString().slice(0, 10);
      series.push({ label, value: counts.get(label) || 0 });
    }
  }
  return series;
}

function dayChartPanel(title, m, r) {
  const series = daySeries(m.days, r.from, r.to);
  return panel({ title: `${title} · 일자별 찾기` },
    panelBody(series.length && series.some((x) => x.value)
      ? plotScroll('일자별 찾기 건수 그래프', countPlot(series, '일자별 찾기 건수', 'line'))
      : emptyBox('조회 기간에 찾기 기록이 없습니다.')));
}

/** 시간대별 활동과 찾기 효율 (#perf-hours). hideEmpty면 활동이 없는 칸을 —로 둔다. */
function hoursTable(hours, hideEmpty = false) {
  const shown = (hours ?? []).filter((x) => x.workers || x.findings);
  const value = (v) => (hideEmpty && !v ? dash : num(v));
  return panel({ cls: 'chart-spacing', title: '시간대별 활동과 찾기 효율' },
    scroll('시간대별 활동과 찾기 효율', h('table', { id: 'perf-hours' },
      h('thead', null, h('tr', null, ['시간대', { label: '활동자 수', numeric: true }, '순활동시간', { label: '찾기 건수', numeric: true },
        { label: '활동시간 내 찾기', numeric: true }, { label: '1인·1시간당 찾기', numeric: true }].map(colHead))),
      h('tbody', null, shown.length
        ? shown.map((x) => h('tr', null, rowHead(x.label), cell(value(x.workers), true),
          cell(hideEmpty && !x.minutes ? dash : perfTime(x.minutes)), cell(value(x.findings), true),
          cell(hideEmpty && !x.minutes ? dash : num(x.matchedFindings), true),
          h('td', { class: 'numeric perf-efficiency' }, perfRate(x.perPersonHour))))
        : emptyRow(6, '시간이 입력된 기록이 없습니다.')))));
}

/** 활동 구간 원기록 (#perf-intervals). 첫 500구간 */
function intervalsTable(m, showChecks = true) {
  const intervals = m.intervals ?? [];
  return panel({ cls: 'chart-spacing', title: '활동 구간 원기록', extra: h('span', { class: 'pill' }, `${num(intervals.length)}구간`) },
    scroll('활동 구간 원기록', h('table', { id: 'perf-intervals' },
      h('thead', null, h('tr', null, ['활동자', '구역', '시작', '종료', { label: '기록 시간(분)', numeric: true }].map(colHead))),
      h('tbody', null, intervals.length
        ? intervals.slice(0, 500).map((a) => h('tr', null, cell(a.name), cell(a.region || '미입력'),
          cell(String(a.start ?? '').replace('T', ' ')), cell(String(a.end ?? '').replace('T', ' ')),
          cell(a.minutes === null ? '미기록' : num(a.minutes), true)))
        : emptyRow(5, '활동 구간이 없습니다.')))),
    tinyNote(`구간은 원기록이므로 겹칠 수 있으며 순활동시간 합계는 중복을 제거합니다. 첫 500구간을 표시하고 엑셀에는 전체 구간을 저장합니다.${showChecks
      ? ` 시간 미입력 활동 ${num(m.unknownActivityTime)}건 · 활동자 미입력 ${num(m.unknownWorker)}건 · 찾기시간 미입력 ${num(m.unknownFindingTime)}건 · 본인 활동 미연결 찾기 ${num(m.unmatchedFindings)}건.`
      : ''}`));
}

/**
 * 노방이 아닌 분류(전체·소셜링 등)의 찾기 상세. 원본 app.js findingCountsDetailHTML:
 * 일자별 찾기(선) · 시간대별 찾기(막대) → 일자별 찾기 건수와 시간 미입력 표 → 노방 안내.
 */
function findingCountsDetail(days, hours, title) {
  const plot = (label, data, type) => (data.length && data.some((x) => x.value)
    ? plotScroll(`${label} 그래프`, countPlot(data, label, type))
    : emptyBox('선택 기간에 찾기 기록이 없습니다.'));
  const findings = (x) => x.findings ?? x.total ?? 0;
  return [
    h('div', { class: 'charts equal chart-spacing' },
      panel({ title: `${title} · 일자별 찾기` }, panelBody(plot('일자별 찾기', days.map((d) => ({ label: d.date, value: findings(d) })), 'line'))),
      panel({ title: '시간대별 찾기' }, panelBody(plot('시간대별 찾기', hours.map((x) => ({ label: x.label, value: x.findings ?? x.value ?? 0 })), 'bar')))),
    panel({ cls: 'chart-spacing', title: '일자별 찾기 건수' },
      scroll('일자별 찾기 건수', h('table', { id: 'perf-finding-days' },
        h('thead', null, h('tr', null, ['일자', { label: '찾기 건수', numeric: true }, { label: '시간 미입력', numeric: true }].map(colHead))),
        h('tbody', null, days.length
          ? days.map((d) => h('tr', null, rowHead(d.date), cell(num(findings(d)), true), cell(num(d.unknownFindingTime ?? d.unknown ?? 0), true)))
          : emptyRow(3, '선택 기간에 기록이 없습니다.'))))),
    h('p', { class: 'tiny' }, '활동시간·시간당 효율은 분류2에서 노방을 선택하면 확인할 수 있습니다.'),
  ];
}

/** 기간 실적과 기록 상세의 활동 부분 (원본 performanceDetailHTML) */
function performanceDetail(m, title, r) {
  if (!r.activityAvailable) return findingCountsDetail(m.days ?? [], m.hours ?? [], title);
  return [
    h('div', { class: 'charts equal chart-spacing' },
      dayChartPanel(title, m, r),
      panel({ title: '활동 시간대 · 찾기 발생 시간대' },
        panelBody(
          h('div', { class: 'an-legend' }, h('span', { class: 'an-key-workers' }, '활동자 수(명)'), h('span', { class: 'an-key-findings' }, '찾기 건수(건)')),
          plotScroll('시간대별 활동자 수와 찾기 건수 그래프', hourComparisonPlot(m.hours ?? []))))),
    hoursTable(m.hours),
    panel({ cls: 'chart-spacing', title: '활동일별 순활동시간·찾기' },
      scroll('활동일별 순활동시간·찾기', h('table', { id: 'perf-days' },
        h('thead', null, h('tr', null, ['일자', { label: '활동자 수', numeric: true }, '순활동시간', { label: '찾기 건수', numeric: true }, { label: '시간당 찾기', numeric: true }, '시간 미입력'].map(colHead))),
        h('tbody', null, (m.days ?? []).length
          ? m.days.map((d) => h('tr', null, rowHead(d.date), cell(num(d.workers), true), cell(perfTime(d.minutes)), cell(num(d.findings), true),
            cell(perfRate(d.perHour), true), cell(`활동 ${num(d.unknownActivityTime)} · 찾기 ${num(d.unknownFindingTime)}`)))
          : emptyRow(6, '선택 기간에 기록이 없습니다.'))))),
    intervalsTable(m),
  ];
}

/* ---------- 찾기 상세: 요일·장소·시간대·나이 ---------- */

function findingBars(rows, dimension) {
  const max = rows.reduce((peak, row) => Math.max(peak, row.findings), 0);
  return rows.length
    ? h('ul', { class: `perf-finding-bars perf-finding-bars-${dimension}`, role: 'list' }, rows.map(({ label, findings }) => h('li', null,
      h('span', null, label),
      h('meter', { min: '0', max: String(max), value: String(findings), 'aria-hidden': 'true' }),
      h('strong', null, `${num(findings)}건`))))
    : emptyBox('조회 기간에 찾기 기록이 없습니다.');
}

function placeHours(places, expandAll) {
  if (!places?.length) return emptyBox('조회 기간에 찾기 기록이 없습니다.');
  return places.map(({ label, findings, hours, unknownTime }, i) => h('details', { class: 'perf-place-hours', open: expandAll || i === 0 },
    h('summary', null, h('span', null, label), h('strong', null, `${num(findings)}건`)),
    h('div', { class: 'perf-place-hour-bars' },
      hours.length ? findingBars(hours, 'hour') : null,
      unknownTime ? h('p', { class: 'tiny' }, `시간 미입력 ${num(unknownTime)}건`) : null)));
}

function findingWeekdays(weekdays, scope, heading) {
  const titleId = `perf-${scope}-weekdays-title`;
  const rows = (weekdays ?? []).map(({ weekday, label, findings, places }) => {
    const placeSummary = places.map((place) => `${place.label} ${num(place.findings)}건`).join(' · ');
    const detailRows = places.flatMap((place) => {
      const hours = [...place.hours];
      if (place.unknownTime) hours.push({ label: '시간 미입력', findings: place.unknownTime });
      return hours.map((hour) => h('tr', null, cell(label), cell(place.label), cell(hour.label), cell(`${num(hour.findings)}건`, true)));
    });
    return h('details', { 'data-finding-weekday-count': String(weekday) },
      h('summary', { 'aria-label': `${label}, ${placeSummary || '찾기 장소 없음'}, 찾기 합계 ${num(findings)}건` },
        h('strong', { class: 'perf-weekday-name' }, label),
        h('span', { class: 'perf-weekday-places' }, placeSummary || dash),
        h('strong', { class: 'perf-weekday-count' }, `${num(findings)}건`)),
      detailRows.length
        ? scroll(`${label} 장소·시간대별 찾기`, h('table', null,
          h('thead', null, h('tr', null, ['요일', '찾기 장소', '시간대', { label: '찾기 건수', numeric: true }].map(colHead))),
          h('tbody', null, detailRows)), 'perf-weekday-overview-hours')
        : h('p', { class: 'perf-weekday-overview-empty' }, '이 요일의 찾기 기록이 없습니다.'));
  });
  return h('section', { class: 'panel perf-weekday-overview', id: `perf-${scope}-weekdays`, 'aria-labelledby': titleId },
    h('div', { class: 'panel-head' }, h('div', null, h(heading, { id: titleId }, '요일별 찾기'), h('p', null, '요일을 펼치면 장소별 찾기 시간대를 볼 수 있습니다.'))),
    h('div', { class: 'perf-weekday-overview-labels', 'aria-hidden': 'true' }, h('span', null, '요일'), h('span', null, '찾기 장소'), h('span', null, '찾기 건수')),
    rows);
}

function findingBreakdowns(m, scope, peak = null) {
  const classDetail = scope !== 'member';
  const heading = classDetail ? 'h3' : 'h2';
  const hours = (m.hours ?? []).filter((hour) => hour.findings > 0);
  if (m.unknownFindingTime) hours.push({ label: '시간 미입력', findings: m.unknownFindingTime });
  const recorded = (label, n) => (m.findings
    ? h('p', { class: 'perf-recorded-fields' }, `${label} 입력 ${num(n)} / ${num(m.findings)}건 · ${perfPercent(n / m.findings)}`)
    : null);
  const fields = m.recordedFields ?? {};
  const box = (id, title, note, label, content) => h('section', { class: 'panel', id: `perf-${scope}-${id}` },
    h('div', { class: 'panel-head' }, h('div', null, h(heading, null, title), note)),
    h('div', { class: 'panel-body', tabindex: '0', role: 'region', 'aria-label': label }, content));
  return h('div', { class: 'perf-finding-breakdowns chart-spacing' },
    box('hour-chart', '장소별 찾기 시간대', recorded('장소·시각 모두', fields.placeAndTime), '장소별 찾기 시간대 내역', placeHours(m.findingPlaceHours, classDetail)),
    box('all-hours', '전체 시간대별 찾기 건수', recorded('시각', m.findings - m.unknownFindingTime), '전체 시간대별 찾기 내역', [findingBars(hours, 'all-hour'), peak]),
    box('place-chart', '장소별 찾기', recorded('장소', fields.place), '장소별 찾기 내역', findingBars(m.findingPlaces ?? [], 'place')),
    box('age-chart', '대상자 나이별 찾기', recorded('나이', fields.age), '나이별 찾기 내역', findingBars(m.findingAges ?? [], 'age')));
}

/* =====================================================================
 * 개인별 데이터 (performance.js performanceMemberHTML)
 * ===================================================================== */

const sortByView = new Map();
const memberStageActual = (row, id) => row.stages?.find((stage) => stage.id === id)?.actual ?? 0;

/** 원본 performanceStatusRows: 화면별로 고른 정렬을 유지한다. */
function statusRows(r) {
  const preferred = sortByView.get(r.kind);
  const sort = preferred === 'efficiency' && !r.activityAvailable ? 'findings' : preferred || 'findings';
  const text = (a, b) => (a || '').localeCompare(b || '', 'ko', { numeric: true });
  const first = r.memberStageColumns?.[0]?.id;
  const priority = {
    findings: r.kind === 'memberData' ? (row) => memberStageActual(row, first) : (row) => row.metrics.findings,
    efficiency: (row) => row.metrics.perHour ?? -1,
    label: () => 0,
  }[sort];
  const rows = [...r.rows].sort((a, b) => priority(b) - priority(a) || text(a.label, b.label) || text(a.region, b.region) || text(a.key, b.key));
  return { ...r, rows, sort };
}

function statusScope(r) {
  const context = [`${r.from || '전체 시작'} ~ ${r.to || '전체'}`, r.region || '전체 구역', classificationLabel(r.classification2)];
  if (r.kind === 'classData' && r.selectedClass) {
    const selected = r.classes?.find(({ value }) => value === r.selectedClass);
    if (selected) context.push(selected.label);
  }
  if (r.detail) context.push(r.detail.name);
  return h('p', { class: 'perf-scope' }, context.join(' · '));
}

function sortControls(r, ctx) {
  if (r.rows.length < 2) return null;
  const classView = r.kind === 'classData';
  const sorts = [['findings', classView ? '찾기순' : '찾B순'], ...(r.activityAvailable ? [['efficiency', '시간당 찾기순']] : []), ['label', classView ? '반 이름순' : '이름순']];
  return h('div', { class: 'perf-sort-controls', role: 'group', 'aria-label': r.kind === 'memberData' ? '개인별 실적 정렬' : '비교 표 정렬' },
    sorts.map(([key, label]) => h('button', {
      type: 'button', class: 'small', 'aria-pressed': String(r.sort === key), 'data-perf-sort': key,
      onclick: () => { sortByView.set(r.kind, key); ctx.redraw(`[data-perf-sort="${key}"]`); },
    }, label)));
}

function memberLeaders(r, ctx) {
  return panel({ id: 'perf-member-leaders', title: '단계별 최다 창출자', desc: '조회 조건에 해당하는 전체 인도자의 기간 내 최초 단계 도달 건수' },
    h('div', { class: 'panel-body perf-member-leader-grid' }, (r.memberStageLeaders ?? []).map(({ id, label, count: c, members }) => {
      const names = new Map();
      const displayName = (member) => [member.name, member.region].filter(Boolean).join(' · ');
      for (const member of members) names.set(displayName(member), (names.get(displayName(member)) || 0) + 1);
      const leaders = members.map((member) => {
        const name = displayName(member);
        const identity = names.get(name) > 1 && member.code ? `${name} · ${member.code}` : name;
        return h('li', null, h('button', { type: 'button', class: 'small ghost', 'aria-pressed': String(r.selectedMember === member.key), onclick: () => ctx.go({ statsMember: member.key }) }, identity));
      });
      return h('article', { class: 'perf-member-leader', 'data-stage-id': id },
        h('h3', null, label),
        c ? [h('p', { class: 'perf-member-leader-count' }, h('strong', null, num(c)), '건', members.length > 1 ? [' ', h('small', null, '공동 1위')] : null), h('ul', null, leaders)]
          : h('p', { class: 'perf-member-leader-empty' }, '실적 없음'));
    })));
}

function memberTable(r, ctx) {
  const columns = r.memberStageColumns ?? [];
  const rows = r.rows.map((row) => {
    const m = row.metrics;
    const selected = r.selectedMember === row.key;
    return h('tr', { class: selected ? 'perf-active-row' : null },
      rowHead(h('button', { type: 'button', class: 'small ghost', 'aria-pressed': String(selected), onclick: () => ctx.go({ statsMember: row.key }) }, row.label)),
      columns.map(({ id }) => cell(num(memberStageActual(row, id)), true)),
      r.activityAvailable ? [cell(m.minutes ? perfTime(m.minutes) : dash, true), h('td', { class: 'numeric perf-efficiency' }, perfRate(m.perHour))] : null);
  });
  return h('section', { class: 'panel chart-spacing', 'aria-labelledby': 'perf-overview-title' },
    h('div', { class: 'panel-head perf-comparison-head' },
      h('div', null, h('h2', { id: 'perf-overview-title' }, '개인별 참여와 실적'), h('p', null, '이름을 누르면 해당 인도자의 기록을 조회합니다.')),
      sortControls(r, ctx)),
    scroll('개인별 참여와 실적', h('table', { id: 'perf-overview' },
      h('thead', null, h('tr', null, colHead('이름'), columns.map(({ label }) => colHead({ label, numeric: true })),
        r.activityAvailable ? [colHead({ label: '순활동시간', numeric: true }), colHead({ label: '시간당 찾기', numeric: true })] : null)),
      h('tbody', null, rows.length ? rows : emptyRow(1 + columns.length + (r.activityAvailable ? 2 : 0), '선택 기간에 기록이 없습니다.')))),
    r.activityAvailable ? tinyNote('시간당 찾기는 본인 노방 활동시간 내 찾기 건수를 중복 구간을 제외한 순활동시간으로 나눈 값입니다.') : null);
}

function memberDetail(m, activityAvailable) {
  const hours = (m.hours ?? []).filter((x) => x.findings > 0);
  const peak = Math.max(0, ...hours.map((x) => x.findings));
  const peaks = hours.filter((x) => x.findings === peak);
  const timed = hours.reduce((sum, x) => sum + x.findings, 0);
  const peakMetric = peaks.length
    ? h('div', { id: 'perf-member-peak', class: 'perf-member-peak-body' },
      h('p', null, '전체 장소 최다 찾기 시간대'),
      h('strong', null, peaks.map((x) => x.label).join(' · ')),
      h('p', null, `${peaks.length > 1 ? '시간대별 ' : ''}${num(peak)}건 · ${perfPercent(peak / timed)}`),
      h('small', null, `찾은 시각이 입력된 ${num(timed)}건 기준`))
    : null;
  return [
    findingWeekdays(m.findingWeekdays, 'member', 'h2'),
    findingBreakdowns(m, 'member', peakMetric),
    activityAvailable ? [hoursTable(m.hours, true), intervalsTable(m, false)] : null,
  ];
}

/** 개인별 데이터 본문. ctx.go({ statsMember })로 인도자를 고르거나 전체로 돌아간다. */
export function memberPage(data, ctx) {
  const r = statusRows(data);
  const person = r.detail;
  const metrics = person?.metrics || r.totals;
  return h('div', { class: 'performance-page performance-status-page' },
    statusScope(r),
    memberLeaders(r, ctx),
    memberTable(r, ctx),
    stagesTable(r),
    h('div', { class: 'perf-selected perf-member-detail-head' },
      h('h2', null, `${person?.name || '전체 인도자'} 활동과 찾기 상세`),
      person ? h('button', { type: 'button', class: 'small', onclick: () => ctx.go({ statsMember: '' }) }, '전체 인도자 보기') : null),
    memberDetail(metrics, r.activityAvailable),
    periodStages(r, null));
}

/* =====================================================================
 * 반별 데이터 (performance.js performanceClassHTML)
 * ===================================================================== */

function classEngagement(r) {
  const rows = r.rows.filter((row) => row.engagement?.members > 0).sort(byLabel);
  return panel({ id: 'perf-class-activity', title: '반별 활동 기록 참여', desc: '전체 활동자율은 현재 명부 중 조회 기간에 지역활동기록 상태 1~3이 있었던 인원의 비율입니다.' },
    panelBody(rows.length
      ? h('div', { class: 'perf-class-activity-grid' }, rows.map(({ label, key, engagement }) => h('article', { class: 'perf-class-activity-card', 'data-class-key': key },
        h('h3', null, label),
        h('p', { class: 'perf-class-activity-rate' }, h('span', null, '전체 활동자율'), h('strong', null, perfPercent(engagement.regionalRate))),
        h('dl', null,
          h('div', null, h('dt', null, '적극적 활동자'), h('dd', null, `${num(engagement.proactiveWorkers)}명`)),
          h('div', null, h('dt', null, '노방 활동자'), h('dd', null, `${num(engagement.streetWorkers)}명`)),
          h('div', null, h('dt', null, '소셜링 활동자'), h('dd', null, `${num(engagement.socialWorkers)}명`))))))
      : emptyBox('조회 조건에 해당하는 활동 중인 명부 인원이 없습니다.')));
}

function classGoals(r) {
  const goals = r.classGoals || [];
  return panel({ id: 'perf-class-goals', cls: 'perf-class-analysis chart-spacing', title: '반별 목표 달성',
    desc: `같은 기간의 반별 목표를 전체 분류·직업구분의 실적과 비교합니다. ${r.region ? '선택 구역에 등록한 반 목표를 표시합니다.' : '자료실의 같은 반을 합산합니다.'}` },
  panelBody(goals.length
    ? h('div', { class: 'perf-class-stages' }, goals.map(({ key, label, stages }) => {
      const measured = stages.filter(({ target }) => target > 0);
      const reached = measured.filter(({ actual, target }) => actual >= target).length;
      return h('article', { class: 'perf-class-stage', 'data-class-goal': key },
        h('h3', null, label, measured.length ? h('span', null, `${num(measured.length)}단계 중 ${num(reached)}단계 달성`) : null),
        h('ul', null, stages.map(({ id, label: stageLabel, actual, target, rate }) => h('li', { 'data-class-stage': id },
          h('div', null, h('strong', null, stageLabel), h('span', null, `실적 ${num(actual)} / 목표 ${num(target)}건`)),
          target > 0
            ? [h('div', { class: 'perf-track', 'aria-hidden': 'true' }, withPercent(h('i'), Math.min(100, rate * 100))),
              h('small', null, `${perfPercent(rate)} · ${actual >= target ? '달성' : `${num(target - actual)}건 남음`}`)]
            : h('small', null, '목표 0건')))));
    }))
    : emptyBox('조회 기간과 구역에 등록된 반별 목표가 없습니다.')));
}

const CLASS_PALETTE = [['#157963', '#77cfb6'], ['#345da8', '#a5c6ff'], ['#a75127', '#ffb791'], ['#7b4a99', '#d9a8f5'], ['#9e365c', '#ffa9c7'], ['#516722', '#bbcf7e']];

/** 반별 일자별 찾기: 반마다 같은 세로축의 작은 그래프 (원본 performanceClassDailyChartHTML) */
function classDailyChart(r) {
  const classOrder = new Map((r.classes ?? []).map(({ value }, i) => [value, i]));
  const rows = [...r.rows].sort(byLabel);
  let first = Infinity;
  let last = -Infinity;
  let max = 0;
  const series = rows.map((row, index) => {
    const order = classOrder.get(row.key || '__unclassified__') ?? index;
    const hue = Math.round(order * 137.508) % 360;
    const colors = CLASS_PALETTE[order] || [`hsl(${hue} 64% 35%)`, `hsl(${hue} 68% 71%)`];
    const days = (row.metrics.days ?? []).filter((d) => d.findings > 0).map((d) => {
      const at = Date.parse(d.date);
      first = Math.min(first, at);
      last = Math.max(last, at);
      max = Math.max(max, d.findings);
      return { at, date: d.date, count: d.findings };
    });
    return { key: row.key, label: classLabel(row.label), colors, days };
  });
  if (!max) return emptyBox('조회 기간에 찾기 기록이 없습니다.');

  const start = r.from ? Date.parse(r.from) : first;
  const end = r.to ? Date.parse(r.to) : last;
  const elapsed = (end - start) / DAY;
  const baseline = 114;
  const top = 18;
  const step = Math.ceil(max / 3);
  const tickCount = Math.ceil(max / step);
  const scaleMax = step * tickCount;
  const x = (at) => (elapsed ? (100 * (at - start)) / (end - start) : 50);
  const y = (n) => baseline - ((baseline - top) * n) / scaleMax;
  const levels = Array.from({ length: tickCount + 1 }, (_, i) => i * step);
  const shortRange = elapsed <= 6;
  const showYear = elapsed >= 365;
  const dateIntervals = shortRange ? elapsed : showYear ? 2 : 4;
  const ticks = Array.from({ length: dateIntervals + 1 }, (_, i) => {
    const at = start + (dateIntervals ? Math.round((i * elapsed) / dateIntervals) : 0) * DAY;
    const date = new Date(at).toISOString().slice(0, 10);
    return { at, date, label: date.slice(showYear ? 2 : 5).replaceAll('-', '.') };
  });
  const yAxis = () => svgEl('svg', { class: 'perf-class-chart-axis', width: num(scaleMax).length * 8 + 14, height: 144, 'aria-hidden': 'true' },
    levels.map((n) => svgEl('text', { x: '100%', y: y(n) + 4, 'text-anchor': 'end' }, `${num(n)}${n === scaleMax ? '건' : ''}`)));
  const grid = () => levels.map((n) => svgEl('line', { class: 'finding-grid', x1: '0%', x2: '100%', y1: y(n), y2: y(n) }));
  const dateAxis = () => ticks.map(({ at, date, label }, i) => {
    const interior = i > 0 && i < ticks.length - 1;
    return svgEl('text', { class: `perf-class-date${interior && i % 2 ? ' perf-class-date-minor' : ''}`, 'data-date': date, x: `${x(at)}%`, y: 136, 'text-anchor': 'middle' }, label);
  });

  const charts = series.map(({ key, label, colors, days }) => {
    const points = new Map([[start, 0], [end, 0]]);
    for (const { at, count: n } of days) {
      if (at > start && !points.has(at - DAY)) points.set(at - DAY, 0);
      if (at < end && !points.has(at + DAY)) points.set(at + DAY, 0);
      points.set(at, n);
    }
    const path = [...points].sort(([a], [b]) => a - b).map(([at, n]) => `${x(at)},${y(n)}`).join(' L');
    const marked = shortRange ? ticks.map(({ at, date }) => ({ at, date, count: points.get(at) || 0 })) : days;
    const marks = marked.map(({ at, date, count: n }) => svgEl('g', null,
      svgEl('title', null, `${date} · ${num(n)}건`),
      svgEl('circle', { class: `perf-class-point${n ? '' : ' perf-class-point-zero'}`, cx: `${x(at)}%`, cy: y(n), r: n ? 3.5 : 2.5 }),
      shortRange && n ? svgEl('text', { class: 'perf-class-point-count', x: `${x(at)}%`, y: y(n) - 8, 'text-anchor': 'middle' }, num(n)) : null));
    const total = days.reduce((sum, d) => sum + d.count, 0);
    const figure = h('figure', { class: 'perf-class-series', 'data-class-series': key },
      h('figcaption', null,
        h('strong', null, svgEl('svg', { class: 'perf-class-swatch', width: 20, height: 12, 'aria-hidden': 'true' },
          svgEl('path', { d: 'M1 6h18' }), svgEl('circle', { cx: 10, cy: 6, r: 3 })), label),
        h('span', null, '합계 ', h('b', null, `${num(total)}건`))),
      h('div', { class: 'perf-class-chart-axes' }, yAxis(),
        svgEl('svg', { class: 'perf-class-daily-plot', width: '100%', height: 144, role: 'img' },
          svgEl('title', null, `${label} 일자별 찾기 · 합계 ${num(total)}건`),
          svgEl('desc', null, days.map(({ date, count: n }) => `${date} ${num(n)}건`).join(', ') || '조회 기간 0건'),
          grid(),
          svgEl('svg', { width: '100%', height: baseline, viewBox: `0 0 100 ${baseline}`, preserveAspectRatio: 'none', overflow: 'visible' },
            svgEl('path', { class: 'perf-class-daily-area', d: `M${path} L${x(end)},${baseline} L${x(start)},${baseline} Z` }),
            svgEl('path', { class: 'perf-class-daily-line', d: `M${path}` })),
          marks, dateAxis())));
    figure.style.setProperty('--series-light', colors[0]);
    figure.style.setProperty('--series-dark', colors[1]);
    return figure;
  });
  return h('div', { class: 'perf-class-series-grid' }, charts);
}

function classFindingDetail(r) {
  const rows = [...r.rows].sort(byLabel);
  if (!rows.length) return emptyPanel('조회 조건에 해당하는 반이 없습니다.');
  return rows.map(({ key, label, metrics }, index) => {
    const scope = `class-${index}`;
    const titleId = `perf-${scope}-finding-title`;
    return h('section', { 'data-finding-class': key, 'aria-labelledby': titleId },
      h('header', { class: 'perf-class-finding-head' },
        h('h2', { id: titleId }, `${classLabel(label)} 찾기 상세`),
        h('span', { class: 'perf-class-finding-count' }, `찾기 ${num(metrics.findings)}건`)),
      findingWeekdays(metrics.findingWeekdays, scope, 'h3'),
      metrics.findings ? findingBreakdowns(metrics, scope) : emptyPanel('조회 기간에 이 반의 찾기 기록이 없습니다.'));
  });
}

function classPeak(r) {
  const rows = r.rows.flatMap(({ label, metrics }) => {
    const peakCount = Math.max(0, ...(metrics.hours ?? []).map(({ findings }) => findings));
    if (!peakCount) return [];
    const peakHours = metrics.hours.filter(({ findings }) => findings === peakCount);
    const timed = metrics.findings - metrics.unknownFindingTime;
    return [h('tr', null, rowHead(label), cell(peakHours.map((x) => x.label).join(' · ')), cell(`${num(peakCount)}건`, true), cell(perfPercent(peakCount / timed), true))];
  });
  return panel({ id: 'perf-class-peak', cls: 'chart-spacing', title: '반별 찾기 집중 시간대', desc: '찾은 시각이 있는 기록을 기준으로 반마다 최다 시간대와 시간대당 비중을 표시합니다.' },
    scroll('반별 찾기 집중 시간대', h('table', null,
      h('thead', null, h('tr', null, ['반', '최다 시간대', { label: '시간대당 찾기', numeric: true }, { label: '시간대당 비중', numeric: true }].map(colHead))),
      h('tbody', null, rows.length ? rows : emptyRow(4, '찾은 시각이 입력된 기록이 없습니다.')))));
}

/** 반별 데이터 본문. ctx.drillMember(row)가 있으면 기간 내 단계별 실적의 반 이름이 개인별 데이터로 이동한다. */
export function classPage(data, ctx) {
  const r = statusRows(data);
  const m = r.totals;
  return h('div', { class: 'performance-page performance-status-page class-performance-page' },
    statusScope(r),
    classEngagement(r),
    periodStages(r, ctx.drillMember),
    classGoals(r),
    stagesTable(r),
    h('div', { class: 'perf-class-details' },
      panel({ id: 'perf-class-daily-chart', cls: 'chart-spacing', title: '반별 일자별 찾기' }, panelBody(classDailyChart(r))),
      h('section', { id: 'perf-class-finding-detail', class: 'chart-spacing', 'aria-label': '반별 찾기 상세' }, classFindingDetail(r)),
      r.activityAvailable ? [hoursTable(m.hours, true), intervalsTable(m, false)] : null),
    classPeak(r));
}

/* =====================================================================
 * 전일자 전도현황 (full-time-performance.js)
 * ===================================================================== */

export function fullTimePanel(result) {
  const { current, previous, groups, totals, stages } = result;
  const comparison = stages.flatMap(({ label }, index) => (['찾B', '찾A'].includes(label) ? [index] : []));
  const value = (v) => cell(v === null || v === undefined ? dash : num(v), true);
  const cells = (counts) => [
    comparison.map((i) => value(counts.previous[i])),
    stages.map((_, i) => [value(counts.current[i]), value(counts.holdings[i])]),
  ];
  const columns = 3 + comparison.length + stages.length * 2;
  const table = h('table', { id: 'full-time-performance' },
    h('colgroup', { span: '3' }), comparison.length ? h('colgroup', { span: String(comparison.length) }) : null,
    stages.map(() => h('colgroup', { span: '2' })),
    h('thead', null,
      h('tr', null,
        h('th', { scope: 'col', rowspan: '2' }, '구역'), h('th', { scope: 'col', rowspan: '2' }, '이름'), h('th', { scope: 'col', rowspan: '2' }, '반'),
        comparison.length ? h('th', { scope: 'colgroup', colspan: String(comparison.length) }, '7일 전 같은 요일') : null,
        stages.map(({ label }) => h('th', { scope: 'colgroup', colspan: '2' }, label))),
      h('tr', null,
        comparison.map((i) => h('th', { scope: 'col', class: 'numeric' }, stages[i].label)),
        stages.map(({ label }) => [
          h('th', { scope: 'col', class: 'numeric', 'aria-label': `${label} 신규` }, '신규'),
          h('th', { scope: 'col', class: 'numeric', 'aria-label': `${label} 보유` }, '보유'),
        ]))),
    groups.length
      ? groups.map(({ label, rows, totals: subtotal }) => h('tbody', null,
        h('tr', { class: 'perf-full-time-subtotal' },
          h('th', { scope: 'rowgroup', colspan: '3' }, h('strong', null, `${label} 소계 · ${num(subtotal.members)}명`)), cells(subtotal)),
        rows.map((row) => h('tr', null,
          h('td', { class: 'perf-full-time-district', title: label }, label),
          h('th', { scope: 'row', class: 'perf-full-time-name', title: row.name }, row.name),
          cell(row.classLabel || dash), cells(row)))))
      : h('tbody', null, emptyRow(columns, '조회 조건에 맞는 전일자 구성원이 없습니다.')),
    groups.length ? h('tfoot', null, h('tr', null, h('th', { scope: 'row', colspan: '3' }, '조회 합계'), cells(totals))) : null);
  return h('section', { class: 'panel chart-spacing performance-page full-time-page', 'aria-labelledby': 'full-time-results-heading' },
    h('div', { class: 'panel-head' },
      h('div', null, h('h2', { id: 'full-time-results-heading' }, '전일자 전도현황'),
        h('p', null, `조회 ${current.from} ~ ${current.to} · 비교 ${previous.from} ~ ${previous.to}`)),
      h('span', { class: 'pill' }, `${num(totals.members)}명`)),
    scroll('전일자 구역별 실적표', table, 'full-time-scroll'),
    tinyNote('현재 명부에서 직업 구분이 전일자인 구성원을 현재 구역별로 집계합니다. 신규는 최초 단계 도달일, 보유는 조회 종료일의 활성 단계 기준입니다. 집계할 수 있는 단계 자료가 없으면 —로 표시합니다. 엑셀에는 모든 단계의 7일 전 비교 수치가 포함됩니다.'));
}
