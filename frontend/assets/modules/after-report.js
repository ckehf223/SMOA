import { action, districtKey, input, queryValues } from './business-ui.js';
import { clear, errorMessage, field, h, notice, select, table } from '../js/ui.js';

const LABELS = { ORGANIZER: '주관자', PARTICIPANT: '활동자' };
const SCORES = [['1', '1 아니다'], ['2', '2 때때로'], ['3', '3 그렇다']];
const CHECKS = [['yes', '예'], ['no', '아니오']];
const PAGE_SIZE = 50;
const MAX_RANGES = 24;
const MAX_COUNT = 2147483647;
const CSS_PATH = '/assets/css/after-report.css';
const VIEWS = {
  records: '전체 기록',
  daily: '일별 활동 집계',
  monthly: '월별 찾기 실적',
  checklist: '체크리스트 분석',
};
const number = new Intl.NumberFormat('ko-KR');
const percent = new Intl.NumberFormat('ko-KR', { style: 'percent', maximumFractionDigits: 1 });

function emptyChoice(label, values, attrs = {}) {
  return select([['', label], ...values], '', attrs);
}

function dialogWithTitle(ctx, title, trigger) {
  const heading = h('h3', { id: 'after-report-dialog-title', class: 'after-report-heading', text: title, tabindex: -1 });
  const content = h('div', { class: 'record-form' }, heading);
  const dialog = h('dialog', {
    class: 'record-dialog after-report-dialog', 'aria-labelledby': heading.id,
    onclose: () => {
      dialog.remove();
      if (trigger.isConnected) trigger.focus();
    },
  }, content);
  ctx.container.append(dialog);
  return { dialog, heading, content };
}

function reportTable(columns, rows, label, emptyMessage) {
  const element = table(columns, rows, emptyMessage);
  element.setAttribute('role', 'region');
  element.setAttribute('aria-label', label);
  element.tabIndex = 0;
  return element;
}

function analysisTable(view, data) {
  const count = (key, label) => ({ label, render: (row) => h('span', { class: 'numeric', text: number.format(row[key]) }) });
  if (view === 'checklist') {
    return reportTable([
      { label: '체크리스트 항목', key: 'label' },
      count('score1', '아니다'), count('score2', '때때로'), count('score3', '그렇다'), count('total', '응답 수'),
      { label: '그렇다 비율', render: ({ score3Rate }) => h('span', {
        class: 'numeric', text: score3Rate == null ? '—' : percent.format(score3Rate / 100),
      }) },
    ], data.checklist.some(({ total }) => total > 0) ? data.checklist : [], VIEWS[view], '조회 조건에 맞는 활동자 응답이 없습니다.');
  }
  const daily = view === 'daily';
  return reportTable([
    { label: daily ? '활동일' : '활동월', key: 'period' },
    count('organizerFindings', '전체 찾기 (주관자 보고)'), count('participantFindings', '본인 찾기 (활동자 보고)'),
    count('organizerReports', '주관자 보고 수'), count('participantReports', '활동자 보고 수'),
    ...(daily ? [count('headcount', '실제 참여 인원')] : []),
  ], data[view], VIEWS[view], '조회 조건에 맞는 활동 집계가 없습니다.');
}

