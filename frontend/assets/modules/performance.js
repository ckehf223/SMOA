import { clear, errorMessage, field, h, notice, select } from '../js/ui.js';
import { reportCards, reportNumber, reportPeriod, reportTable, useReportLayout } from './report-view.js';

const ratio = (count, baseline) => baseline ? (100 * count) / baseline : null;
const percent = (value) => value === null ? '—' : `${value.toFixed(1)}%`;
const duration = (minutes) => `${reportNumber(Math.floor(minutes / 60))}시간 ${minutes % 60}분`;

const stageCompare = (data) => data.metrics.slice(1).map((metric, index) => {
  const previous = data.metrics[index];
  const denominator = data.total[previous.key];
  return { stage: metric.label, prior: previous.label, previous: denominator, current: data.total[metric.key],
    rate: percent(ratio(data.total[metric.key], denominator)) };
});

function stageCell(metric, prior, values, total) {
  const count = values[metric.key];
  if (!prior) return reportNumber(count);
  const value = ratio(count, values[prior.key]);
  const overall = ratio(total[metric.key], total[prior.key]);
  const delta = value === null || overall === null ? null : Math.round((value - overall) * 10) / 10;
  const direction = delta > 0 ? 'over' : delta < 0 ? 'under' : null;
  return h('span', { class: 'report-heat-value', 'data-delta': direction },
    h('strong', { text: `${reportNumber(count)}건` }),
    h('small', { text: percent(value) }),
    direction ? h('small', { text: `${delta > 0 ? '+' : ''}${delta.toFixed(1)}%p` }) : null);
}

function renderOverview(results, data, group, districtName, classification) {
  const total = { district: '전체', values: data.total };
  const columns = [{ label: '구역', render: (row) => row === total
    ? h('strong', { class: 'report-total', text: row.district }) : row.district }];
  if (group) columns.push({ label: group, render: (row) => h('span', { class: 'report-row-label', text: row.group }) });
  const counts = data.metrics.map((metric, index) => ({
    label: metric.label,
    render: (row) => group ? reportNumber(row.values[metric.key])
      : stageCell(metric, data.metrics[index - 1], row.values, data.total),
  }));
  const visible = data.rows.length ? [...data.rows, total] : [];
  const cards = group ? [
    ['찾B', `${reportNumber(data.total.findings)}건`],
    ['만픽', `${reportNumber(data.total.manpik)}건`],
    ['활동 건수', `${reportNumber(data.total.activities)}건`],
    ['활동 시간', duration(data.total.minutes)],
  ] : data.metrics.slice(0, 4).map(({ key, label }) => [label, `${reportNumber(data.total[key])}건`]);
  clear(results).append(
    h('p', { class: 'muted report-scope',
      text: `${data.period.from} ~ ${data.period.to} · ${districtName} · 분류2 ${classification || '전체'}` }),
    reportCards(cards, '기간 실적 요약'),
    reportTable(group ? '기간 내 단계별 실적' : '기간별 단계 실적과 비율', [...columns, ...counts], visible,
      '선택 조건에 해당하는 실적이 없습니다.', group
        ? '찾은 날짜, 단계별 최초 기록일과 활동 기록일을 기준으로 집계합니다.'
        : '신규 건수, 직전 단계 대비 비율, 전체 비율과의 차이를 표시합니다.'));
  if (!group && data.rows.length) results.append(reportTable('전체 단계별 실적 비율', [
    { key: 'prior', label: '직전 단계' }, { key: 'stage', label: '비교 단계' },
    { label: '직전 건수', render: (row) => reportNumber(row.previous) },
    { label: '비교 건수', render: (row) => reportNumber(row.current) },
    { key: 'rate', label: '실적 비율' },
  ], stageCompare(data), undefined, '같은 조회 기간의 두 단계 건수를 비교합니다.'));
}

export async function mount(ctx) {
  useReportLayout(ctx.container);
  const base = '/api/programs/' + ctx.programId;
  const districts = await ctx.api.get(base + '/options');
  const group = { memberData: '활동자·인도자', classData: '반' }[ctx.programId];
  const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  const from = h('input', { type: 'date', value: today.slice(0, 7) + '-01', required: true });
  const to = h('input', { type: 'date', value: today, required: true });
  const district = select([['', '전체 구역'], ...districts.map((d) => [JSON.stringify([d.regionCode, d.districtCode]), d.name])], '');
  const classification = select([['', '전체'], '노방', '소셜링', '온라인', '세미나', '기타'], '');
  const className = h('input', { type: 'text', maxlength: 60, placeholder: '전체 반' });
  const results = h('div', { 'aria-live': 'polite' });
  const submit = h('button', { type: 'submit', class: 'btn primary', text: '조회' });
  const download = h('button', { type: 'button', class: 'btn', text: '엑셀 내보내기', disabled: true,
    onclick: async () => {
      try {
        await ctx.api.download(base + '/export/summary.xlsx?' + query, ctx.programId + '.xlsx');
      } catch (error) {
        ctx.toast(errorMessage(error), 'error');
      }
    },
  });
  let query = '';
  const form = h('form', { class: 'panel row dashboard-reading-filters', onsubmit: (event) => { event.preventDefault(); void load(); } },
    reportPeriod(from, to), field('구역', district), field('분류2', classification),
    field('반', className), submit, ctx.permissions.export ? download : null);
  ctx.container.append(form, results);
  await load();

  async function load() {
    if (submit.disabled) return;
    const filters = new URLSearchParams({ from: from.value, to: to.value });
    const districtName = district.selectedOptions[0].textContent;
    if (className.value.trim()) filters.set('className', className.value.trim());
    if (classification.value) filters.set('classification', classification.value);
    if (district.value) {
      const [regionCode, districtCode] = JSON.parse(district.value);
      filters.set('regionCode', regionCode);
      filters.set('districtCode', districtCode);
    }
    submit.disabled = true;
    download.disabled = true;
    try {
      const data = await ctx.api.get(base + '/data/summary?' + filters);
      renderOverview(results, data, group, districtName, filters.get('classification'));
      query = filters.toString();
      download.disabled = false;
    } catch (error) {
      clear(results).append(notice('error', errorMessage(error)));
    } finally {
      submit.disabled = false;
    }
  }
}
