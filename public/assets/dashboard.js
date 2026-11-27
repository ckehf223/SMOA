import { getJson, h, toast } from './common.js';
import { canOpen, openDrill } from './drill.js';

/**
 * 대시보드 화면. dashboardView(container, me)
 * 기존 SMOA 4.0.41 지역 대시보드(주별·월별 성과 개요 / 활동분석 / 목표)를 옮겼다.
 * 집계는 모두 서버(GET /api/dashboard/overview)가 요청자의 구역 범위 안에서 계산하고, 화면은 받은 값만 보여 준다.
 * 화면은 DOM 노드로 만들며, 스타일은 /assets/dashboard.css 하나만 불러온다.
 */

const STYLE_HREF = '/assets/dashboard.css';
const SVG_NS = 'http://www.w3.org/2000/svg';
const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];
const TABS = [
  ['results', '성과 개요'],
  ['participation', '활동분석'],
  ['goals', '목표'],
];

// 화면을 다시 열어도 조회 단위·기준일·탭을 유지한다. 기준일이 비어 있으면 서버의 오늘(KST)이다.
const state = { unit: 'week', anchor: '', tab: 'results' };

const numberFormat = new Intl.NumberFormat('ko-KR');
const count = (value) => (Number.isFinite(value) ? numberFormat.format(value) : '—');
const rate = (value) => (Number.isFinite(value) ? `${value.toFixed(1)}%` : '—');
const clamp = (value) => Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));

/* ---------- 스타일 · SVG · 작은 조각 ---------- */

let styleReady;
/** 화면 전용 스타일시트를 한 번만 붙이고, 불러온 뒤 화면을 그린다. (CSP: 같은 출처의 외부 파일만 사용) */
function ensureStyles() {
  if (!styleReady) {
    styleReady = new Promise((resolve) => {
      if (document.querySelector(`link[href="${STYLE_HREF}"]`)) return resolve();
      const link = h('link', { rel: 'stylesheet', href: STYLE_HREF });
      link.addEventListener('load', resolve, { once: true });
      link.addEventListener('error', resolve, { once: true }); // 스타일이 없어도 내용은 읽을 수 있다.
      document.head.append(link);
    });
  }
  return styleReady;
}

function svg(tag, attrs, ...kids) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs ?? {})) if (value != null) el.setAttribute(key, String(value));
  el.append(...kids.flat(Infinity).filter((kid) => kid != null));
  return el;
}

/** 막대 길이는 CSS 변수로 전달한다. (style 속성 문자열을 쓰지 않아 CSP에 걸리지 않는다.) */
function track(percent, cls) {
  const fill = h('i');
  fill.style.setProperty('--percent', `${clamp(percent)}%`);
  return h('span', { class: cls, 'aria-hidden': 'true' }, fill);
}

/** 증감 표시. 색뿐 아니라 부호(+/−)로도 방향을 알 수 있다. */
function change(value, unit, unavailable = '비교 불가') {
  if (!Number.isFinite(value)) return h('span', { class: 'dashboard-change neutral' }, unavailable);
  const direction = value > 0 ? 'positive' : value < 0 ? 'negative' : 'neutral';
  const sign = value > 0 ? '+' : value < 0 ? '−' : '';
  const amount = unit === '%' ? Math.abs(value).toFixed(1) : numberFormat.format(Math.abs(value));
  return h('span', { class: `dashboard-change ${direction}` }, `${sign}${amount}${unit}`);
}

const previousLabel = (d) => (d.periodUnit === 'month' ? '전월' : '전주');
const thisLabel = (d) => (d.periodUnit === 'month' ? '이번 달' : '이번 주');

function panel(id, title, description, ...body) {
  return h('section', { class: 'panel', id },
    h('div', { class: 'panel-head' }, h('div', null, h('h2', null, title), description ? h('p', null, description) : null)),
    ...body);
}

const tableScroll = (label, table) => h('div', { class: 'table-scroll', tabindex: '0', role: 'region', 'aria-label': label }, table);
const emptyNote = (text) => h('p', { class: 'workbench-empty' }, text);

/* ---------- 조회 조건 ---------- */

