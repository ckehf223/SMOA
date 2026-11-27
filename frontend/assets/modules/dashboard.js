import { clear, errorMessage, field, h, notice, select, table } from '../js/ui.js';

const path = '/api/programs/dashboard';
const number = (value) => Number(value).toLocaleString('ko-KR');
const seoulToday = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
const iso = (date) => date.toISOString().slice(0, 10);
const metrics = {
  findings: ['찾기', '건'],
  activities: ['활동 기록', '건'],
  minutes: ['누적 활동 시간', '분'],
  people: ['현재 대상자', '명'],
  dropped: ['현재 탈락', '명'],
};
const modes = [['week', '주별'], ['month', '월별'], ['custom', '기간 지정']];

function periodOf(anchor, mode, weekStart = 0, offset = 0) {
  const start = new Date(anchor + 'T00:00:00Z');
  if (mode === 'month') {
    start.setUTCDate(1);
    start.setUTCMonth(start.getUTCMonth() + offset);
    const end = new Date(start);
    end.setUTCMonth(end.getUTCMonth() + 1, 0);
    return [iso(start), iso(end)];
  }
  start.setUTCDate(start.getUTCDate() - (start.getUTCDay() - weekStart + 7) % 7 + offset * 7);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 6);
  return [iso(start), iso(end)];
}

function svg(tag, attrs, ...children) {
  const element = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, value);
  element.append(...children);
  return element;
}

/** 날짜별 실적은 서버 응답을 사용하고, 눈금과 점 위치만 계산한다. */
function dailyTrend(days) {
  if (!days.some(({ total }) => total)) return h('p', { class: 'muted', text: '선택한 기간에 찾기 기록이 없습니다.' });
  const width = 640;
  const left = 48;
  const right = 616;
  const top = 14;
  const bottom = 157;
  const scale = Math.max(4, Math.ceil(Math.max(...days.map(({ total }) => total)) / 4) * 4);
  const points = days.map(({ total }, index) => [
    days.length > 1 ? left + (right - left) * index / (days.length - 1) : (left + right) / 2,
    bottom - (bottom - top) * total / scale,
  ]);
  const coords = points.map(([x, y]) => x.toFixed(2) + ',' + y.toFixed(2)).join(' ');
  const grid = [];
  for (let index = 0; index <= 4; index += 1) {
    const y = bottom - (bottom - top) * index / 4;
    grid.push(svg('line', { class: 'dashboard-grid', x1: left, y1: y, x2: right, y2: y }));
    grid.push(svg('text', { x: left - 8, y: y + 4, 'text-anchor': 'end' }, number(scale * index / 4)));
  }
  const step = Math.max(1, Math.ceil(days.length / 6));
  const labels = days.flatMap(({ day }, index) => index % step === 0 || index === days.length - 1 && index % step >= step / 2
    ? [svg('text', { x: points[index][0], y: bottom + 23, 'text-anchor': 'middle' }, day.slice(5).replace('-', '/'))] : []);
  const dots = days.flatMap(({ day, total }, index) => total || days.length < 32
    ? [svg('circle', { class: 'dashboard-trend-point', cx: points[index][0], cy: points[index][1], r: days.length > 60 ? 2 : 3 },
      svg('title', {}, day + ' · ' + number(total) + '건'))] : []);
  return h('div', {},
    svg('svg', { class: 'dashboard-trend', viewBox: '0 0 ' + width + ' 190', role: 'img', 'aria-label': '일별 찾기 건수 선 그래프' },
      ...grid, ...labels,
      svg('polygon', { class: 'dashboard-trend-area', points: points[0][0] + ',' + bottom + ' ' + coords + ' ' + points.at(-1)[0] + ',' + bottom }),
      svg('polyline', { class: 'dashboard-trend-line', points: coords }),
      ...dots),
    h('details', { class: 'dashboard-reading-detail' }, h('summary', { text: '일별 건수 보기' }),
      table([{ key: 'day', label: '날짜' }, { label: '찾기', render: (row) => number(row.total) }], days)));
}

function panel(title, description, body, kind = '') {
  return h('section', { class: ('panel ' + kind).trim() },
    h('header', { class: 'panel-head' }, h('div', {}, h('h2', { text: title }), description ? h('p', { text: description }) : null)),
    h('div', { class: 'panel-body' }, body));
}

