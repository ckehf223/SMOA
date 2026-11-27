import { clear, errorMessage, field, h, notice, select, table } from '../js/ui.js';

const BASE = '/api/programs/findingStats';
const col = (key, label) => ({ key, label });
const today = () => new Intl.DateTimeFormat('sv-SE', { dateStyle: 'short', timeZone: 'Asia/Seoul' }).format(new Date());
const hourLabel = (hour) => `${String(hour).padStart(2, '0')}시`;
const jobLabel = (job) => ({ __unclassified__: '미입력', __unlinked__: '명부 미연결' })[job] || job;
const number = (n) => new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 2 }).format(n);
const button = (text, onclick) => h('button', { class: 'btn', type: 'button', text, onclick });

function panel(title, content) {
  return h('section', { class: 'panel' }, h('h3', { text: title }), content);
}

export async function mount(ctx) {
  const districts = await ctx.api.get(`${BASE}/options`);
  if (!ctx.container.isConnected) return;
  const end = today();
  const from = h('input', { type: 'date', value: `${end.slice(0, 7)}-01` });
  const to = h('input', { type: 'date', value: end });
  const district = select([['', '전체 구역'], ...districts.map((d) => [JSON.stringify([d.regionCode, d.districtCode]), d.name])], '');
  const job = select([['', '전체 직업구분']], '');
  const content = h('div', { 'aria-live': 'polite' });
  const detail = h('div');
  const submit = h('button', { class: 'btn primary', type: 'submit', text: '조회' });
  let latest = 0;
  let lastQuery = null;

  function query() {
    const values = new URLSearchParams();
    for (const [key, control] of Object.entries({ from, to, job })) if (control.value) values.set(key, control.value);
    if (district.value) {
      const [region, code] = JSON.parse(district.value);
      values.set('regionCode', region);
      values.set('districtCode', code);
    }
    return values;
  }

  async function load() {
    const token = ++latest;
    const params = query();
    submit.disabled = true;
    if (download) download.disabled = true;
    clear(detail);
    clear(content).append(notice('info', '노방 찾기와 주관 구간을 조회하는 중입니다.'));
    try {
      const data = await ctx.api.get(`${BASE}/data/summary?${params}`);
      if (token !== latest || !ctx.container.isConnected) return;
      const choices = Array.from(new Set([...(job.value ? [job.value] : []), ...data.jobCodes]));
      const chosen = job.value;
      job.replaceChildren(...select([['', '전체 직업구분'], ...choices.map((code) => [code, jobLabel(code)])], chosen).children);
      job.value = chosen;
      render(data);
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

  function showLeader(leader) {
    clear(detail).append(panel(`${leader.name} 주관 구간`, h('div', {},
      h('p', { text: `${jobLabel(leader.jobCode)} · 순주관시간 ${number(leader.minutes)}분 · 찾기 ${number(leader.linked)}건` }),
      leader.uncertainSessions ? h('p', { class: 'muted', text: `같은 주관자의 여러 구간과 겹친 ${leader.uncertainSessions}건은 주관자 합계에 한 번 반영했습니다.` }) : null,
      table([col('district', '구역'), col('start', '시작'), col('end', '종료'), col('minutes', '주관시간(분)'), col('linked', '연결 찾기')], leader.sessions),
      button('닫기', () => clear(detail)))));
    detail.setAttribute('tabindex', '-1');
    detail.focus();
  }

  function render(data) {
    const groups = new Map();
    for (const leader of data.leaders) {
      const count = leader.sessions.length;
      if (count) groups.set(count, [...(groups.get(count) || []), leader]);
    }
    const top = Array.from(groups).sort(([a], [b]) => b - a).slice(0, 3);
    const totals = [
      ['기간 내 노방 찾기', data.total], ['주관 구간 연결', data.linked],
      ['직업 조건에 해당하는 연결', data.selectedLinked], ['주관 구간 미연결', data.total - data.linked],
    ];
    const reasons = [
      ['시각 미입력', data.gaps.missingTime], ['구역 미입력', data.gaps.missingDistrict],
      ['주관 구간 없음', data.gaps.noSession], ['여러 주관자와 겹침', data.gaps.ambiguous],
    ];
    const max = Math.max(1, ...data.hours.map((row) => row.total));
    clear(content).append(h('div', { class: 'dashboard-reading-cards' }, totals.map(([label, total]) => h('article', { class: 'panel dashboard-reading-card' },
      h('span', { class: 'muted', text: label }), h('strong', { text: `${number(total)}건` })))),
    top.length ? panel('기간 내 주관 횟수 상위', h('ol', {}, top.map(([count, leaders]) =>
      h('li', {}, h('span', { text: `${number(count)}회 ` }), leaders.map((leader) => button(leader.name, () => showLeader(leader))))))) : null,
    panel('주관자별 찾기', table([
      { label: '주관자', render: (leader) => button(leader.name, () => showLeader(leader)) },
      { label: '직업구분', render: (leader) => jobLabel(leader.jobCode) },
      col('linked', '주관 시간대 찾기'),
      { label: '주요 주관 시간대', render: (leader) => leader.peakHours.map(hourLabel).join(', ') || '—' },
      col('minutes', '순주관시간(분)'), { label: '시간당 찾기', render: (leader) => leader.efficiency == null ? '—' : number(leader.efficiency) },
    ], data.leaders, '선택 조건에 해당하는 주관 기록이 없습니다.')),
    panel('미연결 사유', table([col('label', '항목'), col('count', '건수')], reasons.map(([label, count]) => ({ label, count })))),
    panel('시간대별 찾기', table([
      { label: '시간대', render: (row) => hourLabel(row.hour) }, col('total', '찾기'), col('linked', '주관 연결'),
      { label: '찾기 건수', render: (row) => h('meter', { min: 0, max, value: row.total, 'aria-label': `${hourLabel(row.hour)} ${row.total}건` }) },
    ], data.hours)),
    h('details', { class: 'panel' }, h('summary', { text: '일자별 찾기' }), table([
      col('date', '날짜'), col('total', '찾기'), col('missingTime', '시각 미입력'),
    ], data.days.filter((day) => day.total > 0), '선택한 기간에 찾기 기록이 없습니다.')));
  }

  function preset(kind) {
    const day = today();
    to.value = day;
    if (kind === 'month') from.value = `${day.slice(0, 7)}-01`;
    else if (kind === 'week') {
      const date = new Date(`${day}T00:00:00Z`);
      date.setUTCDate(date.getUTCDate() - date.getUTCDay());
      from.value = date.toISOString().slice(0, 10);
    } else { from.value = ''; to.value = ''; }
    void load();
  }

  const download = ctx.permissions?.export ? button('통계 엑셀', async () => {
    try { await ctx.api.download(`${BASE}/export/summary.xlsx?${lastQuery}`, '찾기·주관자 통계.xlsx'); }
    catch (error) { ctx.toast(errorMessage(error), 'error'); }
  }) : null;
  ctx.container.append(h('form', { class: 'panel row dashboard-reading-filters', onsubmit: (event) => {
    event.preventDefault(); void load();
  } }, field('찾은 날짜 시작', from), field('찾은 날짜 종료', to), field('구역', district), field('주관자 직업구분', job),
  submit, button('금주', () => preset('week')), button('금월', () => preset('month')), button('전체', () => preset('all')), download), detail, content);
  await load();
}