function filtersSection(d, me, go) {
  const unit = d.periodUnit === 'month' ? 'month' : 'week';
  const anchorLabel = unit === 'month' ? '조회월' : '주 기준일';
  const unitButton = (value, label) => h('button', {
    type: 'button',
    class: unit === value ? '' : 'secondary',
    'aria-pressed': String(unit === value),
    onclick: () => go({ unit: value, anchor: d.from }),
  }, label);
  const shiftButton = (direction, label, glyph) => h('button', {
    type: 'button', class: 'secondary icon', 'aria-label': label, onclick: () => go({ anchor: shiftedAnchor(d, direction) }),
  }, h('span', { 'aria-hidden': 'true' }, glyph));
  const input = h('input', {
    type: unit === 'month' ? 'month' : 'date',
    value: unit === 'month' ? d.from.slice(0, 7) : d.from,
    min: unit === 'month' ? '2000-01' : '2000-01-01',
    max: unit === 'month' ? '2100-12' : '2100-12-31',
    'aria-label': anchorLabel,
    onchange: (event) => {
      const value = event.target.value;
      if (value) go({ anchor: unit === 'month' ? `${value}-01` : value });
    },
  });
  const scope = d.scope?.all
    ? '모든 구역 · 모든 분류 합계'
    : d.scope?.districts?.length ? `배정 구역 ${d.scope.districts.join(', ')} · 모든 분류 합계` : '배정된 구역이 없습니다.';
  return h('section', { class: 'filters overview-filters', 'aria-label': '지역 대시보드 조회 조건' },
    h('div', { class: 'dashboard-period-bar' },
      h('div', { class: 'dashboard-period-switch', role: 'group', 'aria-label': '집계 단위' }, unitButton('week', '주별'), unitButton('month', '월별')),
      h('div', { class: 'dashboard-period-navigation' },
        shiftButton(-1, '이전 기간', '‹'),
        h('label', { class: 'dashboard-anchor' }, h('span', null, anchorLabel), input),
        shiftButton(1, '다음 기간', '›'),
        h('button', { type: 'button', class: 'secondary', onclick: () => go({ anchor: '' }) }, unit === 'month' ? '이번 달' : '이번 주')),
      h('div', { class: 'dashboard-scope' }, scope)),
    h('div', { class: 'dashboard-period-caption' },
      h('strong', null, d.from, h('span', null, '—'), d.to),
      h('span', null, `조회 기간 · ${unit === 'month' ? '달력 월' : `주 시작 ${WEEKDAYS[d.period?.weekStart ?? 0]}요일`}`)));
}

/** 현재 기간의 시작일에서 한 기간 앞뒤로 옮긴 기준일. (월은 1일 기준) */
function shiftedAnchor(d, direction) {
  const date = new Date(`${d.from}T12:00:00Z`);
  if (d.periodUnit === 'month') {
    date.setUTCDate(1);
    date.setUTCMonth(date.getUTCMonth() + direction);
  } else date.setUTCDate(date.getUTCDate() + direction * 7);
  return date.toISOString().slice(0, 10);
}

/* ---------- 성과 개요 ---------- */

function sparkline(values, label) {
  // 기간 자료가 없는 곳에서는 선을 끊는다.
  const max = Math.max(1, ...values.filter(Number.isFinite));
  const segments = [];
  let current;
  values.forEach((value, index) => {
    if (!Number.isFinite(value)) {
      current = undefined;
      return;
    }
    if (!current) segments.push((current = []));
    current.push([3 + (index * 94) / Math.max(1, values.length - 1), 27 - (value / max) * 23]);
  });
  if (!segments.length) return null;
  return svg('svg', { class: 'workbench-sparkline', viewBox: '0 0 100 30', role: 'img', 'aria-label': label },
    segments.map((segment) => (segment.length > 1
      ? svg('polyline', { points: segment.map(([x, y]) => `${x},${y}`).join(' ') })
      : svg('circle', { cx: segment[0][0], cy: segment[0][1], r: 2 }))));
}

function scoreboard(d) {
  const before = previousLabel(d);
  const historyLabel = d.periodUnit === 'month' ? '최근 월별' : '최근 주별';
  return h('section', { class: 'panel workbench-scoreboard', 'aria-label': '주요 단계 실적' },
    (d.stageCounts || []).map(({ id, label, actual, previous, source, previousSource }) => {
      const comparable = Number.isFinite(actual) && Number.isFinite(previous) && source === previousSource;
      const delta = comparable ? actual - previous : null;
      const ratio = comparable && previous > 0 ? (delta / previous) * 100 : null;
      const unavailable = source && previousSource && source !== previousSource ? '자료원 다름' : '비교 불가';
      const history = (d.periods || []).map((period) => period.stages?.[id]);
      return h('article', null,
        h('h2', null, `${label} 건수`),
        h('div', { class: 'workbench-score-value' },
          h('strong', null, count(actual), Number.isFinite(actual) ? h('small', null, '건') : null),
          sparkline(history, `${label} ${historyLabel} 실적`)),
        h('div', { class: 'workbench-score-change' },
          h('span', null, `${before} ${count(previous)}${Number.isFinite(previous) ? '건' : ''}`),
          h('span', { class: 'workbench-score-difference' }, change(delta, '건', unavailable), ratio === null ? null : change(ratio, '%'))));
    }));
}

