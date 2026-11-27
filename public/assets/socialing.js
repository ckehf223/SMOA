import { formDialog, getJson, h, sendJson, toast } from './common.js';
import { dateError, download, errorLine, field, fillSelect, latestOnly, liveSearch, num, pager, periodPicker, personNameLink, plainDialog, rate, selectOf, today } from './calling.js';

/** 소셜링 관리·소셜링 통계 화면. 모임은 관리자만 편집하고, 외부유입은 담당 구역 안에서 다룬다. */

const UNASSIGNED = '__unassigned__';
const STATUS_OPTIONS = [
  { value: 'pending', label: '외부유입' },
  { value: 'linked', label: '찾B 이후' },
  { value: 'dropped', label: '탈락' },
  { value: 'reported', label: '일보 기록' },
];

const programOptions = (programs) => [...programs.map((p) => ({ value: p.id, label: p.name })), { value: UNASSIGNED, label: '모임 미지정' }];

function filterRow({ state, controls, onApply, onReset }) {
  return h('form', { class: 'toolbar', role: 'search', onsubmit: (e) => { e.preventDefault(); onApply(); } },
    controls,
    h('div', { class: 'actions' },
      h('button', { type: 'submit' }, '조회'),
      h('button', { type: 'reset', class: 'secondary', onclick: () => { Object.keys(state).forEach((k) => { state[k] = k === 'page' ? 1 : ''; }); setTimeout(onReset); } }, '초기화')));
}

// ───────── 소셜링 관리 ─────────

