import { api, formDialog, getJson, h, postXlsx, sendJson, toast } from './common.js';
import { optionSearch, searchKey } from './option-search.js';

/**
 * 활동 기록·지역활동·단계 이동·변경 이력 화면. recordsViews[id](container, me)
 * 이 파일의 화면 도우미(filterForm, dataTable, statCards, download …)는 analytics.js도 함께 쓴다.
 */

/* ---------- 공용 도우미 ---------- */

export const todayStr = () => new Date().toLocaleDateString('sv');
export const monthStart = () => `${todayStr().slice(0, 8)}01`;
export function shiftDay(day, n) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export const num = (v, digits = 0) => (v == null || Number.isNaN(v) ? '-' : Number(v).toLocaleString('ko-KR', { maximumFractionDigits: digits }));
export const pct = (v, digits = 1) => (v == null || Number.isNaN(v) ? '-' : `${Number(v).toLocaleString('ko-KR', { maximumFractionDigits: digits })}%`);

export const field = (label, control, cls) => h('label', { class: cls }, label, control);
export const textInput = (type, name, value = '', extra = {}) => h('input', { type, name, value, ...extra });

/** options: [{value,label}] 또는 문자열 배열. all이 null이면 '전체' 항목을 만들지 않는다. */
export function selectOf(name, options, value = '', all = '전체') {
  const list = options.map((o) => (typeof o === 'string' ? { value: o, label: o } : o));
  return h('select', { name, value },
    all === null ? null : h('option', { value: '' }, all),
    list.map((o) => h('option', { value: o.value }, o.label)));
}

export const regionOptions = (me) => me.districts.map((d) => ({ value: d.name, label: d.name }));

/** 값이 있는 항목만 쿼리 문자열로 만든다. */
export const qs = (obj) => new URLSearchParams(Object.entries(obj).filter(([, v]) => v !== '' && v != null && v !== false).map(([k, v]) => [k, String(v)]));
export const formValues = (form) => Object.fromEntries([...new FormData(form)].filter(([, v]) => v !== ''));

export function filterForm(controls, run, extra = []) {
  const form = h('form', { class: 'toolbar', role: 'search', onsubmit: (e) => { e.preventDefault(); run(formValues(form)); } },
    controls,
    h('div', { class: 'actions' }, h('button', { type: 'submit' }, '조회'), extra));
  return form;
}

export const errorBox = (err) => h('p', { class: 'status error', role: 'alert' }, err.message);

/** 결과 영역을 비우고 불러오는 동안 안내를 보인 뒤, build()가 만든 노드로 바꾼다. */
export async function showInto(target, build) {
  target.replaceChildren(h('p', { class: 'status' }, '불러오는 중…'));
  try {
    target.replaceChildren(await build());
  } catch (err) {
    target.replaceChildren(errorBox(err));
  }
}

export async function download(url, fallbackName) {
  try {
    const res = await api('GET', url);
    const href = URL.createObjectURL(await res.blob());
    const a = h('a', { href, download: /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? fallbackName });
    document.body.append(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(href);
    toast('엑셀 파일을 내려받았습니다.');
  } catch (err) {
    toast(err.message, 'error');
  }
}

export function dataTable(headers, rows, label) {
  if (!rows.length) return h('div', { class: 'card empty' }, '표시할 자료가 없습니다.');
  return h('div', { class: 'table-wrap', tabindex: '0', role: 'region', 'aria-label': label },
    h('table', null,
      h('thead', null, h('tr', null, headers.map((t) => h('th', { scope: 'col' }, t)))),
      h('tbody', null, rows.map((r) => h('tr', null, r.map((c) => h('td', null, c)))))));
}

export const statCards = (items) => h('div', { class: 'cards' },
  items.map(([value, caption]) => h('div', { class: 'card stat' }, h('div', { class: 'num' }, String(value)), h('div', { class: 'cap' }, caption))));

export function barList(rows) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return h('div', { class: 'bars' }, rows.map((r) => [
    h('span', null, r.label),
    h('progress', { max, value: r.value, 'aria-label': `${r.label} ${r.value}` }),
    h('output', null, num(r.value)),
  ]));
}

export function pager(data, go) {
  return h('div', { class: 'pager' },
    h('button', { type: 'button', class: 'secondary', disabled: data.page <= 1, onclick: () => go(data.page - 1) }, '이전'),
    h('span', null, `${data.page} / ${data.pages} 쪽 · 총 ${num(data.total)}건`),
    h('button', { type: 'button', class: 'secondary', disabled: data.page >= data.pages, onclick: () => go(data.page + 1) }, '다음'));
}

export const section = (title, ...kids) => h('section', { class: 'card' }, h('h2', null, title), ...kids);
export const note = (text) => h('p', { class: 'note' }, text);

const seoulTime = (iso) => new Date(iso).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', hour12: false });

/* ---------- 활동 기록 ---------- */