/* ---------- 상세 화면 이동 (원본 dashboard-drill · dashboard-district-open · dashboard-class-open) ---------- */

/** 일별 점: 그 날짜 하루를 구역별 데이터로 연다. 분류는 전체. */
const drillDay = (date) => openDrill('regionData', { from: date, to: date, region: '', classification2: '' });
/** 구역 증감 행: 대시보드 기간과 그 구역을 구역별 데이터로 연다. 분류는 전체. */
const drillDistrict = (d, region) => openDrill('regionData', { from: d.from, to: d.to, region, classification2: '' });
/**
 * 반 추이: 대시보드 기간과 그 반을 반별 데이터로 연다. 분류는 전체.
 * 표시명(N반)이 아니라 서버가 준 실제 반 코드 값을 보낸다. 값이 없으면 숫자 코드로 대신한다.
 */
const classValue = (row) => (typeof row.value === 'string' && row.value ? row.value : String(row.label).replace(/\s*반$/, ''));
const drillClass = (d, row) => openDrill('classData', { from: d.from, to: d.to, statsClass: classValue(row), classification2: '' });

function districtChanges(d, me) {
  const all = d.findingChanges || [];
  const drill = canOpen(me, 'regionData') && d.source === 'detail';
  const comparable = d.source === d.comparison.source;
  const rows = comparable ? all.filter((row) => Number.isFinite(row.delta) && row.delta !== 0).slice(0, 3) : [];
  const missing = comparable && all.some((row) => row.delta === null);
  let description = '두 기간의 건수 차이가 큰 구역을 최대 세 곳까지 표시합니다.';
  if (missing) description += ' 두 기간 모두 일계를 제출한 구역만 비교했습니다.';
  const message = !comparable ? '두 기간의 찾기 자료원이 달라 구역별 증감을 계산할 수 없습니다.'
    : !all.length ? '두 기간에 찾기 기록이 없습니다.'
      : missing && all.every((row) => row.delta === null) ? '두 기간 모두 찾기 건수를 확인할 수 있는 구역이 없습니다.'
        : '비교 가능한 구역의 찾기 건수가 지난 기간과 같습니다.';
  const district = (row) => (drill && row.region !== '구역 미입력'
    ? h('button', { type: 'button', class: 'ghost small', 'aria-label': `${row.region} 기간 상세`, onclick: () => drillDistrict(d, row.region) }, row.region)
    : h('strong', null, row.region));
  const tiles = rows.map((row) => h('article', null,
    h('div', { class: 'workbench-district-title' }, district(row), change(row.delta, '건')),
    h('p', null, `${previousLabel(d)} ${count(row.previous)}건 → ${thisLabel(d)} ${count(row.actual)}건`)));
  return panel('workbench-district-changes', '구역별 찾기 증감', description,
    rows.length ? h('div', { class: 'workbench-district-tiles' }, tiles) : emptyNote(message));
}

/**
 * 날짜 점. 구역별 데이터를 읽을 수 있으면 원본처럼 마우스·Enter·Space로 그날의 구역별 상세를 연다.
 * 읽을 수 없으면 값만 보여 주는 점이다.
 */
function trendPoint(day, cx, cy, r, drill) {
  const hint = `${day.date} · 찾기 ${count(day.findings)}건${drill ? ' · 구역별 상세 보기' : ''}`;
  const point = svg('circle', {
    class: `dashboard-trend-point${drill ? ' dashboard-trend-drill' : ''}`, cx, cy, r,
    role: drill ? 'button' : null, tabindex: drill ? '0' : null, 'aria-label': drill ? hint : null,
  }, svg('title', null, hint));
  if (drill) {
    point.addEventListener('click', () => drillDay(day.date));
    point.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      drillDay(day.date);
    });
  }
  return point;
}

