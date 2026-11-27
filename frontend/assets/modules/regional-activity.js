import { field, h, select } from '../js/ui.js';
import { action, column, dateFields, districtKey, districtSelect, editor, editorActions, input, mountData, saveRow, section } from './business-ui.js';

const STATUSES = ['미기록', '적극적 활동자', '전도비 후원자', '소극적 활동자', '비활동자'];
const MODES = [['month', '월별'], ['day', '일자별'], ['range', '기간 조회'], ['all', '전체 기록']];
const number = (value) => value.toLocaleString('ko-KR');

function moveDate(value, fallback, step, month) {
  const anchor = new Date((value || fallback) + (month ? '-01' : '') + 'T00:00:00Z');
  if (!Number.isFinite(anchor.getTime())) return fallback;
  if (month) anchor.setUTCMonth(anchor.getUTCMonth() + step);
  else anchor.setUTCDate(anchor.getUTCDate() + step);
  return anchor.toISOString().slice(0, month ? 7 : 10);
}

function picker(label, name, value, today, month = false) {
  const control = input(name, value, { type: month ? 'month' : 'date' });
  const step = (direction, symbol, description) => h('button', {
    class: 'btn small', type: 'button', text: symbol, 'aria-label': description,
    onclick: () => { control.value = moveDate(control.value, today, direction, month); },
  });
  const reset = action(month ? '이번 달' : '오늘', () => { control.value = today; }, 'small ghost');
  return { control, node: h('div', { class: 'regional-date-picker' },
    field(label, control), step(-1, '‹', month ? '이전 달' : '이전 날'), step(1, '›', month ? '다음 달' : '다음 날'), reset) };
}

function activitySummary(counts) {
  const [unrecorded, active, support, passive, inactive] = STATUSES.map((label) => Number(counts[label] ?? 0));
  const working = active + support + passive;
  return [working, inactive, working + inactive, unrecorded];
}

function statusTag(code, name) {
  return h('span', { class: 'regional-status regional-status-' + (Number(code) || 0) },
    code ? h('span', { 'aria-hidden': 'true', text: code }) : null, name || STATUSES[Number(code) || 0]);
}

function summaryView(ctx, data, values) {
  const month = values.mode === 'month';
  const unit = values.mode === 'all' ? '건' : '명';
  const current = activitySummary(data.counts);
  const labels = values.mode === 'all' ? ['활동 기록', '비활동 기록', '기록 합계'] : ['활동자', '비활동자', '기록 인원', '명부 미기록'];
  const cards = labels.map((label, index) => h('article',
    { class: 'regional-summary-card' }, h('h4', { text: label }),
    h('strong', { text: number(current[index]) }, h('small', { text: unit }))));
  const title = values.mode === 'all' ? '전체 활동 기록 요약' : '활동 상태 요약';
  const scope = data.districts.find((row) => districtKey(row) === districtKey(values));
  const period = month ? values.month || data.today.slice(0, 7)
    : values.mode === 'day' ? values.date || data.today
      : values.mode === 'range' ? values.from + ' — ' + values.to : '';
  const caption = h('p', { class: 'muted', text: [period, scope?.districtName || '전체 구역'].filter(Boolean).join(' · ') });
  if (month) {
    const previousMonth = moveDate(period, period, -1, true);
    const params = new URLSearchParams({ mode: 'month', month: previousMonth });
    if (values.regionCode && values.districtCode) {
      params.set('regionCode', values.regionCode);
      params.set('districtCode', values.districtCode);
    }
    ctx.api.get('/api/programs/regionalActivity/data/list?' + params).then((previous) => {
      if (!caption.isConnected) return;
      caption.textContent += ' · 전월 ' + previousMonth;
      const prior = activitySummary(previous.counts);
      cards.forEach((card, index) => {
        const delta = current[index] - prior[index];
        const className = delta === 0 ? '' : delta > 0 ? ' up' : ' down';
        card.append(h('p', { class: 'regional-comparison' },
          prior[2] ? '전월 ' + number(prior[index]) + '명' : '전월 기록 없음',
          prior[2] && current[2] ? h('span', { class: 'regional-change' + className, text: (delta > 0 ? '+' : '') + number(delta) + '명' }) : null));
      });
    }).catch(() => { if (caption.isConnected) caption.textContent += ' · 전월 조회 불가'; });
  }
  return h('section', { class: 'regional-summary' },
    h('header', { class: 'activity-goal-heading' }, h('h3', { text: title }), caption),
    h('div', { class: 'regional-summary-grid' }, cards),
    h('div', { class: 'regional-status-totals' }, STATUSES.map((label, index) =>
      h('span', {}, statusTag(index, label), h('strong', { text: number(data.counts[label] ?? 0) + unit })))));
}