async function activities(box, me) {
  const perm = me.perms.activities;
  const state = { filters: { from: monthStart(), to: todayStr() }, page: 1 };
  const results = h('div');
  let options;

  const paramsOf = () => qs(state.filters);

  async function load() {
    const q = paramsOf();
    q.set('page', state.page);
    await showInto(results, async () => table(await getJson(`/api/activities?${q}`)));
  }

  function table(data) {
    const picked = new Map();
    const deleteButton = h('button', { type: 'button', class: 'danger', disabled: true, onclick: remove }, '선택 삭제');
    const sync = () => { deleteButton.disabled = picked.size === 0; };
    async function remove() {
      if (!picked.size || !confirm(`선택한 활동 ${picked.size}건을 삭제할까요? 삭제 내용은 변경 이력에 남습니다.`)) return;
      try {
        const rows = [...picked.values()].map((r) => ({ id: r.id, personId: r.personId, updatedAt: r.updatedAt }));
        const res = await sendJson('POST', '/api/activities/delete', { rows });
        toast(`${res.deleted}건을 삭제했습니다.`);
        load();
      } catch (err) {
        toast(err.message, 'error');
      }
    }
    const head = ['날짜', '시간', '분', '분류2', '구역', '활동자', '대상자', '장소', '종류', '비고'];
    return h('div', null,
      statCards([[num(data.summary.count), '활동 건수'], [num(data.summary.minutes / 60, 1), '활동 인시간'], [num(data.summary.workers), '활동자 수']]),
      data.items.length
        ? h('div', { class: 'table-wrap', tabindex: '0', role: 'region', 'aria-label': '활동 기록 목록' },
          h('table', null,
            h('thead', null, h('tr', null,
              perm.write ? h('th', { scope: 'col' }, '선택') : null,
              head.map((t) => h('th', { scope: 'col' }, t)),
              perm.write ? h('th', { scope: 'col' }, '관리') : null)),
            h('tbody', null, data.items.map((r) => h('tr', null,
              perm.write ? h('td', null, h('input', { type: 'checkbox', 'aria-label': `${r.date} ${r.worker} 선택`, onchange: (e) => { if (e.target.checked) picked.set(r.id, r); else picked.delete(r.id); sync(); } })) : null,
              h('td', null, r.date),
              h('td', null, r.start && r.end ? `${r.start}~${r.end}` : '미입력'),
              h('td', null, num(r.minutes)),
              h('td', null, h('span', { class: 'pill' }, r.classification2)),
              h('td', null, r.region || '미입력'),
              h('td', { class: 'strong' }, r.worker || '미입력'),
              h('td', null, r.personName ? `${r.personName} (${r.personCode})` : '-'),
              h('td', null, r.place || '-'),
              h('td', null, r.kind || '-'),
              h('td', { class: 'wrapcell' }, r.notes),
              perm.write ? h('td', null, h('button', { type: 'button', class: 'secondary', onclick: () => edit(r) }, '수정')) : null)))))
        : h('div', { class: 'card empty' }, '조건에 맞는 활동이 없습니다.'),
      h('div', { class: 'toolbar' }, perm.write && data.items.length ? deleteButton : null),
      pager(data, (p) => { state.page = p; load(); }));
  }

  async function edit(row) {
    try {
      options ??= await getJson('/api/activities/options');
    } catch (err) {
      toast(err.message, 'error');
      return;
    }
    const v = (k, d = '') => row?.[k] ?? d;
    const pickList = (list, current, blank) => [h('option', { value: '' }, blank), ...list.map((o) => h('option', { value: o.value, selected: o.value === current }, o.label))];
    const members = options.members.map((m) => h('option', { value: m.id, 'data-search': searchKey(m.name, m.code, m.region, m.className, m.className ? `${m.className}반` : '') }, `${m.region || '구역 미입력'} · ${m.name} (${m.code})`));
    const memberSelect = h('select', { name: 'memberId', required: true },
      row ? h('option', { value: '__existing', 'data-keep': '' }, `기존 활동자 유지 (${row.worker || '미입력'})`) : h('option', { value: '' }, '선택'),
      members);
    // 활동자 찾기: 이미 받은 권한 구역 활동자의 이름·번호·구역·반만 걸러 본다. 검색으로 선택값은 바뀌지 않는다.
    const memberSearch = optionSearch(memberSelect, { label: '활동자 찾기', placeholder: '이름·번호·구역·반' });
    formDialog({
      title: row ? `활동 수정 · ${row.code}` : '활동 등록',
      body: h('div', { class: 'form-grid' },
        field('날짜 (필수)', textInput('date', 'date', v('date', todayStr()), { required: true })),
        field('시작 시각', textInput('time', 'start', v('start'))),
        field('종료 시각', textInput('time', 'end', v('end'))),
        field('분류2', h('select', { name: 'classification2', value: v('classification2', '노방') }, options.classification2.map((c) => h('option', { value: c }, c)))),
        field('활동자 찾기 (이름·번호·구역·반)', memberSearch.element),
        field('활동자 (필수)', memberSelect),
        row
          ? field('연결 대상자', h('input', { type: 'text', value: row.personName ? `${row.personName} (${row.personCode})` : '연결 없음', disabled: true }))
          : field('연결 대상자', h('select', { name: 'personId' }, h('option', { value: '' }, '연결 없음 (독립 활동)'),
            options.people.map((p) => h('option', { value: p.id }, `${p.name} (${p.code})`)))),
        field('장소', h('select', { name: 'place' }, pickList(options.places, v('placeValue'), '미입력'))),
        field('활동 종류', h('select', { name: 'kind' }, pickList(options.kinds, v('kindValue'), '기본값'))),
        field('비고', h('textarea', { name: 'notes', maxlength: '5000', value: v('notes') }), 'wide')),
      onSubmit: async (fd) => {
        const body = Object.fromEntries(fd);
        if (row) {
          body.personId = row.personId || undefined;
          body.updatedAt = row.updatedAt;
        } else if (!body.personId) delete body.personId;
        await sendJson(row ? 'PUT' : 'POST', row ? `/api/activities/${encodeURIComponent(row.id)}` : '/api/activities', body);
        toast(row ? '수정했습니다.' : '등록했습니다.');
        load();
      },
    });
  }

  const form = filterForm([
    field('시작일', textInput('date', 'from', state.filters.from)),
    field('종료일', textInput('date', 'to', state.filters.to)),
    field('구역', selectOf('region', regionOptions(me))),
    field('분류2', selectOf('classification2', ['노방', '소셜링', '온라인', '세미나', '기타'])),
    field('시간대', selectOf('timeBand', ['새벽', '오전', '오후', '저녁', '미입력'])),
    field('검색', textInput('search', 'search', '', { maxlength: '100', placeholder: '활동자·장소·비고' })),
  ], (values) => { state.filters = values; state.page = 1; load(); });

  box.append(
    h('div', { class: 'toolbar' }, h('h1', null, '활동 기록'), h('span', { class: 'spacer' }),
      h('div', { class: 'actions' },
        perm.export ? h('button', { type: 'button', class: 'secondary', onclick: () => download(`/api/activities/export?${paramsOf()}`, 'smoa-activities.xlsx') }, '엑셀 내보내기') : null,
        perm.write ? h('button', { type: 'button', onclick: () => edit(null) }, '활동 등록') : null)),
    h('div', { class: 'card' }, form),
    results);
  await load();
}

/* ---------- 지역활동기록 (월별·일자별·기간 조회, 엑셀 불러오기) ---------- */

const CODE_NAMES = { 1: '적극적 활동자', 2: '전도비 후원자', 3: '소극적 활동자', 4: '비활동자' };
const REGIONAL_CODES = [1, 2, 3, 4];
const REGIONAL_MODES = [['monthly', '월별'], ['daily', '일자별'], ['period', '기간 조회']];
const MAX_IMPORT_BYTES = 8 * 1024 * 1024;
const IMPORT_NOTE = '엑셀의 날짜·이름·활동종류(활동여부) 열을 읽습니다. 활동종류는 1~4를 입력하고, 구역은 구성원 명부를 따릅니다. 이전 양식의 종료시간 열도 사용할 수 있습니다. 날짜 열이 없으면 조회월을 적용합니다.';