function trendChart(days, drill) {
  if (!days.length) return emptyNote('조회 기간의 일별 찾기 흐름을 확인할 수 없습니다.');
  const width = 760;
  const height = 278;
  const left = 42;
  const right = 28;
  const top = 22;
  const bottom = 38;
  const plotW = width - left - right;
  const plotH = height - top - bottom;
  const max = Math.max(...days.map((day) => day.findings || 0), 1);
  const scale = max <= 4 ? 4 : Math.ceil(max / 4) * 4;
  const x = (i) => left + (i * plotW) / Math.max(1, days.length - 1);
  const y = (n) => top + plotH * (1 - n / scale);
  const path = `M${days.map((day, i) => `${x(i)},${y(day.findings || 0)}`).join(' L')}`;
  const last = days.length - 1;
  const labelled = new Set([0, Math.floor(last / 4), Math.floor(last / 2), Math.floor((last * 3) / 4), last]);
  const axes = Array.from({ length: 5 }, (_, i) => {
    const value = (scale * i) / 4;
    return [
      svg('line', { class: 'dashboard-grid', x1: left, x2: width - right, y1: y(value), y2: y(value) }),
      svg('text', { x: left - 12, y: y(value) + 4, 'text-anchor': 'end' }, numberFormat.format(value)),
    ];
  });
  const marks = days.map((day, i) => [
    trendPoint(day, x(i), y(day.findings || 0), days.length > 14 ? 4 : 6, drill),
    days.length <= 7 || labelled.has(i)
      ? svg('text', { x: x(i), y: height - 12, 'text-anchor': 'middle', 'aria-hidden': 'true' }, day.date.slice(5).replace('-', '/'))
      : null,
  ]);
  // 점이 단추일 때는 원본처럼 group으로 두어 보조 기술이 각 점에 닿을 수 있게 한다.
  const graph = svg('svg', drill
    ? { class: 'dashboard-trend', viewBox: `0 0 ${width} ${height}`, role: 'group', 'aria-label': '일별 찾기 건수' }
    : { class: 'dashboard-trend', viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': '일별 찾기 건수 그래프. 같은 내용이 아래 표에 있습니다.' },
    axes,
    svg('path', { class: 'dashboard-trend-area', d: `${path} L${x(last)},${y(0)} L${x(0)},${y(0)} Z` }),
    svg('path', { class: 'dashboard-trend-line', d: path }),
    marks);
  // 그래프를 볼 수 없는 경우를 위한 같은 내용의 표
  // 화면 밖 표시 클래스는 표가 아니라 표를 감싼 div에 둔다(표의 최소 너비가 1px 영역을 무시하기 때문).
  const data = h('div', { class: 'dashboard-visually-hidden' },
    h('table', { class: 'dashboard-visually-hidden-table' },
      h('caption', null, '일별 찾기 건수'),
      h('thead', null, h('tr', null, h('th', { scope: 'col' }, '날짜'), h('th', { scope: 'col' }, '찾기 건수'))),
      h('tbody', null, days.map((day) => h('tr', null, h('th', { scope: 'row' }, day.date), h('td', null, count(day.findings)))))));
  return h('div', null, graph, data);
}

function trendPanel(d, me) {
  const drill = canOpen(me, 'regionData');
  return h('section', { class: 'panel dashboard-trend-panel' },
    h('div', { class: 'panel-head' }, h('div', null, h('h2', null, '일별 찾기 흐름'),
      h('p', null, drill ? '날짜별 점을 누르면 구역별 상세로 이동합니다.' : '날짜별 점에 올리면 그날의 찾기 건수를 볼 수 있습니다.'))),
    h('div', { class: 'panel-body' }, trendChart(d.daily || [], drill)));
}

function periodHistory(d, go) {
  const stages = d.stageCounts || [];
  const periods = d.periods || [];
  const table = h('table', { class: 'dashboard-history-table' },
    h('thead', null, h('tr', null, h('th', { scope: 'col' }, '기간'), stages.map(({ label }) => h('th', { class: 'numeric', scope: 'col' }, label)))),
    h('tbody', null, periods.map((period, index) => {
      const selected = index === periods.length - 1;
      return h('tr', { class: selected ? 'dashboard-current-period' : null },
        h('th', { scope: 'row' }, h('button', {
          type: 'button', class: 'ghost small', 'aria-current': selected ? 'date' : null, onclick: () => go({ anchor: period.from }),
        }, period.label || period.from)),
        stages.map(({ id }) => h('td', { class: 'numeric' }, count(period.stages?.[id]))));
    })));
  return h('section', { class: 'panel' },
    h('div', { class: 'panel-head' }, h('div', null,
      h('h2', null, `최근 ${d.periodUnit === 'month' ? '월별' : '주별'} 추이`), h('p', null, '기간을 누르면 해당 기간으로 이동합니다.'))),
    tableScroll('기간별 단계 실적', table));
}

function pathway(d) {
  const rows = d.regionalCohorts || [];
  if (!rows.length) return null;
  return panel('workbench-pathway', '지역 전체 단계향상률',
    '해당 기간에 출발 단계에 처음 도달한 사람 중 다음 단계까지 도달한 비율입니다. 기간 이후 도달도 포함합니다.',
    h('div', { class: 'workbench-path-grid' }, rows.map((row) => h('article', null,
      h('h3', null, row.from, ' ', h('span', { 'aria-hidden': 'true' }, '→'), h('span', { class: 'dashboard-visually-hidden' }, ' 에서 '), ' ', row.to),
      h('div', { class: 'workbench-path-value' }, h('strong', null, rate(row.rate)), h('span', null, `${count(row.count)} / ${count(row.baseCount)}명`)),
      track(row.rate, 'workbench-path-track')))));
}

function classTable(d, me) {
  const rows = d.classCounts || [];
  const stages = rows[0]?.stages || [];
  const conversions = rows[0]?.conversions || [];
  const tone = (value) => (Number.isFinite(value) ? Math.min(4, Math.ceil(value / 25)) : null);
  const columns = 1 + stages.length + conversions.length;
  const drill = canOpen(me, 'classData');
  const label = (row) => (drill
    ? h('button', { type: 'button', class: 'ghost small', 'aria-label': `${row.label} 상세 실적`, onclick: () => drillClass(d, row) }, row.label)
    : row.label);
  const body = rows.length
    ? rows.map((row) => h('tr', null,
      h('th', { scope: 'row' }, label(row)),
      row.stages.map(({ count: n }) => h('td', { class: 'numeric' }, h('strong', null, count(n)))),
      row.conversions.map((c) => h('td', { class: 'numeric' },
        h('span', { class: 'workbench-conversion', 'data-rate-tone': tone(c.rate) }, rate(c.rate)),
        h('small', { class: 'workbench-conversion-base' }, `${count(c.count)} / ${count(c.baseCount)}명`)))))
    : h('tr', null, h('td', { colspan: columns }, emptyNote('반별 실적이 없습니다.')));
  const table = h('table', { id: 'workbench-class-table' },
    h('thead', null, h('tr', null,
      h('th', { scope: 'col' }, '반'),
      stages.map(({ label }) => h('th', { scope: 'col', class: 'numeric' }, label)),
      conversions.map(({ from, to }) => h('th', { scope: 'col', class: 'numeric' }, `${from} → ${to}`)))),
    h('tbody', null, body));
  return h('section', { class: 'panel workbench-classes' },
    h('div', { class: 'panel-head' }, h('div', null, h('h2', null, '반별 단계 실적과 향상률'), h('p', null, '상신일 기준 실적과 출발 단계 기준 향상률을 함께 봅니다.')),
      drill ? menuLink(me, 'classData', '반별 데이터 보기') : null),
    tableScroll('반별 단계 실적과 향상률', table));
}

/** 메뉴에 있는 화면으로만 이동 링크를 만든다. 접근 여부는 서버가 정한다. */
function menuLink(me, id, label) {
  return me.menu?.some((item) => item.id === id) ? h('a', { class: 'dashboard-link', href: `#/${id}` }, label) : null;
}

/* ---------- 활동분석 ---------- */

function activityCoverage(d) {
  const { current, previous } = d.regionalActivity || {};
  if (!current || !previous) return panel('workbench-activity-coverage', '명부 활동기록률', null, emptyNote('현재 명부가 없어 활동기록률을 계산할 수 없습니다.'));
  const total = current.rosterMembers;
  const share = (n) => (total > 0 ? (n / total) * 100 : null);
  const groups = [
    { label: '활동 기록', key: 'active', count: current.active, previous: previous.active },
    { label: '비활동만 기록', key: 'inactive', count: current.recorded - current.active, previous: previous.recorded - previous.active },
    { label: '기록 없음', key: 'missing', count: total - current.recorded, previous: previous.rosterMembers - previous.recorded },
  ];
  const bar = total
    ? h('div', { class: 'workbench-coverage-bar', 'aria-hidden': 'true' }, groups.map((row) => {
      const fill = h('i', { 'data-coverage-group': row.key });
      fill.style.setProperty('--percent', `${clamp(share(row.count))}%`);
      return fill;
    }))
    : null;
  return panel('workbench-activity-coverage', '명부 활동기록률',
    '기간 중 한 번이라도 상태가 기록된 구성원을 한 명으로 셉니다. 활동 기록에는 상태 1~3이 포함됩니다.',
    h('div', { class: 'workbench-coverage-body' },
      h('div', { class: 'workbench-coverage-value' }, h('strong', null, rate(share(current.recorded))), h('span', null, `기록 ${count(current.recorded)}명 / 현재 명부 ${count(total)}명`)),
      bar,
      h('dl', { class: 'workbench-coverage-legend' }, groups.map((row) => h('div', { 'data-coverage-group': row.key },
        h('dt', null, row.label),
        h('dd', null, h('strong', null, `${count(row.count)}명`), h('small', null, `${previousLabel(d)} ${count(row.previous)}명`)))))));
}

function channelMix(d) {
  const participants = new Map((d.totals.activityParticipation || []).map((row) => [row.classification2, row.workers]));
  const rows = (d.categories || [])
    .filter((row) => row.findings > 0 || participants.get(row.classification2) > 0)
    .sort((a, b) => (b.findings ?? 0) - (a.findings ?? 0) || (participants.get(b.classification2) || 0) - (participants.get(a.classification2) || 0));
  const scope = d.source === 'reported'
    ? '구역 일계에는 찾기 분류가 없습니다.'
    : `조회 기간의 전체 찾기 ${count(d.totals.findings)}건을 기준으로 비중을 계산합니다.`;
  const table = h('table', { class: 'workbench-channel-table' },
    h('thead', null, h('tr', null, h('th', { scope: 'col' }, '분류'), ['참여 인원', '찾기 건수', '찾기 비중'].map((t) => h('th', { scope: 'col', class: 'numeric' }, t)))),
    h('tbody', null, rows.map((row) => h('tr', null,
      h('th', { scope: 'row' }, row.label),
      h('td', { class: 'numeric' }, `${count(participants.get(row.classification2) || 0)}명`),
      h('td', { class: 'numeric' }, row.findings === null ? '—' : `${count(row.findings)}건`),
      h('td', { class: 'numeric' }, h('div', { class: 'workbench-share' }, track(row.share, 'workbench-path-track'), rate(row.share)))))));
  return panel('workbench-channel-mix', '분류별 참여와 찾기', `${scope} 참여 인원은 현재 명부 구성원을 분류마다 한 번씩 셉니다.`,
    rows.length ? tableScroll('분류별 참여와 찾기', table) : emptyNote('조회 기간에 분류별 활동·찾기 기록이 없습니다.'));
}

function metric(key, label, value, note) {
  return h('article', { class: 'metric', 'data-overview-metric': key },
    h('div', { class: 'metric-head' }, label), h('div', { class: 'metric-value' }, value), h('p', { class: 'metric-foot' }, note));
}

function activityRates(d) {
  const current = d.regionalActivity?.current;
  const statuses = new Map((d.totals.activityParticipation || []).map((row) => [row.classification2, row]));
  const employment = new Map((d.employmentShares || []).map((row) => [row.id, row]));
  const roster = `명부 ${count(d.totals.members)}명`;
  const cards = [
    metric('regional-activity-rate', '지역 활동자율', rate(current?.activeRosterRate),
      current ? `${count(current.rosterActive)}명 / 명부 ${count(current.rosterMembers)}명` : '현재 명부 없음'),
    ...['노방', '소셜링'].map((type) => metric(`activity-rate-${type}`, `${type} 활동자율`, rate(statuses.get(type)?.rate), `${count(statuses.get(type)?.workers ?? 0)}명 / ${roster}`)),
    ...['전일자', '반일자'].map((type) => metric(`employment-share-${type}`, `${type} 비율`, rate(employment.get(type)?.rate), `${count(employment.get(type)?.members ?? 0)}명 / ${roster}`)),
  ];
  return h('section', { class: 'dashboard-activity-rates' }, h('h2', null, '활동자율'),
    h('div', { class: 'metrics overview-metrics dashboard-activity-grid' }, cards));
}

function regionalActivitySummary(d) {
  const before = previousLabel(d);
  const current = d.regionalActivity?.current;
  const previous = d.regionalActivity?.previous;
  const comparable = Boolean(current && previous);
  const cards = [['활동자', 'active'], ['비활동자', 'inactive']].map(([title, key]) => {
    const now = current?.[key] ?? null;
    const prior = previous?.[key] ?? null;
    return h('article', null,
      h('h3', null, title),
      h('div', { class: 'dashboard-activity-count' }, count(now), now === null ? null : h('small', null, '명')),
      h('div', { class: 'dashboard-activity-comparison' },
        h('span', null, `${before} ${prior === null ? '기록 없음' : `${count(prior)}명`}`),
        change(comparable ? now - prior : null, '명')));
  });
  return h('section', { class: 'panel dashboard-activity-summary', 'aria-label': '지역활동기록 요약' },
    h('div', { class: 'panel-head' }, h('div', null,
      h('h2', null, `${d.periodUnit === 'month' ? '월별' : '주별'} 지역활동기록`),
      h('p', null, `${before} ${d.comparison.from || ''} ~ ${d.comparison.to || ''} 비교`))),
    h('div', { class: 'dashboard-regional-counts' }, cards));
}

/* ---------- 목표 ---------- */

function goalGaps(d) {
  const visible = new Set((d.goalStages || []).map((stage) => stage.id));
  const registered = (d.districts || []).flatMap(({ region, stages }) => stages.filter((s) => visible.has(s.id) && s.target > 0).map((s) => ({ region, ...s })));
  const pending = registered
    .filter((s) => s.actual === null || s.shortfall > 0)
    .sort((a, b) => (b.shortfall ?? -1) - (a.shortfall ?? -1) || a.region.localeCompare(b.region, 'ko', { numeric: true }));
  const summary = registered.length
    ? h('span', { class: 'workbench-goal-summary' },
      `달성 ${count(registered.length - pending.length)}개 · 미달 ${count(pending.filter((s) => s.shortfall > 0).length)}개 · 실적 미확인 ${count(pending.filter((s) => s.actual === null).length)}개`)
    : null;
  const table = h('table', null,
    h('thead', null, h('tr', null, h('th', { scope: 'col' }, '구역'), h('th', { scope: 'col' }, '단계'),
      ['목표', '실적', '남은 건수'].map((t) => h('th', { scope: 'col', class: 'numeric' }, t)))),
    h('tbody', null, pending.map((s) => h('tr', null,
      h('th', { scope: 'row' }, s.region), h('td', null, s.label),
      h('td', { class: 'numeric' }, count(s.target)), h('td', { class: 'numeric' }, count(s.actual)),
      h('td', { class: 'numeric' }, h('strong', null, s.shortfall === null ? '미확인' : `${count(s.shortfall)}건`))))));
  const empty = registered.length ? '이 기간에 등록한 구역별 목표를 모두 달성했습니다.' : '이 기간과 일치하는 1건 이상의 구역 목표가 없습니다.';
  return h('section', { class: 'panel', id: 'workbench-goal-gaps' },
    h('div', { class: 'panel-head' }, h('div', null, h('h2', null, '구역별 목표까지 남은 건수'), h('p', null, '1건 이상 등록한 구역·단계 목표를 비교합니다. 남은 건수가 많은 순서입니다.')), summary),
    pending.length ? h('div', { class: 'table-scroll workbench-goal-table', tabindex: '0', role: 'region', 'aria-label': '구역별 목표까지 남은 건수' }, table) : emptyNote(empty));
}

function stageCards(d, me) {
  const goalsPerm = me.perms?.goals;
  const goalLink = goalsPerm?.write ? menuLink(me, 'goals', '목표 입력') : menuLink(me, 'goals', '목표 보기');
  const cards = (d.goalStages || []).map((s) => {
    const registered = s.target !== null;
    let remaining = '기간 목표 미설정';
    if (registered) {
      if (s.target === 0) remaining = '목표 0건';
      else if (s.shortfall === null) remaining = '실적 미확인';
      else if (s.shortfall === 0) remaining = '구역 목표 달성';
      else remaining = `구역별 총 ${count(s.shortfall)}건 남음`;
    }
    return h('article', { class: 'dashboard-stage-card', 'data-dashboard-goal': s.id },
      h('div', { class: 'dashboard-stage-title' }, s.label, h('span', null, `${count(s.configured)}구역 목표`)),
      h('div', { class: 'dashboard-stage-values' },
        h('strong', null, count(registered ? s.comparedActual : s.actual), h('small', null, registered ? '목표 구역 실적' : '전체 실적')),
        h('span', { 'aria-hidden': 'true' }, '/'),
        h('div', null, count(s.target), h('small', null, '목표'))),
      h('div', { class: 'dashboard-goal-bottom' }, h('span', null, rate(s.rate)), h('span', null, remaining)),
      track(s.rate, 'overview-track'));
  });
  return h('section', { class: 'panel dashboard-stage-section' },
    h('div', { class: 'panel-head' }, h('div', null, h('h2', null, '단계별 목표 달성'), h('p', null, '조회 기간의 최초 상신일 기준 · 찾B는 찾은 날짜')), goalLink),
    h('div', { class: 'dashboard-stage-cards' }, cards),
    h('p', { class: 'dashboard-note' }, '기간이 일치하는 구역 목표의 실적만 달성률에 반영합니다.'));
}

/* ---------- 안내 · 탭 ---------- */

function warnings(d) {
  const lines = [];
  if (d.source === 'reported') lines.push('찾기 건수는 구역 일계 기준입니다. 확인할 수 없는 단계 실적은 —로 표시합니다.');
  if (d.comparison?.source && d.comparison.source !== d.source) lines.push('현재 기간과 비교 기간의 자료원이 다릅니다. 기록 범위를 함께 확인해 주세요.');
  const children = [];
  if (lines.length) children.push(h('div', { class: 'notice warm dashboard-source-note', role: 'note' }, lines.flatMap((line, i) => (i ? [h('br'), line] : [line]))));
  return children;
}

/** 서버가 알려 주는 집계 기준과 주의 사항(자료원, 일계 중복 등)을 접어 둔다. */
function criteria(d) {
  if (!d.notes?.length) return null;
  return h('details', { class: 'dashboard-criteria' },
    h('summary', null, '집계 기준과 주의 사항'),
    h('ul', null, d.notes.map((text) => h('li', null, text))));
}

function tabs(onSelect) {
  const buttons = TABS.map(([key, label]) => h('button', {
    type: 'button', role: 'tab', id: `workbench-tab-${key}`, 'aria-controls': `workbench-panel-${key}`,
    'aria-selected': String(key === state.tab), tabindex: key === state.tab ? '0' : '-1', 'data-workbench-tab': key,
    onclick: () => onSelect(key),
  }, label));
  const list = h('div', { class: 'workbench-tabs', role: 'tablist', 'aria-label': '대시보드 분석 항목' }, buttons);
  list.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const current = buttons.indexOf(event.target.closest('[data-workbench-tab]'));
    if (current < 0) return;
    const step = event.key === 'ArrowLeft' ? -1 : 1;
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (current + step + buttons.length) % buttons.length;
    event.preventDefault();
    buttons[next].focus();
    buttons[next].click();
  });
  return list;
}

