import { clear, field, h, select, table } from '../js/ui.js';
import { column, districtKey, districtSelect, input, mountData } from './business-ui.js';
import { reportCards, reportNumber, reportPeriod, reportTable, useReportLayout } from './report-view.js';

const percent = (count, total) => total ? `${(100 * count / total).toFixed(1)}%` : '—';
const rate = (count, minutes) => minutes ? (count * 60 / minutes).toFixed(2) : '—';
const hours = (minutes) => minutes ? `${Math.floor(minutes / 60)}시간 ${minutes % 60}분` : '—';

function periodCards(total) {
  return reportCards([
    ['노방 참여율', percent(total.street, total.members), `${reportNumber(total.street)} / ${reportNumber(total.members)}명`],
    ['소셜링 참여율', percent(total.socialing, total.members), `${reportNumber(total.socialing)} / ${reportNumber(total.members)}명`],
    ['노방·소셜링 합산 참여율', percent(total.combined, total.members), `고유 참여자 ${reportNumber(total.combined)}명`],
    ['노방 1인·1시간당 찾기', rate(total.matched, total.minutes),
      `순활동 ${hours(total.minutes)} · 연결 ${reportNumber(total.matched)}건`],
  ], '구역별 핵심 지표');
}

function districtColumn(scope, total) {
  return column('name', '구역', (row) => {
    if (row === total) return h('strong', { class: 'report-total', text: row.name });
    const key = districtKey(row);
    if (!key || key === scope.value || ![...scope.options].some((option) => option.value === key)) return row.name;
    return h('button', { type: 'button', class: 'report-group-link', text: row.name,
      'aria-label': `${row.name} 조회`, onclick: () => {
        scope.value = key;
        scope.form.requestSubmit();
      } });
  });
}

function findingChange(row, peak) {
  const direction = row.change > 0 ? 'up' : row.change < 0 ? 'down' : 'even';
  return h('span', { class: 'report-change', 'data-direction': direction },
    h('meter', { min: 0, max: peak, value: Math.abs(row.change), 'aria-hidden': 'true' }),
    h('strong', { text: (row.change > 0 ? '+' : '') + reportNumber(row.change) }));
}

function hourlyEfficiency(data, populatedHours) {
  const groups = [...data.districtHours, { name: data.total.name, hours: data.hours }];
  const peak = Math.max(0, ...groups.flatMap((group) => group.hours
    .filter((hour) => hour.minutes).map((hour) => (60 * hour.matched) / hour.minutes)));
  return reportTable('시간대별 노방 효율', [
    column('name', '구역'),
    ...populatedHours.map((index) => column('hour', data.hours[index].time, (district) => {
      const hour = district.hours[index];
      const level = hour.minutes && peak ? Math.ceil((60 * hour.matched / hour.minutes) / peak * 4) : 0;
      return h('span', { class: 'report-heat-value', 'data-level': String(level) },
        h('strong', { text: rate(hour.matched, hour.minutes) }),
        hour.minutes ? h('small', { text: hours(hour.minutes) }) :
          hour.streetFindings ? h('small', { text: `찾기 ${reportNumber(hour.streetFindings)}건` }) : null);
    })),
  ], populatedHours.length ? groups : [], '시간이 기록된 노방 활동이나 찾기 실적이 없습니다.',
  '활동시간에 연결된 찾기를 노방 순활동 인시간으로 나눕니다. 진할수록 효율이 높습니다.');
}

const intervalCols = [
  column('time', '기간'), column('findings', '찾기'), column('streetFindings', '노방 찾기'),
  column('minutes', '노방 순활동', (row) => hours(row.minutes)), column('matched', '노방 활동 중 찾기'),
  column('efficiency', '시간당 찾기', (row) => rate(row.matched, row.minutes)),
];

function weeklyRows(days) {
  const weeks = [];
  for (const day of days) {
    if (!weeks.length || new Date(day.time + 'T00:00:00Z').getUTCDay() === 0) {
      weeks.push({ from: day.time, to: day.time, findings: 0, streetFindings: 0, minutes: 0, matched: 0 });
    }
    const week = weeks.at(-1);
    week.to = day.time;
    for (const count of ['findings', 'streetFindings', 'minutes', 'matched']) week[count] += day[count];
  }
  return weeks.map((week) => ({ ...week, time: `${week.from} ~ ${week.to}` }));
}