async function socialingManage(box, me) {
  const perm = me.perms.socialingManage;
  const canEditPrograms = me.isAdmin && perm.write;
  const state = { search: '', from: '', to: '', programId: '', status: '', page: 1 };
  const results = h('div');
  let programs = [];
  let regions = me.districts.map((d) => d.name);

  const searchInput = h('input', { type: 'search', name: 'search', maxlength: '200', placeholder: '대상자명, 인도자, 구역 등 검색' });
  const fromInput = h('input', { type: 'date', name: 'from' });
  const toInput = h('input', { type: 'date', name: 'to' });
  const programSelect = selectOf('programId', programOptions([]), '', '전체 모임');
  const statusSelect = selectOf('status', STATUS_OPTIONS, '', '전체 상태');
  const applyFilters = () => {
    search.cancel();
    Object.assign(state, { search: searchInput.value.trim(), from: fromInput.value, to: toInput.value, programId: programSelect.value, status: statusSelect.value, page: 1 });
    load();
  };
  const search = liveSearch({ me, view: 'socialingManage', input: searchInput, state, apply: applyFilters });
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
      const data = await getJson(`/api/socialing/roster?${qs}`);
      if (!latest.current(mine)) return;
      search.remember(state.search);
      period.update(data.period);
      state.page = data.page;
      programs = data.programs;
      regions = [...new Set([...me.districts.map((d) => d.name), ...data.regions])];
      state.programId = fillSelect(programSelect, programOptions(programs), state.programId, '전체 모임');
      results.replaceChildren(table(data));
    } catch (err) {
      if (latest.current(mine)) results.replaceChildren(errorLine(err));
    }
  }

  function table(data) {
    if (!data.items.length) {
      return h('div', { class: 'card empty' }, params().size ? '검색 조건에 맞는 소셜링 기록이 없습니다.' : '등록된 소셜링 기록이 없습니다. 외부유입 등록에서 첫 기록을 추가하세요.');
    }
    const head = ['이름', '모임', '유입일', '찾은 날짜', '현재 단계', '구역', '인도자'];
    return h('section', null,
      h('h2', null, '소셜링 명단'),
      h('p', { class: 'note' }, '외부유입으로 등록한 뒤 찾B로 전환하면 찾기와 목표 실적에 반영됩니다.'),
      h('div', { class: 'table-wrap', tabindex: '0', role: 'region', 'aria-label': '소셜링 명단' },
        h('table', null,
          h('thead', null, h('tr', null, head.map((t) => h('th', { scope: 'col' }, t)), perm.write ? h('th', { scope: 'col' }, '관리') : null)),
          h('tbody', null, data.items.map((r) => h('tr', null,
            h('td', { class: 'strong' }, personNameLink(me, r.personId, r.name, load)),
            h('td', null, r.programName || '모임 미지정'),
            h('td', null, r.date || '—'),
            h('td', null, r.foundDate || '—'),
            h('td', null, r.stage || '—', r.status === 'dropped' ? h('span', { class: 'pill off' }, '탈락') : null),
            h('td', null, r.region || '—'),
            h('td', null, r.worker || '—'),
            perm.write ? h('td', null, actions(r)) : null))))),
      pager(data, (page) => { state.page = page; load(); }));
  }

  function actions(r) {
    if (r.status === 'pending') {
      return h('div', { class: 'row-actions' },
        h('button', { type: 'button', onclick: () => promoteForm(r) }, '찾B 전환'),
        h('button', { type: 'button', class: 'secondary', onclick: () => intakeForm(r) }, '수정'),
        h('button', { type: 'button', class: 'danger', onclick: () => removeIntake(r) }, '삭제'));
    }
    if (r.personId) return h('button', { type: 'button', class: 'secondary', onclick: () => intakeForm(r) }, '모임·유입일 수정');
    return h('span', { class: 'note' }, '일보 기록');
  }

  // ── 외부유입 ──

  function introducerPicker(rec) {
    const known = new Map();
    if (rec?.introducerId) known.set(rec.introducerId, { id: rec.introducerId, name: rec.worker || '현재 인도자', region: rec.region });
    const select = h('select', { name: 'introducerId' });
    const search = h('input', { type: 'search', maxlength: '100', placeholder: '인도자 이름 검색', autocomplete: 'off' });
    let ticket = 0;
    let timer;
    const show = () => {
      const current = select.value || rec?.introducerId || '';
      select.replaceChildren(h('option', { value: '' }, '인도자 없음'),
        ...[...known.values()].map((m) => h('option', { value: m.id }, [m.name, m.region].filter(Boolean).join(' · '))));
      select.value = known.has(current) ? current : '';
    };
    async function find() {
      const mine = ++ticket;
      try {
        const data = await getJson(`/api/socialing/introducers?${new URLSearchParams({ search: search.value.trim() })}`);
        if (mine !== ticket) return;
        const selected = known.get(select.value);
        known.clear();
        for (const m of data.items) known.set(m.id, m);
        if (selected) known.set(selected.id, selected);
        show();
      } catch {
        /* 목록을 읽지 못해도 현재 선택은 유지한다. */
      }
    }
    search.addEventListener('input', () => { ticket++; clearTimeout(timer); timer = setTimeout(find, 175); });
    show();
    find();
    return [field('인도자 검색', search), field('인도자', select)];
  }

  function intakeForm(rec) {
    const linked = Boolean(rec?.personId);
    const programChoices = programs.map((p) => ({ value: p.id, label: p.name }));
    const program = h('select', { name: 'programId', required: true });
    program.replaceChildren(h('option', { value: '' }, '모임 선택'), ...programChoices.map((o) => h('option', { value: o.value }, o.label)));
    program.value = programChoices.some((o) => o.value === (rec?.programId ?? state.programId)) ? (rec?.programId ?? state.programId) : '';
    const date = h('input', { type: 'date', name: 'date', value: rec ? rec.date : today(), required: !linked });
    const regionList = h('datalist', { id: 'social-regions' }, regions.map((v) => h('option', { value: v })));
    const body = linked
      ? [field('모임 *', program), field('외부유입일', date)]
      : [
        field('대상자명 *', h('input', { type: 'text', name: 'name', value: rec?.name ?? '', required: true, maxlength: '100' })),
        field('모임 *', program),
        field('외부유입일 *', date),
        field('구역', h('input', { type: 'text', name: 'region', value: rec?.region ?? '', maxlength: '60', list: 'social-regions' })),
        regionList,
        introducerPicker(rec),
        field('메모', h('textarea', { name: 'notes', maxlength: '10000', value: rec?.notes ?? '' }), 'wide'),
      ];
    formDialog({
      title: linked ? `${rec.name} 모임과 유입일` : rec ? '외부유입 수정' : '외부유입 등록',
      body: h('div', { class: 'form-grid' },
        !linked && !me.isAdmin ? h('p', { class: 'note wide' }, '구역은 담당 구역 이름과 같아야 저장할 수 있습니다. 비워 두면 인도자의 구역을 사용합니다.') : null,
        body),
      onSubmit: async (fd) => {
        const f = Object.fromEntries(fd);
        const input = linked
          ? { personId: rec.personId, programId: f.programId, date: f.date ?? '' }
          : { programId: f.programId, date: f.date, name: f.name, region: f.region ?? '', introducerId: f.introducerId ?? '', notes: f.notes ?? '', requestId: crypto.randomUUID() };
        if (rec?.id) {
          delete input.requestId;
          await sendJson('PUT', `/api/socialing/intakes/${encodeURIComponent(rec.id)}`, input);
        } else {
          await sendJson('POST', '/api/socialing/intakes', input);
        }
        toast('저장했습니다.');
        load();
      },
    });
  }

  function removeIntake(r) {
    formDialog({
      title: '외부유입 삭제',
      body: h('p', null, `${r.name}님의 외부유입 기록을 삭제할까요?`),
      submitLabel: '삭제',
      onSubmit: async () => {
        await sendJson('DELETE', `/api/socialing/intakes/${encodeURIComponent(r.id)}`);
        toast('삭제했습니다.');
        load();
      },
    });
  }

  async function promoteForm(r) {
    let data;
    try {
      data = await getJson(`/api/socialing/intakes/${encodeURIComponent(r.id)}/candidates`);
    } catch (err) {
      toast(err.message, 'error');
      return;
    }
    const people = new Map(data.items.map((p) => [p.id, p]));
    const personSelect = h('select', { name: 'personId' },
      h('option', { value: '' }, '찾B 대상자 새로 등록'),
      data.items.map((p) => h('option', { value: p.id }, [p.name, p.region, p.date, p.code].filter(Boolean).join(' · '))));
    const dateInput = h('input', { type: 'date', name: 'date', required: true, min: data.intakeDate, value: data.intakeDate > today() ? data.intakeDate : today() });
    const fallbackDate = dateInput.value;
    personSelect.addEventListener('change', () => {
      const p = people.get(personSelect.value);
      dateInput.disabled = Boolean(p);
      dateInput.value = p ? p.date : fallbackDate;
    });
    formDialog({
      title: `${r.name} 찾B 전환`,
      submitLabel: '찾B로 전환',
      body: h('div', { class: 'form-grid' },
        field('대상자 연결', personSelect, 'wide'),
        field('찾은 날짜 *', dateInput, 'wide'),
        h('p', { class: 'note wide' }, '이미 등록된 소셜링 대상자를 선택하면 기존 찾은 날짜와 단계 이력을 이어서 사용합니다.')),
      onSubmit: async (fd) => {
        await sendJson('POST', `/api/socialing/intakes/${encodeURIComponent(r.id)}/promote`, { personId: fd.get('personId') ?? '', date: fd.get('personId') ? '' : (fd.get('date') ?? '') });
        toast('찾B 전환을 저장했습니다.');
        load();
      },
    });
  }

  // ── 모임 ──

  function catalog() {
    const dialog = plainDialog('소셜링 모임 관리',
      programs.length
        ? h('ul', null, programs.map((p) => h('li', null, h('strong', null, p.name),
          canEditPrograms ? h('button', { type: 'button', class: 'link', 'aria-label': `${p.name} 이름 수정`, onclick: () => { dialog.close(); programForm(p); } }, '이름 수정') : null)))
        : h('p', { class: 'empty' }, '등록된 모임이 없습니다.'),
      [
        !canEditPrograms ? h('p', { class: 'note' }, '모임 등록·수정은 관리자만 할 수 있습니다.') : null,
        h('button', { type: 'button', class: 'secondary', onclick: () => dialog.close() }, '닫기'),
        canEditPrograms ? h('button', { type: 'button', onclick: () => { dialog.close(); programForm(null); } }, '모임 추가') : null,
      ]);
  }

  function programForm(program) {
    formDialog({
      title: program ? '모임 이름 수정' : '소셜링 모임 추가',
      body: field('모임 이름', h('input', { type: 'text', name: 'name', value: program?.name ?? '', required: true, maxlength: '100' })),
      onSubmit: async (fd) => {
        await sendJson(program ? 'PUT' : 'POST', program ? `/api/socialing/programs/${encodeURIComponent(program.id)}` : '/api/socialing/programs', { name: fd.get('name') });
        toast('저장했습니다.');
        await load();
        catalog();
      },
    });
  }

  const form = filterRow({
    state,
    controls: [field('검색', searchInput), field('시작일', fromInput), field('종료일', toInput), period.element, field('모임', programSelect), field('진행상태', statusSelect)],
    onApply: applyFilters,
    onReset: () => { search.cancel(); load(); },
  });

  box.append(
    h('div', { class: 'toolbar' }, h('h1', null, '소셜링 관리'), h('span', { class: 'spacer' }),
      h('div', { class: 'actions' },
        h('button', { type: 'button', class: 'secondary', onclick: catalog }, '모임 관리'),
        perm.export ? h('button', { type: 'button', class: 'secondary', onclick: () => download('GET', `/api/socialing/roster/export?${params()}`, undefined, 'smoa-socialing-roster.xlsx') }, '명단 엑셀') : null,
        perm.write ? h('button', { type: 'button', onclick: () => intakeForm(null) }, '외부유입 등록') : null)),
    h('div', { class: 'card' }, form),
    results);
  await load();
}

