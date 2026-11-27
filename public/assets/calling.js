import { api, formDialog, getJson, h, sendJson, toast } from './common.js';
import { openPersonDetail } from './person-details.js';

/** 콜링 관리·콜링 통계 화면. 소셜링 화면이 같은 도우미를 가져다 쓴다. */

// 콜링·소셜링 통계의 원본 배치(.panel · .metric · 2/3열)는 status.css에 있다. (CSP: 같은 출처 파일만)
if (typeof document !== 'undefined' && !document.querySelector('link[href="/assets/status.css"]')) {
  document.head.append(h('link', { rel: 'stylesheet', href: '/assets/status.css' }));
}

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const MAX_UPLOAD = 8 * 1024 * 1024; // 서버 엑셀 업로드 상한과 같다.
const MAX_REPORT_CHARS = 300000; // 서버의 콜링 일보 글자 수 상한과 같다.
const PAIR_PAGE = 8;

// ───────── 공용 도우미 ─────────

export const num = (n) => Number(n ?? 0).toLocaleString('ko-KR');
export const rate = (v, digits = 1) => (Number.isFinite(v) ? `${v.toFixed(digits)}%` : '—');
export const today = () => new Date().toLocaleDateString('sv');
export const field = (label, control, cls) => h('label', { class: cls }, label, control);
export const errorLine = (err) => h('p', { class: 'status error', role: 'alert' }, err.message);
export const multiline = (s) => String(s ?? '').split(/\r?\n/).flatMap((line, i) => (i ? [h('br'), line] : [line]));

export function dateError(from, to) {
  return from && to && from > to ? '조회 시작일은 종료일보다 늦을 수 없습니다.' : '';
}

/** 옵션 목록({value,label})으로 select를 채운다. 현재 값이 목록에 없으면 유지하지 않고 전체로 돌린다. */
export function fillSelect(select, options, value, allLabel) {
  select.replaceChildren(
    ...(allLabel == null ? [] : [h('option', { value: '' }, allLabel)]),
    ...options.map((o) => h('option', { value: String(o.value), selected: String(o.value) === String(value) }, o.label)));
  select.value = options.some((o) => String(o.value) === String(value)) ? String(value) : '';
  return select.value;
}

export function selectOf(name, options, value, allLabel) {
  const select = h('select', { name });
  fillSelect(select, options, value, allLabel);
  return select;
}

export function dataTable(label, head, rows) {
  return h('div', { class: 'table-wrap', tabindex: '0', role: 'region', 'aria-label': label },
    h('table', null,
      h('thead', null, h('tr', null, head.map((t) => h('th', { scope: 'col' }, t)))),
      h('tbody', null, rows.map((cells) => h('tr', null, cells.map((c) => h('td', null, c)))))));
}

export function pager(data, go) {
  return h('div', { class: 'pager' },
    h('button', { type: 'button', class: 'secondary', disabled: data.page <= 1, onclick: () => go(data.page - 1) }, '이전'),
    h('span', null, `${data.page} / ${data.pages} 쪽 · 총 ${num(data.total)}건`),
    h('button', { type: 'button', class: 'secondary', disabled: data.page >= data.pages, onclick: () => go(data.page + 1) }, '다음'));
}

export function statCard(label, value, caption) {
  return h('div', { class: 'card stat' }, h('div', { class: 'num' }, value), h('div', { class: 'cap' }, label), caption ? h('div', { class: 'cap' }, caption) : null);
}

export function plainDialog(title, body, actions) {
  const dialog = h('dialog', { 'aria-label': title }, h('h2', null, title), body, h('div', { class: 'buttons' }, actions));
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
  return dialog;
}

export async function saveDownload(method, url, body, fallbackName) {
  const res = await api(method, url, body);
  const href = URL.createObjectURL(await res.blob());
  const a = h('a', { href, download: /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? fallbackName });
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(href);
}