export async function mount(ctx) {
  const root = ctx.container;
  const base = `/api/programs/${ctx.programId}`;
  const organizer = ctx.programId === 'afterOrganizer';
  const all = ctx.programId === 'afterAll';
  if (!document.querySelector(`link[href="${CSS_PATH}"]`)) {
    document.head.append(h('link', { rel: 'stylesheet', href: CSS_PATH }));
  }
  root.classList.add('after-report');
  root.append(notice('info', '사후 조회 조건을 불러오는 중입니다.'));
  const options = await ctx.api.get(`${base}/options`);
  if (!root.isConnected) return;
  const districtChoices = options.districts.map((district) => [districtKey(district), district.label]);
  const districtLabels = new Map(districtChoices);
  const districtLabel = (report) => districtLabels.get(districtKey(report)) ?? report.districtCode;
  const from = input('from', '', { type: 'date', min: '0001-01-01', max: '9999-12-31' });
  const to = input('to', '', { type: 'date', min: '0001-01-01', max: '9999-12-31' });
  const scope = emptyChoice('권한 내 전체 구역', districtChoices, { name: 'scope' });
  const status = h('div');
  const views = all ? Object.entries(VIEWS) : [['records', '사후 보고 목록']];
  const tabs = all ? h('div', { class: 'after-report-tabs', role: 'tablist', 'aria-label': '전체 사후 보기' }) : null;
  const results = new Map();
  const tabButtons = new Map();
  let activeView = 'records';
  let applied = {};
  let requestId = 0;

  function selectView(view, focus = false) {
    if (view !== activeView) {
      results.get(activeView).hidden = true;
      tabButtons.get(activeView).setAttribute('aria-selected', 'false');
      tabButtons.get(activeView).tabIndex = -1;
      activeView = view;
      tabButtons.get(view).setAttribute('aria-selected', 'true');
      tabButtons.get(view).tabIndex = 0;
      void load(1);
    }
    if (focus) tabButtons.get(view).focus();
  }

  views.forEach(([view, label], index) => {
    const active = view === activeView;
    const tabId = `after-report-tab-${view}`;
    const panelAttrs = all ? { id: `after-report-panel-${view}`, role: 'tabpanel', 'aria-labelledby': tabId } : {};
    const panel = h('section', { class: 'panel after-report-list', ...panelAttrs, hidden: !active, 'aria-live': 'polite' });
    results.set(view, panel);
    if (!tabs) return;
    const button = h('button', {
      type: 'button', class: 'btn', id: tabId, role: 'tab', 'aria-controls': panel.id,
      'aria-selected': String(active), tabindex: active ? 0 : -1, text: label,
      onclick: () => selectView(view),
      onkeydown: (event) => {
        const positions = {
          ArrowLeft: (index + views.length - 1) % views.length,
          ArrowRight: (index + 1) % views.length,
          Home: 0,
          End: views.length - 1,
        };
        const next = positions[event.key];
        if (!Number.isInteger(next)) return;
        event.preventDefault();
        selectView(views[next][0], true);
      },
    });
    tabButtons.set(view, button);
    tabs.append(button);
  });

  function apply() {
    to.setCustomValidity(from.value && to.value && from.value > to.value ? '종료일은 시작일과 같거나 이후여야 합니다.' : '');
    if (!filters.reportValidity()) return;
    applied = queryValues(filters);
    void load(1);
  }

  const canWrite = ctx.permissions?.write && !all;
  const filters = h('form', { class: 'panel row dashboard-reading-filters after-report-filters', novalidate: true, onsubmit: (event) => {
    event.preventDefault();
    apply();
  } },
  field('활동 시작일', from), field('활동 종료일', to), field('구역', scope),
  h('button', { type: 'submit', class: 'btn primary', text: '조회' }),
  action('초기화', () => { filters.reset(); apply(); }),
  canWrite ? action('보고 등록', (event) => {
    showEditor(ctx, options, districtChoices, scope.value, organizer, event.currentTarget, () => load(1));
  }) : null);
  clear(root).append(filters, ...[tabs, status, ...results.values()].filter(Boolean));

  async function load(page) {
    const token = ++requestId;
    const view = activeView;
    const result = results.get(view);
    const records = view === 'records';
    const params = new URLSearchParams(records ? { page, size: PAGE_SIZE } : {});
    Object.entries(applied).forEach(([key, value]) => { if (value) params.set(key, value); });
    const query = params.size ? `?${params}` : '';
    clear(status).append(notice('info', records ? '사후 보고를 조회하는 중입니다.' : '사후 보고를 집계하는 중입니다.'));
    result.hidden = true;
    try {
      const data = await ctx.api.get(`${base}/${records ? 'page' : 'analysis'}${query}`);
      if (token !== requestId || !root.isConnected) return;
      if (records) renderList(result, data);
      else clear(result).append(
        h('header', { class: 'after-report-list-header' }, h('h3', { text: VIEWS[view] })),
        analysisTable(view, data),
      );
      clear(status);
      result.hidden = false;
    } catch (error) {
      if (token !== requestId || !root.isConnected) return;
      clear(status).append(notice('error', errorMessage(error)), action('다시 시도', () => load(page)));
    }
  }

  function renderList(result, { items, total, page, size }) {
    const columns = [
      { label: '활동일', key: 'date' },
      { label: '구역', render: districtLabel },
      ...(all ? [{ label: '구분', render: (report) => LABELS[report.role] }] : []),
      { label: '타임', key: 'slot' },
      { label: '활동 장소', key: 'location' },
      { label: '성명', key: 'name' },
      { label: organizer ? '전체 찾기' : '찾기', key: 'findings' },
      { label: '상세', render: (report) => action('보기', (event) => showReport(
        ctx, options, report, districtLabel(report), event.currentTarget), 'small') },
    ];
    const list = reportTable(columns, items, '사후 보고 조회 결과', '조회 조건에 맞는 보고가 없습니다.');
    const lastPage = Math.max(1, Math.ceil(total / size));
    const previous = action('이전', () => load(page - 1), 'small');
    const next = action('다음', () => load(page + 1), 'small');
    previous.disabled = page === 1;
    next.disabled = page >= lastPage;
    clear(result).append(
      h('header', { class: 'after-report-list-header' }, h('h3', { text: '사후 보고 목록' }),
        h('span', { class: 'muted', text: `${total.toLocaleString('ko-KR')}건` })),
      list,
      lastPage > 1 ? h('div', { class: 'after-report-list-footer', role: 'group', 'aria-label': '페이지 이동' },
        previous, h('span', { text: `${page} / ${lastPage}` }), next) : null,
    );
  }

  await load(1);
}