function metricValue(value, unit) {
  return h('strong', { text: number(value) }, h('small', { text: unit }));
}

function scoreBoard(totals, keys) {
  return h('section', { class: 'panel workbench-scoreboard' }, keys.map((key) => {
    const [label, unit] = metrics[key];
    return h('article', {}, h('h2', { text: label }), h('div', { class: 'workbench-score-value' }, metricValue(totals[key], unit)));
  }));
}

function stageCards(stages, total) {
  if (!stages.length) return h('p', { class: 'muted', text: '표시할 단계별 대상자가 없습니다.' });
  return h('div', { class: 'dashboard-stage-cards' }, stages.map(({ stage, total: count }) =>
    h('article', { class: 'dashboard-stage-card' },
      h('h3', { class: 'dashboard-stage-title', text: stage }),
      h('div', { class: 'dashboard-stage-values' }, metricValue(count, '명')),
      h('progress', { class: 'dashboard-stage-progress', max: Math.max(1, total), value: count, 'aria-label': stage + ' 대상자 비중' }))));
}

function districtTable(rows, keys) {
  return table([{ label: '구역', key: 'name' }, ...keys.map((key) => ({
    label: metrics[key][0] + ' (' + metrics[key][1] + ')',
    render: (row) => h('span', { class: 'numeric', text: number(row[key]) }),
  }))], rows, '표시할 구역이 없습니다.');
}

function workbench() {
  const buttons = new Map();
  const panes = new Map();
  const tabLabels = [['performance', '실적'], ['activity', '활동']];
  const tabs = h('div', { class: 'workbench-tabs dashboard-reading-tabs', role: 'tablist', 'aria-label': '대시보드 분석 항목' });
  const root = h('div', { class: 'dashboard-page dashboard-workbench dashboard-reading-workbench' }, tabs);
  let active = tabLabels[0][0];

  function selectTab(key, focus = false) {
    active = key;
    for (const [id, button] of buttons) {
      button.setAttribute('aria-selected', String(id === active));
      button.tabIndex = id === active ? 0 : -1;
      panes.get(id).hidden = id !== active;
    }
    if (focus) buttons.get(key).focus();
  }

  tabLabels.forEach(([key, title], index) => {
    const id = 'reading-tab-' + key;
    const panelId = 'reading-panel-' + key;
    const pane = h('div', {
      class: 'workbench-view', id: panelId, role: 'tabpanel', 'aria-labelledby': id, tabindex: 0,
    });
    const button = h('button', {
      type: 'button', id, role: 'tab', 'aria-controls': panelId, 'data-workbench-tab': key, text: title,
      onclick: () => selectTab(key),
      onkeydown: (event) => {
        const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
        const next = step ? tabLabels[(index + step + tabLabels.length) % tabLabels.length][0]
          : event.key === 'Home' ? tabLabels[0][0] : event.key === 'End' ? tabLabels.at(-1)[0] : null;
        if (next) {
          event.preventDefault();
          selectTab(next, true);
        }
      },
    });
    buttons.set(key, button);
    panes.set(key, pane);
    tabs.append(button);
    root.append(pane);
  });
  selectTab(active);
  return { root, panes };
}