function periodDetail(days) {
  const content = h('div');
  const daysButton = h('button', { type: 'button', class: 'btn small', text: '일별', onclick: () => view(false) });
  const weeksButton = h('button', { type: 'button', class: 'btn small', text: '주별', onclick: () => view(true) });
  const weekly = weeklyRows(days);
  function view(byWeek) {
    daysButton.setAttribute('aria-pressed', String(!byWeek));
    weeksButton.setAttribute('aria-pressed', String(byWeek));
    const scroll = table(intervalCols, byWeek ? weekly : days);
    scroll.tabIndex = 0;
    scroll.setAttribute('role', 'region');
    scroll.setAttribute('aria-label', byWeek ? '주별 찾기·노방 실적' : '일별 찾기·노방 실적');
    clear(content).append(scroll);
  }
  view(false);
  return h('section', { class: 'report-block' },
    h('h3', { text: '기간별 찾기·노방 실적' }),
    h('div', { class: 'report-segments', role: 'group', 'aria-label': '실적 집계 단위' }, daysButton, weeksButton),
    content);
}

export async function mount(ctx) {
  useReportLayout(ctx.container);
  let scopeInput;
  return mountData(ctx, {
    path: '/data/overview',
    xlsx: 'region-data.xlsx',
    fields(data, values) {
      const classes = [...new Set(['노방', '소셜링', '온라인', '세미나', '기타', ...data.classifications])];
      scopeInput = districtSelect(data.districts, 'scope', districtKey(values));
      return [
        reportPeriod(
          input('from', values.from || data.from, { type: 'date', required: true }),
          input('to', values.to || data.to, { type: 'date', required: true })),
        field('구역', scopeInput),
        field('분류2', select([['all', '전체 분류'], ...classes, ['__unclassified__', '미입력']],
          values.classification2 || '노방', { name: 'classification2' })),
      ];
    },
    render(data) {
      const rows = [...data.items, data.total];
      const compare = [...data.items].sort((left, right) => Math.abs(right.change) - Math.abs(left.change)
        || right.findings - left.findings);
      const peakChange = Math.max(1, ...rows.map((item) => Math.abs(item.change)));
      const populatedHours = data.hours.map((row, index) => row.minutes || row.streetFindings ? index : -1)
        .filter((index) => index >= 0);
      const share = (key) => (row) => `${percent(row[key], row.members)} (${row[key]}명)`;
      const district = districtColumn(scopeInput, data.total);
      return [
        h('p', { class: 'muted report-scope', text: `${data.from} ~ ${data.to} · ${scopeInput.selectedOptions[0].textContent}
          · 분류2 ${data.classification2 === '__unclassified__' ? '미입력' : data.classification2 || '전체'}` }),
        periodCards(data.total),
        reportTable('구역별 찾기 증감', [
          district, column('findings', '조회 기간'), column('previous', '직전 기간'),
          column('change', '증감', (row) => findingChange(row, peakChange)),
          column('share', '현재 비중', (row) => percent(row.findings, data.total.findings)),
        ], [...compare, data.total], undefined, `직전 기간 ${data.previousFrom} ~ ${data.previousTo}`),
        reportTable('구역별 노방·소셜링 참여 구성', [
          district, column('members', '명부'), column('streetOnly', '노방만'),
          column('both', '두 활동 모두'), column('socialingOnly', '소셜링만'), column('neither', '두 활동 기록 없음'),
        ], rows),
        reportTable('구역별 핵심 지표', [
          district, column('street', '노방 참여', share('street')),
          column('socialing', '소셜링 참여', share('socialing')), column('combined', '합산 참여', share('combined')),
          column('minutes', '노방 순활동', (row) => hours(row.minutes)),
          column('efficiency', '시간당 찾기', (row) => rate(row.matched, row.minutes)),
          column('findings', '찾기 실적'),
        ], rows),
        hourlyEfficiency(data, populatedHours),
        h('details', { class: 'panel' }, h('summary', { text: '기간 실적과 기록 상세' }),
          reportTable('시간대별 전체 노방 실적', intervalCols, populatedHours.map((index) => data.hours[index])),
          periodDetail(data.days)),
      ];
    },
  });
}