function showReport(ctx, options, report, district, trigger) {
  const organizer = report.role === 'ORGANIZER';
  const { dialog, heading, content } = dialogWithTitle(ctx, `${LABELS[report.role]} 사후 보고`, trigger);
  const rows = [
    ['활동일', report.date], ['구역', district], ['타임', report.slot], ['활동 장소', report.location], ['성명', report.name],
    [organizer ? '주관 시간' : '활동 시간', report.timeRanges.map(({ start, end }) => `${start} – ${end}`).join('\n')],
    ...(organizer
      ? [['활동자 수', report.headcount], ['전체 찾기 건수', report.findings], ['본인 찾기 건수', report.personalFindings],
        ['물약 포지션', report.potionName], ['특이사항', report.notes]]
      : [['본인 찾기 건수', report.findings], ['비고', report.remarks]]),
  ];
  const questions = organizer ? options.organizerChecks : options.participantChecks;
  const answers = organizer ? report.organizerChecklist : report.participantScores;
  const labels = organizer ? { true: '예', false: '아니오' } : Object.fromEntries(SCORES);
  content.append(
    h('dl', { class: 'after-report-details' }, rows.map(([label, value]) =>
      h('div', { class: 'after-report-detail-pair' }, h('dt', { text: label }), h('dd', { text: value ?? '—' })))),
    h('h4', { text: organizer ? '주관자 체크리스트' : '활동 체크리스트' }),
    h('ol', { class: 'after-report-check-results' }, questions.map((question, index) =>
      h('li', {}, question, ' ', h('strong', { text: labels[answers?.[index]] ?? '—' })))),
    h('div', { class: 'record-dialog-actions actions' }, action('닫기', () => dialog.close(), 'primary')),
  );
  dialog.showModal();
  heading.focus();
}

function formSection(title, ...elements) {
  return h('fieldset', { class: 'after-report-form-section' }, h('legend', { text: title }), ...elements);
}