const monthName = (value) => {
  if (!value) return '—';
  const [year, month] = String(value).split('-');
  return `${year}년 ${Number(month)}월`;
};
const rate = (value) => (Number.isFinite(value) ? `${value.toFixed(1)}%` : '—');
const lastDayOf = (month) => {
  const [year, number] = month.split('-').map(Number);
  return `${month}-${String(new Date(Date.UTC(year, number, 0)).getUTCDate()).padStart(2, '0')}`;
};

/** 색에만 의존하지 않도록 번호와 이름을 함께 적는다. 활동자(1~3)는 강조, 비활동자(4)와 미기록은 흐리게 보인다. */
const statusBadge = (labels, code) => (code == null
  ? h('span', { class: 'pill off' }, '미기록')
  : h('span', { class: code === 4 ? 'pill off' : 'pill' }, `${code} ${labels[code] ?? ''}`.trim()));
const withSmall = (node, text) => [node, text ? h('small', null, ` ${text}`) : null];

/** 첫 열을 강조하는 목록 표. 가로로 넓어지면 표 영역 안에서 스크롤된다. */
function listTable(headers, rows, label, empty) {
  if (!rows.length) return h('p', { class: 'note' }, empty);
  return h('div', { class: 'table-wrap', tabindex: '0', role: 'region', 'aria-label': label },
    h('table', null,
      h('thead', null, h('tr', null, headers.map((t) => h('th', { scope: 'col' }, t)))),
      h('tbody', null, rows.map((r) => h('tr', null, r.map((c, i) => h('td', { class: i === 0 ? 'strong' : null }, c)))))));
}

/** 대화상자: 제목·본문·오류 줄·버튼. buttons(ctl)은 ctl.close/ctl.fail을 쓸 수 있다. 닫히면 열었던 버튼으로 초점을 돌려 준다. */
let dialogSeq = 0;
function openDialog({ title, subtitle, body, buttons }) {
  const opener = document.activeElement;
  const titleId = `regional-dialog-${++dialogSeq}`;
  const status = h('p', { class: 'status error', role: 'alert' });
  let dialog;
  const ctl = {
    close: () => dialog.close(),
    fail: (err) => { status.textContent = err?.message ?? ''; },
  };
  dialog = h('dialog', { 'aria-labelledby': titleId },
    h('h2', { id: titleId }, title),
    subtitle ? h('p', { class: 'note' }, subtitle) : null,
    body, status,
    h('div', { class: 'buttons' }, buttons(ctl)));
  dialog.addEventListener('close', () => {
    dialog.remove();
    if (opener?.isConnected) opener.focus();
  });
  document.body.append(dialog);
  dialog.showModal();
  return ctl;
}

/** 대화상자 안 버튼: 실행 중에는 잠그고, 실패하면 오류 줄에 보이고 다시 누를 수 있게 한다. */
function dialogAction(ctl, label, className, task) {
  const button = h('button', { type: 'button', class: className }, label);
  button.addEventListener('click', async () => {
    button.disabled = true;
    ctl.fail(null);
    try {
      await task();
    } catch (err) {
      ctl.fail(err);
      button.disabled = false;
    }
  });
  return button;
}
const cancelAction = (ctl, label = '닫기') => h('button', { type: 'button', class: 'secondary', onclick: ctl.close }, label);