export async function download(method, url, body, fallbackName, okMessage = '엑셀 파일을 내려받았습니다.') {
  try {
    await saveDownload(method, url, body, fallbackName);
    toast(okMessage);
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function postFile(url, file) {
  const res = await fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': XLSX_MIME }, body: await file.arrayBuffer() });
  if (res.status === 401) {
    location.href = '/login';
    throw new Error('로그인이 필요합니다.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || '파일을 처리하지 못했습니다.');
  return data;
}

function chooseXlsx(onFile) {
  const input = h('input', { type: 'file', accept: '.xlsx', hidden: true });
  input.addEventListener('change', async () => {
    const file = input.files[0];
    input.remove();
    if (!file) return;
    if (file.size > MAX_UPLOAD) return toast('엑셀 파일은 최대 8MB입니다.', 'error');
    try {
      await onFile(file);
    } catch (err) {
      toast(err.message, 'error');
    }
  });
  document.body.append(input);
  input.click();
}

/**
 * 이름 칸. 대상자 조회 권한이 있고 실제로 연결된 대상자(id가 있음)일 때만 상세를 여는 단추로 만들고,
 * 그 밖에는 원래 글자 그대로 둔다. 구역 범위와 권한은 상세 API가 다시 확인한다.
 */
export function personNameLink(me, id, name, onChange) {
  if (!id || !me.perms?.people?.read) return name;
  return h('button', { type: 'button', class: 'link', 'aria-label': `${name} 대상자 상세 보기`, onclick: () => openPersonDetail(id, me, { onChange }) }, name);
}

const periodText = ({ from, to }) => {
  if (!from && !to) return '전체 기간';
  if (!from) return `${to}까지`;
  if (!to) return `${from}부터`;
  return from === to ? from : `${from} ~ ${to}`;
};

const hourLabel = (hour) => `${String(hour).padStart(2, '0')}:00–${String(hour + 1).padStart(2, '0')}:00`;
const days = (v) => (Number.isFinite(v) ? `${v.toLocaleString('ko-KR', { maximumFractionDigits: 1 })}일` : '—');
const personLabel = (p) => [p.name, p.area, p.introducer, p.findingDate, p.code].filter(Boolean).join(' · ');

// ───────── 기간 바로 선택 (오늘 · 금주 · 금월 · 전체) ─────────

const PERIOD_PRESETS = ['오늘', '금주', '금월', '전체'];

/** YYYY-MM-DD 문자열을 UTC 날짜로만 계산한다. 브라우저 시간대와 무관하다. */
const parseDay = (value) => { const [y, m, d] = value.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
const formatDay = (date) => date.toISOString().slice(0, 10);

/**
 * 서버가 알려 준 기준(meta.today: 한국 표준시 오늘, meta.weekStart: 0=일 … 6=토)으로 기간을 계산한다.
 * 금주는 주 시작 요일부터 7일, 금월은 그 달 1일부터 말일까지다.
 */
export function periodRange(preset, { today, weekStart }) {
  if (preset === '전체') return { from: '', to: '' };
  if (preset === '오늘') return { from: today, to: today };
  const base = parseDay(today);
  if (preset === '금주') {
    const start = new Date(base);
    start.setUTCDate(start.getUTCDate() - ((base.getUTCDay() - weekStart + 7) % 7));
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 6);
    return { from: formatDay(start), to: formatDay(end) };
  }
  const first = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), 1));
  const last = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 0));
  return { from: formatDay(first), to: formatDay(last) };
}

/**
 * 기간 단추 묶음. 단추를 누르면 시작일·종료일 칸을 채운 뒤 apply()로 조회한다.
 * apply는 다른 조건(검색어·콜링자 등)도 화면에 입력된 값 그대로 함께 적용해야 한다.
 * 서버 기준(meta)을 받기 전에는 단추를 막아 브라우저 시계로 잘못 계산하지 않는다. 지금 기간과 같은 단추는 눌린 상태로 표시한다.
 */
export function periodPicker({ fromInput, toInput, apply }) {
  let meta = null;
  const buttons = PERIOD_PRESETS.map((label) => h('button', {
    type: 'button', class: 'secondary', disabled: true, 'aria-pressed': 'false',
    onclick: () => {
      const range = periodRange(label, meta);
      fromInput.value = range.from;
      toInput.value = range.to;
      apply();
    },
  }, label));
  const sync = () => buttons.forEach((button, i) => {
    button.disabled = !meta;
    const range = meta ? periodRange(PERIOD_PRESETS[i], meta) : null;
    button.setAttribute('aria-pressed', range && range.from === fromInput.value && range.to === toInput.value ? 'true' : 'false');
  });
  fromInput.addEventListener('input', sync);
  toInput.addEventListener('input', sync);
  return {
    element: h('div', { class: 'actions', role: 'group', 'aria-label': '조회 기간 바로 선택' }, buttons),
    update(next) {
      if (next && /^\d{4}-\d{2}-\d{2}$/.test(next.today)) meta = { today: next.today, weekStart: Number.isInteger(next.weekStart) ? next.weekStart : 0 };
      sync();
    },
  };
}

// ───────── 검색어 즉시 조회 (원본: 입력 후 250ms 조회, 화면에 돌아오면 마지막 검색어 복원) ─────────

/** 마지막 검색어. 페이지가 살아 있는 동안만 메모리에 두고, 사용자·화면별로 따로 둔다. */
const savedSearches = new Map();
const SEARCH_DELAY = 250;

/**
 * 검색 칸을 화면에 붙인다. 화면을 열 때 그 사용자·화면의 마지막 검색어를 칸과 state.search에 채운다.
 * 입력하면 250ms 뒤 apply()로 다른 조건(기간·선택 칸)과 함께 조회한다. Enter·기간 단추로 바로 조회하면 apply 전에 cancel()을 부른다.
 */
export function liveSearch({ me, view, input, state, apply }) {
  const key = JSON.stringify([String(me?.user?.id ?? me?.user?.username ?? ''), view]);
  let timer = null;
  const saved = savedSearches.get(key) ?? '';
  input.value = saved;
  state.search = saved;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => { timer = null; apply(); }, SEARCH_DELAY);
  });
  return {
    cancel() { clearTimeout(timer); timer = null; },
    /** 실제로 조회에 반영된 검색어만 기억한다. 빈 값이면 지운다. */
    remember(value) { if (value) savedSearches.set(key, value); else savedSearches.delete(key); },
  };
}