function countField(name, required) {
  return input(name, '', { type: 'text', inputmode: 'numeric', maxlength: 10, required });
}

function checklist(questions, organizer) {
  const choices = organizer ? CHECKS : SCORES;
  return questions.map((question, index) => h('fieldset', { class: 'after-report-question' },
    h('legend', { text: `${index + 1}. ${question}` }),
    h('div', { class: 'after-report-choices' }, choices.map(([value, label]) =>
      h('label', { class: 'after-report-choice' }, input(`answer${index}`, value, { type: 'radio', required: true }), label)))));
}

function trimText(control) {
  const value = control.value.trim();
  control.setCustomValidity(value || !control.required ? '' : '내용을 입력해 주세요.');
  return value;
}

function readCount(control) {
  const value = control.value;
  if (!value && !control.required) {
    control.setCustomValidity('');
    return null;
  }
  const count = Number(value);
  control.setCustomValidity(/^[0-9]+$/.test(value) && count <= MAX_COUNT ? '' : '0 이상의 정수로 입력해 주세요.');
  return count;
}

function clockValue(control) {
  const value = control.value;
  const match = /^([0-9]{1,2}):?([0-5][0-9])$/.exec(value);
  const time = match && Number(match[1]) <= 23 ? `${match[1].padStart(2, '0')}:${match[2]}` : '';
  control.setCustomValidity(!value || time ? '' : '00:00부터 23:59 사이의 시간을 입력해 주세요.');
  return time;
}

function timeField(organizer) {
  const rows = [];
  const host = h('div');
  const addButton = action('시간 추가', () => addRow(true));

  function addRow(removable) {
    function timeInput() {
      const control = input('', '', {
        type: 'text', inputmode: 'numeric', maxlength: 5, placeholder: '00:00',
        autocomplete: 'off', required: true,
      });
      control.addEventListener('blur', () => {
        const time = clockValue(control);
        if (time) control.value = time;
      });
      return control;
    }
    const start = timeInput();
    const end = timeInput();
    const remove = action('삭제', () => {
      rows.splice(rows.indexOf(entry), 1);
      row.remove();
      addButton.disabled = false;
      addButton.focus();
    }, 'small');
    remove.setAttribute('aria-label', '이 활동 시간 구간 삭제');
    const row = h('div', { class: 'after-report-time-row' }, field('시작시간', start), field('종료시간', end), removable ? remove : null);
    const entry = { start, end };
    rows.push(entry);
    host.append(row);
    addButton.disabled = rows.length >= MAX_RANGES;
    if (removable) start.focus();
  }

  addRow(false);
  const element = h('fieldset', { class: 'after-report-time-field' }, h('legend', { text: organizer ? '주관 시간' : '활동 시간' }),
    h('p', { class: 'after-report-hint', text: '24시간제 · 1530 → 15:30' }), host,
    organizer ? null : h('div', { class: 'after-report-time-actions' }, addButton));
  return { element, values: () => rows.map(({ start, end }) => {
    const range = { start: clockValue(start), end: clockValue(end) };
    if (range.start && range.end && range.start >= range.end) {
      end.setCustomValidity('종료시간은 시작시간보다 늦어야 합니다.');
    }
    return range;
  }) };
}

