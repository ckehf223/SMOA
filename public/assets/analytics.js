import { getJson, h, toast } from './common.js';
import { countPlot, hourComparisonPlot, stageValue, trendAxis, trendChart } from './analytics-charts.js';
import { download, field, filterForm, formValues, monthStart, note, num, qs, regionOptions, selectOf, statCards, textInput, todayStr } from './records.js';
import { classPage, fullTimePanel, memberPage, regionPage } from './performance-views.js';
import { canOpen, drillOf, keepDrill, openDrill } from './drill.js';
import { optionSearch, searchKey } from './option-search.js';

/**
 * 분석 화면. analyticsViews[id](container, me)
 * 계산은 모두 서버가 요청자의 구역 범위 안에서 하고, 화면은 받은 결과만 보여 준다.
 * 용어·배치·집계 표시는 기존 SMOA 데스크톱의 통계 진단, 단계 실적, 찾기·주관자 화면을 따른다.
 */

if (typeof document !== 'undefined' && !document.querySelector('link[data-analytics-css]')) {
  document.head.append(h('link', { rel: 'stylesheet', href: '/assets/analytics.css', 'data-analytics-css': '' }));
}

const CLASS2 = ['노방', '소셜링', '온라인', '세미나', '기타', { value: '__unclassified__', label: '미입력' }];
const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'].map((label, i) => ({ value: String(i), label: `${label}요일` }));
const hours = (minutes) => num((minutes ?? 0) / 60, 1);
const dash = '—';

/* ---------- 공용 도우미 ---------- */

/** 화면 머리글: 제목 + (권한이 있을 때만) 엑셀 내보내기 */
function header(title, exportButton) {
  return h('div', { class: 'toolbar' }, h('h1', null, title), h('span', { class: 'spacer' }),
    exportButton ? h('div', { class: 'actions' }, exportButton) : null);
}

const exportButton = (perm, getUrl, fallback) => (perm.export
  ? h('button', { type: 'button', class: 'secondary', onclick: () => download(getUrl(), fallback) }, '엑셀 내보내기')
  : null);

let uid = 0;
const nextId = (prefix) => `${prefix}-${++uid}`;

/** 제목이 있는 패널. 본문은 간격을 두고 쌓는다. */
function panel(title, info, ...body) {
  const id = nextId('an-title');
  return h('section', { class: 'an-panel', 'aria-labelledby': id },
    h('h2', { id }, title), info ? h('p', null, info) : null, h('div', { class: 'an-body' }, body));
}

const emptyText = (text) => h('p', { class: 'an-empty' }, text);

/**
 * 첫 칸이 행 머리글(th scope=row)인 표. rows의 한 줄은 칸 배열이거나 { cells, className, current }.
 * 줄이 없으면 표 대신 안내 문구를 보인다. foot은 합계 줄이다.
 */
function gridTable(label, headers, rows, empty = '표시할 자료가 없습니다.', foot = null, numeric = []) {
  if (!rows.length) return emptyText(empty);
  // numeric: 오른쪽 정렬할 숫자 칸의 순번 (원본 class="numeric")
  const align = (i) => (numeric.includes(i) ? 'numeric' : null);
  const line = (row) => {
    const { cells, className, current } = Array.isArray(row) ? { cells: row } : row;
    return h('tr', { class: className, 'aria-current': current ? 'true' : null },
      cells.map((cell, i) => (i === 0 ? h('th', { scope: 'row', class: align(i) }, cell ?? dash) : h('td', { class: align(i) }, cell ?? dash))));
  };
  return h('div', { class: 'an-scroll', role: 'region', 'aria-label': label, tabindex: '0' },
    h('table', null,
      h('thead', null, h('tr', null, headers.map((t, i) => h('th', { scope: 'col', class: align(i) }, t)))),
      h('tbody', null, rows.map(line)),
      foot ? h('tfoot', null, line(foot)) : null));
}

/** 값이 하나인 지표 묶음. items: [라벨, 값(노드 가능), 단위?] */
function figures(items) {
  return h('dl', { class: 'an-figures' }, items.map(([label, value, unit]) =>
    h('div', null, h('dt', null, label), h('dd', null, value, unit ? h('small', null, unit) : null))));
}