function workbench(d, me, go) {
  const views = new Map(TABS.map(([key]) => [key, null]));
  const make = (key, ...content) => h('div', {
    class: 'workbench-view', role: 'tabpanel', id: `workbench-panel-${key}`, 'aria-labelledby': `workbench-tab-${key}`,
    tabindex: '0', 'data-workbench-panel': key, hidden: key !== state.tab,
  }, ...content);
  views.set('results', make('results', scoreboard(d), districtChanges(d, me), h('div', { class: 'workbench-trend-grid' }, trendPanel(d, me), periodHistory(d, go)), pathway(d), classTable(d, me)));
  views.set('participation', make('participation', activityCoverage(d), channelMix(d), activityRates(d), regionalActivitySummary(d)));
  views.set('goals', make('goals', goalGaps(d), stageCards(d, me)));

  const list = tabs((key) => {
    state.tab = key;
    for (const button of list.querySelectorAll('[data-workbench-tab]')) {
      const on = button.dataset.workbenchTab === key;
      button.setAttribute('aria-selected', String(on));
      button.tabIndex = on ? 0 : -1;
    }
    for (const [name, view] of views) view.hidden = name !== key;
  });
  return h('div', { class: 'dashboard-page dashboard-workbench', id: 'dashboard-workbench' }, list, ...warnings(d), ...views.values(), criteria(d));
}