/** 마지막 요청의 응답만 반영하는 표. begin()으로 번호를 받고 current(번호)로 아직 최신인지 확인한다. */
export function latestOnly() {
  let seq = 0;
  return { begin: () => ++seq, current: (n) => n === seq };
}

/** 조회 조건 양식. 날짜 검사는 서버도 하므로 화면에서는 빠른 안내만 한다. */
function filterForm({ controls, state, onApply, onReset, extra }) {
  return h('form', { class: 'toolbar', role: 'search', onsubmit: (e) => { e.preventDefault(); onApply(); } },
    controls,
    h('div', { class: 'actions' },
      h('button', { type: 'submit' }, '조회'),
      h('button', { type: 'reset', class: 'secondary', onclick: () => { Object.keys(state).forEach((k) => { state[k] = k === 'page' ? 1 : ''; }); setTimeout(onReset); } }, '초기화'),
      extra));
}

// ───────── 콜링 관리 ─────────

async function callingManage(box, me) {
  const perm = me.perms.callingManage;
  const state = { search: '', from: '', to: '', caller: '', page: 1 };
  const results = h('div');
  let rounds = [];
  let callers = [];

  const searchInput = h('input', { type: 'search', name: 'search', maxlength: '200', placeholder: '대상자명, 인도자, 특이사항 등 검색' });
  const fromInput = h('input', { type: 'date', name: 'from' });
  const toInput = h('input', { type: 'date', name: 'to' });
  const callerSelect = h('select', { name: 'caller' });
  fillSelect(callerSelect, [], '', '전체 콜링자');
  const applyFilters = () => {
    search.cancel();
    Object.assign(state, { search: searchInput.value.trim(), from: fromInput.value, to: toInput.value, caller: callerSelect.value, page: 1 });
    load();
  };
  const search = liveSearch({ me, view: 'callingManage', input: searchInput, state, apply: applyFilters });
  const latest = latestOnly();
  const period = periodPicker({ fromInput, toInput, apply: applyFilters });

  const params = () => new URLSearchParams(Object.entries(state).filter(([k, v]) => v && k !== 'page'));

  async function load() {
    const mine = latest.begin();
    const problem = dateError(state.from, state.to);
    if (problem) return results.replaceChildren(h('p', { class: 'status error', role: 'alert' }, problem));
    const qs = params();
    qs.set('page', state.page);
    try {
      const data = await getJson(`/api/calling/records?${qs}`);
      if (!latest.current(mine)) return;
      search.remember(state.search);
      period.update(data.period);
      state.page = data.page;
      rounds = data.rounds;
      callers = data.callers;
      state.caller = fillSelect(callerSelect, callers.map((c) => ({ value: c, label: c })), state.caller, '전체 콜링자');
      results.replaceChildren(reportCard(data), recordsTable(data));
    } catch (err) {
      if (latest.current(mine)) results.replaceChildren(errorLine(err));
    }
  }

  function reportCard(data) {
    const { report, totals } = data;
    const pairs = h('div');
    const showPairs = (page) => {
      if (!report.pairs.length) return pairs.replaceChildren(h('p', { class: 'empty' }, '조회 조건에 맞는 연결 기록이 없습니다.'));
      const pages = Math.ceil(report.pairs.length / PAIR_PAGE);
      const current = Math.min(Math.max(1, page), pages);
      const slice = report.pairs.slice((current - 1) * PAIR_PAGE, current * PAIR_PAGE);
      pairs.replaceChildren(...[dataTable('연결된 콜링자·인도자', ['콜링자', '인도자'], slice.map((p) => [p.caller, p.introducer || '미입력'])),
        pages > 1 ? pager({ page: current, pages, total: report.pairs.length }, showPairs) : null,
        report.pairsTotal > report.pairs.length ? h('p', { class: 'note' }, `연결 ${num(report.pairsTotal)}건 중 처음 ${num(report.pairs.length)}건을 표시합니다.`) : null].filter(Boolean));
    };
    showPairs(1);
    return h('section', { class: 'card' },
      h('div', { class: 'toolbar' },
        h('div', null, h('h2', null, '콜링 전체 결과 보고'), h('p', { class: 'note' }, `조회 기간 ${periodText(state)}`)),
        h('span', { class: 'spacer' }),
        h('strong', null, `총 ${num(totals.count)}건 중 ${num(totals.successes)}건 연결 (${rate(totals.rate, 0)})`),
        h('button', { type: 'button', class: 'secondary', onclick: async () => {
          try {
            await navigator.clipboard.writeText(report.text);
            toast('콜링 결과 보고를 복사했습니다.');
          } catch {
            toast('복사하지 못했습니다. 브라우저의 클립보드 권한을 확인해 주세요.', 'error');
          }
        } }, '결과 보고 복사')),
      h('h3', null, '차수별 연결 결과'),
      dataTable('차수별 연결 결과', ['차수', '콜링 건수', '연결 건수', '연결률'], report.byRound.map((r) => [r.roundLabel, num(r.count), num(r.successes), rate(r.rate, 0)])),
      h('h3', null, '연결된 콜링자·인도자'),
      pairs);
  }

  function recordsTable(data) {
    const head = ['인도자', '인도자구역', '대상자명', '콜링자', '콜링날짜', '콜링시간', '차수', '콜링결과', '특이사항'];
    const filtered = params().size > 0;
    if (!data.items.length) {
      return h('div', { class: 'card empty' }, filtered ? '조회 조건에 맞는 콜링 기록이 없습니다.' : '콜링 기록이 없습니다. 콜링 기록 추가에서 대상자를 선택해 첫 기록을 남기세요.');
    }
    return h('section', null,
      h('h2', null, '콜링 기록'),
      h('div', { class: 'table-wrap', tabindex: '0', role: 'region', 'aria-label': '콜링 기록' },
        h('table', null,
          h('thead', null, h('tr', null, head.map((t) => h('th', { scope: 'col' }, t)), perm.write ? h('th', { scope: 'col' }, '관리') : null)),
          h('tbody', null, data.items.map((r) => h('tr', null,
            h('td', null, r.introducer || '—'),
            h('td', null, r.area || '—'),
            h('td', { class: 'strong' }, r.personUnlinked || r.personDeleted ? r.personName : personNameLink(me, r.personId, r.personName, load), r.personUnlinked ? h('span', { class: 'pill off' }, '대상자 미연결') : null, r.personDeleted ? h('span', { class: 'pill off' }, '대상자 삭제됨') : null),
            h('td', null, r.caller),
            h('td', null, r.date),
            h('td', null, r.time || '미입력'),
            h('td', null, r.roundLabel),
            h('td', null, r.result === '만픽' ? h('span', { class: 'pill' }, r.originalResult || r.result) : (r.originalResult || r.result)),
            h('td', { class: 'wrapcell' }, r.notes ? multiline(r.notes) : '—'),
            perm.write ? h('td', null, h('div', { class: 'row-actions' },
              h('button', { type: 'button', class: 'secondary', onclick: () => recordForm(r) }, '수정'),
              h('button', { type: 'button', class: 'danger', onclick: () => removeRecord(r) }, '삭제'))) : null))))),
      pager(data, (page) => { state.page = page; load(); }));
  }

  function recordForm(rec) {
    const unlinked = Boolean(rec?.personUnlinked);
    const known = new Map();
    if (rec && !unlinked) known.set(rec.personId, { id: rec.personId, name: rec.personName, code: rec.personCode, introducer: rec.introducer, area: rec.area, findingDate: rec.findingDate });
    const introducer = h('input', { type: 'text', readOnly: true, value: rec?.introducer ?? '' });
    const area = h('input', { type: 'text', readOnly: true, value: rec?.area ?? '' });
    const status = h('p', { class: 'note', 'aria-live': 'polite' });
    const personSelect = h('select', { name: 'personId', required: true });
    const search = h('input', { type: 'search', maxlength: '200', placeholder: '대상자명, 인도자, 구역, 관리번호 검색', autocomplete: 'off' });
    let ticket = 0;
    let timer;

    const showPeople = (list) => {
      const selected = known.get(personSelect.value);
      known.clear();
      for (const p of list) known.set(p.id, p);
      if (selected) known.set(selected.id, selected);
      const current = personSelect.value;
      personSelect.replaceChildren(h('option', { value: '' }, '대상자 선택'),
        ...[...known.values()].map((p) => h('option', { value: p.id, selected: p.id === current }, personLabel(p))));
      personSelect.value = known.has(current) ? current : '';
    };
    async function findPeople() {
      const mine = ++ticket;
      status.textContent = '대상자를 찾는 중입니다.';
      try {
        const data = await getJson(`/api/calling/people?${new URLSearchParams({ search: search.value.trim() })}`);
        if (mine !== ticket) return;
        showPeople(data.items);
        status.textContent = data.items.length >= 50 ? '상위 50명 표시 · 검색어를 추가해 찾으세요.' : data.items.length ? `${num(data.items.length)}명 조회` : '조회한 대상자가 없습니다.';
      } catch (err) {
        if (mine === ticket) status.textContent = err.message;
      }
    }
    search.addEventListener('input', () => { ticket++; clearTimeout(timer); timer = setTimeout(findPeople, 175); });
    personSelect.addEventListener('change', () => {
      const p = known.get(personSelect.value);
      introducer.value = p?.introducer ?? '';
      area.value = p?.area ?? '';
    });

    const roundValues = [...rounds];
    if (rec && !roundValues.some((r) => String(r.value) === String(rec.round))) roundValues.push({ value: rec.round, label: rec.roundLabel });
    const roundSelect = h('select', { name: 'round' }, roundValues.map((r) => h('option', { value: String(r.value) }, r.label)), h('option', { value: '' }, '직접 입력'));
    roundSelect.value = String(rec?.round ?? 0);
    const customInput = h('input', { type: 'text', name: 'customRound', maxlength: '60', placeholder: '예: 5차, 수능인원', disabled: true, required: true });
    const customField = h('label', { class: 'wide', hidden: true }, '직접 입력할 차수 *', customInput);
    roundSelect.addEventListener('change', () => {
      const writing = roundSelect.value === '';
      customInput.disabled = !writing;
      customField.hidden = !writing;
      if (writing) customInput.focus();
    });

    formDialog({
      title: rec ? '콜링 기록 수정' : '콜링 기록 추가',
      body: h('div', { class: 'form-grid' },
        unlinked
          ? [h('input', { type: 'hidden', name: 'personId', value: '' }), field('대상자명', h('input', { type: 'text', readOnly: true, value: rec.personName }), 'wide'), h('p', { class: 'note wide' }, '대상자 미연결 기록은 원본 대상자 정보를 유지합니다.')]
          : [field('대상자 검색', search, 'wide'), field('대상자명 *', personSelect, 'wide'), status],
        h('input', { type: 'hidden', name: 'requestId', value: crypto.randomUUID() }),
        field('인도자', introducer),
        field('인도자구역', area),
        field('콜링날짜 *', h('input', { type: 'date', name: 'date', value: rec?.date ?? today(), required: true })),
        field('콜링시간 (선택)', h('input', { type: 'time', name: 'time', value: rec ? rec.time : new Date().toTimeString().slice(0, 5) })),
        field('콜링자 *', h('input', { type: 'text', name: 'caller', value: rec?.caller ?? '', required: true, maxlength: '100', list: 'calling-callers', autocomplete: 'off' })),
        h('datalist', { id: 'calling-callers' }, callers.map((c) => h('option', { value: c }))),
        field('차수 *', roundSelect),
        field('콜링결과 *', h('input', { type: 'text', name: 'resultText', value: rec ? (rec.originalResult || rec.result) : '', required: true, maxlength: '100' })),
        customField,
        field('특이사항', h('textarea', { name: 'notes', maxlength: '5000', value: rec?.notes ?? '' }), 'wide')),
      onSubmit: async (fd) => {
        const f = Object.fromEntries(fd);
        await sendJson(rec ? 'PUT' : 'POST', rec ? `/api/calling/records/${encodeURIComponent(rec.id)}` : '/api/calling/records', {
          requestId: f.requestId,
          personId: f.personId ?? '',
          caller: f.caller,
          date: f.date,
          time: f.time ?? '',
          round: f.round || f.customRound || '',
          resultText: f.resultText,
          notes: f.notes ?? '',
        });
        toast(rec ? '콜링 기록을 수정했습니다.' : '콜링 기록을 저장했습니다.');
        load();
      },
    });
    if (!unlinked) findPeople();
  }

  function removeRecord(r) {
    formDialog({
      title: '콜링 기록 삭제',
      body: h('p', null, `${r.personName} 대상자의 ${r.date} ${r.time || '(시간 미입력)'} 콜링을 삭제할까요?`),
      submitLabel: '삭제',
      onSubmit: async () => {
        await sendJson('DELETE', `/api/calling/records/${encodeURIComponent(r.id)}`);
        toast('삭제했습니다.');
        load();
      },
    });
  }

  // ── 가져오기 ──

  function previewDialog(p, { draft, fileName }) {
    const status = h('p', { class: 'status error', role: 'alert' });
    const unit = p.report ? '일보' : '엑셀';
    const title = p.report ? '콜링 일보 가져오기 미리보기' : p.reportWorkbook ? '콜링 일보 엑셀 가져오기 미리보기' : p.migration ? 'MIG 콜링 엑셀 가져오기 미리보기' : '콜링 엑셀 가져오기 미리보기';
    const where = (e) => (p.report && e.row ? `${num(e.row)}줄` : [e.sheet, e.row ? `${num(e.row)}행` : ''].filter(Boolean).join(' '));
    const headers = ['위치', '인도자', '인도자구역', '대상자명', '콜링자', '콜링날짜', '콜링시간', '차수', '콜링결과', '특이사항'];
    const cards = [['전체 행', p.totalRows], ['반영 예정', p.validCount]];
    if (p.report && p.canExport && p.exportCount !== p.validCount) cards.push(['엑셀 저장 대상', p.exportCount]);
    if (p.unlinkedCount) cards.push(['대상자 미연결', p.unlinkedCount]);
    cards.push(['중복 건너뜀', p.duplicateCount], ['오류', p.errorCount]);

    let dialog;
    const busy = (button, task) => async () => {
      button.disabled = true;
      status.textContent = '';
      try { await task(); } catch (err) { status.textContent = err.message; } finally { button.disabled = false; }
    };
    const applyButton = h('button', { type: 'button' }, p.report ? '프로그램에 등록' : '확인하고 반영');
    applyButton.addEventListener('click', busy(applyButton, async () => {
      const done = await sendJson('POST', '/api/calling/import/apply', { token: p.token });
      toast(`콜링 기록 ${num(done.count)}건을 가져왔습니다.`);
      dialog.close();
      load();
    }));
    const exportButton = h('button', { type: 'button' }, '엑셀로 저장');
    exportButton.addEventListener('click', busy(exportButton, async () => {
      await saveDownload('POST', '/api/calling/report/export', { token: p.token }, 'smoa-calling-report.xlsx');
      toast('엑셀 파일을 내려받았습니다.');
    }));

    dialog = plainDialog(fileName ? `${title} · ${fileName}` : title,
      h('div', null,
        h('div', { class: 'cards' }, cards.map(([label, value]) => statCard(label, num(value)))),
        p.errorCount ? h('div', { class: 'card' },
          h('strong', null, p.report ? `오류 ${num(p.errorCount)}건 · 프로그램에 등록하려면 오류를 확인해 주세요.` : `오류 ${num(p.errorCount)}건 · 반영하려면 엑셀 파일을 수정해 주세요.`),
          h('ul', null, p.errors.slice(0, 30).map((e) => h('li', null, [where(e), e.message].filter(Boolean).join(' · ')))),
          p.errorCount > 30 ? h('p', { class: 'note' }, `처음 30건을 표시합니다.`) : null) : null,
        p.unlinkedCount ? h('p', { class: 'note' }, `대상자 미연결 기록은 ${unit}에 적힌 대상자명과 구역을 저장합니다.`) : null,
        p.duplicateCount ? h('p', { class: 'note' }, `${unit} 안에서 반복되거나 이미 있는 동일 기록은 반영할 때 건너뜁니다.`) : null,
        p.rows.length
          ? dataTable('가져올 콜링 기록', headers, p.rows.map((r) => [
            p.report && r.line ? `${num(r.line)}줄` : [r.sheet, r.line ? `${num(r.line)}행` : ''].filter(Boolean).join(' '),
            r.introducer || '—', r.area || '—',
            r.personName + (r.personId ? '' : ' (미연결)'),
            r.caller, r.date, r.time || '미입력', r.roundLabel, r.originalResult || r.result, multiline(r.notes || '—')]))
          : h('p', { class: 'empty' }, '추가할 콜링 기록이 없습니다.'),
        p.rows.length >= 200 ? h('p', { class: 'note' }, '처음 200건을 표시합니다.') : null,
        status),
      [
        h('button', { type: 'button', class: 'secondary', onclick: () => dialog.close() }, '닫기'),
        p.report ? h('button', { type: 'button', class: 'secondary', onclick: () => { dialog.close(); reportForm(draft); } }, '일보 수정') : null,
        p.report && p.canExport && perm.export ? exportButton : null,
        p.canApply && perm.write ? applyButton : null,
      ]);
  }

  function reportForm(draft = {}) {
    formDialog({
      title: '콜링 일보 가져오기',
      submitLabel: '미리보기',
      body: h('div', { class: 'form-grid' },
        h('p', { class: 'note wide' }, '콜링 일보를 그대로 붙여넣으세요. 일보에 날짜가 없으면 선택한 날짜를, 월일만 있으면 선택한 날짜의 연도를 적용합니다. 건수는 상세 행으로 계산하며 한 번에 30만 자까지 붙여넣을 수 있습니다.'),
        field('콜링 날짜 *', h('input', { type: 'date', name: 'date', value: draft.date ?? today(), required: true })),
        field('기본 콜링자 (선택)', h('input', { type: 'text', name: 'caller', maxlength: '100', value: draft.caller ?? '' })),
        field('콜링 일보 *', h('textarea', { name: 'text', rows: '11', required: true, maxlength: String(MAX_REPORT_CHARS), value: draft.text ?? '' }), 'wide'),
        h('p', { class: 'note wide' }, '입력한 결과 문구를 그대로 저장합니다. 결과 보고에서는 만픽을 연결로 집계합니다.')),
      onSubmit: async (fd) => {
        const next = { date: fd.get('date'), caller: fd.get('caller'), text: fd.get('text') };
        const preview = await sendJson('POST', '/api/calling/report/preview', next);
        previewDialog(preview, { draft: next, fileName: preview.reportDate });
      },
    });
  }

  function importFile(migration) {
    chooseXlsx(async (file) => {
      toast('엑셀 파일을 확인하는 중입니다.');
      const preview = await postFile(`/api/calling/import/preview${migration ? '?migration=1' : ''}`, file);
      previewDialog(preview, { fileName: file.name });
    });
  }

  const form = filterForm({
    state,
    controls: [field('검색', searchInput), field('시작일', fromInput), field('종료일', toInput), period.element, field('콜링자', callerSelect)],
    onApply: applyFilters,
    onReset: () => { search.cancel(); load(); },
  });

  box.append(
    h('div', { class: 'toolbar' }, h('h1', null, '콜링 관리'), h('span', { class: 'spacer' }),
      h('div', { class: 'actions' },
        perm.write ? h('button', { type: 'button', class: 'secondary', onclick: () => download('GET', '/api/calling/template', undefined, 'smoa-calling-template.xlsx', '입력 양식을 내려받았습니다.') }, '입력 양식') : null,
        perm.write || perm.export ? h('button', { type: 'button', class: 'secondary', onclick: () => reportForm() }, '콜링 일보 가져오기') : null,
        perm.write ? h('button', { type: 'button', class: 'secondary', onclick: () => importFile(false) }, '엑셀 가져오기') : null,
        perm.write ? h('button', { type: 'button', class: 'secondary', onclick: () => importFile(true) }, 'MIG 엑셀 가져오기') : null,
        perm.export ? h('button', { type: 'button', class: 'secondary', onclick: () => download('GET', `/api/calling/records/export?${params()}`, undefined, 'smoa-calling.xlsx') }, '조회 결과 엑셀') : null,
        perm.write ? h('button', { type: 'button', onclick: () => recordForm(null) }, '콜링 기록 추가') : null)),
    h('div', { class: 'card' }, form),
    results);
  await load();
}

