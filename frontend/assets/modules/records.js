// records 모듈: 대상자(people) / 활동 기록(activities) / 변경 이력(history) / 단계 이동 분석(stages).
// 지역활동기록(regionalActivity)은 아직 이식되지 않아 '데이터 연결 준비 중'으로 표시한다.
// 구역 선택지와 자료 범위·권한은 서버가 정한다. 화면은 응답을 그대로 그린다.
// 연락처: 원문은 화면에 나오지 않는다(서버가 끝 네 자리만 돌려준다). 수정 폼에 원문을 미리 채우지 않고, 연락처는 전용 입력으로만 보낸다.
import { mountNotConnected } from '../js/placeholder.js';
import { badge, clear, confirmAction, errorMessage, field, h, notice, select, table } from '../js/ui.js';

const STATUS_LABEL = { active: '진행', dropped: '탈락' };
const HISTORY_LABEL = {
  CREATED: '등록', UPDATED: '수정', STAGE_CHANGED: '단계 이동', STAGE_BASELINE: '단계 기준(최초)', DROPPED: '탈락', RESTORED: '복귀',
  STATUS_CHANGED: '상태 변경', DELETED: '삭제', UNDELETED: '삭제 취소', PHONE_CHANGED: '연락처 변경', ACTIVITY_CHANGED: '활동 변경',
};
const KIND_LABEL = { STAGE: '단계', STATUS: '상태', CHANGE: '변경' };
const today = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
const base = (ctx) => `/api/programs/${encodeURIComponent(ctx.programId)}`;
const districtKey = (row) => row.regionCode && row.districtCode ? `${row.regionCode}|${row.districtCode}` : '';
const districtsAsOptions = (districts) => districts.map((d) => [districtKey(d), [d.regionName, d.districtName || d.name].filter(Boolean).join(' / ')]);
const labelDistrict = (options) => {
  const names = new Map(options);
  return (row) => names.get(districtKey(row)) || (districtKey(row) ? '구역 정보 없음' : '구역 미지정');
};
const seoul = (utcIso) => (utcIso ? new Date(utcIso).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', hour12: false }) : '');
const businessTime = (iso) => (iso ? iso.replace('T', ' ').replace(/:00$/, '') : '');

// 대상자 원본 필드 정의(서버 PersonField 와 같은 키). codeGroups 는 공통코드 그룹 이름 후보(자동완성 제안용).
const PERSON_SECTIONS = [
  { title: '기본 정보', fields: [
    { key: 'code', label: '식별번호', type: 'text', max: 60, hint: '비워도 됩니다(중복 허용).' },
    { key: 'name', label: '이름', type: 'text', max: 100, required: true },
    { key: 'gender', label: '성별', type: 'text', max: 20, codeGroups: ['SEX', 'GENDER'] },
    { key: 'age', label: '나이', type: 'number', min: 0, max: 120 },
    { key: 'ageAsOf', label: '나이 기준일', type: 'date' },
    { key: 'classification1', label: '분류1', type: 'text', max: 20, codeGroups: ['CLASS1', 'CLASSIFICATION1'] },
    { key: 'classification2', label: '분류2', type: 'text', max: 20, codeGroups: ['CLASS2', 'CLASSIFICATION2'] },
    { key: 'className', label: '반', type: 'text', max: 60, codeGroups: ['BAN', 'CLASS'] },
    { key: 'employment', label: '직업', type: 'text', max: 60, codeGroups: ['JOB', 'EMPLOYMENT'] },
  ] },
  { title: '찾은 정보', fields: [
    { key: 'foundDate', label: '찾은 날짜', type: 'date', future: false },
    { key: 'foundTime', label: '찾은 시간', type: 'time' },
    { key: 'dateUnknown', label: '찾은 날짜 미상', type: 'checkbox' },
    { key: 'place', label: '찾은 장소', type: 'text', max: 200 },
    { key: 'tool', label: '사용 도구', type: 'text', max: 200 },
    { key: 'residence', label: '거주지', type: 'text', max: 200 },
    { key: 'teacher', label: '교사', type: 'text', max: 100 },
    { key: 'worker', label: '담당자', type: 'text', max: 100 },
    { key: 'reason', label: '사유', type: 'textarea', max: 2000 },
  ] },
  { title: '인도자', fields: [
    { key: 'introducerId', label: '명부에서 인도자 선택', type: 'employee' },
    { key: 'introducerCode', label: '인도자 구성원ID', type: 'text', max: 60 },
    { key: 'introducerName', label: '인도자 이름', type: 'text', max: 100 },
    { key: 'introducerOrg', label: '인도자 소속', type: 'text', max: 300 },
  ] },
  { title: '일정·단계 날짜', fields: [
    { key: 'appointment', label: '확정 일정', type: 'text', max: 30 },
    { key: 'manpikDate', label: '만픽일', type: 'date' },
    { key: 'findADate', label: '찾A일', type: 'date' },
    { key: 'habBDate', label: '합B일', type: 'date' },
    { key: 'habADate', label: '합A(육따)일', type: 'date' },
    { key: 'youngTtaDate', label: '영따일', type: 'date' },
    { key: 'bokshinDate', label: '복신일', type: 'date' },
    { key: 'cardReceivedDate', label: '신카접수일', type: 'date' },
    { key: 'centerRegisteredDate', label: '센터등록일', type: 'date' },
  ] },
  { title: '메모·사용자 정의', fields: [
    { key: 'notes', label: '메모', type: 'textarea', max: 5000 },
    { key: 'custom', label: '사용자 정의 항목(JSON 객체)', type: 'json', hint: '예: {"항목":"값"} — 비우면 지웁니다.' },
  ] },
];
const PERSON_FIELDS = PERSON_SECTIONS.flatMap((s) => s.fields);

export async function mount(ctx) {
  if (ctx.programId === 'regionalActivity') return (await import('./regional-activity.js')).mount(ctx);
  const views = { people: mountPeople, activities: mountActivities, history: mountHistory, stages: mountStages };
  const view = views[ctx.programId];
  if (!view) return mountNotConnected(ctx, ['지역활동 기록 저장·삭제', '지역활동 가져오기', '보고서 복사']);
  return view(ctx);
}

/** 작업을 실행하고 성공/실패를 알린다. 409(다른 사용자가 먼저 수정)이면 목록을 다시 읽는다. */
function run(ctx, task, success, after) {
  return async () => {
    try {
      await task();
      if (success) ctx.toast(success, 'ok');
    } catch (error) {
      ctx.toast(errorMessage(error), 'error');
      if (error.status !== 409) return;
    }
    if (after) {
      try { await after(); } catch (error) { ctx.toast(errorMessage(error), 'error'); }
    }
  };
}

const action = (label, onclick, style = 'small', attrs = {}) => h('button', {
  type: 'button', class: ('btn ' + style).trim(), text: label, onclick, ...attrs,
});

function recordDialog(programId) {
  const titleId = programId + '-record-title';
  const dialog = h('dialog', { class: 'record-dialog', 'aria-labelledby': titleId });
  const close = () => dialog.close();
  dialog.addEventListener('close', () => { if (!dialog.open) clear(dialog); });
  function show(content) {
    const title = content.querySelector('h2, h3');
    title.id = titleId;
    clear(dialog).append(content, action('닫기', close, 'record-dialog-close ghost', { text: '×', 'aria-label': '닫기' }));
    if (!dialog.open) dialog.showModal();
    title.tabIndex = -1;
    title.focus();
  }
  return { dialog, show, close };
}

function recordTable(columns, rows, name, empty, onOpen) {
  const wrapper = table(columns, rows, empty);
  wrapper.classList.add('record-table');
  wrapper.setAttribute('role', 'region');
  wrapper.setAttribute('aria-label', name);
  wrapper.tabIndex = 0;
  if (onOpen && rows.length) {
    [...wrapper.querySelectorAll('tbody tr')].forEach((row, index) => {
      row.classList.add('record-table-row');
      row.addEventListener('dblclick', (event) => {
        if (!event.target.closest('button, a, input, select')) onOpen(rows[index]);
      });
    });
  }
  return wrapper;
}

function addPageToolbar(root, actions) {
  const toolbar = h('div', { class: 'record-toolbar actions' }, actions);
  const title = root.previousElementSibling;
  if (!title?.matches('.page-title')) {
    root.append(toolbar);
    return;
  }
  const header = h('header', { class: 'record-page-head' });
  title.before(header);
  header.append(title, toolbar);
}

function pageList(ctx, host, query, unit, render, title) {
  const limit = 50;
  let offset = 0;
  let requestId = 0;

  async function load(next = offset) {
    const id = ++requestId;
    const params = query();
    params.set('limit', limit);
    params.set('offset', next);
    const page = await ctx.api.get(`${base(ctx)}/page?${params}`);
    if (id !== requestId) return;
    if (!page.items.length && next > 0) return load(0);
    offset = page.offset;
    const total = page.total.toLocaleString('ko-KR');
    const range = page.items.length ? ` · ${(offset + 1).toLocaleString('ko-KR')}–${(offset + page.items.length).toLocaleString('ko-KR')}` : '';
    const pageCount = Math.max(1, Math.ceil(page.total / limit));
    const current = Math.floor(offset / limit) + 1;
    const visiblePages = [...new Set([1, current - 1, current, current + 1, pageCount])]
      .filter((value) => value > 0 && value <= pageCount).sort((a, b) => a - b);
    const pageButton = (label, target, attrs) => action(label, run(ctx, () => load((target - 1) * limit)), 'small', attrs);
    const pageButtons = visiblePages.flatMap((value, index) => [
      value - visiblePages[index - 1] > 1 ? h('span', { 'aria-hidden': 'true', text: '…' }) : null,
      pageButton(String(value), value, { 'aria-label': value + '쪽', 'aria-current': value === current ? 'page' : null, disabled: value === current }),
    ]);
    const footer = h('footer', { class: 'record-table-foot list-summary' },
      h('p', { class: 'muted', role: 'status', text: `전체 ${total}${unit}${range}` }),
      h('nav', { class: 'actions', 'aria-label': '목록 페이지' },
        pageButton('이전', current - 1, { disabled: current <= 1 }),
        ...pageButtons,
        pageButton('다음', current + 1, { disabled: current >= pageCount })));
    clear(host).append(h('section', { class: 'panel record-list' },
      title ? h('header', { class: 'record-list-head' }, h('h3', { text: title }), h('span', { class: 'badge', text: total + unit })) : null,
      render(page.items), footer));
  }

  return { load, reset: () => load(0) };
}

function detailGrid(entries) {
  return h('dl', { class: 'record-detail-grid' }, entries.map(([label, value]) => h('div', {},
    h('dt', { text: label }), h('dd', { text: value === '' || value == null ? '—' : value }))));
}

function detailTimeline(ctx, title, kind, personId, empty, render, historyKind) {
  if (!ctx.me?.permissions?.[kind]?.read) return null;
  const entries = h('div', { class: 'record-timeline' });
  const loadMore = action('더 보기', () => void load(), 'small', { hidden: true });
  const status = h('p', { class: 'muted', role: 'status' });
  let offset = 0;
  async function load() {
    loadMore.disabled = true;
    status.textContent = '불러오는 중…';
    const query = new URLSearchParams({ personId, offset, limit: 10 });
    if (historyKind) query.set('kind', historyKind);
    try {
      const page = await ctx.api.get('/api/programs/' + kind + '/page?' + query);
      if (!entries.isConnected) return;
      const rows = page.items;
      entries.append(...rows.map(render));
      offset += rows.length;
      status.textContent = offset ? '' : empty;
      loadMore.hidden = !rows.length || offset >= page.total;
    } catch (error) {
      status.textContent = errorMessage(error);
      loadMore.hidden = false;
    } finally {
      loadMore.disabled = false;
    }
  }
  const disclosure = h('details', { class: 'record-detail-section' }, h('summary', { text: title }), entries, status, loadMore);
  disclosure.addEventListener('toggle', () => { if (disclosure.open && !offset && !loadMore.disabled) void load(); });
  return disclosure;
}

function datalistFor(options, spec) {
  const group = (spec.codeGroups || []).find((g) => options.codes && options.codes[g]);
  if (!group) return { list: null, datalist: null };
  const id = `dl-${spec.key}`;
  const datalist = h('datalist', { id }, options.codes[group].filter((i) => i.active).map((i) => h('option', { value: i.value, label: i.label })));
  return { list: id, datalist };
}

/** 정의에 따라 입력 컨트롤을 만든다. person 이 있으면 현재 값으로 채운다(연락처는 정의에 없다). */
function buildControls(ctx, options, person) {
  const controls = {};
  const nodes = [];
  for (const section of PERSON_SECTIONS) {
    const items = [];
    for (const spec of section.fields) {
      const current = person ? person[spec.key] : undefined;
      let input;
      if (spec.type === 'employee') {
        const empty = ['', '연결 없음'];
        const saved = current ? [[current, person.introducerName || '현재 연결된 인도자']] : [];
        input = select([empty, ...saved], current, { 'aria-label': spec.label });
        const search = h('input', { type: 'search', maxlength: 100, placeholder: '이름 또는 구성원 ID', 'aria-label': '인도자 검색어' });
        const status = h('small', { class: 'muted', role: 'status' });
        const button = h('button', { type: 'button', class: 'btn small', text: '명부 검색', onclick: run(ctx, async () => {
          button.disabled = true;
          try {
            const params = new URLSearchParams({ q: search.value, limit: 30 });
            const page = await ctx.api.get(`${base(ctx)}/introducers?${params}`);
            const optionsById = new Map([empty, ...saved, ...page.items.map((e) =>
              [e.id, [e.name, e.code, e.org].filter(Boolean).join(' · ')])]);
            const previous = input.value;
            if (!optionsById.has(previous)) optionsById.set(previous, input.selectedOptions[0]?.text || '선택한 인도자');
            input.replaceChildren(...select([...optionsById], previous).options);
            input.value = previous;
            status.textContent = `검색 ${page.total}명 · ${page.items.length}명 표시`;
          } finally { button.disabled = false; }
        }) });
        controls[spec.key] = { spec, input, original: current };
        items.push(h('section', { class: 'field' }, h('div', { class: 'row' }, search, button),
          field(spec.label, input), status));
        continue;
      } else if (spec.type === 'textarea') input = h('textarea', { maxlength: spec.max, text: current ?? '' });
      else if (spec.type === 'checkbox') input = h('input', { type: 'checkbox', checked: Boolean(current) });
      else if (spec.type === 'json') input = h('textarea', { rows: 3, text: current ? JSON.stringify(current) : '' });
      else {
        const attrs = { type: spec.type, value: current ?? '', maxlength: spec.max, min: spec.min, max: spec.type === 'date' && spec.future === false ? today() : spec.max && spec.type === 'number' ? spec.max : undefined };
        const dl = datalistFor(options, spec);
        if (dl.list) attrs.list = dl.list;
        input = h('input', attrs);
        if (dl.datalist) items.push(dl.datalist);
      }
      controls[spec.key] = { spec, input, original: current };
      items.push(field(spec.label + (spec.required ? ' *' : ''), input, spec.hint));
    }
    nodes.push(h('details', { class: 'panel', open: section.title === '기본 정보' || section.title === '찾은 정보' }, h('summary', { text: section.title }), h('div', { class: 'grid2' }, items)));
  }
  return { controls, nodes };
}

/** 컨트롤의 현재 값을 API 값으로 바꾼다. 빈 값은 null(= 지움). */
function readControl({ spec, input }) {
  if (spec.type === 'checkbox') return input.checked;
  const raw = input.value.trim();
  if (raw === '') return null;
  if (spec.type === 'number') return Number(raw);
  if (spec.type === 'json') {
    let parsed;
    try { parsed = JSON.parse(raw); } catch (e) { throw new Error(`${spec.label}: JSON 형식이 올바르지 않습니다.`); }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${spec.label}: 객체 형식이어야 합니다.`);
    return parsed;
  }
  return raw;
}

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
/** 화면 값과 비교할 원래 값(체크박스는 없으면 false, 빈 문자열은 null). */
const originalOf = ({ spec, original }) => (spec.type === 'checkbox' ? Boolean(original) : original === '' ? null : original);

// ---------------------------------------------------------------- 대상자
async function mountPeople(ctx) {
  const root = ctx.container;
  root.classList.add('records-surface');
  const canWrite = ctx.permissions.write;
  const options = await ctx.api.get(`${base(ctx)}/options`);
  const districtOptions = districtsAsOptions(options.districts);
  const districtLabel = labelDistrict(districtOptions);
  const stageLabel = Object.fromEntries((options.stageItems || []).map((s) => [s.value, s.label]));
  const filters = { q: '', stageId: '', status: '', district: '', phoneLast4: '', foundFrom: '', foundTo: '', includeDeleted: false };
  const editor = recordDialog('people');
  const listHost = h('div');

  function query() {
    const params = new URLSearchParams();
    if (filters.q) params.set('q', filters.q);
    if (filters.stageId) params.set('stageId', filters.stageId);
    if (filters.status) params.set('status', filters.status);
    if (filters.phoneLast4) params.set('phoneLast4', filters.phoneLast4);
    if (filters.foundFrom) params.set('foundFrom', filters.foundFrom);
    if (filters.foundTo) params.set('foundTo', filters.foundTo);
    if (filters.district) {
      const [regionCode, districtCode] = filters.district.split('|');
      params.set('regionCode', regionCode);
      params.set('districtCode', districtCode);
    }
    if (filters.includeDeleted) params.set('includeDeleted', 'true');
    return params;
  }

  const pages = pageList(ctx, listHost, query, '명', (people) => recordTable([
      { label: '대상자명', render: (p) => h('div', { class: 'record-person' },
        action(p.name, () => showDetail(p), 'record-person-link'),
        p.introducerName ? h('small', { class: 'muted', text: '인도자 ' + p.introducerName }) : null) },
      { label: '식별번호', key: 'code' }, { label: '구역', render: districtLabel }, { label: '반', key: 'className' },
      { label: '단계', render: (p) => p.stageId ? badge(stageLabel[p.stageId] || p.stageId, 'record-stage') : '—' },
      { label: '담당자', key: 'worker' },
      { label: '찾은 날짜', render: (p) => [p.dateUnknown ? '미기록' : p.foundDate, p.foundTime].filter(Boolean).join(' ') },
      { label: '분류1', key: 'classification1' }, { label: '분류2', key: 'classification2' },
      { label: '상태', render: (p) => h('span', {}, badge(STATUS_LABEL[p.status] || p.status, p.status === 'active' ? 'ok' : 'error'),
        p.deleted ? badge('삭제됨', 'warn') : null) },
      { label: '연락처', render: (p) => (p.hasPhone ? `***-${p.phoneLast4}` : '') },
      ...(canWrite ? [{ label: '관리', render: rowActions }] : []),
    ], people, '대상자 목록', '조건에 맞는 대상자가 없습니다.', (p) => canWrite && !p.deleted ? showForm(p) : showDetail(p)), '대상자 목록');
  const load = pages.load;

  function rowActions(p) {
    const box = h('div', { class: 'actions' });
    if (p.deleted) {
      box.append(h('button', { class: 'btn small', type: 'button', text: '삭제 취소', onclick: run(ctx, () => ctx.api.post(`${base(ctx)}/items/${p.id}/undelete?rowVersion=${p.rowVersion}`), '복구했습니다.', load) }));
      return box;
    }
    box.append(
      h('button', { class: 'btn small', type: 'button', text: '수정', onclick: () => showForm(p) }),
      h('button', { class: 'btn small', type: 'button', text: '연락처', onclick: () => showPhone(p) }),
      h('button', { class: 'btn small', type: 'button', text: '단계 이동', onclick: () => showStage(p) }),
      p.status === 'active'
        ? h('button', { class: 'btn small', type: 'button', text: '탈락', onclick: () => showLifecycle(p, 'dropout', '탈락') })
        : h('button', { class: 'btn small', type: 'button', text: '복귀', onclick: () => showLifecycle(p, 'return', '복귀') }),
      h('button', {
        class: 'btn small danger', type: 'button', text: '삭제',
        onclick: () => confirmAction(`'${p.name}' 대상자를 삭제할까요? (이력에서 복구할 수 있습니다)`)
          && run(ctx, () => ctx.api.del(`${base(ctx)}/items/${p.id}?rowVersion=${p.rowVersion}`), '삭제했습니다.', load)(),
      }));
    return box;
  }

  function showDetail(p) {
    const hero = h('header', { class: 'record-detail-head' },
      h('span', { class: 'record-detail-avatar', 'aria-hidden': 'true', text: [...p.name][0] }),
      h('div', {}, h('h3', { text: p.name }), h('p', { class: 'muted', text: districtLabel(p) + (p.className ? ' · ' + p.className : '') })),
      h('div', { class: 'record-detail-badges' },
        p.stageId ? badge(stageLabel[p.stageId] || p.stageId, 'record-stage') : null,
        badge(STATUS_LABEL[p.status] || p.status, p.status === 'active' ? 'ok' : 'error'),
        p.deleted ? badge('삭제됨', 'warn') : null));
    const sections = PERSON_SECTIONS.map(({ title, fields }) => {
      const rows = fields.filter(({ key, type }) => !['name', 'className', 'notes', 'dateUnknown'].includes(key)
        && type !== 'employee' && p[key] !== undefined && p[key] !== null && p[key] !== '')
        .map(({ label, key, type }) => [
          label, type === 'json' ? JSON.stringify(p[key]) : key === 'foundDate' && p.dateUnknown ? '미기록' : String(p[key]),
        ]);
      if (title === '기본 정보' && p.hasPhone) rows.push(['연락처', `끝 네 자리 ${p.phoneLast4}`]);
      if (title === '찾은 정보' && p.dateUnknown && !p.foundDate) rows.unshift(['찾은 날짜', '미기록']);
      const notes = title === '메모·사용자 정의' && p.notes;
      return rows.length || notes ? h('section', { class: 'record-detail-section' }, h('h4', { text: title }),
        rows.length ? detailGrid(rows) : null, notes ? h('p', { class: 'record-detail-note', text: p.notes }) : null) : null;
    });
    const stages = detailTimeline(ctx, '단계의 여정', 'history', p.id, '단계 이동 기록이 없습니다.', (entry) => {
      const from = entry.fromValue ? (stageLabel[entry.fromValue] || entry.fromValue) + ' → ' : '';
      return h('article', { class: 'record-timeline-item' }, h('strong', { text: from + (stageLabel[entry.toValue] || entry.toValue || '단계 이동') }),
        h('p', { text: [businessTime(entry.effectiveAt), entry.actorName, entry.reason].filter(Boolean).join(' · ') }));
    }, 'STAGE');
    const activities = detailTimeline(ctx, '활동 기록', 'activities', p.id, '활동 기록이 없습니다.', (entry) =>
      h('article', { class: 'record-timeline-item' },
        h('strong', { text: [entry.date, entry.type, entry.minutes ? entry.minutes + '분' : ''].filter(Boolean).join(' · ') }),
        h('p', { text: [entry.worker, entry.place, entry.memo].filter(Boolean).join(' · ') })));
    const lifecycle = detailTimeline(ctx, '탈락 · 복귀 이력', 'history', p.id, '탈락이나 복귀 기록이 없습니다.', (entry) =>
      h('article', { class: 'record-timeline-item' },
        h('strong', { text: HISTORY_LABEL[entry.type] || STATUS_LABEL[entry.toValue] || '상태 변경' }),
        h('p', { text: [businessTime(entry.effectiveAt), entry.actorName, entry.reason].filter(Boolean).join(' · ') })), 'STATUS');
    editor.show(h('section', { class: 'record-form' }, hero, sections, stages, activities, lifecycle,
      h('div', { class: 'record-dialog-actions actions' },
        canWrite && !p.deleted ? action('대상자 수정', () => showForm(p), 'primary') : null,
        action('닫기', editor.close, '', { 'aria-label': '대상자 상세 닫기' }))));
  }

  function showForm(person) {
    const editing = Boolean(person);
    const { controls, nodes } = buildControls(ctx, options, person);
    const previousDistrict = editing ? districtKey(person) : '';
    const optionsForDistrict = editing && !districtOptions.some(([key]) => key === previousDistrict)
      ? [['', districtLabel(person)], ...districtOptions] : districtOptions;
    const district = select(optionsForDistrict, editing ? previousDistrict : districtOptions[0]?.[0]);
    const stage = select(options.stages.map((s) => [s, stageLabel[s] || s]), person?.stageId || options.stages[0], { disabled: editing });
    // 새 대상자 등록에서만 연락처를 받는다(저장 후에는 끝 네 자리만 보인다). 수정 폼에는 연락처 입력이 없다.
    const phone = editing ? null : h('input', { type: 'tel', autocomplete: 'off', maxlength: 30, placeholder: '010-0000-0000' });
    editor.show(h('section', { class: 'record-form' }, h('h3', { class: 'record-form-title', text: editing ? '대상자 수정' : '대상자 등록' }),
      h('div', { class: 'grid2' }, field('구역(지역+구역) *', district), field('단계 *', stage, editing ? '단계는 [단계 이동]으로 바꿉니다.' : ''),
        phone ? field('연락처', phone, '저장 후에는 끝 네 자리만 표시됩니다.') : null),
      nodes,
      h('div', { class: 'record-dialog-actions actions' }, h('button', {
        class: 'btn primary', type: 'button', text: '저장',
        onclick: run(ctx, async () => {
          const values = {};
          for (const [key, control] of Object.entries(controls)) values[key] = readControl(control);
          if (!values.name) throw new Error('이름: 필수 항목입니다.');
          const [regionCode, districtCode] = district.value.split('|');
          if (editing) {
            // 바뀐 필드만 보낸다(안 보낸 필드는 서버에서 그대로 유지된다). rowVersion 으로 동시 수정 충돌을 막는다.
            const patch = { rowVersion: person.rowVersion };
            for (const [key, control] of Object.entries(controls)) {
              if (!same(values[key], originalOf(control))) patch[key] = values[key];
            }
            if (district.value && district.value !== previousDistrict) { patch.regionCode = regionCode; patch.districtCode = districtCode; }
            if (Object.keys(patch).length === 1) { ctx.toast('바뀐 내용이 없습니다.', 'info'); return; }
            await ctx.api.put(`${base(ctx)}/items/${person.id}`, patch);
          } else {
            const body = { regionCode, districtCode, stageId: stage.value };
            for (const [key, value] of Object.entries(values)) {
              if (value !== null && value !== false) body[key] = value;
              if (key === 'dateUnknown' && value) body[key] = true;
            }
            if (phone && phone.value.trim()) body.phone = phone.value.trim();
            await ctx.api.post(`${base(ctx)}/items`, body);
            if (phone) phone.value = '';
          }
          editor.close();
        }, '저장했습니다.', load),
      }), action('취소', editor.close, ''))));
  }

  function showPhone(person) {
    // 현재 연락처 원문은 서버도 화면도 알려 주지 않는다. 새 번호를 입력해 바꾸거나 지울 수만 있다.
    const phone = h('input', { type: 'tel', autocomplete: 'off', maxlength: 30, placeholder: '새 번호 입력' });
    editor.show(h('section', { class: 'record-form' }, h('h3', { class: 'record-form-title', text: `연락처 변경 · ${person.name}` }),
      h('p', { class: 'muted', text: person.hasPhone ? `현재 등록됨(끝 네 자리 ${person.phoneLast4})` : '등록된 연락처 없음' }),
      field('새 연락처', phone, '서버에서 암호화해 저장하며 화면에는 끝 네 자리만 표시됩니다.'),
      h('div', { class: 'record-dialog-actions actions' },
        h('button', {
          class: 'btn primary', type: 'button', text: '변경',
          onclick: run(ctx, async () => {
            if (!phone.value.trim()) throw new Error('새 연락처를 입력해 주세요. 지우려면 [연락처 지우기]를 누르세요.');
            await ctx.api.put(`${base(ctx)}/items/${person.id}/phone`, { phone: phone.value.trim(), rowVersion: person.rowVersion });
            phone.value = '';
            editor.close();
          }, '연락처를 변경했습니다.', load),
        }),
        person.hasPhone ? h('button', {
          class: 'btn danger', type: 'button', text: '연락처 지우기',
          onclick: () => confirmAction('저장된 연락처를 지울까요?')
            && run(ctx, async () => { await ctx.api.put(`${base(ctx)}/items/${person.id}/phone`, { phone: null, rowVersion: person.rowVersion }); editor.close(); }, '연락처를 지웠습니다.', load)(),
        }) : null,
        action('취소', () => { phone.value = ''; editor.close(); }, ''))));
  }

  function showStage(person) {
    const stage = select(options.stages.filter((s) => s !== person.stageId).map((s) => [s, stageLabel[s] || s]), '');
    const day = h('input', { type: 'date', max: today(), value: today() });
    const time = h('input', { type: 'time' });
    const reason = h('input', { type: 'text', maxlength: 2000 });
    editor.show(h('section', { class: 'record-form' }, h('h3', { class: 'record-form-title', text: `단계 이동 · ${person.name}` }),
      h('p', { class: 'muted', text: '현재 ' + (stageLabel[person.stageId] || person.stageId || '단계 미기록') }),
      h('div', { class: 'grid2' }, field('이동할 단계', stage), field('적용일', day), field('적용 시각(선택, 한국 시간)', time), field('사유', reason)),
      h('div', { class: 'record-dialog-actions actions' }, h('button', {
        class: 'btn primary', type: 'button', text: '이동',
        onclick: run(ctx, async () => {
          await ctx.api.post(`${base(ctx)}/items/${person.id}/stage`, {
            stageId: stage.value, effectiveDate: day.value, effectiveTime: time.value || null, reason: reason.value, rowVersion: person.rowVersion,
          });
          editor.close();
        }, '단계를 이동했습니다.', load),
      }), action('취소', editor.close, ''))));
  }

  function showLifecycle(person, path, label) {
    const day = h('input', { type: 'date', max: today(), value: today() });
    const reason = h('input', { type: 'text', maxlength: 2000 });
    editor.show(h('section', { class: 'record-form' }, h('h3', { class: 'record-form-title', text: `${label} 등록 · ${person.name}` }),
      h('div', { class: 'grid2' }, field(`${label}일`, day), field('사유', reason)),
      h('div', { class: 'record-dialog-actions actions' }, h('button', {
        class: 'btn primary', type: 'button', text: label,
        onclick: run(ctx, async () => {
          await ctx.api.post(`${base(ctx)}/items/${person.id}/${path}`, { effectiveDate: day.value, reason: reason.value, rowVersion: person.rowVersion });
          editor.close();
        }, `${label} 처리했습니다.`, load),
      }), action('취소', editor.close, ''))));
  }

  const q = h('input', { type: 'search', placeholder: '이름·식별번호', maxlength: 100 });
  const stage = select([['', '전체 단계'], ...options.stages.map((s) => [s, stageLabel[s] || s])], '');
  const status = select([['', '전체 상태'], ['active', '진행'], ['dropped', '탈락']], '');
  const district = select([['', '전체 구역'], ...districtOptions], '');
  const last4 = h('input', { type: 'text', inputmode: 'numeric', maxlength: 4, pattern: '[0-9]{4}', placeholder: '연락처 끝 4자리', autocomplete: 'off' });
  const from = h('input', { type: 'date' });
  const to = h('input', { type: 'date' });
  const deleted = h('input', { type: 'checkbox' });
  const apply = () => {
    Object.assign(filters, { q: q.value.trim(), stageId: stage.value, status: status.value, district: district.value, phoneLast4: last4.value.trim(),
      foundFrom: from.value, foundTo: to.value, includeDeleted: deleted.checked });
    run(ctx, pages.reset)();
  };
  const detailed = h('details', { class: 'record-filter-more' },
    h('summary', { text: '상세 조건' }),
    h('div', { class: 'record-filter-grid' },
      field('구역', district), field('진행 상태', status), field('연락처 끝 4자리', last4),
      h('label', { class: 'record-filter-checkbox' }, deleted, '삭제 포함')));
  const filterForm = h('form', {
    class: 'panel record-filters', 'aria-label': '대상자 검색 조건',
    onsubmit: (event) => { event.preventDefault(); apply(); },
    onreset: () => {
      // 기본값 복원 뒤 조회해 날짜와 상세 조건까지 함께 초기화한다.
      setTimeout(apply, 0);
    },
  }, h('div', { class: 'record-filter-primary' },
    field('통합 검색', q), field('현재 단계', stage),
    h('div', { class: 'record-date-range', role: 'group', 'aria-label': '찾은 날짜 범위' },
      field('찾은 날짜(부터)', from), h('span', { 'aria-hidden': 'true', text: '—' }), field('찾은 날짜(까지)', to)),
    h('div', { class: 'actions' }, h('button', { class: 'btn primary', type: 'submit', text: '조회' }),
      h('button', { class: 'btn ghost', type: 'reset', text: '초기화' }))), detailed);
  addPageToolbar(root, [
    ctx.permissions.export ? h('button', {
      class: 'btn', type: 'button', text: '엑셀 내보내기',
      onclick: run(ctx, () => ctx.api.download(`${base(ctx)}/export/items.xlsx?${query()}`, 'people.xlsx')),
    }) : null,
    canWrite ? action('대상자 등록', () => showForm(null), 'primary') : null,
  ]);
  root.append(filterForm, listHost, editor.dialog);
  if (!districtOptions.length) root.prepend(notice('warn', '배정된 구역이 없어 표시할 자료가 없습니다. 관리자에게 구역 배정을 요청해 주세요.'));
  await load();
}

// ---------------------------------------------------------------- 활동 기록
const ACTIVITY_FIELDS = [
  { key: 'date', label: '활동일 *', type: 'date', future: false },
  { key: 'startTime', label: '시작 시각', type: 'time' },
  { key: 'endTime', label: '종료 시각', type: 'time' },
  { key: 'minutes', label: '활동 시간(분)', type: 'number', min: 0, max: 1440, hint: '비우면 시작·종료로 계산합니다.' },
  { key: 'type', label: '활동 종류 *', type: 'text', max: 100 },
  { key: 'code', label: '활동 코드', type: 'text', max: 60 },
  { key: 'worker', label: '활동자 이름', type: 'text', max: 100 },
  { key: 'workerId', label: '활동자 ID', type: 'text', max: 60 },
  { key: 'workerCode', label: '활동자 구성원ID', type: 'text', max: 60 },
  { key: 'className', label: '반', type: 'text', max: 60 },
  { key: 'classification2', label: '분류2', type: 'text', max: 20 },
  { key: 'place', label: '장소', type: 'text', max: 200 },
  { key: 'sessionKey', label: '세션', type: 'text', max: 100 },
];

async function mountActivities(ctx) {
  const root = ctx.container;
  root.classList.add('records-surface');
  const canWrite = ctx.permissions.write;
  const people = await ctx.api.get('/api/programs/people/items').catch(() => null);
  const options = await ctx.api.get(`${base(ctx)}/options`);
  const districtOptions = districtsAsOptions(options.districts);
  const districtLabel = labelDistrict(districtOptions);
  const personName = (id) => (people || []).find((p) => p.id === id)?.name || `대상자 #${id}`;
  const filters = { personId: '', standalone: '', district: '', from: '', to: '' };
  const editor = recordDialog('activities');
  const summaryHost = h('div');
  const listHost = h('div');

  function query() {
    const params = new URLSearchParams();
    if (filters.personId) params.set('personId', filters.personId);
    if (filters.standalone) params.set('standalone', filters.standalone);
    if (filters.from) params.set('from', filters.from);
    if (filters.to) params.set('to', filters.to);
    if (filters.district) {
      const [region, district] = filters.district.split('|');
      params.set('regionCode', region);
      params.set('districtCode', district);
    }
    return params;
  }

  const pages = pageList(ctx, listHost, query, '건', (activities) => recordTable([
      { label: '날짜', key: 'date' },
      { label: '활동자 · 조직', render: (a) => h('div', { class: 'record-person' },
        action(a.worker || a.workerCode || '활동자 미기록', () => showDetail(a), 'record-person-link'),
        h('small', { class: 'muted', text: districtLabel(a) + (a.className ? ' · ' + a.className : '') })) },
      { label: '활동 장소', key: 'place' },
      { label: '시간', render: (a) => [a.startTime, a.endTime].filter(Boolean).join('–') + (a.minutes ? ` (${a.minutes}분)` : '') },
      { label: '활동 종류', render: (a) => a.type ? badge(a.type, 'record-stage') : '—' },
      { label: '활동 메모', key: 'memo' }, { label: '분류2', key: 'classification2' },
      { label: '대상자', render: (a) => (a.standalone ? badge('독립 활동', 'warn') : personName(a.personId)) },
      { label: '세션', key: 'sessionKey' },
      ...(canWrite ? [{ label: '관리', render: (a) => h('div', { class: 'actions' },
        h('button', { class: 'btn small', type: 'button', text: '수정', onclick: () => showForm(a) }),
        h('button', {
          class: 'btn small danger', type: 'button', text: '삭제',
          onclick: () => confirmAction('이 활동 기록을 삭제할까요?') && run(ctx, () => ctx.api.del(`${base(ctx)}/items/${a.id}?rowVersion=${a.rowVersion}`), '삭제했습니다.', load)(),
        })) }] : []),
    ], activities, '활동 목록', '조건에 맞는 활동 기록이 없습니다.', showDetail), '활동 목록');
  let summaryRequest = 0;
  async function load(reset = false) {
    const id = ++summaryRequest;
    const [summary] = await Promise.all([ctx.api.get(`${base(ctx)}/summary?${query()}`), reset ? pages.reset() : pages.load()]);
    if (id !== summaryRequest) return;
    clear(summaryHost).append(h('div', { class: 'record-activity-metrics' },
      [['대상자 활동', summary.personActivities], ['독립 활동', summary.standaloneActivities]].map(([label, metric]) =>
        h('article', { class: 'panel record-metric-card' }, h('h3', { text: label }),
          h('strong', { text: metric.count.toLocaleString('ko-KR') }, h('small', { text: '건' })),
          h('p', { class: 'muted', text: '활동 시간 ' + metric.minutes.toLocaleString('ko-KR') + '분' })))));
  }

  function showDetail(activity) {
    const entries = [['대상자', activity.standalone ? '독립 활동' : personName(activity.personId)], ['구역', districtLabel(activity)],
      ...ACTIVITY_FIELDS.filter(({ key }) => activity[key] !== undefined && activity[key] !== null && activity[key] !== '')
        .map(({ key, label }) => [label.replace(' *', ''), activity[key]])];
    editor.show(h('section', { class: 'record-form' }, h('header', { class: 'record-detail-head' },
      h('span', { class: 'record-detail-avatar', 'aria-hidden': 'true', text: '활' }),
      h('div', {}, h('h3', { text: '활동 상세' }), h('p', { class: 'muted', text: [activity.date, activity.type].filter(Boolean).join(' · ') }))),
      detailGrid(entries), activity.memo ? h('p', { class: 'record-detail-note', text: activity.memo }) : null,
      h('div', { class: 'record-dialog-actions actions' }, canWrite ? action('활동 수정', () => showForm(activity), 'primary') : null,
        action('닫기', editor.close, '', { 'aria-label': '활동 상세 닫기' }))));
  }

  function showForm(activity) {
    const editing = Boolean(activity);
    const controls = {};
    const items = [];
    for (const spec of ACTIVITY_FIELDS) {
      const current = activity ? activity[spec.key] : undefined;
      const input = h('input', { type: spec.type, value: current ?? (spec.key === 'date' ? today() : ''), maxlength: spec.max, min: spec.min,
        max: spec.type === 'date' && spec.future === false ? today() : spec.type === 'number' ? spec.max : undefined });
      controls[spec.key] = { spec, input, original: current };
      items.push(field(spec.label, input, spec.hint));
    }
    const memo = h('textarea', { maxlength: 5000, text: activity?.memo || '' });
    const person = select([['', '대상자 없음(독립 활동)'], ...(people || []).map((p) => [p.id, `${p.name}${p.code ? ` (${p.code})` : ''}`])], activity?.personId || '', { disabled: editing });
    const district = select(districtOptions, activity?.regionCode ? `${activity.regionCode}|${activity.districtCode}` : districtOptions[0]?.[0], { disabled: editing });
    editor.show(h('section', { class: 'record-form' }, h('h3', { class: 'record-form-title', text: editing ? '활동 수정' : '활동 등록' }),
      h('div', { class: 'grid2' }, field('대상자', person, editing ? '대상자 연결은 바꿀 수 없습니다.' : '대상자를 고르지 않으면 독립 활동으로 저장됩니다.'),
        field('구역(독립 활동)', district, '대상자를 고르면 대상자의 구역이 쓰입니다.'), items),
      field('메모', memo),
      h('div', { class: 'record-dialog-actions actions' }, h('button', {
        class: 'btn primary', type: 'button', text: '저장',
        onclick: run(ctx, async () => {
          const values = {};
          for (const [key, control] of Object.entries(controls)) values[key] = readControl(control);
          values.memo = memo.value.trim() === '' ? null : memo.value.trim();
          if (editing) {
            const patch = { rowVersion: activity.rowVersion };
            for (const [key, value] of Object.entries(values)) {
              const original = key === 'memo' ? activity.memo ?? null : originalOf(controls[key]);
              if (!same(value, original === '' ? null : original)) patch[key] = value;
            }
            if (Object.keys(patch).length === 1) { ctx.toast('바뀐 내용이 없습니다.', 'info'); return; }
            await ctx.api.put(`${base(ctx)}/items/${activity.id}`, patch);
          } else {
            const body = {};
            for (const [key, value] of Object.entries(values)) if (value !== null) body[key] = value;
            if (person.value) body.personId = person.value;
            else {
              const [regionCode, districtCode] = district.value.split('|');
              body.regionCode = regionCode;
              body.districtCode = districtCode;
            }
            await ctx.api.post(`${base(ctx)}/items`, body);
          }
          editor.close();
        }, '저장했습니다.', load),
      }), action('취소', editor.close, ''))));
  }

  const personFilter = select([['', '전체 대상자'], ...(people || []).map((p) => [p.id, p.name])], '');
  const kind = select([['', '전체'], ['false', '대상자 활동'], ['true', '독립 활동']], '');
  const from = h('input', { type: 'date' });
  const to = h('input', { type: 'date' });
  const districtFilter = select([['', '전체 구역'], ...districtOptions], '');
  const apply = () => {
    Object.assign(filters, { personId: personFilter.value, standalone: kind.value, district: districtFilter.value, from: from.value, to: to.value });
    run(ctx, () => load(true))();
  };
  addPageToolbar(root, [canWrite ? action('활동 등록', () => showForm(null), 'primary') : null]);
  root.append(h('form', { class: 'panel record-filters', 'aria-label': '활동 조회 조건',
    onsubmit: (event) => { event.preventDefault(); apply(); },
    onreset: () => setTimeout(apply, 0),
  }, h('div', { class: 'record-filter-primary' },
    field('대상자', personFilter), field('구분', kind), field('구역', districtFilter),
    h('div', { class: 'record-date-range', role: 'group', 'aria-label': '활동 날짜 범위' },
      field('시작일', from), h('span', { 'aria-hidden': 'true', text: '—' }), field('종료일', to)),
    h('div', { class: 'actions' }, h('button', { class: 'btn primary', type: 'submit', text: '조회' }),
      h('button', { class: 'btn ghost', type: 'reset', text: '초기화' })))));
  if (canWrite && people === null) root.append(notice('warn', '대상자 목록을 읽을 권한이 없어 대상자 활동을 연결할 수 없습니다(독립 활동은 등록할 수 있습니다).'));
  root.append(summaryHost, listHost, editor.dialog);
  await load();
}

// ---------------------------------------------------------------- 변경 이력
async function mountHistory(ctx) {
  const host = h('div');
  const options = await ctx.api.get(`${base(ctx)}/options`);
  const districtLabel = labelDistrict(districtsAsOptions(options.districts));
  const personFilter = h('input', { type: 'text', inputmode: 'numeric', placeholder: '대상자 번호(선택)', maxlength: 19 });
  const from = h('input', { type: 'date' });
  const to = h('input', { type: 'date' });
  const kind = select([['', '전체'], ...Object.entries(KIND_LABEL)], '');
  let filter = new URLSearchParams();
  const pages = pageList(ctx, host, () => new URLSearchParams(filter), '건', (entries) => table([
      { label: '기록 시각', render: (e) => seoul(e.recordedAt) },
      { label: '적용 시각', render: (e) => businessTime(e.effectiveAt) + (e.timeUnknown ? ' (시각 미상)' : '') },
      { label: '구분', render: (e) => KIND_LABEL[e.kind] || e.kind },
      { label: '종류', render: (e) => HISTORY_LABEL[e.type] || e.type }, { label: '구역', render: districtLabel },
      { label: '대상자', key: 'personId' }, { label: '이전', key: 'fromValue' }, { label: '이후', key: 'toValue' },
      { label: '사유', key: 'reason' }, { label: '처리자', key: 'actorName' },
    ], entries));
  const apply = run(ctx, () => {
    filter = new URLSearchParams(Object.entries({ personId: personFilter.value.trim(), from: from.value, to: to.value, kind: kind.value }).filter(([, value]) => value));
    return pages.reset();
  });
  ctx.container.append(h('div', { class: 'panel' }, h('div', { class: 'row' }, field('대상자 번호', personFilter),
    field('구분', kind), field('시작일', from), field('종료일', to), h('button', { class: 'btn', type: 'button', text: '조회', onclick: apply }))), host);
  await pages.load();
}

// ---------------------------------------------------------------- 단계 이동 분석
async function mountStages(ctx) {
  const from = h('input', { type: 'date' });
  const to = h('input', { type: 'date' });
  const host = h('div');
  async function load() {
    const params = new URLSearchParams();
    if (from.value) params.set('from', from.value);
    if (to.value) params.set('to', to.value);
    const summary = await ctx.api.get(`${base(ctx)}/summary?${params}`);
    clear(host).append(h('p', { text: `단계 이동 ${summary.total}건` }), table([
      { label: '이동', key: 'name' }, { label: '건수', key: 'count' },
    ], Object.entries(summary.transitions).map(([name, count]) => ({ name, count }))));
  }
  ctx.container.append(h('div', { class: 'panel' }, h('div', { class: 'row' }, field('시작일', from), field('종료일', to),
    h('button', { class: 'btn', type: 'button', text: '조회', onclick: run(ctx, load) }))), host);
  await load();
}