async function regionalActivity(box, me) {
  const perm = me.perms.regionalActivity;
  const state = { mode: 'monthly', month: todayStr().slice(0, 7), date: '', from: monthStart(), to: todayStr(), region: '', code: '' };
  const filters = h('div', { class: 'card' });
  const results = h('div');
  let data = null; // 마지막으로 불러온 조회 결과
  let loadSeq = 0;

  const labelsOf = () => data?.labels ?? CODE_NAMES;
  const paramsOf = () => (state.mode === 'period'
    ? qs({ from: state.from, to: state.to, region: state.region, code: state.code })
    : qs({ month: state.month, date: state.mode === 'daily' ? state.date : '', region: state.region }));

  async function load() {
    const seq = ++loadSeq;
    await showInto(results, async () => {
      const next = await getJson(`/api/regional-activity?${paramsOf()}`);
      if (seq !== loadSeq) return results.firstChild; // 더 늦게 시작한 조회가 있으면 이 결과는 버린다.
      data = next;
      if (state.mode === 'period') return periodView(next);
      return state.mode === 'daily' ? dailyView(next) : monthlyView(next);
    });
  }

  /* ----- 조회 조건 ----- */

  function setMode(mode) {
    if (mode === state.mode) return;
    if (mode === 'period' && state.from === monthStart() && state.to === todayStr() && state.month !== todayStr().slice(0, 7)) {
      Object.assign(state, { from: `${state.month}-01`, to: lastDayOf(state.month) });
    }
    state.mode = mode;
    state.date = '';
    drawFilters();
    filters.querySelector(`[data-mode="${mode}"]`)?.focus();
    load();
  }

  function shiftMonth(direction) {
    const [year, number] = state.month.split('-').map(Number);
    const position = year * 12 + number - 1 + direction;
    const nextYear = Math.floor(position / 12);
    if (nextYear < 1 || nextYear > 9999) return;
    Object.assign(state, { month: `${String(nextYear).padStart(4, '0')}-${String((position % 12) + 1).padStart(2, '0')}`, date: '' });
    drawFilters();
    filters.querySelector(`[data-shift="${direction}"]`)?.focus();
    load();
  }

  /** 일자별 보기로 옮긴다. date가 비면 그 달의 일자 목록을 보인다. */
  async function openDay(date) {
    state.mode = 'daily';
    state.date = date;
    if (date) state.month = date.slice(0, 7);
    drawFilters();
    await load();
    results.querySelector('h2[tabindex="-1"]')?.focus({ preventScroll: true });
  }

  function openRegion(region) {
    state.region = region;
    drawFilters();
    load();
  }

  function pickDate() {
    if (state.mode !== 'daily') {
      state.mode = 'daily';
      state.date = '';
      drawFilters();
      load();
    }
    filters.querySelector('input[name="date"]')?.focus();
  }

  function drawFilters() {
    const modeBar = h('div', { class: 'toolbar' },
      h('div', { class: 'actions', role: 'group', 'aria-label': '조회 방식' },
        REGIONAL_MODES.map(([value, label]) => h('button', {
          type: 'button', class: value === state.mode ? null : 'secondary', 'data-mode': value, 'aria-pressed': String(value === state.mode), onclick: () => setMode(value),
        }, label))),
      me.perms.daily?.read ? h('a', { href: '#/daily' }, '활동자 제외·이름 통합 (구역 일보 화면)') : null);
    const regionField = field('구역', selectOf('region', regionOptions(me), state.region, '전체 구역'));

    if (state.mode === 'period') {
      const error = h('p', { class: 'status error', role: 'alert' });
      const apply = (form) => {
        const v = formValues(form);
        const valid = (day) => /^\d{4}-\d{2}-\d{2}$/.test(day ?? '');
        if (!valid(v.from) || !valid(v.to)) { error.textContent = '시작일과 종료일을 입력해 주세요.'; return; }
        if (v.from > v.to) { error.textContent = '시작일을 종료일과 같거나 앞선 날짜로 선택해 주세요.'; return; }
        error.textContent = '';
        Object.assign(state, { from: v.from, to: v.to, region: v.region ?? '', code: v.code ?? '' });
        load();
      };
      const form = filterForm([
        field('시작일', textInput('date', 'from', state.from, { required: true })),
        field('종료일', textInput('date', 'to', state.to, { required: true })),
        regionField,
        field('활동 상태', selectOf('code', REGIONAL_CODES.map((c) => ({ value: String(c), label: `${c} ${labelsOf()[c]}` })), state.code, '전체 상태')),
      ], () => apply(form));
      form.setAttribute('aria-label', '지역활동기록 조회 조건');
      form.addEventListener('change', () => apply(form));
      filters.replaceChildren(modeBar, form, error);
      return;
    }

    const apply = (form, changed) => {
      const v = formValues(form);
      state.region = v.region ?? '';
      if (changed === 'month' || state.mode !== 'daily') {
        // 조회월을 바꾸면 선택한 날짜는 해제한다.
        if (/^\d{4}-(0[1-9]|1[0-2])$/.test(v.month ?? '')) state.month = v.month;
        state.date = '';
        if (form.elements.date) form.elements.date.value = '';
      } else if (form.elements.date && !form.elements.date.checkValidity()) {
        form.elements.date.reportValidity();
        return;
      } else {
        state.date = v.date ?? '';
        if (state.date) {
          state.month = state.date.slice(0, 7);
          form.elements.month.value = state.month;
        }
      }
      load();
    };
    const importInput = h('input', {
      type: 'file', accept: '.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', hidden: true, tabindex: '-1',
      onchange: () => chooseFile(importInput),
    });
    const form = filterForm([
      field('조회월', textInput('month', 'month', state.month, { required: true })),
      state.mode === 'daily' ? field('조회일', textInput('date', 'date', state.date)) : null,
      regionField,
    ], () => apply(form, ''), [
      h('button', { type: 'button', class: 'secondary', 'data-shift': '-1', onclick: () => shiftMonth(-1) }, '이전 달'),
      h('button', { type: 'button', class: 'secondary', 'data-shift': '1', onclick: () => shiftMonth(1) }, '다음 달'),
      perm.write ? h('button', { type: 'button', onclick: () => importInput.click() }, '엑셀 불러오기') : null,
      importInput,
    ]);
    form.setAttribute('aria-label', '지역활동기록 조회 조건');
    form.addEventListener('change', (e) => { if (e.target !== importInput) apply(form, e.target.name); });
    filters.replaceChildren(...[modeBar, form, perm.write ? note(IMPORT_NOTE) : null].filter(Boolean));
  }

  /* ----- 공통 표 ----- */

  const memberName = (r) => withSmall(r.name, r.memberCode);

  function transitionTable(d, rows, empty) {
    const labels = d.labels ?? CODE_NAMES;
    return listTable(['이름', '전월', '조회월'], rows.map((r) => [
      memberName(r),
      withSmall(statusBadge(labels, r.from), r.fromRegion),
      withSmall(statusBadge(labels, r.to), r.toRegion),
    ]), '월별 활동 상태 변화', empty);
  }

  /* ----- 월별 ----- */

  function monthlyView(d) {
    const labels = d.labels ?? CODE_NAMES;
    const comparable = d.current.recorded > 0 && d.previous.recorded > 0;
    const metrics = [['활동자', 'active'], ['비활동자', 'inactive'], ['기록 인원', 'recorded'], ['명부 미기록', 'unrecorded']];
    const cards = metrics.map(([title, key]) => {
      const delta = d.current[key] - d.previous[key];
      const before = d.previous.recorded > 0 ? `전월 ${num(d.previous[key])}명` : '전월 기록 없음';
      const change = !comparable ? '비교 불가' : delta === 0 ? '변동 없음' : `${delta > 0 ? '+' : '−'}${num(Math.abs(delta))}명`;
      return [`${num(d.current[key])}명`, title, `${before} · ${change}`];
    });
    const breakdown = REGIONAL_CODES.map((code) => {
      const before = d.previous.counts?.[code] || 0;
      const now = d.current.counts?.[code] || 0;
      return [statusBadge(labels, code), d.previous.recorded ? `${num(before)}명` : '—', d.current.recorded ? `${num(now)}명` : '—', comparable ? `${now - before > 0 ? '+' : ''}${num(now - before)}명` : '—'];
    });
    const changes = d.changes ?? [];
    const others = [
      ['활동 유형 변경', changes.filter((r) => r.direction === 'changed')],
      ['기록상 구역 변경', d.transfers ?? []],
      ['이번 달 새로 기록', d.entered ?? []],
      ['전월 기록 · 이번 달 미기록', d.missing ?? []],
    ];
    return h('div', null,
      section('월별 활동 상태 비교',
        note(`${d.region || '전체 지역'} · ${monthName(d.previousMonth)}와 ${monthName(d.month)} 비교`),
        h('div', { class: 'cards' }, cards.map(([value, title, detail]) => h('div', { class: 'card stat' }, h('div', { class: 'num' }, value), h('div', { class: 'cap' }, title), h('p', { class: 'note' }, detail)))),
        note(`기록 인원 중 활동자 ${rate(d.current.activeRate)} · 현재 명부 기록률 ${rate(d.current.coverageRate)} · 인원 증감에는 월별 기록 범위와 구역 이동이 반영됩니다. 전환은 두 달에 기록된 상태를 비교합니다.`),
        listTable(['활동 상태', monthName(d.previousMonth), monthName(d.month), '증감'], breakdown, '활동 상태별 인원', '')),
      districtSection(d),
      section('활동으로 전환', note('비활동자(4) → 활동자(1–3)'), h('span', { class: 'pill' }, `${num(changes.filter((r) => r.direction === 'activated').length)}명`),
        transitionTable(d, changes.filter((r) => r.direction === 'activated'), '해당하는 인원이 없습니다.')),
      section('비활동으로 전환', note('활동자(1–3) → 비활동자(4)'), h('span', { class: 'pill off' }, `${num(changes.filter((r) => r.direction === 'deactivated').length)}명`),
        transitionTable(d, changes.filter((r) => r.direction === 'deactivated'), '해당하는 인원이 없습니다.')),
      h('details', { class: 'card' }, h('summary', null, '그 밖의 월별 변화'),
        others.map(([title, rows]) => h('div', null, h('h3', null, title, ' ', h('span', { class: 'pill' }, `${num(rows.length)}명`)), transitionTable(d, rows, '해당하는 인원이 없습니다.')))),
      monthlyRoster(d),
      undatedSection(d),
      d.notes?.length ? h('details', { class: 'card' }, h('summary', null, '집계 기준'), h('ul', null, d.notes.map((t) => h('li', null, t)))) : null);
  }

  function districtSection(d) {
    if (d.region || !d.districts?.length) return null;
    const active = (period) => (period.recorded ? `${num(period.active)}명` : '—');
    return section('구역별 월간 활동 상태', note('구역명을 누르면 그 구역만 볼 수 있습니다.'),
      listTable(['구역', '전월 활동자', '조회월 활동자', '활동자 증감', '조회월 비활동자', '조회월 미기록'], d.districts.map(({ region, current, previous }) => {
        const change = current.active - previous.active;
        return [
          h('button', { type: 'button', class: 'secondary', 'aria-label': `${region}만 보기`, onclick: () => openRegion(region) }, region),
          active(previous), active(current),
          current.recorded && previous.recorded ? `${change > 0 ? '+' : ''}${num(change)}명` : '—',
          current.recorded ? `${num(current.inactive)}명` : '—', `${num(current.unrecorded)}명`,
        ];
      }), '구역별 월간 활동 상태', ''));
  }

  function monthlyRoster(d) {
    const labels = d.labels ?? CODE_NAMES;
    const rows = d.members.map((r) => {
      const code = r.currentCode;
      const mayEdit = perm.write && r.editable && (!d.region || (code == null ? r.currentRosterRegion : r.currentRegion) === d.region);
      let action = '—';
      if (mayEdit) {
        action = code != null
          ? h('button', { type: 'button', class: 'secondary', 'aria-label': `${r.name} 기록 편집`, onclick: () => editDialog({ memberId: r.memberId, name: r.name, region: r.region, date: r.currentDate || '', code }) }, '수정')
          : h('button', { type: 'button', class: 'secondary', 'aria-label': `${r.name} 기록 추가할 날짜 선택`, onclick: pickDate }, '조회일 선택');
      }
      return [
        memberName(r), r.region || '미입력',
        withSmall(statusBadge(labels, r.previousCode), r.previousCode == null ? '' : r.previousDate || '날짜 없는 월별 기록'),
        withSmall(statusBadge(labels, code), code == null ? '' : r.currentDate || '날짜 없는 월별 기록'),
        action,
      ];
    });
    return section('구성원별 월별 기록', note('각 월의 가장 최근 날짜 기록을 표시합니다. 날짜 기록이 없으면 기존 월별 기록을 사용합니다.'),
      h('span', { class: 'pill' }, `${num(d.members.length)}명`),
      listTable(['이름', '구역', monthName(d.previousMonth), monthName(d.month), '편집'], rows, '구성원별 월별 기록', '조회 조건에 맞는 구성원 또는 기록이 없습니다.'));
  }

  function undatedSection(d) {
    if (!d.undatedRecords?.length) return null;
    const labels = d.labels ?? CODE_NAMES;
    const rows = d.undatedRecords.map((r) => [
      r.name, r.region || '미입력', statusBadge(labels, r.code),
      perm.write && r.editable
        ? h('button', { type: 'button', class: 'secondary', 'aria-label': `${r.name} 날짜 없는 월별 기록 편집`, onclick: () => editDialog({ memberId: r.memberId, name: r.name, region: r.region, date: '', code: r.code }) }, '수정')
        : '—',
    ]);
    return h('details', { class: 'card' }, h('summary', null, '날짜 없는 월별 기록 ', h('span', { class: 'pill' }, `${num(rows.length)}명`)),
      listTable(['이름', '구역', '활동 상태', '편집'], rows, '날짜 없는 월별 기록', ''));
  }

  /* ----- 일자별 ----- */

  function dailyView(d) {
    return d.date ? dayRoster(d) : dailyHistory(d);
  }

  function dailyHistory(d) {
    const dates = new Map();
    for (const record of d.dailyRecords ?? []) {
      if (!dates.has(record.date)) dates.set(record.date, { active: 0, inactive: 0 });
      dates.get(record.date)[record.code === 4 ? 'inactive' : 'active']++;
    }
    const rows = [...dates].map(([date, { active, inactive }]) => [
      h('button', { type: 'button', class: 'secondary', 'aria-label': `${date} 기록 보기`, onclick: () => openDay(date) }, date),
      `${num(active + inactive)}명`, `${num(active)}명`, `${num(inactive)}명`,
    ]);
    return section(`${monthName(d.month)} 일자별 기록`,
      note('날짜를 누르면 그날 기록된 구성원을 볼 수 있습니다. 새 기록은 위의 조회일을 선택해 추가하세요.'),
      h('span', { class: 'pill' }, `${num(dates.size)}일`),
      listTable(['기록 날짜', '기록 인원', '활동자', '비활동자'], rows, '일자별 기록', '이 달의 날짜별 기록이 없습니다.'));
  }

  function dayRoster(d) {
    const labels = d.labels ?? CODE_NAMES;
    const recorded = (d.dailyRecords ?? []).filter((row) => row.date === d.date);
    const available = d.members.filter((row) => row.editable && row.currentRosterRegion && row.dayCode == null && (!d.region || row.currentRosterRegion === d.region));
    const rows = recorded.map((row) => [
      row.name, row.region || '미입력', statusBadge(labels, row.code),
      perm.write
        ? h('div', { class: 'actions' },
          row.editable ? h('button', { type: 'button', class: 'secondary', 'aria-label': `${row.name} 기록 편집`, onclick: () => editDialog({ memberId: row.memberId, name: row.name, region: row.region, date: d.date, code: row.code }) }, '수정') : null,
          h('button', { type: 'button', class: 'danger', 'aria-label': `${row.name} ${d.date} 기록 삭제`, onclick: () => removeDialog({ memberId: row.memberId, name: row.name, date: d.date }) }, '삭제'))
        : '—',
    ]);
    const addRows = available.map((row) => [
      row.name, row.currentRosterRegion || '미입력',
      h('button', { type: 'button', class: 'secondary', 'aria-label': `${row.name} 기록 추가`, onclick: () => editDialog({ memberId: row.memberId, name: row.name, region: row.currentRosterRegion, date: d.date, code: null }) }, '기록 추가'),
    ]);
    return h('div', null,
      section(`${d.date} 구성원별 일자 기록`,
        note(`기록 ${num(recorded.length)}명 · 활동자 ${num(d.day?.active)}명 · 비활동자 ${num(d.day?.inactive)}명`),
        h('div', { class: 'actions' }, h('button', { type: 'button', class: 'secondary', onclick: () => openDay('') }, '일자 목록으로')),
        h('h3', { tabindex: '-1' }, '기록된 구성원'),
        listTable(['이름', '구역', '활동 상태', '편집'], rows, '구성원별 일자 기록', '이 날짜에 기록된 구성원이 없습니다.')),
      perm.write && addRows.length
        ? h('details', { class: 'card' }, h('summary', null, '기록 추가 ', h('span', { class: 'pill' }, `${num(addRows.length)}명`)),
          listTable(['이름', '구역', '추가'], addRows, '기록을 추가할 구성원', ''))
        : null);
  }

  /* ----- 기간 조회 ----- */

  function periodView(d) {
    const labels = d.labels ?? CODE_NAMES;
    const counts = REGIONAL_CODES.map((code) => h('span', null, `${labels[code]} `, h('strong', null, `${num(d.period.counts?.[code] || 0)}명`), ' · '));
    const reports = [['전주 대비', d.weekly], ['전월 대비', d.monthly]];
    return h('div', null,
      section('활동 집계 텍스트', note('조회 종료일이 속하는 주와 월을 기준으로 비교합니다.'),
        h('div', { class: 'actions' }, reports.map(([label, report]) => h('div', null,
          h('button', { type: 'button', class: 'secondary', onclick: () => reportDialog(d, label, report) }, label),
          h('p', { class: 'note' }, `${report.from} ~ ${report.to}`))))),
      section('구성원별 기간 활동기록', note('기간 중 가장 낮은 활동 상태 번호를 구성원마다 한 번 집계합니다.'),
        h('span', { class: 'pill' }, `${num(d.records.length)}명 표시`),
        h('p', { class: 'note' }, counts, '미기록 ', h('strong', null, `${num(d.period.unrecorded)}명`)),
        listTable(['이름', '구역', '기간 활동 상태', '해당 기록일'], d.records.map((r) => [memberName(r), r.region || '구역 미입력', statusBadge(labels, r.code), r.date || '—']),
          '구성원별 기간 활동기록', '조회 조건에 맞는 활동기록이 없습니다.')));
  }

  function reportDialog(d, title, report) {
    const text = h('textarea', { id: 'regional-report-text', readOnly: true, rows: '16', value: report.text });
    openDialog({
      title: `${title} 활동 집계`,
      subtitle: `${report.from} ~ ${report.to} · ${d.region || '전체 구역'}`,
      body: field('집계 텍스트', text),
      buttons: (ctl) => [
        cancelAction(ctl),
        h('button', {
          type: 'button',
          onclick: async () => {
            try {
              await navigator.clipboard.writeText(report.text);
              toast('활동 집계 텍스트를 복사했습니다.');
            } catch {
              text.focus();
              text.select();
              ctl.fail(new Error('복사하지 못했습니다. 선택된 문구를 직접 복사해 주세요.'));
            }
          },
        }, '텍스트 복사'),
      ],
    });
  }

  /* ----- 기록 편집·삭제 ----- */

  /** 일자별(date 있음) 또는 날짜 없는 월별 기록의 활동 상태를 저장한다. code가 null이면 새 기록이다. */
  function editDialog({ memberId, name, region, date, code }) {
    if (!date && code == null) return;
    const month = data.month;
    const select = h('select', { name: 'code', required: true },
      h('option', { value: '' }, '상태 선택'),
      REGIONAL_CODES.map((c) => h('option', { value: String(c), selected: c === code }, `${c} · ${labelsOf()[c]}`)));
    openDialog({
      title: date ? '일자별 활동 상태 편집' : '월별 활동 상태 편집',
      body: h('div', null,
        h('p', null, h('strong', null, name), ` · ${region || '구역 미입력'} · ${date || monthName(month)}`),
        field('활동 상태', select)),
      buttons: (ctl) => [
        code != null ? h('button', { type: 'button', class: 'danger', onclick: () => { ctl.close(); removeDialog({ memberId, name, date }); } }, date ? '이 날짜 기록 지우기' : '이 달 기록 지우기') : null,
        cancelAction(ctl, '취소'),
        dialogAction(ctl, '저장', null, async () => {
          const value = Number(select.value);
          if (!REGIONAL_CODES.includes(value)) {
            select.focus();
            throw new Error('활동 상태를 선택해 주세요.');
          }
          await sendJson('POST', '/api/regional-activity/save', { month, ...(date ? { date } : {}), memberId, code: value });
          ctl.close();
          toast(date ? '일자별 활동 상태를 저장했습니다.' : '월별 활동 상태를 저장했습니다.');
          load();
        }),
      ],
    });
  }

  function removeDialog({ memberId, name, date }) {
    const month = data.month;
    openDialog({
      title: date ? '이 날짜 기록 지우기' : '이 달 기록 지우기',
      body: h('p', null, h('strong', null, name), `의 ${date || monthName(month)} 활동 상태 기록을 지웁니다. 지운 내용은 변경 이력에 남습니다.`),
      buttons: (ctl) => [
        cancelAction(ctl, '취소'),
        dialogAction(ctl, '기록 지우기', 'danger', async () => {
          await sendJson('POST', '/api/regional-activity/remove', { month, ...(date ? { date } : {}), memberId });
          ctl.close();
          toast(date ? '이 날짜의 활동 상태 기록을 지웠습니다.' : '날짜 없는 월별 기록을 지웠습니다.');
          load();
        }),
      ],
    });
  }

  /* ----- 엑셀 불러오기: 미리보기 → 적용 ----- */

  async function chooseFile(input) {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    if (!/\.xlsx$/i.test(file.name)) { toast('엑셀(.xlsx) 파일을 선택해 주세요.', 'error'); return; }
    if (file.size > MAX_IMPORT_BYTES) { toast('엑셀 파일은 최대 8MB입니다.', 'error'); return; }
    const query = qs({ month: state.month, region: state.region, name: file.name });
    toast('엑셀 파일을 확인하는 중입니다.');
    try {
      previewDialog(await postXlsx(`/api/regional-activity/import-preview?${query}`, file));
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  function previewDialog(preview) {
    const labels = labelsOf();
    const { counts } = preview;
    const duplicateCount = Math.max(preview.totalDuplicates || 0, counts.unchanged, preview.duplicates.length);
    const period = !preview.dateMode ? monthName(preview.month)
      : !preview.firstDate ? '확인할 날짜 없음'
        : preview.firstDate === preview.lastDate ? preview.firstDate : `${preview.firstDate} ~ ${preview.lastDate}`;
    const dated = preview.dateMode;
    const changeRows = preview.rows.map((r) => [
      num(r.row), ...(dated ? [r.date] : []), withSmall(r.name, r.memberCode), r.region || '미입력',
      statusBadge(labels, r.previousCode), statusBadge(labels, r.code), r.action === 'insert' ? '신규' : '변경',
    ]);
    const duplicateRows = preview.duplicates.map((r) => [
      num(r.row), r.date || r.month || '—', withSmall(r.name, r.memberCode), r.region || '미입력', statusBadge(labels, r.code),
      r.blocking ? `${num(r.matchedRow)}행과 중복 (적용 불가)` : '기존 기록과 같아 건너뜁니다.',
    ]);
    const body = h('div', null,
      h('p', { class: 'note' }, `${dated ? '적용할 날짜' : '적용할 월'} `, h('strong', null, period), ` · ${preview.region || '전체 구역'}`),
      h('p', { class: 'note' }, dated
        ? '엑셀 각 행의 날짜를 적용합니다. 같은 구성원·날짜의 기존 기록을 갱신하고 마지막 날짜의 기록을 엽니다.'
        : '날짜 열이 없는 파일이므로 선택한 조회월의 월별 기록에 적용합니다.'),
      statCards([[num(counts.insert), '신규'], [num(counts.replace), '변경'], [num(duplicateCount), '중복'], [num(counts.errors), '오류']]),
      preview.errors.length
        ? h('div', { role: 'group', 'aria-label': '확인할 오류' },
          h('h3', null, `오류 ${num(preview.totalErrors)}건`),
          h('ul', null, preview.errors.map((e) => h('li', null, `${num(e.row)}행: ${e.message}`))),
          preview.totalErrors > preview.errors.length ? h('p', { class: 'note' }, `처음 ${num(preview.errors.length)}건만 표시합니다.`) : null)
        : null,
      listTable(['행', ...(dated ? ['날짜'] : []), '이름', '구역', '기존 상태', '가져올 상태', '결과'], changeRows, '가져올 활동기록', ''),
      preview.totalChanged > preview.rows.length ? h('p', { class: 'note' }, `신규·변경 ${num(preview.totalChanged)}건 중 처음 ${num(preview.rows.length)}건을 표시합니다.`) : null,
      duplicateRows.length
        ? h('details', null, h('summary', null, `중복 ${num(duplicateCount)}건`),
          listTable(['행', dated ? '날짜' : '월', '이름', '구역', '상태', '처리'], duplicateRows, '중복 활동기록', ''),
          duplicateCount > duplicateRows.length ? h('p', { class: 'note' }, `처음 ${num(duplicateRows.length)}건만 표시합니다.`) : null)
        : null);
    openDialog({
      title: '지역활동기록 가져오기 미리보기',
      subtitle: `${period} · ${preview.sheet} 시트${preview.fileName ? ` · ${preview.fileName}` : ''}`,
      body,
      buttons: (ctl) => [
        cancelAction(ctl),
        preview.canCommit && preview.importId
          ? dialogAction(ctl, dated ? '날짜별 기록 적용' : '이 월에 적용', null, async () => {
            if (!dated && preview.month !== state.month) throw new Error('조회월이 변경됐습니다. 엑셀 미리보기를 다시 열어 주세요.');
            const res = await sendJson('POST', '/api/regional-activity/import-apply', { importId: preview.importId });
            ctl.close();
            toast(res.applied ? (dated ? `날짜별 활동기록 ${num(res.applied)}건을 가져왔습니다.` : `월별 활동 상태 ${num(res.applied)}건을 가져왔습니다.`) : '기존 기록과 같아 바뀐 내용이 없습니다.');
            if (dated && res.lastDate) await openDay(res.lastDate);
            else load();
          })
          : null,
      ],
    });
  }

  box.append(
    h('div', { class: 'toolbar' }, h('h1', null, '지역활동기록'), h('span', { class: 'spacer' }),
      h('div', { class: 'actions' },
        perm.export ? h('button', { type: 'button', class: 'secondary', onclick: () => download(`/api/regional-activity/export?${paramsOf()}`, 'smoa-regional-activity.xlsx') }, '엑셀 내보내기') : null)),
    filters,
    results);
  drawFilters();
  await load();
}

/* ---------- 단계 이동 ---------- */

async function stages(box, me) {
  const perm = me.perms.stages;
  const state = { filters: { date: todayStr() }, page: 1 };
  const results = h('div');
  const formHost = h('div', { class: 'card' });

  const paramsOf = () => qs(state.filters);

  async function load() {
    const q = paramsOf();
    q.set('page', state.page);
    await showInto(results, async () => {
      const data = await getJson(`/api/stage-movements?${q}`);
      if (!formHost.firstChild) buildForm(data);
      const span = data.from === data.to ? data.from : `${data.from} ~ ${data.to}`;
      return h('div', null,
        statCards([[num(data.total), `${span} 이동 건수`]]),
        data.movements.length ? section('이동 유형', barList(data.movements)) : null,
        section('기간별 단계 현황', note(`${span} · 신규 진입과 달성률은 단계별 상신일 기준입니다. 유지 보유는 기간 시작 전에 진입해 기간 말까지 같은 단계에 있는 인원입니다.`),
          dataTable(['단계', '기간 목표', '기간 신규 진입', '달성률', '유지 보유', '기간 말 재고'],
            data.inventory.map((r) => [h('span', { class: 'strong' }, r.label), r.target == null ? '-' : num(r.target), num(r.entered),
              r.target ? pct((r.entered / r.target) * 100) : '-', r.retained == null ? '-' : num(r.retained), num(r.stock)]), '기간별 단계 현황')),
        section('단계별 향상률', note('조회 기간에 출발 단계에 처음 도달한 인원 중 도착 단계까지 향상된 비율입니다. 기간 종료 뒤 도달도 포함하며, 출발 인원이 0명이면 -로 표시합니다.'),
          dataTable(['출발 → 도착 단계', '출발 인원', '향상 인원', '향상률'],
            data.cohort.map((c) => [h('span', { class: 'strong' }, c.label), num(c.baseCount), num(c.count), c.rate == null ? '-' : pct(c.rate * 100)]), '단계별 향상률')),
        dataTable(['적용일', '시각', '구분', '대상자', '구역', '반', '이전', '이후', '활동자', '사유', '기록자'],
          data.rows.map((r) => [r.date, r.time, h('span', { class: r.kind === 'stage' ? 'pill' : 'pill off' }, r.kind === 'stage' ? '단계' : '탈락·복귀'),
            h('span', { class: 'strong' }, `${r.personName} (${r.personCode})`), r.region || '미입력', r.className || '-', r.from, r.to, r.worker || '-', h('span', null, r.reason || '-'), r.actor || '-']), '단계 이동 목록'),
        pager(data, (p) => { state.page = p; load(); }));
    });
  }

  box.append(h('div', { class: 'toolbar' }, h('h1', null, '단계 이동'), h('span', { class: 'spacer' }),
    h('div', { class: 'actions' }, perm.export ? h('button', { type: 'button', class: 'secondary', onclick: () => download(`/api/stage-movements/export?${paramsOf()}`, 'smoa-stage-movements.xlsx') }, '엑셀 내보내기') : null)));
  function buildForm(data) {
    const stageOpts = data.stages.map((s) => ({ value: s.id, label: s.name }));
    // 통합 검색은 첫 줄에 두고(대상자 이름·식별번호·담당 활동자), 조회 뒤에도 입력값은 양식에 그대로 남는다.
    const resetButton = h('button', { type: 'button', class: 'secondary', onclick: () => {
      form.reset();
      form.elements.date.value = todayStr();
      state.filters = { date: todayStr() };
      state.page = 1;
      load();
    } }, '조건 초기화');
    const form = filterForm([
      field('통합 검색 (이름·번호·활동자)', textInput('search', 'search', '', { maxlength: '60', placeholder: '대상자 이름·번호·활동자', 'aria-label': '단계 이동 통합 검색: 대상자 이름·식별번호·활동자' })),
      field('기준일', textInput('date', 'date', state.filters.date)),
      field('기간 시작', textInput('date', 'from', '')),
      field('기간 종료', textInput('date', 'to', '')),
      field('구역', selectOf('region', regionOptions(me))),
      field('이전 단계', selectOf('fromStage', stageOpts)),
      field('이후 단계', selectOf('toStage', stageOpts)),
      field('구분', selectOf('kind', [{ value: 'stage', label: '단계 이동' }, { value: 'lifecycle', label: '탈락·복귀' }])),
    ], (values) => {
      if (values.from || values.to) delete values.date;
      state.filters = values;
      state.page = 1;
      load();
    }, [resetButton]);
    formHost.append(form);
  }

  box.append(formHost, results);
  await load();
}

/* ---------- 변경 이력 ---------- */

async function history(box, me) {
  const perm = me.perms.history;
  const state = { filters: { from: shiftDay(todayStr(), -30), to: todayStr() }, page: 1 };
  const results = h('div');
  const formHost = h('div', { class: 'card' });

  async function load() {
    const q = qs(state.filters);
    q.set('page', state.page);
    await showInto(results, async () => {
      const data = await getJson(`/api/history?${q}`);
      if (!formHost.firstChild) buildForm(data);
      return h('div', null,
        data.scoped ? note('배정된 구역과 관련된 변경만 표시됩니다. 연락처는 끝 네 자리만 보입니다.') : note('연락처는 끝 네 자리만 보입니다.'),
        dataTable(['일시', '작업자', '작업', '대상', '변경 내용'],
          data.items.map((e) => [seoulTime(e.at), e.actor, h('span', { class: 'pill' }, e.action), e.target || '-',
            h('div', null, e.changes.length
              ? e.changes.map((c) => h('div', null, h('strong', null, `${c.field}: `), `${c.before || '(없음)'} → ${c.after || '(없음)'}`))
              : '변경 내용 없음')]), '변경 이력 목록'),
        pager(data, (p) => { state.page = p; load(); }));
    });
  }

  function buildForm(data) {
    formHost.append(filterForm([
      field('시작일', textInput('date', 'from', state.filters.from)),
      field('종료일', textInput('date', 'to', state.filters.to)),
      field('작업', selectOf('action', data.actions)),
      field('작업자', selectOf('actor', data.actors)),
      field('검색', textInput('search', 'search', '', { maxlength: '60', placeholder: '대상자 이름·번호' })),
    ], (values) => { state.filters = values; state.page = 1; load(); }));
  }

  /* ----- 삭제 대상자 복원: 변경 이력 조회와 대상자 쓰기 권한이 모두 있을 때만 보인다. ----- */

  function restorePanel() {
    const body = h('div');
    const panel = h('details', { class: 'card' }, h('summary', null, '삭제 대상자 복원'), body);
    let opened = false;

    async function loadList() {
      await showInto(body, async () => {
        const { items } = await getJson('/api/history/recoverable');
        return h('div', null,
          note('삭제된 대상자 중 배정된 구역 안에서 복원할 수 있는 대상자입니다. 같은 번호로 다시 등록하며 연락처는 복원되지 않고, 기존 콜링 기록은 다시 연결됩니다.'),
          items.length
            ? listTable(['대상자', '삭제 일시', '복원'], items.map((item) => [
              withSmall(item.name, item.code), seoulTime(item.at),
              h('button', { type: 'button', class: 'secondary', 'aria-label': `${item.name} 복원`, onclick: () => confirmRestore(item) }, '복원'),
            ]), '복원할 수 있는 삭제 대상자', '')
            : note('복원할 수 있는 삭제 대상자가 없습니다.'));
      });
    }

    function confirmRestore(item) {
      openDialog({
        title: '삭제 대상자 복원',
        body: h('p', null, h('strong', null, `${item.name} (${item.code})`), '을(를) 같은 번호로 복원합니다. 복원한 내용은 변경 이력에 남습니다.'),
        buttons: (ctl) => [
          cancelAction(ctl, '취소'),
          dialogAction(ctl, '복원', null, async () => {
            await sendJson('POST', `/api/history/recoverable/${encodeURIComponent(item.id)}/restore`, { revision: item.revision });
            ctl.close();
            toast('삭제한 대상자를 복원했습니다.');
            loadList();
            load();
          }),
        ],
      });
    }

    panel.addEventListener('toggle', () => {
      if (panel.open && !opened) {
        opened = true;
        loadList();
      }
    });
    return panel;
  }

  box.append(
    h('div', { class: 'toolbar' }, h('h1', null, '변경 이력'), h('span', { class: 'spacer' }),
      h('div', { class: 'actions' },
        perm.export ? h('button', { type: 'button', class: 'secondary', onclick: () => download(`/api/history/export?${qs(state.filters)}`, 'smoa-history.xlsx') }, '엑셀 내보내기') : null)),
    formHost,
    perm.read && me.perms.people?.write ? restorePanel() : null,
    results);
  await load();
}

export const recordsViews = { activities, regionalActivity, stages, history };
