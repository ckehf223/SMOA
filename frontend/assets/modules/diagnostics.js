import { clear, errorMessage, field, h, notice, select, table } from '../js/ui.js';

const BASE = '/api/programs/diagnostics';
const col = (key, label) => ({ key, label });
const button = (text, onclick) => h('button', { class: 'btn', type: 'button', text, onclick });
const periodNames = ['선택 기간', '직전 기간', '두 기간 전'];
const percent = (rate) => rate == null ? '—' : `${(100 * rate).toLocaleString('ko-KR', { maximumFractionDigits: 2 })}%`;
const dateRange = (period) => `${period.from} ~ ${period.to}`;

function section(title, ...content) {
  return h('section', { class: 'panel' }, h('h3', { text: title }), content);
}

export async function mount(ctx) {
  const districts = await ctx.api.get(`${BASE}/options`);
  if (!ctx.container.isConnected) return;
  const now = new Intl.DateTimeFormat('sv-SE', { dateStyle: 'short', timeZone: 'Asia/Seoul' }).format(new Date());
  const anchor = h('input', { type: 'date', max: now, value: now, required: true });
  const kind = select([['week', '주별'], ['month', '월별']], 'week');
  const district = select([['', '전체 구역'], ...districts.map((d) => [JSON.stringify([d.regionCode, d.districtCode]), d.name])], '');
  const content = h('div', { 'aria-live': 'polite' });
  const submit = h('button', { class: 'btn primary', type: 'submit', text: '조회' });
  let lastQuery = null;
  let latest = 0;
  const download = ctx.permissions?.export ? button('진단 엑셀', async () => {
    try { await ctx.api.download(`${BASE}/export/summary.xlsx?${lastQuery}`, '통계 진단.xlsx'); }
    catch (error) { ctx.toast(errorMessage(error), 'error'); }
  }) : null;

  async function load() {
    const token = ++latest;
    const params = new URLSearchParams({ anchor: anchor.value, kind: kind.value });
    if (district.value) {
      const [region, code] = JSON.parse(district.value);
      params.set('regionCode', region);
      params.set('districtCode', code);
    }
    submit.disabled = true;
    if (download) download.disabled = true;
    clear(content).append(notice('info', '기간별 통계와 기록 누락을 조회하는 중입니다.'));
    try {
      const result = await ctx.api.get(`${BASE}/data/summary?${params}`);
      if (token !== latest || !ctx.container.isConnected) return;
      render(result);
      lastQuery = params;
    } catch (error) {
      if (token === latest) clear(content).append(notice('error', errorMessage(error)));
    } finally {
      if (token === latest) {
        submit.disabled = false;
        if (download) download.disabled = lastQuery !== params;
      }
    }
  }

  function render(data) {
    const tabList = h('div', { class: 'row', role: 'group', 'aria-label': '통계 진단 보기' });
    const tabBody = h('div');
    const views = [['기간 비교', () => comparisons(data)], ['장소·시간대', () => locations(data.locations)],
      ['단계 관찰', () => cohorts(data)]];
    const tabs = views.map(([label], index) => button(label, () => show(index)));
    function show(index) {
      tabs.forEach((tab, i) => {
        tab.classList.toggle('primary', index === i);
        tab.setAttribute('aria-pressed', String(index === i));
      });
      clear(tabBody).append(views[index][1]());
    }
    tabList.append(...tabs);
    clear(content).append(tabList, tabBody);
    show(0);
  }

  ctx.container.append(h('form', { class: 'panel row dashboard-reading-filters', onsubmit: (event) => {
    event.preventDefault(); void load();
  } }, field('기준일', anchor), field('기간 단위', kind), field('구역', district), submit, download), content);
  await load();
}

function comparisons(data) {
  const rows = data.periods.map((row, index) => ({ ...row, label: periodNames[index], range: dateRange(row.period), ...row.quality }));
  return section('기간 비교', table([col('label', '구분'), col('range', '조회 기간'), col('roadFindings', '노방 찾기'), col('roadActivities', '노방 활동'),
    col('findingsWithoutTime', '찾기 시각 누락'), col('findingsWithoutPlace', '찾기 장소 누락'), col('activitiesWithoutTime', '활동 시각 누락'),
    col('activitiesWithoutPlace', '활동 장소 누락'), col('activitiesWithoutWorker', '활동자 누락')], rows));
}

function cohorts(data) {
  const rows = data.periods.flatMap((row, index) => row.cohorts.map((value) => ({ ...value, period: periodNames[index] })));
  return section('단계 관찰', h('p', { class: 'muted', text: `관찰 기준일 ${data.asOf}. 기준 일수가 지난 인원으로 도달 비율을 계산합니다.` }),
    table([col('period', '기간'), col('label', '단계'), col('days', '기준 일수'), col('started', '전체'),
      col('completed', '관찰 완료'), col('observing', '관찰 중'), col('reached', '기간 내 도달'),
      { label: '도달 비율', render: (row) => percent(row.rate) }], rows));
}

function locations(rows) {
  const place = select([['', '전체 장소'], ...Array.from(new Set(rows.map((row) => row.place)))], '');
  const hours = select([['', '전체 시간대'], ...Array.from({ length: 24 }, (_, n) => [String(n), `${String(n).padStart(2, '0')}시`]), ['unknown', '시각 미입력']], '');
  const result = h('div');
  let page = 0;
  function render() {
    const filtered = rows.filter((r) => (!place.value || r.place === place.value) && (!hours.value || String(r.hour ?? 'unknown') === hours.value));
    const size = 40;
    const prev = button('이전', () => { page--; render(); });
    const next = button('다음', () => { page++; render(); });
    const pageCount = Math.max(1, Math.ceil(filtered.length / size));
    prev.disabled = page === 0;
    next.disabled = page + 1 === pageCount;
    clear(result).append(table([col('district', '구역'), col('place', '장소'),
      { label: '시간대', render: (r) => r.hour == null ? '시각 미입력' : `${String(r.hour).padStart(2, '0')}시` },
      col('records', '활동 기록'), col('workers', '활동자'), col('minutes', '인분'), col('findings', '찾기'),
    ], filtered.slice(page * size, (page + 1) * size), '선택한 조건에 해당하는 장소·시간대 기록이 없습니다.'),
    h('div', { class: 'row' }, prev, h('span', { text: `${page + 1} / ${pageCount} · ${filtered.length}개` }), next));
  }
  for (const field of [place, hours]) field.addEventListener('change', () => { page = 0; render(); });
  render();
  return section('장소·시간대', h('div', { class: 'row' }, field('장소', place), field('시간대', hours)), result);
}