export async function mount(ctx) {
  if (!document.getElementById('activity-goals-style')) document.head.append(h('link',
    { id: 'activity-goals-style', rel: 'stylesheet', href: '/assets/css/activity-goals.css' }));
  ctx.container.classList.add('activity-goal-view', 'regional-activity-view');
  const endpoint = '/api/programs/regionalActivity/data/items';
  return mountData(ctx, {
    defaults: { mode: 'month' },
    xlsx: 'regional-activity.xlsx',
    fields(data, values) {
      const mode = input('mode', values.mode, { type: 'hidden' });
      const date = picker('조회일', 'date', values.date || data.today, data.today);
      const todayMonth = data.today.slice(0, 7);
      const month = picker('조회월', 'month', values.month || todayMonth, todayMonth, true);
      const range = dateFields({ from: values.from || todayMonth + '-01', to: values.to || data.today });
      const buttons = MODES.map(([key, label]) => h('button', { class: 'btn small', type: 'button', text: label,
        onclick: () => { mode.value = key; update(); },
      }));
      const update = () => {
        buttons.forEach((button, index) => button.setAttribute('aria-pressed', String(MODES[index][0] === mode.value)));
        date.node.hidden = date.control.disabled = mode.value !== 'day';
        month.node.hidden = month.control.disabled = mode.value !== 'month';
        for (const label of range) {
          label.hidden = mode.value !== 'range';
          label.lastChild.disabled = label.hidden;
          label.lastChild.required = !label.hidden;
        }
      };
      update();
      return [h('div', { class: 'regional-mode-row', role: 'group', 'aria-label': '조회 기준' }, mode, ...buttons),
        date.node, month.node, ...range,
        field('구역', districtSelect(data.districts, 'scope', districtKey(values))),
        field('활동 상태', select([['', '전체 상태'], ...STATUSES.map((name, i) => [i, name])], values.status, { name: 'status' }))];
    },
    render(data, values, context, refresh) {
      const canWrite = context.permissions?.write;
      const open = (row = {}) => {
        const status = field('활동 상태', select(STATUSES.slice(1).map((name, i) => [i + 1, name]), row.status || 1, { name: 'status' }));
        if (row.id) {
          editor(context, '활동 상태 편집', [
            h('p', { class: 'muted', text: [row.memberName, row.districtName, row.date || row.month].filter(Boolean).join(' · ') }),
            status,
          ], (body) => saveRow(context, endpoint, row, { status: Number(body.status) }), refresh);
          return;
        }
        const mode = select([['day', '일'], ['month', '월']], values.mode === 'month' ? 'month' : 'day', { name: 'interval' });
        const date = field('활동일', input('date', values.date || data.today, { type: 'date' }));
        const month = field('활동월', input('month', values.month || data.today.slice(0, 7), { type: 'month' }));
        const update = () => {
          date.hidden = month.lastChild.required = mode.value === 'month';
          month.hidden = date.lastChild.required = mode.value === 'day';
          date.lastChild.disabled = date.hidden;
          month.lastChild.disabled = month.hidden;
        };
        mode.addEventListener('change', update);
        update();
        editor(context, '활동 상태 등록', [
          field('구성원', select([['', '구성원 선택'], ...data.members.map((member) => [member.id,
            [member.name, member.districtName, member.code].filter(Boolean).join(' / ')])], row.memberId, { name: 'memberId', required: true })),
          field('등록 기준', mode), date, month, status,
        ], ({ interval, ...body }) => saveRow(context, endpoint, row, { ...body, status: Number(body.status) }), refresh);
      };
      return [
        summaryView(context, data, values),
        canWrite ? h('div', { class: 'activity-goal-toolbar actions' }, action('활동 등록', () => open(), 'primary')) : null,
        section((values.mode === 'range' ? '구성원별 기간 활동기록' : '구성원별 활동기록') + ' (' + number(data.items.length)
          + (values.mode === 'all' ? '건)' : '명)'), [
          column('memberName', '구성원', (row) => h('div', { class: 'activity-member' },
            h('strong', { text: row.memberName }), row.memberCode ? h('small', { class: 'muted', text: row.memberCode }) : null)),
          column('regionName', '지역'), column('districtName', '구역'), column('month', '활동월'),
          column('date', '기록일', (row) => row.date || (row.id ? '월별 기록' : '—')),
          column('statusName', '활동 상태', (row) => statusTag(row.status, row.statusName)),
          ...(canWrite ? [column('actions', '관리', (row) => row.id
            ? editorActions(context, endpoint, row, open, refresh)
            : action('등록', () => open(row)))] : []),
        ], data.items, '조회 조건에 맞는 활동기록이 없습니다.'),
      ];
    },
  });
}
