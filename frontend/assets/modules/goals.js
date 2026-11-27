import { badge, field, h, select } from '../js/ui.js';
import { action, column, dateFields, districtKey, districtSelect, editor, editorActions, input, mountData, saveRow, section } from './business-ui.js';

const PERIODS = { week: '주간', month: '월간', custom: '직접 지정' };
const number = (value) => Number(value).toLocaleString('ko-KR');
const stageKey = (row) => row.stageId || '*';
const stageName = (row) => row.stageName || row.stageId || '전체 찾기';
const districtName = (row) => [row.regionName, row.districtName].filter(Boolean).join(' / ') || '구역 미지정';

function goalMatrix(data, canWrite, open) {
  const groups = new Map();
  const labels = new Map([['*', '전체 찾기'], ...data.stages.map(({ code, name }) => [code, name])]);
  const presentStages = new Set();
  for (const row of data.items) {
    const key = JSON.stringify([row.regionCode, row.districtCode, row.className, row.from, row.to, row.periodUnit]);
    if (!groups.has(key)) groups.set(key, { ...row, stages: new Map() });
    const grouped = groups.get(key).stages;
    const stage = stageKey(row);
    if (!labels.has(stage)) labels.set(stage, stageName(row));
    presentStages.add(stage);
    if (!grouped.has(stage)) grouped.set(stage, []);
    grouped.get(stage).push(row);
  }
  if (!presentStages.size) return null;
  const columns = [
    column('districtName', '구역 · 반', (row) => h('div', { class: 'activity-member' },
      h('strong', { text: districtName(row) }), row.className ? h('small', { class: 'muted', text: row.className }) : null)),
    column('period', '기간', (row) => h('div', { class: 'goal-period-cell' },
      h('span', { text: row.from + ' — ' + row.to }), h('small', { class: 'muted', text: PERIODS[row.periodUnit] || row.periodUnit }))),
    ...[...labels].filter(([stage]) => presentStages.has(stage)).map(([stage, label]) =>
      column(stage, label, (row) => {
        const targets = row.stages.get(stage);
        if (!targets?.length) return h('span', { class: 'muted', text: '—' });
        return h('div', { class: 'goal-matrix-values' }, targets.map((target) =>
          canWrite
            ? h('button', { class: 'btn small goal-matrix-target', type: 'button',
              'aria-label': [districtName(target), target.className, label, target.from, target.to, '목표 편집'].filter(Boolean).join(' '),
              text: number(target.target) + '건', onclick: () => open(target) })
            : h('strong', { text: number(target.target) + '건' })));
      })),
  ];
  const matrix = section('구역·반별 단계 목표', columns, [...groups.values()]);
  matrix.classList.add('goal-matrix');
  const scroll = matrix.querySelector('.table-wrap');
  scroll.tabIndex = 0;
  scroll.setAttribute('role', 'region');
  scroll.setAttribute('aria-label', '구역·반별 단계 목표 표');
  return matrix;
}

export async function mount(ctx) {
  if (!document.getElementById('activity-goals-style')) document.head.append(h('link',
    { id: 'activity-goals-style', rel: 'stylesheet', href: '/assets/css/activity-goals.css' }));
  ctx.container.classList.add('activity-goal-view', 'goals-view');
  const endpoint = '/api/programs/goals/data/items';
  return mountData(ctx, {
    xlsx: 'goals.xlsx',
    fields: (data, values) => [
      ...dateFields(values),
      field('구역', districtSelect(data.districts, 'scope', districtKey(values))),
      field('반', select([['', '전체 반'], ...data.classes], values.className, { name: 'className' })),
      field('단계', select([['', '전체 단계'], ['*', '전체 찾기'], ...data.stages.map((row) => [row.code, row.name])],
        values.stage, { name: 'stage' })),
    ],
    render(data, values, context, refresh) {
      const canWrite = context.permissions?.write;
      const open = (row = {}) => editor(context, row.id ? '목표 편집' : '목표 등록', [
        field('구역', districtSelect(data.districts, 'scope', districtKey(row.id ? row : values), '구역 미지정')),
        field('반', input('className', row.id ? row.className : values.className, { maxlength: 60 })),
        field('시작일', input('from', row.from || values.from, { type: 'date', required: true })),
        field('종료일', input('to', row.to || values.to, { type: 'date', required: true })),
        field('기간 구분', select(Object.entries(PERIODS), row.periodUnit || 'custom', { name: 'periodUnit' })),
        field('단계', select([['', '전체 찾기'], ...data.stages.filter((stage) => stage.useInd === 'Y' || stage.code === row.stageId)
          .map((stage) => [stage.code, stage.name])], row.id ? row.stageId : values.stage === '*' ? '' : values.stage, { name: 'stageId' })),
        field('목표', input('target', row.target ?? 0, { type: 'number', min: 0, max: 23000000, step: 1, required: true })),
      ], (body) => saveRow(context, endpoint, row, { ...body, target: Number(body.target) }), refresh);
      return [
        canWrite ? h('div', { class: 'activity-goal-toolbar actions' }, action('목표 등록', () => open(), 'primary')) : null,
        goalMatrix(data, canWrite, open),
        section('기간별 목표와 실적 (' + number(data.items.length) + '건)', [
          column('districtName', '구역', (row) => districtName(row)), column('className', '반'),
          column('periodUnit', '기간 구분', (row) => PERIODS[row.periodUnit] || row.periodUnit),
          column('from', '시작일'), column('to', '종료일'),
          column('stageName', '단계', stageName),
          column('target', '목표', (row) => number(row.target)),
          column('actual', '실적', (row) => number(row.actual)),
          column('shortfall', '미달', (row) => number(row.shortfall)),
          column('rate', '달성률', (row) => row.rate == null ? '—'
            : badge(Number(row.rate).toFixed(1) + '%', Number(row.rate) >= 100 ? 'ok' : 'warn')),
          ...(canWrite ? [column('actions', '관리', (row) => editorActions(context, endpoint, row, open, refresh, '해제'))] : []),
        ], data.items, '조회 조건에 등록된 목표가 없습니다.'),
      ];
    },
  });
}
