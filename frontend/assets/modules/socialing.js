import { badge, clear, field, h, select, table } from '../js/ui.js';
import { column, districtKey, districtSelect, input, mountData } from './business-ui.js';
import { reportCards, reportNumber, reportTable, useReportLayout } from './report-view.js';

const rate = (row) => row.total ? `${(100 * row.converted / row.total).toFixed(1)}%` : '—';
const district = (row) => [row.regionName, row.districtName].filter(Boolean).join(' / ') || '—';
const programName = (row) => row.programName || '모임 미지정';
const pageSize = 30;

function currentDates() {
  const today = new Date(Date.now() + 9 * 3600 * 1000);
  const to = today.toISOString().slice(0, 10);
  const week = new Date(today.getTime() - today.getUTCDay() * 86400000).toISOString().slice(0, 10);
  return { to, week, month: to.slice(0, 7) + '-01' };
}

function socialPeriod(values) {
  const from = input('from', values.from, { type: 'date' });
  const to = input('to', values.to, { type: 'date' });
  const constrain = () => {
    from.max = to.value;
    to.min = from.value;
  };
  const preset = (label, key) => h('button', { type: 'button', class: 'btn small', text: label, onclick: () => {
    const dates = currentDates();
    from.value = dates[key] || '';
    to.value = key ? dates.to : '';
    constrain();
    from.form.requestSubmit();
  } });
  from.addEventListener('input', constrain);
  to.addEventListener('input', constrain);
  constrain();
  return h('fieldset', { class: 'report-period' },
    h('legend', { text: '조회 기간' }),
    h('div', { class: 'report-date-pair' }, field('시작일', from), field('종료일', to)),
    h('div', { class: 'report-presets' },
      preset('오늘', 'to'), preset('금주', 'week'), preset('금월', 'month'), preset('전체', '')));
}

function summary(data) {
  return reportCards([
    ['외부유입', reportNumber(data.total) + '명'],
    ['미전환', reportNumber(data.pending) + '명'],
    ['대상자 전환', reportNumber(data.converted) + '명'],
    ['유입 대비 전환율', rate(data)],
  ], '소셜링 기간 지표');
}

function totalsBy(items, key, label) {
  const groups = new Map();
  for (const item of items) {
    const id = key(item);
    const row = groups.get(id) || { label: label(item), total: 0, pending: 0, converted: 0 };
    row.total += item.total;
    row.pending += item.pending;
    row.converted += item.converted;
    groups.set(id, row);
  }
  return [...groups.values()];
}

function analysis(data) {
  const groups = totalsBy(data.items, (item) => item.programId, programName);
  groups.sort((a, b) => a.label.localeCompare(b.label, 'ko'));
  const months = totalsBy(data.items, (item) => item.month, (item) => item.month || '접수일 미입력');
  const counts = [
    column('total', '신규 유입', (row) => reportNumber(row.total)),
    column('converted', '대상자 전환', (row) => reportNumber(row.converted)),
    column('pending', '미전환', (row) => reportNumber(row.pending)),
    column('conversionRate', '전환율', rate),
  ];
  return [summary(data),
    reportTable('모임별 유입과 전환', [column('label', '모임'), ...counts], groups, '모임별로 집계할 기록이 없습니다.'),
    reportTable('월별 유입과 전환', [column('label', '월'), ...counts], months, '조회 기간에 집계할 접수가 없습니다.')];
}

function intakes(data) {
  const host = h('section', { class: 'report-block' });
  const headings = [
    column('name', '이름'), column('programName', '모임', programName),
    column('date', '유입일', (row) => row.date || '—'),
    column('district', '구역', (row) => h('span', { class: 'report-row-label', text: district(row) })),
    column('introducerName', '인도자', (row) => h('span', { class: 'report-row-label', text: row.introducerName || '—' })),
    column('status', '진행 상태', (row) =>
      row.status === 'converted' ? badge('대상자 전환', 'ok') : badge('외부유입', 'warn')),
  ];
  function render(offset) {
    const rows = data.items.slice(offset, offset + pageSize);
    const grid = table(headings, rows, '조회 조건에 맞는 소셜링 접수가 없습니다.');
    const buttons = h('div', { class: 'actions' });
    if (data.items.length > pageSize) {
      const step = (label, start, disabled) => h('button', {
        type: 'button', class: 'btn small', text: label, disabled,
        onclick: () => {
          render(start);
          host.querySelector('.list-summary').focus();
        },
      });
      buttons.append(step('이전', offset - pageSize, offset === 0),
        step('다음', offset + pageSize, offset + pageSize >= data.items.length));
    }
    const range = rows.length ? ` · ${reportNumber(offset + 1)}–${reportNumber(offset + rows.length)}` : '';
    clear(host).append(h('h3', { text: '소셜링 명단' }), grid,
      h('div', { class: 'list-summary', tabindex: -1 },
        h('p', { class: 'muted', role: 'status', text: `전체 ${reportNumber(data.total)}명${range}` }), buttons));
  }
  render(0);
  const catalog = h('details', { class: 'report-block' }, h('summary', { text: '모임 목록' }),
    table([column('name', '모임'), column('useInd', '사용 여부', (row) => row.useInd === 'Y' ? badge('사용', 'ok') : badge('미사용'))],
      data.programs, '등록된 모임이 없습니다.'));
  return [summary(data), host, catalog];
}

export async function mount(ctx) {
  const stats = ctx.programId === 'socialingStats';
  const dates = currentDates();
  useReportLayout(ctx.container);
  return mountData(ctx, {
    defaults: stats ? { from: dates.month, to: dates.to } : {},
    xlsx: stats ? 'socialing-stats.xlsx' : 'socialing.xlsx',
    fields: (data, values) => [
      socialPeriod(values),
      field('모임', select([['', '전체 모임'], ...data.programs.map((row) => [row.id, row.name])],
        values.programId, { name: 'programId' })),
      field('구역', districtSelect(data.districts, 'scope', districtKey(values))),
      !stats && field('이름 검색', input('q', values.q, { type: 'search', placeholder: '대상자, 인도자', maxlength: 120 })),
      !stats && field('진행 상태', select([['', '전체'], ['pending', '외부유입'], ['converted', '대상자 전환']],
        values.socialStatus, { name: 'socialStatus' })),
    ],
    render: stats ? analysis : intakes,
  });
}
