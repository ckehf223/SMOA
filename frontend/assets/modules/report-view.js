import { field, h, table } from '../js/ui.js';

export const reportNumber = (value) => (value ?? 0).toLocaleString('ko-KR');

export function useReportLayout(element) {
  if (!document.querySelector('link[href="/assets/css/reports-view.css"]')) {
    document.head.append(h('link', { rel: 'stylesheet', href: '/assets/css/reports-view.css' }));
  }
  element.classList.add('report-view');
}

export function reportPeriod(from, to) {
  const update = () => {
    from.max = to.value;
    to.min = from.value;
  };
  const preset = (label, start) => h('button', { type: 'button', class: 'btn small', text: label, onclick: () => {
    const today = new Date(Date.now() + 9 * 3600 * 1000);
    to.value = today.toISOString().slice(0, 10);
    from.value = start(today, to.value);
    update();
    from.form.requestSubmit();
  } });
  from.addEventListener('input', update);
  to.addEventListener('input', update);
  update();
  return h('fieldset', { class: 'report-period' }, h('legend', { text: '조회 기간' }),
    h('div', { class: 'report-date-pair' }, field('시작일', from), field('종료일', to)),
    h('div', { class: 'report-presets', 'aria-label': '빠른 기간 선택' },
      preset('최근 7일', (today) => new Date(today.getTime() - 6 * 86400000).toISOString().slice(0, 10)),
      preset('금월', (_today, end) => end.slice(0, 7) + '-01')));
}

export function reportCards(values, label) {
  return h('section', { class: 'report-cards', 'aria-label': label },
    values.map(([title, value, detail]) => h('article', { class: 'report-card' },
      h('h3', { text: title }), h('strong', { text: value }),
      detail ? h('small', { text: detail }) : null)));
}

export function reportTable(title, columns, rows, empty, description) {
  const scroll = table(columns, rows, empty);
  scroll.setAttribute('aria-label', title);
  scroll.setAttribute('role', 'region');
  scroll.tabIndex = 0;
  return h('section', { class: 'report-block' },
    h('h3', { text: title }), description ? h('p', { class: 'muted', text: description }) : null, scroll);
}