/** 접근 가능한 탭. 좌우·Home·End 키로 오가고, 내용은 render(key)가 만든 노드로 바꾼다. */
function tabs({ label, prefix, items, value, render }) {
  const body = h('div', { class: 'an-tabpanel', role: 'tabpanel', id: `${prefix}-panel`, tabindex: '0' });
  const buttons = new Map();
  let current = value;

  function mark() {
    for (const [key, button] of buttons) {
      button.setAttribute('aria-selected', String(key === current));
      button.tabIndex = key === current ? 0 : -1;
    }
    body.setAttribute('aria-labelledby', `${prefix}-tab-${current}`);
  }
  function refresh() {
    mark();
    body.replaceChildren(render(current));
  }
  function select(key) {
    if (key === current) return;
    current = key;
    refresh();
  }

  const bar = h('div', { class: 'an-tabs', role: 'tablist', 'aria-label': label, onkeydown: (e) => {
    if (!['Home', 'End', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return;
    const keys = items.map(([key]) => key);
    const at = keys.indexOf(current);
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? keys.length - 1 : (at + (e.key === 'ArrowRight' ? 1 : -1) + keys.length) % keys.length;
    e.preventDefault();
    select(keys[next]);
    buttons.get(keys[next]).focus();
  } });
  for (const [key, text] of items) {
    const button = h('button', { type: 'button', role: 'tab', id: `${prefix}-tab-${key}`, 'aria-controls': `${prefix}-panel`, onclick: () => select(key) }, text);
    buttons.set(key, button);
    bar.append(button);
  }
  refresh();
  return { bar, body, refresh, current: () => current };
}

/** 모달 대화상자. 닫으면 제거되고 포커스는 브라우저가 열었던 버튼으로 돌려 준다. */
function openDialog({ title, caption, body }) {
  const id = nextId('an-dialog');
  const dialog = h('dialog', { class: 'an-dialog', 'aria-labelledby': id },
    h('h2', { id }, title), caption ? h('p', { class: 'an-caption' }, caption) : null, body,
    h('div', { class: 'an-buttons' }, h('button', { type: 'button', onclick: () => dialog.close() }, '닫기')));
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
}

const rangeError = (from, to) => (from && to && from > to ? '시작일은 종료일보다 늦을 수 없습니다.' : '');
const alertBox = (text) => h('p', { class: 'status error', role: 'alert' }, text);

/** 금주·금월·전체 바로가기. 기간은 서버가 주 시작 요일 설정에 맞춰 내려 준다. */
function presetButtons(presets, state, sync, run) {
  if (!presets?.length) return null;
  return h('div', { class: 'an-presets', role: 'group', 'aria-label': '조회 기간 바로가기' }, presets.map((p) =>
    h('button', {
      type: 'button', class: 'secondary', 'aria-pressed': String((state.from ?? '') === p.from && (state.to ?? '') === p.to),
      onclick: () => { sync(); state.from = p.from; state.to = p.to; run(); },
    }, p.label)));
}

/** 폼의 값을 지정한 키만 state에 옮긴다. 비운 칸은 빈 문자열이 된다. */
function readInto(state, values, keys) {
  for (const key of keys) state[key] = values[key] ?? '';
}

/* ---------- 찾기·주관자 통계 ---------- */

const FINDING_KEYS = ['from', 'to', 'region', 'classification2', 'statsLeaderEmployment'];
const perfTime = (minutes) => `${Math.floor(minutes / 60)}시간 ${Math.round(minutes % 60)}분`;
const perfPercent = (v) => (v == null ? dash : `${(v * 100).toFixed(1)}%`);
const stamp = (value) => (value ? value.replace('T', ' ') : dash);

async function findingStats(box, me) {
  const perm = me.perms.findingStats;
  // 기존 화면의 기본은 노방 전용 주관자 개요다. '찾기 통계'를 고르면 분류2를 직접 정한다.
  const state = { from: monthStart(), to: todayStr(), view: 'leaders' };
  const results = h('div', { class: 'an-page' });
  const formHost = h('div', { class: 'card' });
  let last = null;
  const leaders = () => state.view === 'leaders';
  let token = 0;

  const paramsOf = () => qs({
    from: state.from, to: state.to, region: state.region, view: state.view,
    classification2: leaders() ? '노방' : state.classification2,
    statsLeaderEmployment: leaders() ? state.statsLeaderEmployment : '',
  });

  function drawForm() {
    let form;
    const sync = () => { readInto(state, formValues(form), FINDING_KEYS); };
    const viewSelect = selectOf('view', [{ value: 'leaders', label: '주관자 개요 (노방)' }], state.view, '찾기 통계');
    // 보기를 바꾸면 이전 보기의 결과가 새 조건과 함께 남지 않도록 바로 다시 조회하고, 보기 칸으로 포커스를 돌려 준다.
    viewSelect.addEventListener('change', () => {
      sync();
      state.view = viewSelect.value;
      load();
      formHost.querySelector('select[name="view"]')?.focus();
    });
    // 직업구분 목록은 주관자 개요 응답에만 있다. 다른 보기의 응답이면 비운다.
    const employments = (last?.leaderOverview ? last.leaderOverview.employments ?? [] : []).map((e) => ({ value: e.value, label: e.label }));
    form = filterForm([
      field('시작일', textInput('date', 'from', state.from ?? '')),
      field('종료일', textInput('date', 'to', state.to ?? '')),
      field('구역', selectOf('region', regionOptions(me), state.region ?? '', '전체 구역')),
      field('보기', viewSelect),
      leaders()
        ? field('주관자 직업구분', selectOf('statsLeaderEmployment', employments, state.statsLeaderEmployment ?? '', '전체 직업구분'))
        : field('분류2', selectOf('classification2', CLASS2, state.classification2 ?? '', '전체 분류')),
    ], (values) => {
      readInto(state, values, FINDING_KEYS);
      state.view = values.view ?? '';
      load();
    }, [
      leaders() ? h('span', { class: 'an-fixed' }, '노방 전용') : null,
      presetButtons(last?.presets, state, sync, load),
    ]);
    // 보기별 원본 안내
    formHost.replaceChildren(form, h('p', { class: 'an-note' }, leaders()
      ? '찾은 날짜·시각과 같은 구역의 주관 구간을 연결합니다.'
      : '찾은 날짜·시각으로 일자별·시간대별 찾기를 집계합니다. 활동시간·시간당 효율은 분류2에서 노방을 선택하면 확인할 수 있습니다.'));
  }

  /** 마지막 요청의 응답만 결과와 필터에 반영한다. (보기·조건을 바꾼 뒤 늦게 온 이전 응답은 버린다) */
  async function load() {
    const mine = ++token;
    const wantLeaders = leaders();
    drawForm();
    results.replaceChildren(h('p', { class: 'status' }, '불러오는 중…'));
    let d;
    try {
      d = await getJson(`/api/analytics/finding-stats?${paramsOf()}`);
    } catch (err) {
      if (mine === token) results.replaceChildren(alertBox(err.message));
      return;
    }
    if (mine !== token || wantLeaders !== leaders()) return;
    // 직업구분 목록이나 바로가기가 달라졌을 때만 폼을 다시 그려, 조회 버튼의 포커스를 지킨다.
    const changed = JSON.stringify([last?.leaderOverview?.employments, last?.presets]) !== JSON.stringify([d.leaderOverview?.employments, d.presets]);
    last = d;
    if (changed) {
      const focused = formHost.contains(document.activeElement) ? document.activeElement.name : '';
      drawForm();
      if (focused) formHost.querySelector(`[name="${focused}"]`)?.focus();
    }
    results.replaceChildren(d.leaderOverview ? leaderPage(d) : generalPage(d));
  }

  box.append(header('찾기·주관자 통계', exportButton(perm, () => `/api/analytics/finding-stats/export?${paramsOf()}`, 'smoa-finding-stats.xlsx')), formHost, results);
  await load();
}

const leaderPeak = (leader) => (leader.peakLeadHours ?? []).map(({ label }) => label).join(' · ') || dash;

function leaderButton(d, leader) {
  return h('button', { type: 'button', class: 'an-link', 'aria-label': `${leader.name} 주관 상세 보기`, onclick: () => leaderDetail(d, leader.id) }, leader.name);
}

/** 주관 구간 표: 앞의 500구간만 보이고, 전체는 엑셀로 확인한다. */
function sessionTable(sessions, withName) {
  const shown = sessions.slice(0, 500);
  return [
    gridTable('주관 구간', [...(withName ? ['주관자'] : []), '구역', '시작', '종료', '주관시간(분)', '연결 찾기'],
      shown.map((s) => [...(withName ? [s.name] : []), s.region || '미입력', stamp(s.start), stamp(s.end), num(s.minutes), `${num(s.count)}건`]),
      '시간이 입력된 주관 구간이 없습니다.', null, withName ? [4, 5] : [3, 4]),
    sessions.length > shown.length
      ? h('p', { class: 'an-note' }, `${num(sessions.length)}구간 중 처음 ${num(shown.length)}구간을 표시합니다. 엑셀에서 전체를 확인할 수 있습니다.`)
      : null,
  ];
}

function venueTable(rows) {
  return gridTable('주관자·장소별 회차 성과',
    ['조회 순위', '주관자', '주관 활동 장소', '주관 회차', '참여자 전체 찾기', '점수', '회당 찾기'],
    rows.map((r) => [`${num(r.rank)}위`, r.name, r.place, `${num(r.sessions)}회`, `${num(r.findings)}건`, `${num(r.score)}점`, `${num(r.perSession, 2)}건`]),
    '조회 조건에 맞는 주관 장소와 회차가 없습니다.', null, [3, 4, 5, 6]);
}

function leaderDetail(d, id) {
  const leader = d.leaders.find((row) => row.id === id);
  if (!leader) return;
  const sessions = d.sessions.filter((s) => s.leaderId === id);
  const unresolved = Math.max(0, leader.count - sessions.reduce((sum, s) => sum + s.count, 0));
  const caption = [leader.employmentLabel || '명부 미연결', ...(leader.regions ?? []).map((r) => r || '구역 미입력')].filter(Boolean).join(' · ');
  openDialog({
    title: `${leader.name} 주관 상세`,
    caption,
    body: h('div', { class: 'an-body' },
      h('div', { class: 'an-summary-line' },
        h('span', null, '주관 시간대 찾기 ', h('strong', null, `${num(leader.count)}건`)),
        h('span', null, '주관 구간 ', h('strong', null, `${num(leader.sessionCount)}개`)),
        h('span', null, '주요 주관 시간대 ', h('strong', null, leaderPeak(leader))),
        leader.unknown ? h('span', null, '시간 미입력 주관 기록 ', h('strong', null, `${num(leader.unknown)}건`)) : null),
      h('section', null, h('h3', null, '주관 구간별 연결 찾기'), sessionTable(sessions, false),
        unresolved ? h('p', { class: 'an-note' }, `같은 주관자의 여러 구간과 겹치는 ${num(unresolved)}건은 주관자 합계에 한 번만 포함했습니다.`) : null),
      h('section', null, h('h3', null, '주관 장소별 회차 성과'), venueTable(d.leaderOverview.venueScores.rows.filter((row) => row.leaderId === id)))),
  });
}

/** 주관자 개요(노방 전용): 원본 화면의 순서 — 상위 횟수, 요약, 장소별 성과, 주관자별 찾기. */
function leaderPage(d) {
  const scope = d.leaderOverview;
  if (!d.total && !d.leaders.length && !d.sessions.length) return emptyText('선택 조건에 노방 찾기와 주관 기록이 없습니다.');

  const linked = scope.assignedGlobal ?? d.matched;
  const assigned = scope.assigned ?? d.matched;
  const missing = d.total - linked;
  const reasons = [
    ['찾은 시각 미입력', d.unassigned.unknownTime], ['구역 미입력', d.unassigned.unknownRegion],
    ['해당 시간에 주관 기록 없음', d.unassigned.noSession], ['여러 주관자의 시간 겹침', d.unassigned.ambiguous],
  ].filter(([, count]) => count > 0).sort((a, b) => b[1] - a[1]);
  const cards = [
    ['기간·구역 내 노방 찾기', d.total, '건', d.total ? `주관 연결 ${((linked / d.total) * 100).toFixed(1)}%` : '집계할 찾기 기록 없음'],
    ['조회 조건에 연결된 찾기', assigned, '건', scope.outsideEmployment ? `다른 직업구분에 연결 ${num(scope.outsideEmployment)}건` : '현재 주관자 조회 조건 기준'],
    ['주관자', d.leaderCount ?? d.leaders.length, '명', `주관 구간 ${num(d.sessions.length)}개`],
    ['주관 구간 미연결', missing, '건', '선택 기간·구역 전체 기준'],
  ].map(([label, value, unit, foot], i) => h('article', { class: 'card an-metric' },
    h('h3', null, label), h('div', { class: 'an-value' }, num(value), h('small', null, unit)), h('div', { class: 'an-foot' }, foot),
    i === 3 && missing > 0
      ? h('details', null, h('summary', null, '미연결 사유'), h('dl', null, reasons.map(([name, count]) => h('div', null, h('dt', null, name), h('dd', null, `${num(count)}건`)))))
      : null));

  const vs = scope.venueScores;
  const ranking = scope.topBySessions ?? [];

  return h('div', { class: 'an-page' },
    note(`${d.from || '전체 시작'} ~ ${d.to || '전체'} · ${d.region || '전체 구역'} · ${scope.employmentLabel || '전체 직업구분'}`),
    panel('기간 내 주관 횟수 상위', '조회 조건에 맞는 주관 구간을 기준으로 공동 순위를 표시합니다.',
      ranking.length
        ? h('div', { class: 'an-ranking' }, ranking.map(({ rank, count, leaders: ranked }) => h('article', { 'data-rank': rank },
          h('h3', null, `${rank}위`, h('span', null, `${num(count)}회`)),
          h('ul', null, ranked.map((leader) => h('li', null, leaderButton(d, leader)))))))
        : emptyText('선택 조건에 시간이 입력된 주관 기록이 없습니다.')),
    h('div', { class: 'cards' }, cards),
    panel('주관자·장소별 회차 성과', '각 장소에서 주관한 회차에 참여한 사람들의 찾기를 합산합니다. 고유 찾기 1건은 1점이며 회당 평균에 0건 회차도 포함합니다.',
      venueTable(vs.rows),
      h('p', { class: 'an-note' }, `조회 조건에서 연결된 찾기 ${num(vs.assigned)}건${vs.outsideEmployment ? ` · 다른 직업구분에서 연결 ${num(vs.outsideEmployment)}건` : ''}`),
      h('p', { class: 'an-note' }, `선택 기간·구역 전체에서 회차 후보 중복 ${num(vs.ambiguous)}건 · 연결 근거 부족 ${num(vs.unmatched)}건 · 주관자·장소 확인 필요 ${num(vs.unclearSessions)}회 · 시간 미입력 주관 기록 ${num(vs.untimedLeaderRecords)}건`),
      h('details', { class: 'an-more' }, h('summary', null, '회차와 찾기를 연결하는 기준'),
        h('p', null, '활동공지의 회차ID로 참여자를 묶습니다. 참여자가 기록한 구역에서 주관자와 참여자의 활동 시간이 겹치는 동안 발생한 찾기를 연결합니다. 회차ID가 없는 활동은 같은 구역과 활동 장소에서 주관자와 참여자의 활동 시간이 겹쳐야 연결합니다. 주관자·장소와 회차가 하나로 확인된 찾기를 한 번 집계합니다. 구역을 선택하면 그 구역의 참여 기록과 찾기를 집계합니다.'))),
    panel('주관자별 찾기', '주관 시간대에 같은 구역에서 발생한 찾기를 집계합니다. 이름을 누르면 개인별 주관 구간을 확인할 수 있습니다.',
      gridTable('주관자별 찾기', ['주관자', '직업구분', '주관 시간대 찾기', '주요 주관 시간대', '순주관시간', '주관 효율'],
        d.leaders.map((l) => [leaderButton(d, l), l.employmentLabel || '명부 미연결', `${num(l.count)}건`, leaderPeak(l), l.minutes ? perfTime(l.minutes) : dash, perfPercent(l.efficiency)]),
        '선택 조건에 맞는 주관 기록이 없습니다.', null, [2, 4, 5]),
      h('p', { class: 'an-note' }, '주요 주관 시간대는 주관한 시간이 가장 긴 시간대입니다. 효율은 중복 시간을 제외한 순주관시간 1시간당 찾기 1건을 100%로 표시합니다.')),
    h('details', { class: 'an-more' }, h('summary', null, '찾기와 주관을 연결하는 기준'),
      h('p', null, '분이 기록된 찾기는 실제 시각으로, 시간대만 보고된 찾기는 해당 시간대와 주관의 시작·종료 시각으로 연결합니다. 여러 주관자에게 겹치는 찾기는 개인 실적 집계에서 제외합니다.'),
      h('p', null, '같은 주관자의 여러 구간과 겹치는 찾기는 한 번 집계합니다.')),
    h('details', { class: 'an-more' }, h('summary', null, '시간대별·일자별·주관 구간 전체 보기'),
      h('div', { class: 'an-body' },
        h('h3', null, '주관 시간대별 찾기'), plotBox(scope.hours, '주관 시간대별 찾기 건수', 'bar', '선택 기간에 찾기 기록이 없습니다.'),
        h('h3', null, '일자별 찾기'), plotBox(d.days.slice(-366).map((x) => ({ label: x.date, value: x.total })), '일자별 찾기 건수', 'line', '선택 기간에 찾기 기록이 없습니다.'),
        h('h3', null, '주관 구간'), sessionTable(d.sessions, true))));
}

/** 그래프를 가로 스크롤 영역에 담는다. 값이 모두 0이면 안내를 보인다. */
function plotBox(data, title, type, empty) {
  if (!data.length || !data.some((r) => r.value)) return emptyText(empty);
  return h('div', { class: 'an-scroll', role: 'region', 'aria-label': `${title} 그래프 가로 스크롤`, tabindex: '0' }, countPlot(data, title, type));
}

/** 분류2를 직접 고르는 '찾기 통계' 보기. 원본의 일자·시간대 그래프와 함께 표를 보인다. */
function generalPage(d) {
  const un = d.unassigned;
  if (!d.total && !d.leaders.length && !d.sessions.length) return emptyText('선택 기간에 찾기 기록이 없습니다.');
  const comparison = d.activityComparison?.hours;
  return h('div', { class: 'an-page' },
    statCards([[num(d.total), '찾기 건수'], [num(d.timed), '시각이 있는 건수'], [num(d.matched), '주관자 연결'], [num(d.leaderCount), '주관자 수']]),
    panel('연결하지 못한 건수', null, gridTable('연결하지 못한 건수', ['시각 미입력', '구역 미입력', '활동 구간 없음', '여러 활동자 중복', '회차 불확실'],
      [[num(un.unknownTime), num(un.unknownRegion), num(un.noSession), num(un.ambiguous), num(d.sessionUncertain)]], undefined, null, [0, 1, 2, 3, 4])),
    panel('시간대별 찾기', null, plotBox(d.hours.map((x) => ({ label: x.label, value: x.value })), '시간대별 찾기 건수', 'bar', '선택 기간에 찾기 기록이 없습니다.')),
    comparison
      ? panel('활동 시간대 · 찾기 발생 시간대', null,
        h('div', { class: 'an-legend' }, h('span', { class: 'an-key-workers' }, '활동자 수(명)'), h('span', { class: 'an-key-findings' }, '찾기 건수(건)')),
        h('div', { class: 'an-scroll', role: 'region', 'aria-label': '시간대별 활동자 수와 찾기 건수 그래프 가로 스크롤', tabindex: '0' }, hourComparisonPlot(comparison)))
      : null,
    panel('주관자별', null, gridTable('주관자별 찾기', ['주관자', '구역', '찾기', '활동 인시간', '인시간당 찾기'],
      d.leaders.map((l) => [h('span', { class: 'strong' }, l.name), l.region || '미입력', num(l.count), hours(l.minutes), num(l.perHour, 2)]), undefined, null, [2, 3, 4])),
    panel('일자별', null,
      plotBox(d.days.slice(-366).map((x) => ({ label: x.date, value: x.total })), '일자별 찾기 건수', 'line', '선택 기간에 찾기 기록이 없습니다.'),
      gridTable('일자별 찾기', ['날짜', '찾기', '시각 미입력'], d.days.slice(-366).map((x) => [x.date, num(x.total), num(x.unknown)]), undefined, null, [1, 2])),
    panel('주관 회차', null, gridTable('주관 회차', ['주관자', '구역', '시작', '종료', '분', '연결 찾기'],
      d.sessions.slice(0, 500).map((s) => [s.name, s.region || '미입력', stamp(s.start), stamp(s.end), num(s.minutes), num(s.count)]), undefined, null, [4, 5])));
}

/* ---------- 구역·개인·반 데이터 ---------- */

/*
 * 화면 본문은 performance-views.js(원본 district-overview.js·performance.js)가 그린다. 여기서는 조회 조건과 불러오기만 맡는다.
 * 대시보드·반별 데이터에서 상세 이동으로 열면(drill.js) 그 조건으로 첫 조회를 한다. 메뉴로 열면 기본값(금월·노방)이다.
 */
const PERF_KEYS = ['from', 'to', 'region', 'classification2', 'statsClass', 'statsEmployment', 'statsMember'];
const PERF_PAGES = { regionData: regionPage, memberData: memberPage, classData: classPage };
const PERF_HINT = {
  regionData: '분류2는 찾기·단계 지표에 적용됩니다. 참여율은 노방·소셜링, 시간대별 효율은 노방을 집계합니다.',
  other: '찾기: 찾은 날짜 · 단계 실적: 최초 도달일 · 활동: 기록 날짜·시간 · 분류2에 따라 분리 집계',
};
/** 원본 화면의 기본 조회 조건(조건 초기화도 같은 분류로 돌아간다). */
const perfDefaults = () => ({ from: monthStart(), to: todayStr(), region: '', classification2: '노방', statsClass: '', statsEmployment: '', statsMember: '' });

/** embed가 있으면 머리글 없이 그 화면의 엑셀 단추만 넘긴다. (개인별 데이터 탭) */
function performanceView(kind, title, slug) {
  return async (box, me, embed) => {
    const perm = me.perms[kind];
    const state = perfDefaults();
    const drill = drillOf(kind);
    if (drill) for (const key of PERF_KEYS) if (key in drill) state[key] = drill[key];
    // 메뉴로 처음 열면 원본처럼 금주(서버 주 시작 요일)로 조회한다. 기간은 첫 응답의 from/to로 채운다.
    let initialWeek = !drill;
    if (initialWeek) Object.assign(state, { from: '', to: '' });
    const results = h('div', { class: 'perf-results' });
    const formHost = h('div', { class: 'card' });
    const paramsOf = (week = false) => qs(week ? { ...state, period: 'week' } : state);
    let last = null;
    let token = 0;
    let detailsOpen = false;
    let memberQuery = '';

    const ctx = {
      /** 같은 화면에서 조건을 바꿔 다시 조회한다. (구역 좁히기, 인도자 선택 등) */
      go(patch) { Object.assign(state, patch); load(); },
      /** 받은 자료로만 다시 그린다. (정렬) */
      redraw(focus) {
        if (!last) return;
        results.replaceChildren(PERF_PAGES[kind](last, ctx));
        if (focus) results.querySelector(focus)?.focus();
      },
      detailsOpen: () => detailsOpen,
      setDetailsOpen: (open) => { detailsOpen = open; },
      // 원본 perf-group-drill: 반 이름 → 같은 조건의 그 반 개인별 실적
      drillMember: kind === 'classData' && canOpen(me, 'memberData')
        ? (row) => openDrill('memberData', {
          from: state.from, to: state.to, region: state.region, classification2: state.classification2,
          statsEmployment: state.statsEmployment, statsClass: row.className || '__unclassified__', statsMember: '',
        })
        : null,
    };

    function buildForm(d) {
      let form;
      const sync = () => { readInto(state, formValues(form), PERF_KEYS); };
      const classes = d?.classes ?? d?.options?.classes ?? [];
      const employments = d?.employments ?? d?.options?.employments ?? [];
      // 인도자: 서버가 읽기 범위로 내려 준 d.members만 이름·구역으로 걸러 고른다. (선택은 조회를 눌러 적용)
      let memberSelect = null;
      let memberSearch = null;
      if (kind === 'memberData') {
        memberSelect = selectOf('statsMember', [], '', '전체 인도자');
        memberSelect.append(...(d?.members ?? []).map((m) => h('option', { value: m.key, 'data-search': searchKey(m.name, m.region || '구역 미입력') },
          `${m.name} · ${m.region || '구역 미입력'}`)));
        memberSelect.value = state.statsMember ?? '';
        memberSearch = optionSearch(memberSelect, { label: '인도자 찾기', placeholder: '이름·구역' });
        memberSearch.input.dataset.memberSearch = '';
        memberSearch.input.addEventListener('input', () => { memberQuery = memberSearch.input.value; });
        if (memberQuery) {
          memberSearch.input.value = memberQuery;
          memberSearch.input.dispatchEvent(new Event('input'));
        }
      }
      form = filterForm([
        field('시작일', textInput('date', 'from', state.from ?? '')),
        field('종료일', textInput('date', 'to', state.to ?? '')),
        field('구역', selectOf('region', regionOptions(me), state.region ?? '', '전체 구역')),
        field('반', selectOf('statsClass', classes, state.statsClass ?? '', '전체 반')),
        field('직업구분', selectOf('statsEmployment', employments, state.statsEmployment ?? '', '전체 직업구분')),
        field('분류2', selectOf('classification2', CLASS2, state.classification2 ?? '', '전체 분류')),
        memberSearch ? field('인도자 찾기 (이름·구역)', memberSearch.element) : null,
        memberSelect ? field('인도자', memberSelect) : null,
      ], (values) => { readInto(state, values, PERF_KEYS); load(); }, [
        presetButtons(d?.presets, state, sync, load),
        h('button', {
          type: 'button', class: 'secondary',
          onclick: () => { sync(); Object.assign(state, { region: '', statsMember: '', statsClass: '', statsEmployment: '', classification2: '노방' }); load(); },
        }, '조건 초기화'),
      ]);
      formHost.replaceChildren(form, h('p', { class: 'an-note perf-filter-hint' }, kind === 'regionData' ? PERF_HINT.regionData : PERF_HINT.other));
    }

    /**
     * 폼을 다시 그려도 사용 중이던 칸(이름이 같은 칸, 인도자 찾기)의 포커스와 커서를 지킨다.
     * 조회 중 응답이 와서 폼이 바뀌어도 검색어 입력·화살표 선택이 끊기지 않게 한다.
     */
    function rebuildForm(d) {
      const active = formHost.contains(document.activeElement) ? document.activeElement : null;
      const selector = !active ? null
        : 'memberSearch' in active.dataset ? '[data-member-search]'
          : active.name ? `[name="${active.name}"]` : null;
      const caret = active && typeof active.selectionStart === 'number' ? [active.selectionStart, active.selectionEnd] : null;
      // 아직 조회에 반영하지 않은 선택 칸의 값(화살표로 고른 인도자 등)은 화면에서 유지한다.
      const pending = active?.tagName === 'SELECT' ? active.value : null;
      buildForm(d);
      if (!selector) return;
      const next = formHost.querySelector(selector);
      if (!next) return;
      if (pending !== null && [...next.options].some((o) => o.value === pending)) next.value = pending;
      next.focus();
      if (caret) try { next.setSelectionRange(...caret); } catch { /* 커서가 없는 칸 */ }
    }

    async function load() {
      const mine = ++token;
      const week = initialWeek && !state.from && !state.to;
      initialWeek = false;
      rebuildForm(last);
      results.replaceChildren(h('p', { class: 'status' }, '불러오는 중…'));
      let d;
      try {
        d = await getJson(`/api/analytics/${slug}?${paramsOf(week)}`);
      } catch (err) {
        if (mine === token) {
          if (week) initialWeek = true;
          results.replaceChildren(alertBox(err.message));
        }
        return;
      }
      if (mine !== token) return;
      last = d;
      if (week) { state.from = d.from ?? ''; state.to = d.to ?? ''; }
      // 서버가 반 이름을 코드로 맞추거나 범위 밖 인도자를 비우면 그 값을 조건으로 삼는다.
      state.statsClass = d.selectedClass ?? state.statsClass;
      if (kind === 'memberData') state.statsMember = d.selectedMember ?? '';
      keepDrill(kind, state);
      rebuildForm(d);
      results.replaceChildren(PERF_PAGES[kind](d, ctx));
    }

    const exportAction = exportButton(perm, () => `/api/analytics/${slug}/export?${paramsOf()}`, `smoa-${slug}.xlsx`);
    if (embed) embed.setExport(exportAction);
    else box.append(header(title, exportAction));
    box.append(formHost, results);
    await load();
  };
}

/* ---------- 통계 진단 ---------- */

const DIAGNOSTIC_TABS = [['review', '기간 비교'], ['activity', '장소·시간대'], ['progress', '단계·모임'], ['staffing', '반별 인력'], ['people', '대상자 구성']];
const dnum = (n) => (Number.isFinite(n) ? Number(n).toLocaleString('ko-KR', { maximumFractionDigits: 2 }) : '산출 불가');
const dpct = (n) => (Number.isFinite(n) ? `${dnum(n * 100)}%` : '산출 불가');
const dtime = (minutes) => `${dnum(minutes / 60)} 인시간`;
const dhour = (hour) => (hour == null ? '시각 미입력' : `${String(hour).padStart(2, '0')}시`);
const dclass = (value) => (/^\d+$/.test(value ?? '') ? `${value}반` : (value || '반 미입력'));
const korean = (a, b) => a.localeCompare(b, 'ko', { numeric: true });

function reviewTab(d) {
  const cards = d.review.map((row) => {
    const isRate = row.unit === '%';
    const value = (n) => (Number.isFinite(n) ? (isRate ? dpct(n) : `${dnum(n)} ${row.unit}`) : '산출 불가');
    const delta = Number.isFinite(row.delta)
      ? `${row.delta > 0 ? '+' : ''}${dnum(isRate ? row.delta * 100 : row.delta)}${isRate ? '%p' : ` ${row.unit}`}`
      : '산출 불가';
    return h('article', { class: 'an-card' },
      h('header', null, h('h3', null, row.title), h('span', { class: 'an-status' }, row.status)),
      h('strong', { class: 'an-main' }, value(row.current)),
      h('p', null, row.sample),
      h('dl', null, h('div', null, h('dt', null, '직전 기간'), h('dd', null, value(row.previous))), h('div', null, h('dt', null, '증감'), h('dd', null, delta))),
      h('p', null, `직전 기준 · ${row.priorSample}`),
      h('p', null, row.reason));
  });
  const unit = d.period.kind === 'month' ? '월' : '주';
  return h('div', { class: 'an-page' }, panel('이번 기간의 변화',
    `직전 ${unit} ${d.previous.from} ~ ${d.previous.to}와 비교합니다. 관찰 기준일 ${d.period.asOf}. 기준 기간 ${d.period.from} ~ ${d.period.to} · 그 전 ${d.earlier.from} ~ ${d.earlier.to}`,
    cards.length ? h('div', { class: 'an-review-grid' }, cards) : emptyText('비교할 항목이 없습니다.')));
}

function qualityPanel(d) {
  const q = d.activity.quality;
  return panel('노방 기록 확인', '장소·시간대의 조회 조건을 적용한 수치입니다. 미입력·미연결 건수는 서로 겹칠 수 있습니다.',
    figures([
      ['찾기 장소 미입력', dnum(q.missingPlace), '건'], ['찾은 시각 미입력', dnum(q.missingTime), '건'],
      ['활동 미연결 찾기', dnum(d.activity.totals.unmatched), '건'], ['활동 시각 미입력', dnum(q.unknownActivityTime), '건'],
      ['활동 장소 미입력', dnum(q.unknownActivityPlace), '건'], ['활동자 미확인', dnum(q.unknownWorker), '건'],
      ['활동 귀속 충돌', dnum(q.conflictMinutes), '분'],
    ]));
}

/** 칸을 눌렀을 때 보이는 날짜·회차별 내역 */
function cellDetail(activity, index) {
  const cell = activity.cells[index];
  const title = `${cell.place || '장소 미입력'} · ${dhour(cell.hour)}`;
  const rows = activity.details.filter((r) => r.place === cell.place && r.hour === cell.hour).map((r) => [
    r.date, r.region || '구역 미입력', dclass(r.className), dnum(r.session), dnum(r.workers), dtime(r.minutes),
    dnum(r.findings), dnum(r.matched), dnum(r.unmatched), dnum(r.perHour),
  ]);
  return [
    h('h3', null, title),
    figures([
      ['활동 회차', dnum(cell.sessions), '회'], ['고유 활동자', dnum(cell.workers), '명'], ['전체 찾기', dnum(cell.findings), '건'], ['미연결', dnum(cell.unmatched), '건'],
      ['10인시간당 7일 내 만픽', dnum(cell.perTenHours7), Number.isFinite(cell.perTenHours7) ? '명' : null],
    ]),
    h('p', { class: 'an-note' }, `${dnum(cell.reached7)}명 / 관찰 완료 ${dtime(cell.matureMinutes)}`),
    gridTable(title, ['날짜', '구역', '반', '회차', '활동자', '순인시간', '전체 찾기', '연결', '미연결', '건/인시간'], rows, '이 칸에 해당하는 기록이 없습니다.'),
  ];
}

function activityTab(d, refetchWith) {
  const { activity } = d;
  const { cells } = activity;
  const { region, weekday, regions } = d.venueOptions;
  const venueSelect = (name, options, value, all) => {
    const select = selectOf(name, options, value, all);
    select.addEventListener('change', () => refetchWith(name, select.value));
    return select;
  };
  const filters = h('div', { class: 'an-venue', role: 'group', 'aria-label': '장소·시간대 조회 조건' },
    field('구역', venueSelect('venueRegion', regions.map((r) => ({ value: r, label: r })), region, '전체 구역')),
    field('요일', venueSelect('venueWeekday', WEEKDAYS, String(weekday), '전체 요일')));
  if (!cells.length) {
    return h('div', { class: 'an-page' }, panel('장소·시간대별 노방 활동', null, filters, emptyText('조회 조건에 노방 활동·찾기 기록이 없습니다.')), qualityPanel(d));
  }

  const places = [...new Set(cells.map((c) => c.place))].sort((a, b) => Number(!a) - Number(!b) || korean(a, b));
  const hourList = [...new Set(cells.map((c) => c.hour))].sort((a, b) => (a ?? 24) - (b ?? 24));
  const byPlace = new Map(places.map((place) => [place, new Map()]));
  let peak = 0;
  cells.forEach((c, index) => {
    byPlace.get(c.place).set(c.hour, index);
    if (Number.isFinite(c.perHour)) peak = Math.max(c.perHour, peak);
  });

  const detail = h('div', { class: 'an-detail', id: 'an-cell-detail', 'aria-live': 'polite', hidden: true });
  const matrix = h('div', { class: 'an-scroll', role: 'region', 'aria-label': '장소·시간대별 연결된 찾기', tabindex: '0' },
    h('table', { class: 'an-heat' },
      h('thead', null, h('tr', null, h('th', { scope: 'col' }, '장소'), hourList.map((hour) => h('th', { scope: 'col' }, dhour(hour))))),
      h('tbody', null, places.map((place) => h('tr', null,
        h('th', { scope: 'row' }, place || '장소 미입력'),
        hourList.map((hour) => {
          const index = byPlace.get(place).get(hour);
          if (index === undefined) return h('td', { class: 'an-heat-none' }, '기록 없음');
          const c = cells[index];
          const measurable = Number.isFinite(c.perHour);
          const level = measurable && peak > 0 ? Math.ceil((3 * c.perHour) / peak) : 0;
          const text = measurable ? `${dnum(c.perHour)}건/인시간` : '산출 불가';
          const count = measurable ? `${dnum(c.matched)}건 / ${dtime(c.minutes)}` : `총 ${dnum(c.findings)}건 · 인시간 미확인`;
          const button = h('button', {
            type: 'button', class: 'an-heat-cell', 'data-level': level, 'aria-pressed': 'false', 'aria-controls': 'an-cell-detail',
            'aria-label': `${place || '장소 미입력'} ${dhour(hour)} 상세, ${text}, ${count}`,
            onclick: () => {
              for (const other of matrix.querySelectorAll('[aria-pressed="true"]')) other.setAttribute('aria-pressed', 'false');
              button.setAttribute('aria-pressed', 'true');
              detail.replaceChildren(...cellDetail(activity, index));
              detail.hidden = false;
            },
          }, h('strong', null, text), h('small', null, count));
          return h('td', null, button);
        }))))));

  const t = activity.totals;
  return h('div', { class: 'an-page' },
    panel('장소·시간대별 노방 활동',
      '같은 활동자·구역·반·장소의 활동 중 찾은 건수를 순인시간으로 나눕니다. 칸을 누르면 날짜·회차별 내역을 볼 수 있습니다.',
      filters,
      figures([['전체 찾기', dnum(t.findings), '건'], ['활동 연결', dnum(t.matched), '건'], ['미연결', dnum(t.unmatched), '건'], ['순인시간', dnum(t.minutes / 60), '인시간']]),
      matrix, detail),
    qualityPanel(d));
}

function cohortRow(label, row) {
  return [label, dnum(row.started), dnum(row.mature), dnum(row.reached), dnum(row.observing), dpct(row.rate)];
}

function progressTab(d) {
  const columns = ['기간 내 출발', '관찰 완료', '기한 내 도달', '관찰 중', '도달률'];
  const details = d.windows.map((w, i) => {
    const title = `${w.label} · ${w.days}일`;
    return h('details', { class: 'an-more' }, h('summary', null, `${title} 구역·반별 내역`),
      gridTable(title, ['출발 당시 구역·반', ...columns], w.groups.map((g) => cohortRow(`${g.region || '구역 미입력'} · ${dclass(g.className)}`, g)), '조회 기간에 이 단계의 출발 기록이 없습니다.'));
  });
  return h('div', { class: 'an-page' },
    panel('단계별 기한 내 도달률', `${d.period.asOf}까지 관찰 기한을 모두 채운 출발 인원 중 도달한 비율입니다. 같은 날 도달한 사람도 포함합니다.`,
      gridTable('단계별 도달률', ['단계 · 기한', ...columns], d.windows.map((w) => cohortRow(`${w.label} · ${w.days}일`, w)), '조회할 단계가 없습니다.'),
      details,
      h('p', { class: 'an-note' }, `대상자별 도달을 확인할 수 없는 구역 일계 ${dnum(d.aggregateOnlyReports)}건은 기한 내 도달률에서 제외합니다.`)),
    panel('소셜링 유입 후 찾B', '실제 외부유입일을 출발일로 사용합니다. 관찰 완료와 관찰 중 인원을 모임별로 표시합니다.',
      gridTable('모임별 찾B 도달률', ['모임 · 기한', ...columns], d.socialing.map((r) => cohortRow(`${r.label} · ${r.days}일`, r)), '조회 기간의 모임 유입 기록이 없습니다.')));
}

const ROLES = [['fullTime', '전일자'], ['halfTime', '반일자'], ['employed', '직장인'], ['other', '기타'], ['unknown', '미입력']];

function staffingTab(d) {
  const { rows, associations, basis } = d.staffing;
  const none = '조회 조건에 해당하는 반이 없습니다.';
  const counts = rows.map((r) => [dclass(r.label), dnum(r.roster), ...ROLES.map(([key]) => `${dnum(r[key])}명 · ${r.roster ? dpct(r[key] / r.roster) : '산출 불가'}`)]);
  const participation = rows.map((r) => [dclass(r.label), dnum(r.participants), ...ROLES.map(([key]) => dnum(r.participantsByRole[key])), dnum(r.streetHours), dnum(r.matchedFindings), dnum(r.perStreetHour)]);
  const results = rows.map((r) => [dclass(r.label), dnum(r.findings), dnum(r.eligible), dnum(r.reached), dnum(r.pending), dpct(r.progressRate)]);
  const links = associations.map((a) => h('article', { class: 'an-card' },
    h('h3', null, `${a.label} ↔ ${a.outcomeLabel}`), h('strong', { class: 'an-main' }, dnum(a.rho)),
    h('p', null, `${dnum(a.sampleSize)}개 구역·반 · ${dnum(a.regionCount)}개 구역`), a.reason ? h('p', null, a.reason) : null));
  return h('div', { class: 'an-page' },
    panel('반별 명부 구성', basis, gridTable('현재 명부 직업구분', ['반', '명부 인원', ...ROLES.map(([, label]) => label)], counts, none)),
    panel('실제 노방 참여', '명부에 연결된 고유 참여 인원과 노방 활동 인시간을 함께 봅니다.',
      gridTable('반별 노방 참여', ['반', '참여자', ...ROLES.map(([, label]) => label), '순인시간', '연결 찾기', '건/인시간'], participation, none)),
    panel('반별 찾기와 7일 내 만픽', '관찰 기한을 채운 찾B를 기준으로 도달률을 계산합니다.',
      gridTable('반별 찾기 및 도달', ['반', '찾기', '관찰 완료', '도달', '관찰 중', '도달률'], results, none)),
    panel('명부 구성과 실적의 관계', '스피어만 순위상관계수는 −1에서 +1 사이입니다. 장소·활동시간·팀 규모가 다른 반의 관찰값이므로 인력 배치 효과를 추정하기 어렵습니다.',
      links.length ? h('div', { class: 'an-assoc-grid' }, links) : emptyText('계산할 구역·반이 없습니다.')));
}

function peopleTab(d) {
  const m = d.demographics;
  if (!m.available) {
    return h('div', { class: 'an-page' }, panel('대상자 구성', null, emptyText('구역 일계만 있는 기간입니다. 나이·성별·거주지 구성을 보려면 개인별 찾기 기록이 필요합니다.')));
  }
  const cards = [['age', '나이'], ['gender', '성별'], ['residence', '거주 권역']].map(([key, label]) => {
    const v = m[key];
    return h('article', { class: 'an-card' }, h('h3', null, label),
      h('p', null, `입력 ${dnum(v.recorded)}명 · 미입력 ${dnum(v.unknown)}명${v.unclear ? ` · 확인 필요 ${dnum(v.unclear)}명` : ''}`),
      gridTable(label, ['구분', '인원', '구성비'], v.rows.map((r) => [r.label, `${dnum(r.count)}명`, dpct(r.share)]), '조회 기간에 대상자 기록이 없습니다.'));
  });
  return h('div', { class: 'an-page' }, panel('대상자 구성',
    `구성비는 미입력을 포함해 조회 기간에 찾은 고유 대상자 ${dnum(m.total)}명을 기준으로 합니다. 나이는 저장된 값이며 거주지는 확인된 행정구역으로 묶습니다.`,
    h('div', { class: 'an-people-grid' }, cards)));
}

/** 기간 시작일에서 한 기간 앞뒤로 옮긴 기준일 (대시보드 shiftedAnchor와 같은 규칙, 월은 1일 기준) */
function shiftedPeriod(period, direction) {
  const date = new Date(`${period.from}T12:00:00Z`);
  if (period.kind === 'month') {
    date.setUTCDate(1);
    date.setUTCMonth(date.getUTCMonth() + direction);
  } else date.setUTCDate(date.getUTCDate() + direction * 7);
  return date.toISOString().slice(0, 10);
}

async function diagnostics(box, me) {
  // anchor가 비어 있으면 서버의 오늘(관찰 기준일)이다. 원본 diagnostic-period.js와 같은 kind/anchor만 보낸다.
  const state = { kind: 'week', anchor: '', venueRegion: '', venueWeekday: '' };
  const results = h('div');
  const formHost = h('div', { class: 'card' });
  let data = null;
  let tab = 'review';
  let token = 0;

  /** 원본 통계 진단 기간 조작: 주별·월별, 이전·다음, 기준일(달) 입력, 이번 주·달, 선택 범위 */
  function drawForm() {
    const asOf = data?.period?.asOf || todayStr();
    // 응답 전(또는 단위를 바꾼 직후)에는 요청한 조건으로 그린다.
    const period = data?.period && data.period.kind === state.kind ? data.period : null;
    const monthly = state.kind === 'month';
    const anchor = state.anchor || asOf;
    const label = monthly ? '조회월' : '주 기준일';
    const active = formHost.contains(document.activeElement) ? document.activeElement.dataset.diag : '';
    const go = (patch) => { Object.assign(state, patch); load(); };
    const unit = (kind, text) => h('button', {
      type: 'button', class: state.kind === kind ? '' : 'secondary', 'aria-pressed': String(state.kind === kind), 'data-diag': `unit-${kind}`,
      onclick: () => { if (state.kind !== kind) go({ kind }); },
    }, text);
    const end = period ? period.periodEnd ?? period.to : anchor;
    const shift = (direction, text, glyph) => h('button', {
      type: 'button', class: 'secondary icon', 'aria-label': text, 'data-diag': `shift${direction}`,
      disabled: !period || (direction > 0 && end >= asOf),
      onclick: () => { if (period) go({ anchor: shiftedPeriod(period, direction) }); },
    }, h('span', { 'aria-hidden': 'true' }, glyph));
    const input = h('input', {
      type: monthly ? 'month' : 'date', 'aria-label': label, 'data-diag': 'anchor',
      max: monthly ? asOf.slice(0, 7) : asOf, value: monthly ? anchor.slice(0, 7) : anchor,
      onchange: (e) => {
        const value = e.target.value;
        if (!value || !e.target.validity.valid) return;
        go({ anchor: monthly ? `${value}-01` : value });
      },
    });
    formHost.replaceChildren(h('section', { class: 'an-period', 'aria-label': '통계 진단 조회 기간' },
      h('div', { class: 'an-period-bar' },
        h('div', { class: 'an-period-switch', role: 'group', 'aria-label': '집계 단위' }, unit('week', '주별'), unit('month', '월별')),
        h('div', { class: 'an-period-nav' },
          shift(-1, '이전 기간', '‹'),
          h('label', { class: 'an-period-anchor' }, h('span', null, label), input),
          shift(1, '다음 기간', '›'),
          h('button', { type: 'button', class: 'secondary', 'data-diag': 'today', onclick: () => go({ anchor: '' }) }, monthly ? '이번 달' : '이번 주'))),
      h('p', { class: 'an-period-caption' }, period
        ? h('strong', null, `${period.from} — ${period.to}`)
        : h('span', null, '기간을 불러오는 중…'))));
    if (active) {
      const next = formHost.querySelector(`[data-diag="${active}"]`);
      (next && !next.disabled ? next : formHost.querySelector('[data-diag="anchor"]'))?.focus();
    }
  }

  /** 장소·시간대 조건을 바꾸면 같은 탭에서 다시 조회하고 바꾼 칸으로 포커스를 돌려 준다. */
  function refetchWith(name, value) {
    state[name] = value;
    load(name);
  }

  let applied = null; // 마지막으로 성공한 조회 조건

  async function load(focusName) {
    const mine = ++token;
    drawForm();
    results.replaceChildren(h('p', { class: 'status' }, '불러오는 중…'));
    let d;
    try {
      d = await getJson(`/api/analytics/diagnostics?${qs(state)}`);
    } catch (err) {
      if (mine !== token) return;
      if (!applied) {
        results.replaceChildren(alertBox(err.message));
        drawForm();
        return;
      }
      // 실패하면 대시보드처럼 이전 조건과 화면으로 되돌린다.
      toast(err.message, 'error');
      Object.assign(state, applied);
      d = data;
    }
    if (mine !== token) return;
    data = d;
    applied = { ...state };
    drawForm();
    const render = (key) => {
      if (key === 'activity') return activityTab(data, refetchWith);
      if (key === 'progress') return progressTab(data);
      if (key === 'staffing') return staffingTab(data);
      if (key === 'people') return peopleTab(data);
      return reviewTab(data);
    };
    const view = tabs({ label: '통계 진단 항목', prefix: 'an-diag', items: DIAGNOSTIC_TABS, value: tab, render: (key) => { tab = key; return render(key); } });
    results.replaceChildren(view.bar, view.body);
    if (focusName) results.querySelector(`[name="${focusName}"]`)?.focus();
  }

  box.append(header('통계 진단', exportButton(me.perms.diagnostics, () => `/api/analytics/diagnostics/export?${qs(state)}`, 'smoa-diagnostics.xlsx')), formHost, results);
  await load();
}

/* ---------- 단계 실적 ---------- */

const STAGE_TABS = [['strength', '단계 강약 분석'], ['trend', '구역별 8주 추이']];
const STAGE_METRICS = [{ value: 'count', label: '신규 건수' }, { value: 'rate', label: '기간 실적 비율' }, { value: 'stock', label: '주차 말 보유 건수' }];
const MISSING_KEYS = ['구역 미입력', '__unclassified__'];
const decimal = (n) => Number(n).toLocaleString('ko-KR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const deviationText = (v) => (Number.isFinite(v) ? `${v > 0 ? '+' : ''}${decimal(v)}%` : dash);
const SOURCE_LABEL = { reported: '구역 일계', detail: '대상자 상세' };

async function stagePerformance(box, me) {
  const perm = me.perms.stagePerformance;
  // query: 서버에 보내는 조회 조건. view: 이미 받은 자료를 다시 그릴 때만 쓰는 화면 선택.
  const query = { from: monthStart(), to: todayStr(), trendEnd: '', includeCurrent: '', region: '', statsClassification2: '', statsClass: '', source: '' };
  const view = { tab: 'strength', grouping: 'district', group: '', strengthStage: '', trendDistrict: '', trendCompare: '', trendStage: '', trendMetric: 'count', moreOpen: false };
  const status = h('div');
  let data = null;
  let loadError = null;
  let token = 0;

  const periodError = () => (!query.from || !query.to ? '조회 기간의 시작일과 종료일을 입력해 주세요.' : rangeError(query.from, query.to));
  const trendError = () => (query.trendEnd && query.trendEnd > todayStr() ? '오늘 이전의 조회 기준일을 선택해 주세요.' : '');
  const activeError = () => (view.tab === 'trend' ? trendError() : periodError());

  /** 잘못된 날짜는 보내지 않고 기본값으로 대신 조회한다. (오류는 화면에 알린다.) */
  function effective() {
    const range = periodError() ? { from: monthStart(), to: todayStr() } : { from: query.from, to: query.to };
    return { ...query, ...range, trendEnd: trendError() ? '' : query.trendEnd };
  }
  const dataQuery = () => qs(effective());

  function exportUrl() {
    const q = qs({
      ...effective(), stageView: view.tab,
      grouping: view.tab === 'strength' ? view.grouping : '',
      strengthGroup: view.tab === 'strength' ? view.group : '',
      trendStage: view.tab === 'trend' ? view.trendStage || data?.stages[0]?.key : '',
      trendDistrict: view.tab === 'trend' ? view.trendDistrict : '',
      trendCompare: view.tab === 'trend' ? view.trendCompare : '',
    });
    return `/api/analytics/stage-performance/export?${q}`;
  }

  const exportAction = perm.export
    ? h('button', { type: 'button', class: 'secondary', onclick: () => {
      const error = activeError();
      if (error) toast(error, 'error');
      else download(exportUrl(), 'smoa-stage-performance.xlsx');
    } }, '엑셀 내보내기')
    : null;

  async function load() {
    const mine = ++token;
    status.replaceChildren(h('p', { class: 'status' }, '불러오는 중…'));
    try {
      const d = await getJson(`/api/analytics/stage-performance?${dataQuery()}`);
      if (mine !== token) return;
      data = d;
      loadError = null;
    } catch (err) {
      if (mine !== token) return;
      loadError = err;
    }
    status.replaceChildren();
    tabView.refresh();
  }

  /* --- 조회 조건 --- */

  const QUERY_NAMES = { strength: ['from', 'to'], trend: ['trendEnd', 'includeCurrent'] };
  const SHARED_NAMES = ['region', 'statsClassification2', 'statsClass', 'source'];

  function queryForm() {
    const classes = (data?.classes ?? []).map((c) => ({ value: c.key, label: c.label }));
    const strength = view.tab === 'strength';
    return filterForm([
      strength ? field('시작일', textInput('date', 'from', query.from ?? '')) : null,
      strength ? field('종료일', textInput('date', 'to', query.to ?? '')) : null,
      strength ? null : field('조회 기준일', textInput('date', 'trendEnd', query.trendEnd || todayStr(), { max: todayStr() })),
      strength ? null : field('조회 범위', selectOf('includeCurrent', [{ value: 'true', label: '기준일이 속한 주 포함' }], query.includeCurrent, '완료된 주')),
      field('조회 구역', selectOf('region', regionOptions(me), query.region ?? '')),
      field('분류2', selectOf('statsClassification2', CLASS2, query.statsClassification2 ?? '', '전체 분류')),
      field('반', selectOf('statsClass', classes, query.statsClass ?? '')),
      field('자료원', selectOf('source', [{ value: 'detail', label: '대상자 상세' }, { value: 'reported', label: '구역 일계' }], query.source ?? '', '자동')),
    ], (values) => {
      readInto(query, values, [...QUERY_NAMES[view.tab], ...SHARED_NAMES]);
      if (!strength && query.trendEnd === todayStr()) query.trendEnd = '';
      load();
    });
  }

  /** 받은 자료만 다시 그리는 선택 칸. 바꾸면 서버를 부르지 않고 그 칸으로 포커스를 돌려 준다. */
  function localSelect(label, key, options, value, all, after) {
    const select = selectOf(key, options, value, all);
    select.dataset.local = key;
    select.addEventListener('change', () => {
      view[key] = select.value;
      after?.();
      tabView.refresh();
      body().querySelector(`[data-local="${key}"]`)?.focus();
    });
    return field(label, select);
  }
  const body = () => tabView.body;

  /* --- 상세 대화상자 --- */

  async function openDetails({ grouping, group, stage, label, stageLabel, from, to, source }, button) {
    button.disabled = true;
    try {
      const d = await getJson(`/api/analytics/stage-performance/details?${qs({ ...effective(), from, to, grouping, group: grouping === 'total' ? '' : group, stage, source: source || query.source })}`);
      openDialog({
        title: `${label} · ${stageLabel} 신규 실적`,
        caption: `${from || '처음'} ~ ${to || '현재'} · ${num(d.count)}건`,
        body: gridTable('단계별 집계 내역', ['기준일', '대상자', '구역', '반', '자료원', '건수'],
          d.rows.map((r) => [r.date, r.name || (r.source === 'reported' ? '(일계 합계)' : dash), r.region || '구역 미입력', r.className || dash, SOURCE_LABEL[r.source] ?? dash, num(r.count)]),
          '확인 가능한 집계 내역이 없습니다.'),
      });
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      button.disabled = false;
    }
  }

  /** 건수 칸: 0건이 아니면 눌러서 집계 내역을 연다. */
  function drillCell(row, stage, scope) {
    const count = stageValue(stage.count, 'count');
    if (!stage.count) return h('strong', null, count);
    const button = h('button', {
      type: 'button', class: 'an-link', 'aria-label': `${row.label} ${stage.label} ${count} 상세`,
      onclick: () => openDetails({ ...scope, group: row.key, stage: stage.key, label: row.label, stageLabel: stage.label, source: row.source }, button),
    }, count);
    return button;
  }

  /* --- 단계 강약 분석 --- */

  function strengthPage(d) {
    const byClass = view.grouping === 'class';
    const groupName = byClass ? '반' : '구역';
    const rows = byClass ? d.classes : d.districts;
    const selected = rows.find((row) => row.key === view.group)?.key ?? '';
    const visible = selected ? rows.filter((row) => row.key === selected) : rows;
    const stage = d.stages.find((item) => item.key === view.strengthStage) ?? d.stages[0];
    const scope = { from: d.from, to: d.to, grouping: byClass ? 'class' : 'district' };

    const matrixRow = (row, total) => {
      const cells = row.stages.map((s) => {
        if (!Number.isFinite(s.count)) return h('span', { class: 'an-unavailable' }, '자료 부족');
        const direction = s.deviation > 0 ? 'up' : s.deviation < 0 ? 'down' : null;
        return [drillCell(row, s, total ? { from: d.from, to: d.to, grouping: 'total' } : scope),
          h('span', { class: 'an-sub' }, stageValue(s.rate, 'rate')),
          total ? null : h('span', { class: 'an-sub an-deviation', 'data-direction': direction }, deviationText(s.deviation))];
      });
      return { cells: [row.label, Number.isFinite(row.workers) ? `${num(row.workers)}명` : dash, ...cells], className: total ? 'an-total' : null };
    };

    const controls = h('div', { class: 'an-controls' },
      localSelect('비교 단위', 'grouping', [{ value: 'district', label: '구역별' }, { value: 'class', label: '반별' }], view.grouping, null, () => { view.group = ''; }),
      localSelect(`표시 ${groupName}`, 'group', rows.map((row) => ({ value: row.key, label: row.label })), selected, `전체 ${groupName}`));

    const matrix = panel('기간별 단계향상률 취합',
      '각 칸에 신규 건수, 직전 단계 대비 비율, 평균 대비 차이가 순서대로 표시됩니다. 건수를 누르면 집계 내역을 볼 수 있습니다.',
      h('p', { class: 'an-note' }, `자료원: ${SOURCE_LABEL[d.source] ?? '자료 부족'} · ${d.from || '처음'} ~ ${d.to || '현재'}`),
      gridTable('단계별 신규 건수와 향상률', [groupName, '활동자', ...d.stages.map((s) => s.label)],
        visible.map((row) => matrixRow(row, false)), `조회 조건에 해당하는 ${groupName}가 없습니다.`, matrixRow(d.total, true)),
      h('p', { class: 'an-note' }, '같은 기간의 직전 단계 실적으로 나눕니다. 비율은 100%를 넘을 수 있으며, 직전 단계가 0건이면 —로 표시합니다.'));

    return [controls, matrix, strengthSummary(d, rows, stage, groupName, byClass), groupExtremes(visible, groupName), normalizedPanel(visible, stage, groupName)];
  }

  function strengthSummary(d, rows, stage, groupName, byClass) {
    if (!stage) return null;
    const benchmark = (byClass ? d.classBenchmark : d.districtBenchmark).find((item) => item.key === stage.key);
    const picker = h('div', { class: 'an-controls' }, localSelect('비교할 단계', 'strengthStage', d.stages.map((s) => ({ value: s.key, label: s.label })), stage.key, null));
    const entries = rows.filter((row) => !MISSING_KEYS.includes(row.key))
      .map((row) => ({ row, cell: row.stages.find((item) => item.key === stage.key) })).filter((entry) => Number.isFinite(entry.cell?.count));
    const byCount = entries.slice().sort((a, b) => b.cell.count - a.cell.count);
    if (!Number.isFinite(benchmark?.average) || !byCount.length) {
      return panel('선택 단계의 강약', null, picker, emptyText('비교에 사용할 단계별 기록이 없습니다.'));
    }
    const list = (items) => (items.length
      ? items.map(({ row, cell }) => h('li', null, h('strong', null, row.label), ' ', `${stageValue(cell.count, 'count')} · ${deviationText(cell.deviation)}`))
      : [h('li', null, '해당 없음')]);
    const above = byCount.filter(({ cell }) => cell.deviation > 0).slice(0, 2);
    const below = byCount.filter(({ cell }) => cell.deviation < 0).reverse().slice(0, 2);
    return panel('선택 단계의 강약', `집계 가능한 ${num(benchmark.groups)}개 ${groupName}의 신규 건수를 비교합니다.`, picker,
      h('div', { class: 'an-bench-grid' },
        h('article', { class: 'an-card' }, h('h3', null, `${groupName} 평균`), h('strong', { class: 'an-main' }, `${decimal(benchmark.average)}건`),
          h('p', null, `활동자 100명당 기준 ${Number.isFinite(benchmark.per100) ? `${decimal(benchmark.per100)}건` : dash}`)),
        h('article', { class: 'an-card', 'data-direction': 'up' }, h('h3', null, `평균보다 높은 ${groupName}`), h('ul', null, list(above))),
        h('article', { class: 'an-card', 'data-direction': 'down' }, h('h3', null, `평균보다 낮은 ${groupName}`), h('ul', null, list(below)))));
  }

  function groupExtremes(rows, groupName) {
    if (!rows.length) return null;
    const cell = (stage) => (stage
      ? [h('strong', null, stage.label), h('span', { class: 'an-sub' }, `${stageValue(stage.count, 'count')} · ${deviationText(stage.deviation)}`)]
      : dash);
    const lines = rows.map((row) => {
      const ordered = row.stages.filter((s) => Number.isFinite(s.deviation)).sort((a, b) => b.deviation - a.deviation);
      return [row.label, cell(ordered[0]), cell(ordered.length > 1 ? ordered.at(-1) : null)];
    });
    return panel(`${groupName}별 강점과 보완 단계`, '각 단계의 평균 대비 차이가 가장 높은 단계와 가장 낮은 단계를 표시합니다.',
      gridTable(`${groupName}별 강점과 보완 단계`, [groupName, '평균 대비 가장 높은 단계', '평균 대비 가장 낮은 단계'], lines));
  }

  function normalizedPanel(rows, stage, groupName) {
    if (!stage || !rows.length) return null;
    const lines = rows.map((row) => {
      const cell = row.stages.find(({ key }) => key === stage.key);
      return [row.label, stageValue(cell?.count, 'count'), Number.isFinite(row.workers) ? `${num(row.workers)}명` : dash, Number.isFinite(cell?.per100) ? `${decimal(cell.per100)}건` : dash];
    });
    const more = h('details', { class: 'an-more', open: view.moreOpen },
      h('summary', null, `${stage.label} 활동자 100명당 실적`),
      gridTable('선택 단계의 활동자 100명당 실적', [groupName, '신규 건수', '고유 활동자', '활동자 100명당 건수'], lines));
    more.addEventListener('toggle', () => { view.moreOpen = more.open; });
    return more;
  }

  /* --- 구역별 8주 추이 --- */

  const weekRow = (week, district) => (district ? week.districts.find((row) => row.key === district) : week.total);

  /** 선택한 구역(없으면 전체)별로 주마다의 지표 값을 모은다. 진행 중 주는 전주 같은 요일 값도 함께 가진다. */
  function trendSeries(weeks, districts, stageKey, metric) {
    return districts.map((district) => {
      const latest = weeks.map((week) => weekRow(week, district)).find(Boolean);
      const cellOf = (week) => weekRow(week, district)?.stages.find((cell) => cell.key === stageKey);
      const prior = weeks.at(-1)?.comparison;
      return {
        district,
        label: latest?.label || district || '전체 구역',
        values: weeks.map((week) => cellOf(week)?.[metric] ?? null),
        priorValue: prior ? weekRow(prior, district)?.stages.find((cell) => cell.key === stageKey)?.[metric] ?? null : null,
      };
    });
  }

  function trendPage(d) {
    const weeks = d.weekly;
    const districts = [...new Map(weeks.flatMap((week) => week.districts).map((row) => [row.key, row.label])).entries()];
    const selected = districts.some(([key]) => key === view.trendDistrict) ? view.trendDistrict : '';
    const comparison = districts.some(([key]) => key === view.trendCompare && key !== selected) ? view.trendCompare : '';
    const stage = d.stages.find((item) => item.key === view.trendStage) ?? d.stages[0];
    const metric = view.trendMetric;
    const metricLabel = STAGE_METRICS.find((m) => m.value === metric)?.label;

    const controls = h('div', { class: 'an-controls' },
      localSelect('구역', 'trendDistrict', districts.map(([value, label]) => ({ value, label })), selected, '전체 구역', () => { if (view.trendDistrict === view.trendCompare) view.trendCompare = ''; }),
      localSelect('비교 구역', 'trendCompare', districts.filter(([key]) => key !== selected).map(([value, label]) => ({ value, label })), comparison, '비교 안 함'),
      localSelect('단계', 'trendStage', d.stages.map((s) => ({ value: s.key, label: s.label })), stage?.key ?? '', null),
      localSelect('지표', 'trendMetric', STAGE_METRICS, metric, null));
    if (!weeks.length || !stage) return [controls, emptyText('표시할 주차 데이터가 없습니다.')];

    const picked = comparison ? [selected, comparison] : [selected];
    const series = trendSeries(weeks, picked, stage.key, metric);
    const perDistrict = selected ? series : trendSeries(weeks, districts.map(([key]) => key).filter((key) => key !== '구역 미입력' || key === comparison), stage.key, metric);
    const title = `${stage.label} ${metricLabel} 주별 추이`;
    const last = weeks.at(-1);

    const lines = weeks.map((week, i) => [
      [`${week.from} ~ ${week.to}`, week.partial ? h('span', { class: 'an-status an-week-state' }, '진행 중') : null],
      ...series.map((line) => {
        const row = weekRow(week, line.district);
        const cell = row?.stages.find((item) => item.key === stage.key);
        return metric === 'count' && cell
          ? drillCell(row, cell, { from: week.from, to: week.to, grouping: line.district ? 'district' : 'total' })
          : stageValue(line.values[i], metric);
      }),
    ]);
    const prior = last.comparison;
    const priorRow = prior
      ? { cells: [[`전주 같은 요일 `, h('small', { class: 'an-sub' }, `${prior.from} ~ ${prior.to}`)], ...series.map(({ priorValue }) => stageValue(priorValue, metric))] }
      : null;

    const axis = trendAxis(series, metric);
    const figure = axis
      ? h('figure', { class: 'an-figure' },
        h('figcaption', null, h('strong', null, title),
          h('span', { class: 'an-legend' }, series.map((item, index) => h('span', { 'data-series': index }, item.label)))),
        h('div', { class: 'an-scroll', role: 'region', 'aria-label': '그래프 가로 스크롤', tabindex: '0' },
          trendChart(weeks, series, metric, axis, { title, id: 'an-trend-chart' })))
      : emptyText('선택한 주차의 차트를 그릴 자료가 없습니다.');

    const perAxis = trendAxis(perDistrict, metric);
    const small = perDistrict.map((item, index) => h('figure', { class: 'an-figure', 'data-trend-district': item.district },
      h('figcaption', null, h('strong', null, item.label),
        h('span', null, `${last.partial ? '진행 중 주' : '최근 주'} `, h('b', null, stageValue(item.values.at(-1), metric)))),
      perAxis && item.values.some(Number.isFinite)
        ? trendChart(weeks, [item], metric, perAxis, { title: `${item.label} ${title}`, id: `an-district-chart-${index + 1}`, compact: true })
        : emptyText('선택한 주차의 차트를 그릴 자료가 없습니다.')));

    return [controls,
      panel('최근 8주 실적', `${weeks[0].from} ~ ${last.to}${metric === 'stock' ? ' · 보유는 해당 주 마지막 조회일의 단계 기준' : ''}`,
        figure, gridTable('주차별 실적', ['주차', ...series.map((line) => line.label)], lines, '표시할 주차 데이터가 없습니다.', priorRow)),
      perDistrict.length ? panel('구역별 8주 그래프', perDistrict.length > 1 ? '모든 구역 그래프에 같은 세로축을 적용합니다.' : null, h('div', { class: 'an-trend-grid' }, small)) : null];
  }

  /* --- 화면 조립 --- */

  const tabView = tabs({
    label: '단계 성과 분석', prefix: 'an-stage', items: STAGE_TABS, value: view.tab,
    render: (key) => {
      view.tab = key;
      const error = activeError();
      const page = h('div', { class: 'an-page' }, queryForm());
      if (error) page.append(alertBox(error));
      else if (loadError) page.append(alertBox(loadError.message));
      else if (data) page.append(...(key === 'trend' ? trendPage(data) : strengthPage(data)).filter(Boolean));
      return page;
    },
  });

  box.append(header('단계 강약 분석', exportAction), status, tabView.bar, tabView.body);
  await load();
}

/* ---------- 개인별 데이터 · 전일자 전도현황 ---------- */

/** 전일자 전도현황 (원본 full-time-performance.js). 기준일을 비우면 서버의 오늘이다. */
async function fullTimeView(box, me, embed) {
  const perm = me.perms.memberData;
  const state = { anchor: '', region: '', search: '' };
  const results = h('div');
  const formHost = h('div', { class: 'card' });
  let last = null;
  let token = 0;

  function buildForm(d) {
    const districts = (d?.districts ?? []).map(({ region, label }) => ({ value: region, label }));
    formHost.replaceChildren(filterForm([
      field('기준일', textInput('date', 'anchor', state.anchor || d?.anchor || '', { max: d?.asOf || todayStr() })),
      field('구역', selectOf('region', districts.length ? districts : regionOptions(me), d ? (d.selectedRegion ?? state.region) : state.region, '전체 구역')),
      field('이름', textInput('search', 'search', state.search ?? '', { maxlength: '60', placeholder: '이름 검색' })),
    ], (values) => {
      state.anchor = values.anchor ?? '';
      state.region = values.region ?? '';
      state.search = values.search ?? '';
      load();
    }));
  }

  async function load() {
    const mine = ++token;
    buildForm(last);
    results.replaceChildren(h('p', { class: 'status' }, '불러오는 중…'));
    let d;
    try {
      d = await getJson(`/api/analytics/full-time?${qs(state)}`);
    } catch (err) {
      if (mine === token) results.replaceChildren(alertBox(err.message));
      return;
    }
    if (mine !== token) return;
    last = d;
    buildForm(d);
    results.replaceChildren(fullTimePanel(d));
  }

  const exportAction = exportButton(perm, () => `/api/analytics/full-time/export?${qs(state)}`, 'smoa-full-time.xlsx');
  if (embed) embed.setExport(exportAction);
  else box.append(header('전일자 전도현황', exportAction));
  box.append(formHost, results);
  await load();
}

/** 개인별 데이터 메뉴: 원본처럼 '개인별 분석'과 '전일자 전도현황'을 같은 머리글 아래에서 오간다. */
async function memberData(box, me) {
  const personal = performanceView('memberData', '개인별 데이터', 'member-data');
  const modes = [['personal', '개인별 분석', personal], ['fullTime', '전일자 전도현황', fullTimeView]];
  const actions = h('div', { class: 'actions' });
  const bar = h('div', { class: 'perf-full-time-tabs', role: 'group', 'aria-label': '개인별 데이터 항목' });
  const body = h('div');
  let seq = 0;

  async function show(mode, refocus = false) {
    const mine = ++seq;
    bar.replaceChildren(...modes.map(([value, label]) => h('button', {
      type: 'button', class: 'small', 'aria-pressed': String(value === mode), 'data-member-mode': value,
      onclick: () => { if (value !== mode) show(value, true); },
    }, label)));
    if (refocus) bar.querySelector(`[data-member-mode="${mode}"]`)?.focus();
    actions.replaceChildren();
    const inner = h('div');
    body.replaceChildren(inner);
    const embed = { setExport: (button) => { if (mine === seq) actions.replaceChildren(...(button ? [button] : [])); } };
    try {
      await modes.find(([value]) => value === mode)[2](inner, me, embed);
    } catch (err) {
      if (mine === seq) inner.replaceChildren(alertBox(err.message));
    }
  }

  box.append(h('div', { class: 'toolbar' }, h('h1', null, '개인별 데이터'), h('span', { class: 'spacer' }), actions), bar, body);
  await show('personal');
}

export const analyticsViews = {
  findingStats,
  regionData: performanceView('regionData', '구역별 데이터', 'region-data'),
  memberData,
  classData: performanceView('classData', '반별 데이터', 'class-data'),
  diagnostics,
  stagePerformance,
};