// ───────── 콜링 통계 ─────────

async function callingStats(box, me) {
  const perm = me.perms.callingStats;
  const state = { search: '', from: '', to: '', caller: '', round: '' };
  const results = h('div');

  const searchInput = h('input', { type: 'search', name: 'search', maxlength: '200', placeholder: '대상자명, 인도자, 특이사항 등 검색' });
  const fromInput = h('input', { type: 'date', name: 'from' });
  const toInput = h('input', { type: 'date', name: 'to' });
  const callerSelect = selectOf('caller', [], '', '전체 콜링자');
  const roundSelect = selectOf('round', [], '', '전체 차수');
  const applyFilters = () => {
    search.cancel();
    Object.assign(state, { search: searchInput.value.trim(), from: fromInput.value, to: toInput.value, caller: callerSelect.value, round: roundSelect.value });
    load();
  };
  const search = liveSearch({ me, view: 'callingStats', input: searchInput, state, apply: applyFilters });
  const latest = latestOnly();
  const period = periodPicker({ fromInput, toInput, apply: applyFilters });
  const params = () => new URLSearchParams(Object.entries(state).filter(([, v]) => v));

  async function load() {
    const mine = latest.begin();
    const problem = dateError(state.from, state.to);
    if (problem) return results.replaceChildren(h('p', { class: 'status error', role: 'alert' }, problem));
    try {
      const d = await getJson(`/api/calling/stats?${params()}`);
      if (!latest.current(mine)) return;
      search.remember(state.search);
      period.update(d.period);
      state.caller = fillSelect(callerSelect, d.callers.map((c) => ({ value: c, label: c })), state.caller, '전체 콜링자');
      state.round = fillSelect(roundSelect, d.rounds, state.round, '전체 차수');
      results.replaceChildren(view(d));
    } catch (err) {
      if (latest.current(mine)) results.replaceChildren(errorLine(err));
    }
  }

  /* 원본 calling.js callingStatsHTML: 요약 4칸 → 시간대·콜링자·차수 3열 → 교차 2열 → 찾B 후 소요일 */

  function summary(totals, lag) {
    const cards = [
      ['전체 콜링', num(totals.count), '건', `대상자 ${num(totals.targets)}명 · 콜링자 ${num(totals.callerCount)}명`],
      ['만픽', num(totals.successes), '건', '결과가 만픽으로 기록된 콜링'],
      ['만픽률', rate(totals.rate), '', '전체 콜링 중 만픽 비율'],
      ['찾B 후 평균 만픽 소요일', days(lag.average), '', `찾B일 확인 ${num(lag.count)}명`],
    ];
    return h('section', { id: 'calling-summary', class: 'metrics calling-summary', 'aria-label': '콜링 요약' },
      cards.map(([label, value, unit, detail]) => h('article', { class: 'metric' },
        h('div', { class: 'metric-head' }, label),
        h('div', { class: 'metric-value' }, value, unit ? h('small', null, unit) : null),
        h('div', { class: 'metric-foot' }, detail))));
  }

  /** columns: [[읽기 함수, 머리글]]. 첫 칸은 행 머리글이고 건수·만픽률은 오른쪽 정렬이다. */
  function breakdown(id, title, columns, rows, emptyText = '조회 조건에 맞는 콜링 기록이 없습니다.') {
    const heading = `${id}-heading`;
    return h('section', { class: 'panel calling-panel calling-breakdown-panel', 'aria-labelledby': heading },
      h('div', { class: 'panel-head' }, h('h2', { id: heading }, title)),
      rows.length
        ? h('div', { class: 'table-scroll calling-breakdown-scroll', role: 'region', 'aria-labelledby': heading, tabindex: '0' },
          h('table', { id },
            h('thead', null, h('tr', null,
              columns.map(([, label]) => h('th', { scope: 'col' }, label)),
              ['콜링 건수', '만픽 건수', '만픽률'].map((label) => h('th', { scope: 'col', class: 'numeric' }, label)))),
            h('tbody', null, rows.map((row) => h('tr', null,
              columns.map(([read], i) => (i === 0 ? h('th', { scope: 'row' }, read(row)) : h('td', null, read(row)))),
              h('td', { class: 'numeric' }, num(row.count)),
              h('td', { class: 'numeric' }, num(row.successes)),
              h('td', { class: 'numeric calling-rate' }, rate(row.rate)))))))
        : h('div', { class: 'empty' }, emptyText));
  }

  function lagPanel(lag) {
    const track = (value) => {
      const fill = h('i');
      fill.style.setProperty('--percent', `${Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0))}%`);
      return h('span', { class: 'calling-rate-track', 'aria-hidden': 'true' }, fill);
    };
    return h('section', { id: 'calling-lag', class: 'panel calling-panel', 'aria-labelledby': 'calling-lag-heading' },
      h('div', { class: 'panel-head' }, h('div', null,
        h('h2', { id: 'calling-lag-heading' }, '찾B일부터 만픽 콜링까지'),
        h('p', null, '조회 조건 내 대상자별 첫 만픽 콜링까지의 날짜 차이입니다. 80% 도달 추정은 관측된 만픽 대상자의 분포를 기준으로 계산합니다.'))),
      lag.count
        ? [h('div', { class: 'panel-body calling-lag-body' },
          h('dl', { class: 'calling-lag-metrics' },
            [['평균 소요일', days(lag.average)], ['중앙값', days(lag.median)], ['80% 도달 추정', days(lag.p80)]]
              .map(([label, value]) => h('div', null, h('dt', null, label), h('dd', null, value)))),
          h('p', { class: 'muted' }, `집계 대상 ${num(lag.count)}명${lag.missing ? ` · 날짜 확인 필요 ${num(lag.missing)}명` : ''}`)),
        h('div', { class: 'table-scroll', role: 'region', 'aria-label': '찾B 이후 누적 만픽 대상자', tabindex: '0' },
          h('table', { id: 'calling-lag-within' },
            h('thead', null, h('tr', null,
              h('th', { scope: 'col' }, '찾B 이후'),
              h('th', { scope: 'col', class: 'numeric' }, '누적 만픽 대상자'),
              h('th', { scope: 'col', class: 'numeric' }, '관측 만픽 중 누적 비율'))),
            h('tbody', null, lag.within.map((w) => h('tr', null,
              h('th', { scope: 'row' }, w.days === 0 ? '당일' : `${num(w.days)}일 이내`),
              h('td', { class: 'numeric' }, `${num(w.count)}명`),
              h('td', { class: 'numeric calling-rate' }, h('div', { class: 'calling-lag-rate' }, track(w.rate), rate(w.rate))))))))]
        : h('div', { class: 'empty' }, lag.missing ? `찾B일과 콜링날짜를 확인할 만픽 대상자가 ${num(lag.missing)}명 있습니다.` : '소요일을 집계할 만픽 대상자가 없습니다.'));
  }

  function view(d) {
    const { totals, lag } = d;
    const hourEmpty = d.missingTime ? '시간이 기록된 콜링이 없습니다.' : undefined;
    const hour = [(row) => hourLabel(row.hour), '시간대'];
    const caller = [(row) => row.caller, '콜링자'];
    const round = [(row) => row.roundLabel, '차수'];
    return h('div', { id: 'calling-stats', class: 'calling-stats status-page' },
      summary(totals, lag),
      d.missingTime ? h('p', { class: 'notice calling-time-note' }, `시간 미입력 ${num(d.missingTime)}건은 시간대별 집계에서 제외됩니다.`) : null,
      h('div', { class: 'calling-breakdowns calling-breakdowns-simple' },
        breakdown('calling-by-hour', '시간대별 만픽', [hour], d.byHour, hourEmpty),
        breakdown('calling-by-caller', '콜링자별 만픽', [caller], d.byCaller),
        breakdown('calling-by-round', '차수별 만픽', [round], d.byRound)),
      h('div', { class: 'calling-breakdowns' },
        breakdown('calling-by-caller-hour', '콜링자·시간대별 만픽', [caller, hour], d.byCallerHour, hourEmpty),
        breakdown('calling-by-caller-round', '콜링자·차수별 만픽', [caller, round], d.byCallerRound)),
      lagPanel(lag));
  }

  const form = filterForm({
    state,
    controls: [field('검색', searchInput), field('시작일', fromInput), field('종료일', toInput), period.element, field('콜링자', callerSelect), field('차수', roundSelect)],
    onApply: applyFilters,
    onReset: () => { search.cancel(); load(); },
  });

  box.append(
    h('div', { class: 'toolbar' }, h('h1', null, '콜링 데이터 현황'), h('span', { class: 'spacer' }),
      h('div', { class: 'actions' },
        perm.export ? h('button', { type: 'button', class: 'secondary', onclick: () => download('GET', `/api/calling/stats/export?${params()}`, undefined, 'smoa-calling-stats.xlsx') }, '통계 엑셀') : null)),
    h('div', { class: 'card' }, form),
    results);
  await load();
}

export const callingViews = { callingManage, callingStats };
