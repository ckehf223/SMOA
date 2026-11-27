import { clear, confirmAction, errorMessage, field, h, notice, select, table } from '../js/ui.js';

const BASE = '/api/programs/callingSheet';
const SORT_LABELS = {
  id: '번호', foundDate: '찾기일', callStatus: '콜링 상태', callResult: '콜링 결과', targetName: '대상자',
  introducerName: '인도자', district: '구역', assignedUserName: '콜링 담당',
  manpikConfirmedAt: '만픽 확정 날짜', createdAt: '등록일', updatedAt: '수정일',
};
const DISTRICT_SEPARATOR = '\u001f';
const short = (key, label, width) => ({ key, label, width });
const button = (label, action, cls = 'btn') => h('button', { type: 'button', class: cls, text: label, onclick: action });
const input = (type = 'text', attrs = {}) => h('input', { type, ...attrs });
const named = (value) => value?.trim() || null;
const pair = (region, district) => [region, district].join(DISTRICT_SEPARATOR);
const displayPhone = (row) => row.phoneLast4 ? `•••• ${row.phoneLast4}` : (row.hasPhone ? '저장됨' : '');
const displayName = (round) => round?.callerName || round?.callerUserId || '';

function parameters(values) {
  return new URLSearchParams(Object.entries(values).filter(([, value]) => value !== '' && value !== false && value != null));
}

function dayInKorea() {
  const parts = new Intl.DateTimeFormat('sv-SE', { dateStyle: 'short', timeZone: 'Asia/Seoul' });
  return parts.format(new Date());
}

function choice(values, empty, current = '') {
  return select([['', empty], ...values], current);
}

function sheetTable(columns, rows, emptyText) {
  const head = h('thead', {}, h('tr', {}, columns.map(({ label, width }) =>
    h('th', { text: label, scope: 'col', 'data-width': width }))));
  const body = h('tbody');
  for (const row of rows) {
    body.append(h('tr', {}, columns.map(({ key, label, render, width }, index) => {
      const value = render ? render(row) : row[key];
      return h(index === 0 ? 'th' : 'td', { scope: index === 0 ? 'row' : null,
        'data-label': label, 'data-width': width }, value == null || value === ''
        ? h('span', { class: 'muted', text: '—' }) : h('div', { class: 'calling-sheet-cell' }, value));
    })));
  }
  if (!rows.length) body.append(h('tr', {}, h('td', {
    colspan: columns.length, class: 'calling-sheet-empty muted', text: emptyText,
  })));
  return h('div', { class: 'calling-sheet-scroll', role: 'region',
    'aria-label': '콜링시트 조회 결과', tabindex: 0 },
  h('table', { class: 'data calling-sheet-grid' }, head, body));
}