// ───────── 소셜링 통계 ─────────

async function socialingStats(box, me) {
  const perm = me.perms.socialingStats;
  const now = today();
  const state = { from: `${now.slice(0, 7)}-01`, to: now, programId: '', region: '' };
  const results = h('div');

  const fromInput = h('input', { type: 'date', name: 'from', value: state.from });
  const toInput = h('input', { type: 'date', name: 'to', value: state.to });
  const programSelect = selectOf('programId', programOptions([]), '', '전체 모임');
  const regionSelect = selectOf('region', [], '', '전체 구역');
  const applyFilters = () => {
    Object.assign(state, { from: fromInput.value, to: toInput.value, programId: programSelect.value, region: regionSelect.value });
    load();
  };
  const period = periodPicker({ fromInput, toInput, apply: applyFilters });
  const params = () => new URLSearchParams(Object.entries(state).filter(([, v]) => v));

  async function load() {
    const problem = dateError(state.from, state.to);
    if (problem) return results.replaceChildren(h('p', { class: 'status error', role: 'alert' }, problem));
    try {
      const d = await getJson(`/api/socialing/stats?${params()}`);
      period.update(d.period);
      state.programId = fillSelect(programSelect, programOptions(d.programs), state.programId, '전체 모임');
      const names = [...new Set([...me.districts.map((x) => x.name), ...d.regions, state.region].filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ko', { numeric: true }));
      state.region = fillSelect(regionSelect, names.map((n) => ({ value: n, label: n })), state.region, '전체 구역');
      results.replaceChildren(view(d));
    } catch (err) {
      results.replaceChildren(errorLine(err));
    }
  }

  /* 원본 socialing.js socialingStatsHTML: 기간 지표 4칸 → 모임별 표 → 월별 표. 숫자 칸은 오른쪽 정렬이다. */

  /** 첫 칸은 행 머리글, 나머지는 숫자 칸. rows: [[머리글, ...숫자 문자열]] */
  function statTable(id, label, headers, rows) {
    return h('div', { class: 'table-scroll', role: 'region', 'aria-label': label, tabindex: '0' },
      h('table', { id },
        h('thead', null, h('tr', null, headers.map((text, i) => h('th', { scope: 'col', class: i ? 'numeric' : null }, text)))),
        h('tbody', null, rows.map(([head, ...values]) => h('tr', null,
          h('th', { scope: 'row' }, head),
          values.map((value) => h('td', { class: 'numeric' }, value)))))));
  }

  function statPanel(title, description, content) {
    const id = `socialing-${title === '월별 실적' ? 'monthly' : 'programs'}-heading`;
    return h('section', { class: 'panel social-panel', 'aria-labelledby': id },
      h('div', { class: 'panel-head' }, h('div', null, h('h2', { id }, title), h('p', null, description))),
      content);
  }

  function view({ totals, groups, trend }) {
    const cards = [
      ['신규 외부유입', num(totals.inflows), '명', '유입일 기준'],
      ['찾B 실적', num(totals.findings), '건', '찾은 날짜 기준'],
      ['찾A 실적', num(totals.findAs), '건', '최초 찾A 도달일 기준'],
      ['유입 → 찾B 전환율', rate(totals.conversionRate), '', `조회 기간 유입 ${num(totals.inflows)}명 중 전환 ${num(totals.converted)}명`],
    ];
    return h('div', { id: 'socialing-stats', class: 'social-stats status-page' },
      h('section', { class: 'metrics social-summary', 'aria-label': '소셜링 기간 지표' },
        cards.map(([title, value, unit, foot]) => h('article', { class: 'metric' },
          h('div', { class: 'metric-head' }, title),
          h('div', { class: 'metric-value' }, value, unit ? h('small', null, unit) : null),
          h('div', { class: 'metric-foot' }, foot)))),
      statPanel('모임별 유입과 전환', '전환율은 조회 기간에 유입된 사람 중 현재까지 찾B에 도달한 비율입니다. 찾B·찾A 실적은 각 단계의 날짜로 집계합니다.',
        groups.length
          ? statTable('socialing-program-results', '모임별 유입과 전환', ['모임', '신규 유입', '유입 중 전환', '미전환', '전환율', '찾B 실적', '찾A 실적'],
            groups.map((g) => [g.programName, num(g.inflows), num(g.converted), num(g.pending), rate(g.conversionRate), num(g.findings), num(g.findAs)]))
          : h('div', { class: 'empty' }, '모임별로 집계할 기록이 없습니다.')),
      statPanel('월별 실적', '조회 기간에 유입, 찾B, 찾A가 기록된 달을 표시합니다.',
        trend.length
          ? statTable('socialing-monthly', '월별 실적', ['월', '신규 유입', '찾B', '찾A'], trend.map((t) => [t.month, num(t.inflows), num(t.findings), num(t.findAs)]))
          : h('div', { class: 'empty' }, '선택 기간에 유입·찾B·찾A 기록이 없습니다.')));
  }

  const form = filterRow({
    state,
    controls: [field('시작일', fromInput), field('종료일', toInput), period.element, field('모임', programSelect), field('구역', regionSelect)],
    onApply: applyFilters,
    onReset: load,
  });

  box.append(
    h('div', { class: 'toolbar' }, h('h1', null, '소셜링 데이터현황'), h('span', { class: 'spacer' }),
      h('div', { class: 'actions' },
        perm.export ? h('button', { type: 'button', class: 'secondary', onclick: () => download('GET', `/api/socialing/stats/export?${params()}`, undefined, 'smoa-socialing-stats.xlsx') }, '통계 엑셀') : null)),
    h('div', { class: 'card' }, form),
    results);
  await load();
}

export const socialingViews = { socialingManage, socialingStats };