function showEditor(ctx, options, districts, scope, organizer, trigger, refresh) {
  const { dialog, heading, content } = dialogWithTitle(ctx, organizer ? '주관자 보고 등록' : '활동자 보고 등록', trigger);
  const date = input('date', '', { type: 'date', min: '0001-01-01', max: '9999-12-31', required: true });
  const slots = organizer ? options.slots.filter((slot) => slot !== '4타임') : options.slots;
  const slot = emptyChoice('타임 선택', slots, { required: true });
  const district = select([['', '구역 선택'], ...districts], scope || (districts.length === 1 ? districts[0][0] : ''), { required: true });
  const location = emptyChoice('활동 장소 선택', [...options.locations, ['__custom', '직접 입력']], { required: true });
  const customLocation = input('customLocation', '', { type: 'text', maxlength: 80 });
  const customField = field('활동 장소 직접 입력', customLocation);
  customField.hidden = true;
  customLocation.disabled = true;
  location.addEventListener('change', () => {
    const custom = location.value === '__custom';
    customField.hidden = !custom;
    customLocation.disabled = !custom;
    customLocation.required = custom;
    if (custom) customLocation.focus();
  });
  const name = input('name', '', { type: 'text', maxlength: 80, autocomplete: 'name', required: true });
  const potion = input('potionName', '', { type: 'text', maxlength: 80 });
  const time = timeField(organizer);
  const headcount = countField('headcount', organizer);
  const findings = countField('findings', true);
  const personal = countField('personalFindings', false);
  const notes = h('textarea', { rows: 3, maxlength: 1500 });
  const questions = organizer ? options.organizerChecks : options.participantChecks;
  const submit = h('button', { type: 'submit', class: 'btn primary', text: '사후 보고 저장' });
  const cancel = action('취소', () => dialog.close());
  const status = h('div', { role: 'alert' });

  const form = h('form', { novalidate: true, onsubmit: save },
    formSection('활동 정보',
      h('div', { class: 'after-report-fields' },
        field('활동일', date), field(organizer ? '주관 타임' : '활동 타임', slot), field('구역', district),
        field('활동 장소', location), customField, field(organizer ? '주관자 성명' : '활동자 성명', name),
        organizer ? field('물약 포지션 (선택)', potion) : null), time.element),
    formSection(organizer ? '주관자 체크리스트' : '활동 체크리스트', ...checklist(questions, organizer)),
    formSection('활동 결과',
      h('div', { class: 'after-report-fields' },
        organizer ? field('활동자 수', headcount) : null,
        field(organizer ? '전체 찾기 건수' : '본인 찾기 건수', findings),
        organizer ? field('본인 찾기 건수 (선택)', personal) : null),
      field(organizer ? '특이사항 (선택)' : '비고 (선택)', notes)),
    status,
    h('div', { class: 'record-dialog-actions actions' }, cancel, submit));
  if (organizer) {
    content.append(h('p', { class: 'after-report-hint', text: '같은 활동일·구역·타임으로 저장하면 기존 주관자 보고를 갱신합니다.' }));
  }
  content.append(form);
  dialog.addEventListener('cancel', (event) => { if (submit.disabled) event.preventDefault(); });
  dialog.showModal();
  heading.focus();

  async function save(event) {
    event.preventDefault();
    if (submit.disabled) return;
    const custom = location.value === '__custom';
    const payload = {
      date: date.value, slot: slot.value, name: trimText(name),
      location: custom ? trimText(customLocation) : location.value,
      timeRanges: time.values(), findings: readCount(findings),
    };
    if (organizer) {
      payload.headcount = readCount(headcount);
      payload.personalFindings = readCount(personal);
    }
    if (!form.reportValidity()) return;
    [payload.regionCode, payload.districtCode] = JSON.parse(district.value);
    const answers = new FormData(form);
    const selections = questions.map((_, index) => answers.get(`answer${index}`));
    if (organizer) {
      payload.organizerChecklist = selections.map((value) => value === 'yes');
      payload.potionName = potion.value.trim() || null;
      payload.notes = notes.value.trim() || null;
    } else {
      payload.participantScores = selections.map(Number);
      payload.remarks = notes.value.trim() || null;
    }
    submit.disabled = true;
    cancel.disabled = true;
    status.textContent = '';
    try {
      await ctx.api.post(`/api/programs/${ctx.programId}/items`, payload);
    } catch (error) {
      if (!dialog.isConnected) return;
      status.textContent = errorMessage(error);
      submit.disabled = false;
      cancel.disabled = false;
      return;
    }
    if (!dialog.isConnected) return;
    dialog.close();
    ctx.toast('사후 보고를 저장했습니다.', 'ok');
    await refresh();
  }
}