/* ---------- 화면 ---------- */

export async function dashboardView(box, me) {
  await ensureStyles();
  const filterHost = h('div');
  const body = h('div');
  let shown = null;
  let latest = 0;

  const draw = (d) => {
    shown = d;
    filterHost.replaceChildren(filtersSection(d, me, go));
    body.replaceChildren(workbench(d, me, go));
  };

  async function fetchOverview() {
    const query = new URLSearchParams({ period: state.unit });
    if (state.anchor) query.set('anchor', state.anchor);
    return getJson(`/api/dashboard/overview?${query}`);
  }

  /** 조회 단위·기준일을 바꾼다. 실패하면 이전 조회 조건과 화면을 그대로 둔다. */
  async function go(next) {
    const previous = { ...state };
    const ticket = ++latest;
    Object.assign(state, next);
    try {
      const d = await fetchOverview();
      if (ticket === latest) draw(d);
    } catch (err) {
      if (ticket !== latest) return;
      Object.assign(state, previous);
      toast(err.message, 'error');
      if (shown) filterHost.replaceChildren(filtersSection(shown, me, go)); // 잘못 입력한 값을 되돌린다.
    }
  }

  box.append(h('div', { class: 'dashboard-root' }, h('h1', null, '대시보드'), filterHost, body));
  draw(await fetchOverview());
}