export async function mount(ctx) {
  const root = ctx.container;
  root.classList.add('calling-sheet-module');
  if (!document.querySelector('link[href="/assets/css/calling-sheet.css"]')) {
    document.head.append(h('link', { rel: 'stylesheet', href: '/assets/css/calling-sheet.css' }));
  }
  root.append(notice('info', '콜링시트 설정을 불러오는 중입니다.'));
  const opts = await ctx.api.get(`${BASE}/options`);
  if (!root.isConnected) return;

  const nameCounts = new Map();
  for (const { name } of opts.districts) nameCounts.set(name, (nameCounts.get(name) || 0) + 1);
  const districts = opts.districts.map((d) => [pair(d.regionCode, d.districtCode),
    nameCounts.get(d.name) > 1 ? `${d.name} (${d.regionCode})` : d.name]);
  const districtNames = new Map(districts);
  const districtName = (r) => r.districtCode ? districtNames.get(pair(r.regionCode, r.districtCode)) ?? r.districtCode : '미지정';
  const accounts = (opts.accounts || []).map(({ id, name }) => [id, name]);
  const accountChoices = (current, empty = '미연결') => choice(
    current && !accounts.some(([id]) => id === current) ? [...accounts, [current, '기존 연결']] : accounts, empty, current);
  const listHost = h('div');
  const editorHost = h('div');
  const viewButtons = new Map();
  const controls = {
    q: input('search', { placeholder: '대상자·인도자·담당·특이사항', maxlength: 100 }),
    district: choice(districts, '전체'),
    callStatus: input('text', { maxlength: 60, list: 'calling-sheet-statuses' }),
    callResult: input('text', { maxlength: 100, list: 'calling-sheet-results' }),
    foundFrom: input('date'), foundTo: input('date'), createdFrom: input('date'),
    assignedUserId: accountChoices(null, '전체'),
    assigned: choice([['none', '미지정'], ['any', '지정됨']], '전체'),
    manpik: choice([['any', '있음'], ['none', '없음']], '전체'),
    roundCode: input('text', { maxlength: 30, list: 'calling-sheet-rounds', placeholder: '예) 1' }),
    roundState: select([['has', '담당 있음'], ['none', '담당 없음']], 'has'),
    phoneLast4: input('text', { inputmode: 'numeric', maxlength: 4, pattern: '[0-9]{4}', autocomplete: 'off' }),
    sort: select(opts.sortKeys.map((key) => [key, SORT_LABELS[key] || key]), 'foundDate'),
    dir: select([['desc', '내림차순'], ['asc', '오름차순']], 'desc'),
    trash: input('checkbox'),
  };

  const mainViews = [
    { label: '콜링시트' }, { label: '신규건', values: () => ({ createdFrom: dayInKorea() }) },
    { label: '미지정건', values: { assigned: 'none' } }, { label: '만픽건', values: { manpik: 'any' } },
    { label: '차트', mode: 'chart' }, { label: 'Table', mode: 'table' },
  ];
  const districtViews = districts.map(([district, label]) => ({ label, values: { district } }));
  const roundViews = opts.defaultRounds.map(({ code, label }) => ({ label: `${label}콜링`, values: { roundCode: code } }));
  let activeView = mainViews[0];
  let page = 1;
  let request = 0;
  let applied = {};

  function readFilters() {
    const values = {};
    for (const [key, control] of Object.entries(controls)) {
      values[key] = control.type === 'checkbox' ? control.checked : control.value.trim();
    }
    const [regionCode, districtCode] = values.district.split(DISTRICT_SEPARATOR);
    delete values.district;
    if (districtCode) Object.assign(values, { regionCode, districtCode });
    if (!values.roundCode) delete values.roundState;
    return values;
  }

  function apply() {
    if (filterDetails.querySelector(':invalid')) filterDetails.open = true;
    if (!filters.reportValidity()) return;
    applied = readFilters();
    page = 1;
    void load();
  }

  function activate(view) {
    activeView = view;
    if (!view.mode) {
      filters.reset();
      controls.sort.value = 'foundDate';
      const values = typeof view.values === 'function' ? view.values() : view.values || {};
      for (const [key, value] of Object.entries(values)) controls[key].value = value;
    }
    for (const [view, tab] of viewButtons) tab.setAttribute('aria-pressed', String(view === activeView));
    apply();
  }

  function viewGroup(title, views, showTitle = true) {
    if (!views.length) return null;
    return h('div', { class: 'calling-sheet-view-group' },
      showTitle ? h('span', { class: 'calling-sheet-view-label', text: title }) : null,
      h('div', { class: 'calling-sheet-view-tabs', role: 'group', 'aria-label': title },
        views.map((view) => {
          const tab = button(view.label, () => activate(view), 'btn small');
          viewButtons.set(view, tab);
          return tab;
        })));
  }

  const basicFields = [
    ['검색', 'q'], ['구역', 'district'], ['콜링 상태', 'callStatus'], ['콜링 결과', 'callResult'],
  ];
  const advancedFields = [
    ['찾기일 시작', 'foundFrom'], ['찾기일 종료', 'foundTo'], ['등록일 시작', 'createdFrom'],
    ...(accounts.length ? [['콜링 담당 계정', 'assignedUserId']] : []), ['콜링 담당', 'assigned'],
    ['만픽 확정', 'manpik'], ['회차 코드', 'roundCode'], ['회차 담당', 'roundState'], ['연락처 끝 4자리', 'phoneLast4'],
    ['정렬 기준', 'sort'], ['정렬 방향', 'dir'],
  ];
  const filterDetails = h('details', { class: 'calling-sheet-more-filters' },
    h('summary', { text: '상세 조건·정렬' }), h('div', { class: 'calling-sheet-advanced-fields' },
      advancedFields.map(([label, key]) => field(label, controls[key]))));
  const filters = h('form', { class: 'panel calling-sheet-filters', novalidate: true,
    onsubmit: (event) => { event.preventDefault(); apply(); } },
    h('div', { class: 'calling-sheet-basic-fields' }, basicFields.map(([label, key]) => field(label, controls[key]))),
    filterDetails,
    h('div', { class: 'row calling-sheet-filter-actions' }, h('button', { type: 'submit', class: 'btn primary', text: '조회' }),
      button('초기화', () => activate(mainViews[0])),
      opts.canWrite ? h('label', { class: 'calling-sheet-trash' }, controls.trash, ' 휴지통만 조회') : null,
      opts.canExport ? button('엑셀 내보내기', () => guarded(async () => {
        await ctx.api.download(`${BASE}/export/items.xlsx?${parameters(applied)}`, '콜링시트.xlsx');
      })) : null,
      opts.canWrite ? button('대상자 등록', (event) => {
        editorTrigger = event.currentTarget;
        showEditor(null);
      }, 'btn primary') : null));
  const listOptions = (id, values) => h('datalist', { id }, values.map((value) => h('option', { value })));
  let editorTrigger = null;
  clear(root).append(h('nav', { class: 'panel calling-sheet-views', 'aria-label': '콜링시트 보기' },
    viewGroup('기본 보기', mainViews, false), viewGroup('구역', districtViews), viewGroup('회차', roundViews)),
    filters, editorHost, listHost,
    listOptions('calling-sheet-statuses', opts.statuses), listOptions('calling-sheet-results', opts.results),
    listOptions('calling-sheet-rounds', opts.defaultRounds.map(({ code }) => code)));

  async function guarded(operation, host = null) {
    try {
      await operation();
    } catch (err) {
      if (host) clear(host).append(notice('error', errorMessage(err)));
      else ctx.toast(errorMessage(err), 'error');
    }
  }

  async function load() {
    const token = ++request;
    const query = parameters({ ...applied, page, size: 25 });
    const chart = activeView.mode === 'chart';
    clear(listHost).append(notice('info', '조회 중입니다.'));
    try {
      const result = await ctx.api.get(`${BASE}/${chart ? 'stats' : 'items'}?${query}`);
      if (token !== request || !root.isConnected) return;
      if (chart) renderStats(result);
      else if (page > 1 && !result.items.length) {
        page = Math.min(page - 1, Math.max(1, Math.ceil(result.total / result.size)));
        await load();
      } else renderList(result);
    } catch (err) {
      if (token === request && root.isConnected) clear(listHost).append(notice('error', errorMessage(err)));
    }
  }

  function renderStats(stats) {
    const panels = [
      ['콜링 상태', stats.byStatus.map(({ key, count }) => [key || '미기재', count])],
      ['콜링 결과', stats.byResult.map(({ key, count }) => [key || '미기재', count])],
      ['구역', stats.byDistrict.map((d) => [districtName(d), d.count])],
    ];
    clear(listHost).append(h('p', { text: `전체 ${stats.total}건 · 담당 미지정 ${stats.unassigned}건 · 만픽 확정 ${stats.manpik}건` }),
      h('div', { class: 'grid2' }, panels.map(([title, rows]) => {
        const chartRows = rows.map(([label, count]) => ({ label, count }));
        return h('section', { class: 'panel' }, h('h3', { text: title }), table([
          short('label', '항목'), short('count', '건수'),
          { label: '비율', render: ({ count }) => h('progress', { value: count, max: Math.max(1, stats.total), 'aria-label': `전체 ${stats.total}건 중 ${count}건` }) },
        ], chartRows));
      })));
  }

  const primary = [
    { label: '대상자', width: 'name', render: (r) => button(r.targetName, (event) => {
      editorTrigger = event.currentTarget;
      void showDetail(r);
    }, 'calling-sheet-target-button') },
    short('callStatus', '콜링 상태'), short('foundDate', '찾기일', 'date'), short('callResult', '콜링 결과', 'text'),
    short('introducerName', '인도자'), { label: '연락처', width: 'date', render: displayPhone },
    { label: '구역', width: 'text', render: districtName },
  ];
  const extra = [
    short('sexCode', '성별', 'number'), short('ageText', '나이', 'number'), short('residence', '거주지', 'text'),
    short('preferredPlace', '선호 장소', 'text'), short('notes', '특이사항', 'long'),
    short('consultTopic', '컨설팅 주제', 'long'), short('manpikConfirmedAt', '만픽 확정 날짜', 'date'),
    short('manpikInfo', '만픽 정보', 'long'),
    ...opts.defaultRounds.map(({ code, label }) => ({ label: `${label} 콜링자`, render: (r) => displayName(r.rounds.find((round) => round.code === code)) })),
  ];

  function renderList(result) {
    const columns = [...primary, ...(activeView.mode === 'table' ? [] : extra), short('assignedUserName', '콜링 담당')];
    const pageCount = Math.max(1, Math.ceil(result.total / result.size));
    const before = button('이전', () => { page -= 1; void load(); }, 'btn small');
    const after = button('다음', () => { page += 1; void load(); }, 'btn small');
    before.disabled = page <= 1;
    after.disabled = page >= pageCount;
    const narrowed = Object.entries(applied).some(([key, value]) => key !== 'sort' && key !== 'dir' && Boolean(value));
    const emptyText = applied.trash ? '휴지통에서 조회 조건에 맞는 항목이 없습니다.'
      : narrowed ? '조회 조건에 맞는 콜링시트가 없습니다.' : '콜링시트에 등록된 항목이 없습니다.';
    const first = result.total ? (page - 1) * result.size + 1 : 0;
    const last = result.total ? first + result.items.length - 1 : 0;
    const resultRange = result.total ? ` · ${first}~${last}번째` : '';
    clear(listHost).append(h('section', { class: 'panel calling-sheet-results', 'aria-label': '콜링시트 결과' },
      h('div', { class: 'list-summary calling-sheet-list-summary' },
        h('p', { role: 'status', text: `${activeView.label} · ${result.total.toLocaleString('ko-KR')}건${resultRange}` }),
        h('div', { class: 'row calling-sheet-pagination', 'aria-label': '페이지 이동' },
          before, h('span', { text: `${page} / ${pageCount}` }), after)),
      sheetTable(columns, result.items, emptyText)));
  }

  function closeEditor() {
    clear(editorHost);
    if (editorTrigger?.isConnected) editorTrigger.focus();
    editorTrigger = null;
  }

  function openEditor(title, ...body) {
    const section = h('section', { class: 'panel calling-sheet-editor', tabindex: '-1', 'aria-label': title },
      h('h3', { text: title }), body);
    clear(editorHost).append(section);
    section.focus();
  }

  async function showDetail(row) {
    const pending = notice('info', '상세 정보를 불러오는 중입니다.');
    openEditor('콜링시트 상세', pending, button('닫기', closeEditor));
    try {
      const r = await ctx.api.get(`${BASE}/items/${row.id}${row.deleted ? '?includeDeleted=true' : ''}`);
      if (!pending.isConnected) return;
      const details = opts.fields.filter(({ key }) => key !== 'regionCode' && key !== 'districtCode')
        .map(({ key, label }) => [label, r[key]]);
      details.push(['구역', districtName(r)], ['연락처', displayPhone(r)], ['등록일', r.createdAt], ['수정일', r.updatedAt]);
      const change = async (restore) => {
        if (!confirmAction(restore ? '이 자료를 복구하시겠습니까?' : '이 자료를 휴지통으로 이동하시겠습니까?')) return;
        await guarded(async () => {
          const version = `?rowVersion=${r.rowVersion}`;
          if (restore) await ctx.api.post(`${BASE}/items/${r.id}/undelete${version}`);
          else await ctx.api.del(`${BASE}/items/${r.id}${version}`);
          closeEditor();
          ctx.toast(restore ? '복구했습니다.' : '휴지통으로 이동했습니다.', 'success');
          await load();
        });
      };
      openEditor(`${r.targetName} 상세`, h('dl', { class: 'grid2' }, details.map(([label, value]) => h('div', {},
        h('dt', { class: 'field-label', text: label }), h('dd', { text: value || '—' })))),
      table([short('label', '회차'), { label: '콜링자', render: displayName }], r.rounds, '지정한 회차가 없습니다.'),
      h('div', { class: 'row' },
        opts.canWrite && !r.deleted ? button('수정', () => showEditor(r), 'btn primary') : null,
        opts.canWrite ? button(r.deleted ? '복구' : '삭제', () => change(r.deleted), r.deleted ? 'btn' : 'btn danger') : null,
        button('닫기', closeEditor)));
    } catch (err) {
      if (pending.isConnected) pending.replaceWith(notice('error', errorMessage(err)));
    }
  }

  function lookup(endpoint, current, setName) {
    const term = input('search', { maxlength: 100, placeholder: '이름 검색' });
    const results = choice([], '미연결');
    const status = h('div', { role: 'status' });
    let matches = new Map();
    let token = 0;
    function setChoices(rows, value) {
      matches = new Map(rows.map((r) => [r.id, r]));
      const choices = rows.map((r) => [r.id, `${r.name} · ${districtName(r)} · #${r.id}`]);
      if (value && !matches.has(value)) choices.unshift([value, `기존 연결 #${value}`]);
      results.replaceChildren(...choice(choices, '미연결', value).children);
      results.value = value || '';
    }
    setChoices([], current);
    const search = async () => {
      const sequence = ++token;
      try {
        const rows = await ctx.api.get(`${BASE}/${endpoint}?${parameters({ q: term.value, limit: 30 })}`);
        if (sequence !== token || !results.isConnected) return;
        setChoices(rows, results.value);
        status.textContent = rows.length ? `${rows.length}건` : '일치하는 자료가 없습니다.';
      } catch (err) {
        if (sequence === token) clear(status).append(notice('error', errorMessage(err)));
      }
    };
    term.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); void search(); }
    });
    results.addEventListener('change', () => {
      const item = matches.get(results.value);
      if (item) setName(item.name);
    });
    return { results, search: h('div', { class: 'row' }, term, button('찾기', search, 'btn small'), status) };
  }

  function showEditor(record) {
    const editing = record != null;
    const previous = record || {};
    const messages = h('div', { role: 'status' });
    const excluded = new Set(['targetId', 'introducerId', 'regionCode', 'districtCode', 'assignedUserId']);
    const fields = new Map();
    for (const { key, kind, max } of opts.fields.filter(({ key }) => !excluded.has(key))) {
      const value = previous[key] ?? '';
      fields.set(key, kind === 'TEXT' ? h('textarea', { rows: 3, maxlength: max, text: value })
        : input({ DATE: 'date', DATETIME: 'datetime-local' }[kind] || 'text', {
          value, maxlength: max, step: kind === 'DATETIME' ? 1 : null, required: key === 'targetName',
          list: { callStatus: 'calling-sheet-statuses', callResult: 'calling-sheet-results' }[key],
        }));
    }
    const target = lookup('targets', previous.targetId, (name) => {
      if (!fields.get('targetName').value.trim()) fields.get('targetName').value = name;
    });
    const introducer = lookup('members', previous.introducerId, (name) => {
      if (!fields.get('introducerName').value.trim()) fields.get('introducerName').value = name;
    });
    const district = choice(districts, opts.unassignedAllowed ? '미지정' : '구역 선택',
      previous.districtCode ? pair(previous.regionCode, previous.districtCode) : '');
    district.required = !opts.unassignedAllowed;
    const assignee = accountChoices(previous.assignedUserId);
    assignee.addEventListener('change', () => {
      if (assignee.value && !fields.get('assignedUserName').value.trim()) {
        fields.get('assignedUserName').value = accounts.find(([id]) => id === assignee.value)?.[1] || '';
      }
    });
    const phone = input('tel', { maxlength: 40, autocomplete: 'off', disabled: !opts.contactKeyAvailable });
    const erasePhone = input('checkbox');
    erasePhone.addEventListener('change', () => { phone.disabled = erasePhone.checked || !opts.contactKeyAvailable; });
    const roundHost = h('div');
    const roundEditors = new Map();
    const oldRounds = new Map((previous.rounds || []).map((r) => [r.code, r]));
    const defaultCodes = new Set(opts.defaultRounds.map(({ code }) => code));
    function addRound(code, label, old = {}) {
      const name = input('text', { value: old.callerName || '', maxlength: 100 });
      const actor = accountChoices(old.callerUserId);
      const title = input('text', { value: label, maxlength: 60 });
      actor.addEventListener('change', () => {
        if (actor.value && !name.value.trim()) name.value = accounts.find(([id]) => id === actor.value)?.[1] || '';
      });
      const box = h('fieldset', {}, h('legend', { text: `회차 ${code}` }),
        h('div', { class: 'grid2' }, field('회차 이름', title), field('콜링자', name), field('계정 연결', actor)),
        !defaultCodes.has(code) ? button('회차 제거', () => { roundEditors.delete(code); box.remove(); }, 'btn small') : null);
      roundEditors.set(code, { name, actor, title });
      roundHost.append(box);
    }
    for (const { code, label } of opts.defaultRounds) addRound(code, oldRounds.get(code)?.label ?? label, oldRounds.get(code));
    for (const [code, old] of oldRounds) if (!defaultCodes.has(code)) addRound(code, old.label, old);
    const roundCode = input('text', { maxlength: 30, placeholder: '추가 회차 코드', 'aria-label': '추가 회차 코드' });
    const appendRound = () => {
      const code = roundCode.value.trim();
      clear(messages);
      if (!/^[0-9a-zA-Z_\-\p{Script=Hangul}]{1,30}$/u.test(code) || roundEditors.has(code)) {
        messages.append(notice('error', '회차 코드는 중복 없이 영문·숫자·한글·_- 30자 이내로 입력하세요.'));
        return;
      }
      addRound(code, code);
      roundCode.value = '';
    };
    const submit = h('button', { type: 'submit', class: 'btn primary', text: '저장' });
    const form = h('form', { onsubmit: async (event) => {
      event.preventDefault();
      submit.disabled = true;
      clear(messages);
      await guarded(async () => {
        const [regionCode, districtCode] = district.value.split(DISTRICT_SEPARATOR);
        const body = {
          ...Object.fromEntries(Array.from(fields, ([key, control]) => [key, named(control.value)])),
          regionCode: regionCode || null, districtCode: districtCode || null,
          targetId: target.results.value || null, introducerId: introducer.results.value || null,
          assignedUserId: assignee.value || null,
        };
        if (editing) {
          for (const key of Object.keys(body)) if ((previous[key] || null) === body[key]) delete body[key];
          body.rowVersion = record.rowVersion;
        }
        if (erasePhone.checked) body.phone = null;
        else if (phone.value.trim()) body.phone = phone.value.trim();
        const rounds = [];
        for (const [code, controls] of roundEditors) {
          const callerName = named(controls.name.value);
          const callerUserId = controls.actor.value || null;
          const label = named(controls.title.value);
          const old = oldRounds.get(code);
          if (callerName || callerUserId) {
            if (!old || old.label !== label || (old.callerName || null) !== callerName || old.callerUserId !== callerUserId) {
              rounds.push({ code, label, callerName, callerUserId });
            }
          } else if (old) rounds.push({ code, remove: true });
        }
        for (const [code] of oldRounds) if (!roundEditors.has(code)) rounds.push({ code, remove: true });
        if (rounds.length) body.rounds = rounds;
        if (editing) await ctx.api.patch(`${BASE}/items/${record.id}`, body);
        else await ctx.api.post(`${BASE}/items`, body);
        phone.value = '';
        closeEditor();
        ctx.toast('저장했습니다.', 'success');
        if (applied.trash) activate(mainViews[0]);
        else await load();
      }, messages);
      submit.disabled = false;
    } }, messages,
    h('div', { class: 'grid2' },
      field('구역', district), ...opts.fields.filter(({ key }) => fields.has(key)).map(({ key, label }) => field(label, fields.get(key))),
      field('콜링 담당 계정 연결', assignee),
      field('새 연락처', phone, opts.contactKeyAvailable ? (displayPhone(previous) || '암호화해 저장합니다.') : '연락처 암호화 키가 필요합니다.'),
      editing && previous.hasPhone ? field('저장한 연락처 삭제', erasePhone) : null),
    h('details', {}, h('summary', { text: '대상자·인도자 연결' }),
      h('div', { class: 'grid2' }, target.search, field('대상자 선택', target.results), introducer.search, field('인도자 선택', introducer.results))),
    h('details', {}, h('summary', { text: '회차별 콜링자' }), roundHost,
      h('div', { class: 'row' }, roundCode, button('회차 추가', appendRound))),
    h('div', { class: 'row' }, submit, button('취소', () => { phone.value = ''; closeEditor(); })));
    openEditor(editing ? '콜링시트 수정' : '콜링시트 대상자 등록', form);
  }

  activate(mainViews[0]);
}