export async function mount(ctx) {
  const [districts, settings] = await Promise.all([
    ctx.api.get(path + '/options'),
    ctx.me?.permissions?.settings?.read ? ctx.api.get('/api/programs/settings/data/library').catch(() => null) : null,
  ]);
  const weekStart = settings?.weekStart ?? 0;
  let mode = 'week';
  const [start, end] = periodOf(seoulToday(), mode, weekStart);
  const anchor = h('input', { type: 'date', value: start, 'aria-label': '주 기준일' });
  const anchorLabel = h('span', { text: '주 기준일' });
  const from = h('input', { type: 'date', value: start, required: true, 'aria-label': '시작일' });
  const to = h('input', { type: 'date', value: end, required: true, 'aria-label': '종료일' });
  const district = select([['', '권한 내 모든 구역'], ...districts.map((d) => [d.regionCode + '|' + d.districtCode, d.name])], '',
    { 'aria-label': '구역' });
  const read = h('button', { type: 'submit', class: 'btn primary', text: '조회' });
  const today = h('button', { type: 'button', class: 'btn ghost', text: '이번 주', onclick: () => setPeriod(seoulToday()) });
  const caption = h('strong', { text: start + ' — ' + end });
  const error = h('div');
  const { root: board, panes } = workbench();
  let requestId = 0;

  async function load() {
    const id = ++requestId;
    const query = new URLSearchParams({ from: from.value, to: to.value });
    if (district.value) {
      const [regionCode, districtCode] = district.value.split('|');
      query.set('regionCode', regionCode);
      query.set('districtCode', districtCode);
    }
    read.disabled = true;
    board.setAttribute('aria-busy', 'true');
    try {
      const data = await ctx.api.get(path + '/data/summary?' + query);
      if (id !== requestId) return;
      clear(error);
      caption.textContent = data.period.from + ' — ' + data.period.to;
      clear(panes.get('performance')).append(
        scoreBoard(data.totals, ['findings', 'people', 'dropped']),
        h('div', { class: 'workbench-trend-grid' },
          panel('일별 찾기 기록', '찾은 날짜 기준', dailyTrend(data.days), 'dashboard-trend-panel'),
          panel('구역별 찾기 현황', '', districtTable(data.districts, ['findings']))),
        panel('단계별 현재 현황', '탈락 포함 현재 단계', stageCards(data.stages, data.totals.people)));
      clear(panes.get('activity')).append(
        scoreBoard(data.totals, ['activities', 'minutes', 'findings']),
        panel('구역별 활동 현황', '조회 기간의 활동 기록과 시간 합계', districtTable(data.districts, ['activities', 'minutes'])));
    } catch (failure) {
      if (id === requestId) {
        clear(error).append(notice('error', errorMessage(failure)));
        for (const pane of panes.values()) clear(pane);
      }
    } finally {
      if (id === requestId) {
        read.disabled = false;
        board.setAttribute('aria-busy', 'false');
      }
    }
  }

  function setPeriod(date, shift = 0) {
    if (!date || mode === 'custom') return;
    [from.value, to.value] = periodOf(date, mode, weekStart, shift);
    anchor.value = mode === 'month' ? from.value.slice(0, 7) : from.value;
    void load();
  }

  const periodNav = h('div', { class: 'dashboard-period-navigation' },
    h('button', { type: 'button', class: 'btn icon', 'aria-label': '이전 기간', text: '‹', onclick: () => setPeriod(from.value, -1) }),
    h('label', { class: 'dashboard-anchor' }, anchorLabel, anchor),
    h('button', { type: 'button', class: 'btn icon', 'aria-label': '다음 기간', text: '›', onclick: () => setPeriod(from.value, 1) }),
    today);
  const dateInputs = h('div', { class: 'dashboard-period-navigation dashboard-custom-period', hidden: true },
    field('시작일', from), field('종료일', to));
  const modeButtons = modes.map(([key, label]) => h('button', {
    type: 'button', class: 'btn', 'aria-pressed': String(key === mode), text: label,
    onclick: () => {
      if (mode === key) return;
      mode = key;
      for (const [index, button] of modeButtons.entries()) button.setAttribute('aria-pressed', String(modes[index][0] === mode));
      periodNav.hidden = mode === 'custom';
      dateInputs.hidden = mode !== 'custom';
      from.disabled = to.disabled = mode !== 'custom';
      anchor.type = mode === 'month' ? 'month' : 'date';
      const label = mode === 'month' ? '조회월' : '주 기준일';
      anchorLabel.textContent = label;
      anchor.setAttribute('aria-label', label);
      today.textContent = mode === 'month' ? '이번 달' : '이번 주';
      if (mode !== 'custom') setPeriod(from.value || seoulToday());
    },
  }));
  from.disabled = to.disabled = true;
  anchor.addEventListener('change', () => setPeriod(mode === 'month' && anchor.value ? anchor.value + '-01' : anchor.value));
  district.addEventListener('change', () => void load());
  const filters = h('form', { class: 'filters overview-filters', 'aria-label': '대시보드 조회 조건',
    onsubmit: (event) => { event.preventDefault(); void load(); },
  }, h('div', { class: 'dashboard-period-bar' },
    h('div', { class: 'dashboard-period-switch', role: 'group', 'aria-label': '집계 단위' }, modeButtons),
    periodNav, dateInputs, h('div', { class: 'dashboard-scope' }, district, read)),
  h('div', { class: 'dashboard-period-caption', role: 'status' }, caption));
  ctx.container.append(h('div', { class: 'dashboard-root' }, filters, error, board));
  await load();
}
