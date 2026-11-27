import { clear, confirmAction, errorMessage, field, h, notice, select, table } from '../js/ui.js';
import { ApiError, refreshCsrf } from '../js/api.js';

const manage = '/api/programs/callingManage';
const integer = new Intl.NumberFormat('ko-KR');
const number = (n) => integer.format(n ?? 0);
const rate = (n, digits = 1) => Number.isFinite(n) ? n.toFixed(digits) + '%' : '—';
const lagDays = (n) => Number.isFinite(n) ? new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 1 }).format(n) + '일' : '—';
const seoulDay = (now = Date.now()) => new Date(now + 9 * 3600 * 1000).toISOString().slice(0, 10);
const composite = (d) => [d.regionCode, d.districtCode].join('|');
const empty = (label) => [['', label]];
const button = (label, onclick, style = '', attrs = {}) =>
  h('button', { type: 'button', class: ('btn ' + style).trim(), text: label, onclick, ...attrs });

const iconPaths = {
  activity: 'M3 12h4l3-8 4 16 3-8h4',
  target: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0',
  flow: 'M4 5h5v5H4z M15 14h5v5h-5z M9 7h8v7 M14 11l3 3 3-3',
  clock: 'M12 8v4l3 2 M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0',
  download: 'M12 3v12 M7 10l5 5 5-5 M4 16v5h16v-5',
  upload: 'M12 16V4 M7 9l5-5 5 5 M4 16v5h16v-5',
  plus: 'M12 5v14 M5 12h14',
};

function icon(name) {
  const namespace = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(namespace, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'calling-icon');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(namespace, 'path');
  path.setAttribute('d', iconPaths[name]);
  svg.append(path);
  return svg;
}

function actionButton(label, glyph, onclick, style = '') {
  const action = button(label, onclick, ('calling-icon-button ' + style).trim());
  action.prepend(icon(glyph));
  return action;
}

function callingTable(columns, rows, label, { rowHeader = 0, emptyText } = {}) {
  const wrap = table(columns, rows, emptyText);
  wrap.tabIndex = 0;
  wrap.setAttribute('role', 'region');
  wrap.setAttribute('aria-label', label);
  const headings = wrap.querySelectorAll('thead th');
  headings.forEach((heading, i) => {
    heading.scope = 'col';
    if (columns[i].numeric) heading.classList.add('calling-numeric');
  });
  if (!rows.length) return wrap;
  for (const row of wrap.querySelectorAll('tbody tr')) {
    Array.from(row.cells).forEach((cell, i) => {
      if (columns[i].numeric) cell.classList.add('calling-numeric');
      if (i === rowHeader) {
        const heading = h('th', { scope: 'row' }, Array.from(cell.childNodes));
        cell.replaceWith(heading);
      }
    });
  }
  return wrap;
}

function openEditor(host, title, form, focus) {
  const opener = document.activeElement;
  const dialog = h('dialog', { class: 'panel calling-dialog', 'aria-labelledby': 'calling-dialog-title' },
    h('header', { class: 'calling-dialog-head' }, h('h2', { id: 'calling-dialog-title', text: title })),
    form);
  dialog.addEventListener('close', () => {
    dialog.remove();
    if (opener?.isConnected) opener.focus();
  }, { once: true });
  clear(host).append(dialog);
  dialog.showModal();
  focus.focus();
}

function run(ctx, task) {
  return async () => {
    try { await task(); }
    catch (error) { ctx.toast(errorMessage(error), 'error'); }
  };
}

async function copyText(value) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const area = h('textarea', { class: 'calling-copy-source', 'aria-label': '복사할 텍스트', text: value });
  document.body.append(area);
  area.select();
  const copied = document.execCommand('copy');
  area.remove();
  if (!copied) throw new Error('복사를 완료하지 못했습니다.');
}

function presetDates(key, options) {
  const day = options.today || seoulDay();
  if (key === 'today') return [day, day];
  if (key === 'month') return [day.slice(0, 7) + '-01', day];
  if (key === 'week') {
    const local = new Date(day + 'T00:00:00Z');
    local.setUTCDate(local.getUTCDate() - (local.getUTCDay() - (options.weekStart ?? 0) + 7) % 7);
    return [local.toISOString().slice(0, 10), day];
  }
  return ['', ''];
}

function buildFilters(options, isStats, submit) {
  const search = h('input', { type: 'search', maxlength: 200, placeholder: '대상자명, 인도자, 특이사항 등 검색' });
  const from = h('input', { type: 'date', 'aria-label': '시작일' });
  const to = h('input', { type: 'date', 'aria-label': '종료일' });
  const caller = select([...empty('전체 콜링자'), ...options.callers], '');
  const district = select([...empty('전체 구역'), ...options.districts.map(d => [composite(d), d.name])], '');
  const round = isStats ? select([...empty('전체 차수'), ...options.rounds.map(r => [r.value, r.label])], '') : null;
  let active = 'all';
  const periods = [['today', '오늘'], ['week', '금주'], ['month', '금월'], ['all', '전체']];
  const setPeriod = (key) => {
    active = key;
    for (const el of presets.children) el.setAttribute('aria-pressed', String(el.dataset.period === active));
  };
  const presets = h('div', { class: 'actions calling-periods', role: 'group', 'aria-label': '조회 기간 빠른 선택' }, periods.map(([key, label]) =>
    button(label, () => {
      const [start, end] = presetDates(key, options);
      from.value = start;
      to.value = end;
      setPeriod(key);
      submit();
    }, 'small', { 'data-period': key, 'aria-pressed': String(key === active) })));
  for (const el of [from, to]) el.addEventListener('change', () => setPeriod(''));
  const form = h('form', { class: 'panel calling-filters', 'aria-label': '콜링 조회 조건', onsubmit: (event) => {
    event.preventDefault();
    submit();
  } },
  h('div', { class: 'calling-filter-fields' },
    h('label', { class: 'field calling-filter-search' }, h('span', { class: 'field-label', text: '검색' }), search),
    h('fieldset', { class: 'calling-filter-dates' }, h('legend', { class: 'field-label', text: '조회 기간' }),
      h('div', { class: 'calling-date-range' }, from, h('span', { 'aria-hidden': 'true', text: '—' }), to)),
    field('콜링자', caller), field('구역', district), round ? field('차수', round) : null,
    h('button', { type: 'submit', class: 'btn primary', text: '조회' })),
  h('div', { class: 'calling-filter-foot' }, presets, button('초기화', () => {
    search.value = from.value = to.value = caller.value = district.value = '';
    if (round) round.value = '';
    setPeriod('all');
    submit();
  }, 'small ghost')));
  return { form, caller, query() {
    const params = new URLSearchParams();
    const [regionCode, districtCode] = district.value.split('|');
    Object.entries({ search: search.value.trim(), from: from.value, to: to.value, caller: caller.value,
      round: round?.value, regionCode, districtCode }).forEach(([key, value]) => {
      if (value) params.set(key, value);
    });
    return params;
  } };
}

function roundColumns(digits = 1) {
  return [{ key: 'roundLabel', label: '차수' }, ...countColumns(digits)];
}

function countColumns(digits, successLabel = '연결') {
  return [
    { label: '콜링 건수', numeric: true, render: (row) => number(row.count) },
    { label: successLabel + ' 건수', numeric: true, render: (row) => number(row.successes) },
    { label: successLabel + '률', numeric: true, render: (row) => h('span', { class: 'calling-rate', text: rate(row.rate, digits) }) },
  ];
}

function periodLabel(from, to) {
  if (from && to) return from === to ? from : from + ' ~ ' + to;
  if (from) return from + '부터';
  if (to) return to + '까지';
  return '전체 기간';
}

function pageFoot(offset, limit, total, load) {
  const first = total ? offset + 1 : 0;
  const last = Math.min(offset + limit, total);
  const page = Math.floor(offset / limit) + 1;
  const pages = Math.max(1, Math.ceil(total / limit));
  const links = [1, page - 1, page, page + 1, pages].filter((n, i, all) => n >= 1 && n <= pages && all.indexOf(n) === i)
    .sort((a, b) => a - b);
  const jump = (next) => load((next - 1) * limit);
  return h('div', { class: 'list-summary' },
    h('p', { class: 'muted', role: 'status', text: '전체 ' + number(total) + '건' +
      (total ? ' · ' + number(first) + '–' + number(last) : '') }),
    pages > 1 ? h('nav', { class: 'actions calling-pagination', 'aria-label': '목록 페이지' },
      button('‹', () => jump(page - 1), 'small', { disabled: page === 1, 'aria-label': '이전 페이지' }),
      links.flatMap((value, i) => [
        i && value - links[i - 1] > 1 ? h('span', { class: 'muted', 'aria-hidden': 'true', text: '…' }) : null,
        button(number(value), () => jump(value), value === page ? 'small primary' : 'small',
          { 'aria-current': value === page ? 'page' : undefined, 'aria-label': number(value) + '페이지' }),
      ]),
      button('›', () => jump(page + 1), 'small', { disabled: page === pages, 'aria-label': '다음 페이지' })) : null);
}

function reportPanel(ctx, summary, usedQuery) {
  const { totals, connected } = summary;
  const pairBox = h('div');
  function pairs(offset) {
    const size = 8;
    clear(pairBox).append(callingTable([
      { key: 'caller', label: '콜링자' }, { label: '인도자', render: (row) => row.introducer || '미입력' },
    ], connected.slice(offset, offset + size), '연결된 콜링자와 인도자',
    { emptyText: '조회 조건에 맞는 연결 기록이 없습니다.' }));
    if (connected.length > size) pairBox.append(pageFoot(offset, size, connected.length, pairs));
  }
  pairs(0);
  return h('section', { class: 'panel calling-panel', 'aria-labelledby': 'calling-report-title' },
    h('div', { class: 'calling-panel-head calling-report-head' },
      h('div', {}, h('h2', { id: 'calling-report-title', text: '콜링 전체 결과 보고' }),
        h('p', { class: 'muted', text: '조회 기간 ' + periodLabel(usedQuery.get('from'), usedQuery.get('to')) })),
      h('div', { class: 'actions' },
        h('strong', { class: 'calling-report-total', text: '총 ' + number(totals.count) + '건 중 ' + number(totals.successes) +
          '건 연결 (' + rate(totals.rate ?? 0, 0) + ')' }),
        button('결과 보고 복사', run(ctx, async () => {
          await copyText(summary.report);
          ctx.toast('콜링 결과 보고를 복사했습니다.', 'ok');
        }), 'small'),
        ctx.permissions.export ? button('결과 보고 엑셀', run(ctx, () =>
          ctx.api.download(manage + '/export/report.xlsx?' + usedQuery, 'SMOA-콜링-결과보고.xlsx')), 'small') : null)),
    h('div', { class: 'calling-report-grid' },
      h('section', {}, h('h3', { text: '차수별 연결 결과' }), callingTable(roundColumns(0), summary.byRound, '차수별 연결 결과')),
      h('section', {}, h('h3', { text: '연결된 콜링자·인도자' }), pairBox)));
}

function formMaker(ctx, options, host, record, afterSave) {
  const selected = h('input', { type: 'text', readonly: true, value: record?.personName || '' });
  const introducer = h('input', { type: 'text', readonly: true, value: record?.introducer || '' });
  const area = h('input', { type: 'text', readonly: true, value: record?.districtName || '' });
  const selectionStatus = h('p', { class: 'calling-target-name muted', role: 'status',
    text: record?.personUnlinked ? '대상자 미연결' : null });
  const lookup = h('input', { type: 'search', maxlength: 100, placeholder: '이름 또는 식별번호', autocomplete: 'off' });
  const results = h('div', { class: 'calling-target-results' });
  let target = null;
  let request = 0;
  const search = run(ctx, async () => {
    const id = ++request;
    clear(results).append(notice('info', '대상자를 조회하고 있습니다.'));
    const found = await ctx.api.get(manage + '/targets?' + new URLSearchParams({ q: lookup.value.trim() }));
    if (id !== request) return;
    clear(results).append(table([
      { key: 'name', label: '이름' }, { key: 'code', label: '식별번호' },
      { key: 'introducer', label: '인도자' }, { key: 'districtName', label: '구역' },
      { key: 'findingDate', label: '찾은 날짜' },
      { label: '선택', render: (row) => button('선택', () => {
        target = row;
        selected.value = [row.name, row.code].filter(Boolean).join(' · ');
        introducer.value = row.introducer || '';
        area.value = row.districtName || '';
        selectionStatus.textContent = (row.name || '대상자') + ' 선택';
        clear(results);
        selected.focus();
      }, 'small') },
    ], found, '조회한 대상자가 없습니다.'));
  });
  lookup.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); search(); }
  });
  const date = h('input', { type: 'date', value: record?.date || options.today || seoulDay(), required: true });
  const time = h('input', { type: 'time', step: 1, value: record?.time || '' });
  const caller = h('input', { type: 'text', value: record?.caller || '', maxlength: 100, required: true, list: 'calling-known-callers' });
  const roundLabels = [...new Set(['신규', ...options.rounds.map((item) => item.label), ...(record?.roundLabel ? [record.roundLabel] : [])])];
  const round = select([...roundLabels, ['', '직접 입력']], record?.roundLabel || '신규');
  const customRound = h('input', { type: 'text', maxlength: 60, placeholder: '예: 5차, 수능인원', disabled: true, required: true });
  const customField = field('직접 입력할 차수 *', customRound);
  customField.hidden = true;
  round.addEventListener('change', () => {
    const custom = round.value === '';
    customRound.disabled = !custom;
    customField.hidden = !custom;
    if (custom) customRound.focus();
  });
  const result = h('input', { type: 'text', value: record?.resultText || '', maxlength: 100, required: true, list: 'calling-known-results' });
  const notes = h('textarea', { maxlength: 5000, rows: 3, text: record?.notes || '' });
  const status = h('div');
  const submit = h('button', { class: 'btn primary', type: 'submit', text: record ? '수정 저장' : '콜링 기록 저장' });
  const form = h('form', { class: 'calling-editor', onsubmit: async (event) => {
    event.preventDefault();
    if (!record && !target) {
      clear(status).append(notice('warn', '대상자를 선택해 주세요.'));
      lookup.focus();
      return;
    }
    const body = { personId: target?.id, date: date.value, time: time.value, caller: caller.value, round: round.value || customRound.value,
      result: result.value, notes: notes.value, rowVersion: record?.rowVersion };
    submit.disabled = true;
    clear(status);
    try {
      if (record) await ctx.api.put(manage + '/items/' + encodeURIComponent(record.id), body);
      else await ctx.api.post(manage + '/items', body);
      form.closest('dialog').close();
      ctx.toast(record ? '콜링 기록을 수정했습니다.' : '콜링 기록을 추가했습니다.', 'ok');
      await afterSave();
    } catch (error) {
      clear(status).append(notice('error', errorMessage(error)));
    } finally {
      submit.disabled = false;
    }
  } },
    h('div', { class: 'calling-picker' },
      h('div', { class: 'row calling-picker-search' },
        field(record ? '대상자 변경' : '대상자 검색', lookup), button('대상자 조회', search)),
      results,
      field(record ? '대상자명' : '대상자명 *', selected),
      selectionStatus,
      h('div', { class: 'calling-field-grid' }, field('인도자', introducer), field('인도자구역', area))),
    h('div', { class: 'calling-field-grid' }, field('콜링날짜 *', date), field('콜링시간', time), field('콜링자 *', caller),
      field('차수 *', round), customField, field('콜링결과 *', result)),
    field('특이사항', notes),
    h('datalist', { id: 'calling-known-callers' }, options.callers.map(v => h('option', { value: v }))),
    h('datalist', { id: 'calling-known-results' }, options.results.map(v => h('option', { value: v }))),
    status, h('div', { class: 'actions calling-dialog-foot' }, button('취소', () => form.closest('dialog').close(), 'ghost'), submit));
  openEditor(host, record ? '콜링 기록 수정' : '콜링 기록 추가', form, lookup);
}

async function showTargetDetail(ctx, row) {
  const target = await ctx.api.get('/api/programs/people/items/' + encodeURIComponent(row.personId));
  const dialog = h('dialog', { class: 'panel calling-target-detail', 'aria-labelledby': 'calling-target-title' });
  const details = [
    ['식별번호', target.code], ['이름', target.name], ['성별', target.gender], ['나이', target.age],
    ['구역', row.districtName], ['인도자', target.introducerName || row.introducer], ['담당자', target.worker],
    ['단계', target.stageId], ['찾은 날짜', target.dateUnknown ? '미상' : target.foundDate],
    ['찾은 시간', target.foundTime], ['찾은 장소', target.place], ['사용 도구', target.tool],
  ];
  dialog.append(h('h2', { id: 'calling-target-title', text: '대상자 상세' }),
    h('dl', { class: 'detail' }, details.flatMap(([label, value]) => [h('dt', { text: label }), h('dd', { text: value ?? '—' })])),
    button('닫기', () => dialog.close()));
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  ctx.container.append(dialog);
  dialog.showModal();
}

function recordTable(ctx, rows, options, formHost, reload) {
  const targetRead = ctx.me.permissions.people?.read;
  const person = (row) => h('div', {},
    targetRead && row.personId && !row.personDeleted ? button(row.personName || '—',
      run(ctx, () => showTargetDetail(ctx, row)), 'small ghost calling-target-link') : h('strong', { text: row.personName || '—' }),
    row.personCode ? h('small', { class: 'muted calling-record-subline', text: row.personCode }) : null,
    row.personUnlinked ? h('small', { class: 'muted calling-record-subline', text: '대상자 미연결' }) : null,
    row.personDeleted ? h('small', { class: 'muted calling-record-subline', text: '기록 당시 정보' }) : null);
  const columns = [
    { key: 'introducer', label: '인도자' }, { key: 'districtName', label: '인도자구역' },
    { label: '대상자명', render: person }, { key: 'caller', label: '콜링자' },
    { key: 'date', label: '콜링날짜' }, { label: '콜링시간', render: (r) => r.time || h('span', { class: 'muted', text: '미입력' }) },
    { key: 'roundLabel', label: '차수' }, { label: '콜링결과', render: (r) =>
      h('div', { class: r.result === '만픽' ? 'calling-result-text calling-rate' : 'calling-result-text', text: r.resultText || r.result || '—' }) },
    { label: '특이사항', render: (r) => h('div', {
      class: 'calling-record-notes', text: r.notes || '—',
      tabindex: r.notes ? 0 : undefined, role: r.notes ? 'region' : undefined, 'aria-label': r.notes ? '특이사항' : undefined,
    }) },
  ];
  if (ctx.permissions.write) columns.push({ label: '관리', render: (row) =>
    h('div', { class: 'actions calling-row-actions' },
      button('수정', () => formMaker(ctx, options, formHost, row, reload), 'small ghost'),
      button('삭제', run(ctx, async () => {
        if (!confirmAction('이 콜링 기록을 삭제할까요?')) return;
        await ctx.api.del(manage + '/items/' + encodeURIComponent(row.id) + '?' + new URLSearchParams({ rowVersion: row.rowVersion }));
        ctx.toast('콜링 기록을 삭제했습니다.', 'ok');
        await reload();
      }), 'small danger')) });
  return callingTable(columns, rows, '콜링 기록', { rowHeader: 2,
    emptyText: '조회 조건에 맞는 콜링 기록이 없습니다.' });
}

async function uploadPreview(file, migration) {
  if (!file || file.size > 1000000 || !file.name.toLowerCase().endsWith('.xlsx')) {
    throw new Error('1MB 이하의 XLSX 파일을 선택해 주세요.');
  }
  const { header, token } = await refreshCsrf();
  const body = new FormData();
  body.set('file', file);
  const response = await fetch(manage + '/import/preview?migration=' + migration, {
    method: 'POST', credentials: 'same-origin', body, headers: { Accept: 'application/json', [header]: token },
  });
  if (response.status === 401) window.dispatchEvent(new CustomEvent('smoa:unauthorized'));
  if (!response.ok) {
    const failure = await response.json().catch(() => ({}));
    throw new ApiError(response.status, failure.code, failure.message || '엑셀을 읽지 못했습니다.');
  }
  return response.json();
}

function importEditor(ctx, mode, host, refresh) {
  const xlsx = mode !== 'report';
  const title = { normal: '엑셀 가져오기', migration: 'MIG 엑셀 가져오기', report: '콜링 일보 가져오기' }[mode];
  const source = xlsx ? h('input', { type: 'file', accept: '.xlsx', required: true })
    : h('textarea', { rows: 8, maxlength: 500000, placeholder: '콜링 배분 일보를 붙여넣으세요.', required: true });
  const date = xlsx ? null : h('input', { type: 'date' });
  const year = xlsx ? null : h('input', { type: 'text', inputmode: 'numeric', maxlength: 4, pattern: '[1-9][0-9]{3}' });
  const caller = xlsx ? null : h('input', { type: 'text', maxlength: 100 });
  const previewBox = h('div', { class: 'calling-preview', 'aria-live': 'polite' });
  const previewButton = h('button', { class: 'btn primary', type: 'submit', text: '미리보기' });
  const invalidate = () => clear(previewBox);
  for (const control of [source, date, year, caller].filter(Boolean)) {
    control.addEventListener(xlsx ? 'change' : 'input', invalidate);
  }
  function renderPreview(data) {
    const actions = h('div', { class: 'actions' });
    if (data.canApply) {
      const apply = button('콜링 기록 등록', async () => {
        if (!confirmAction(number(data.validCount) + '개의 콜링 기록을 등록할까요?')) return;
        apply.disabled = true;
        try {
          const result = await ctx.api.post(manage + '/import/apply', { token: data.token });
          previewBox.closest('dialog').close();
          ctx.toast('콜링 기록 ' + number(result.added) + '건을 등록했습니다. 중복 ' + number(result.skipped) + '건.', 'ok');
          await refresh();
        } catch (error) {
          clear(previewBox).append(notice('error', errorMessage(error)));
        }
      }, 'primary');
      actions.append(apply);
    }
    if (data.canExport) actions.append(button('일보 엑셀 저장', run(ctx, () =>
      ctx.api.download(manage + '/export/import/' + encodeURIComponent(data.token) + '.xlsx', 'SMOA-콜링-일보.xlsx'))));
    const errors = data.errors.map(e => h('li', { text: e.sheet + ' ' + e.row + '행 · ' + e.message }));
    const warnings = data.warnings.map(w => h('li', { text: w }));
    const figures = [
      ['전체', data.totalRows], ['등록 가능', data.validCount], ['중복', data.duplicateCount],
      ['미연결', data.unlinkedCount], ['오류', data.errorCount],
    ];
    clear(previewBox).append(...[
      h('h3', { text: '가져오기 미리보기' }),
      h('dl', { class: 'calling-preview-counts' }, figures.map(([label, count]) =>
        h('div', {}, h('dt', { text: label }), h('dd', { text: number(count) + '건' })))),
      errors.length ? h('div', { class: 'notice error' }, h('strong', { text: '확인이 필요한 행' }), h('ul', {}, errors)) : null,
      warnings.length ? h('div', { class: 'notice warn' }, h('strong', { text: '일보 표기와 상세 건수 확인' }), h('ul', {}, warnings)) : null,
      data.rows.length ? table([
        { key: 'personName', label: '대상자명' }, { key: 'introducer', label: '인도자' }, { key: 'districtName', label: '구역' },
        { key: 'caller', label: '콜링자' }, { key: 'date', label: '날짜' }, { key: 'time', label: '시간' },
        { key: 'roundLabel', label: '차수' }, { key: 'resultText', label: '결과' },
        { label: '특이사항', render: (r) => h('div', { class: 'calling-record-notes', text: r.notes || '' }) },
      ], data.rows) : null,
      data.validCount > data.rows.length ? h('p', { class: 'muted', text: '미리보기에는 처음 ' + number(data.rows.length) + '건이 표시됩니다.' }) : null,
      actions,
    ].filter(Boolean));
  }
  const form = h('form', { class: 'calling-import', onsubmit: async (event) => {
    event.preventDefault();
    previewButton.disabled = true;
    clear(previewBox).append(notice('info', '콜링 입력 자료를 확인하고 있습니다.'));
    const current = [source, date, year, caller].filter(Boolean);
    current.forEach(el => { el.disabled = true; });
    try {
      const result = xlsx ? await uploadPreview(source.files[0], mode === 'migration')
        : await ctx.api.post(manage + '/import/report/preview', { text: source.value, date: date.value, year: year.value, caller: caller.value });
      renderPreview(result);
    } catch (error) { clear(previewBox).append(notice('error', errorMessage(error))); }
    finally {
      previewButton.disabled = false;
      current.forEach(el => { el.disabled = false; });
    }
  } },
  !xlsx ? h('div', { class: 'calling-field-grid' }, field('기본 날짜', date), field('기본 연도', year), field('기본 콜링자', caller)) : null,
  xlsx ? field('콜링 엑셀', source, 'XLSX 1MB, 최대 2,000행') : field('콜링 일보 원문', source),
  h('div', { class: 'actions calling-dialog-foot' }, button('닫기', () => form.closest('dialog').close(), 'ghost'), previewButton),
  previewBox);
  openEditor(host, title, form, source);
}

function statsPanel(summary) {
  const { totals, lag } = summary;
  const metrics = [
    ['전체 콜링', number(totals.count), '건', '대상자 ' + number(totals.targets) + '명 · 콜링자 ' +
      number(totals.callerCount) + '명', 'activity'],
    ['만픽', number(totals.successes), '건', '결과가 만픽으로 기록된 콜링', 'target'],
    ['만픽률', rate(totals.rate), '', '전체 콜링 중 만픽 비율', 'flow'],
    ['찾B 후 평균 만픽 소요일', lagDays(lag.average), '', '찾B일 확인 ' + number(lag.count) + '명', 'clock'],
  ];
  const metric = ([label, value, unit, foot, glyph]) => h('article', { class: 'panel calling-metric' },
    h('div', { class: 'calling-metric-head' }, h('span', { text: label }), icon(glyph)),
    h('strong', { class: 'calling-metric-value', text: value }, unit ? h('small', { text: unit }) : null),
    h('span', { class: 'calling-metric-foot', text: foot }));
  const byCaller = { key: 'caller', label: '콜링자' };
  const byHour = { label: '시간대', render: (row) => String(row.hour).padStart(2, '0') + ':00–' +
    String(row.hour + 1).padStart(2, '0') + ':00' };
  const breakdown = (label, cols, rows, emptyText = '조회 조건에 맞는 콜링 기록이 없습니다.') =>
    h('section', { class: 'panel calling-panel calling-breakdown', 'aria-label': label },
      h('div', { class: 'calling-panel-head' }, h('h2', { text: label })),
      callingTable([...cols, ...countColumns(1, '만픽')], rows, label, { emptyText }));
  const hourEmpty = summary.missingTime ? '시간이 기록된 콜링이 없습니다.' : undefined;
  const lagMetrics = [['평균 소요일', lag.average], ['중앙값', lag.median], ['80% 도달 추정', lag.p80]];
  return h('div', { class: 'calling-stats' },
    h('section', { class: 'calling-metrics', 'aria-label': '콜링 요약' }, metrics.map(metric)),
    summary.missingTime ? notice('info', '시간 미입력 ' + number(summary.missingTime) + '건은 시간대별 집계에서 제외됩니다.') : null,
    h('div', { class: 'calling-breakdowns calling-breakdowns-three' },
      breakdown('시간대별 만픽', [byHour], summary.byHour, hourEmpty), breakdown('콜링자별 만픽', [byCaller], summary.byCaller),
      breakdown('차수별 만픽', [{ key: 'roundLabel', label: '차수' }], summary.byRound)),
    h('div', { class: 'calling-breakdowns' },
      breakdown('콜링자·시간대별 만픽', [byCaller, byHour], summary.byCallerHour, hourEmpty),
      breakdown('콜링자·차수별 만픽', [byCaller, { key: 'roundLabel', label: '차수' }], summary.byCallerRound)),
    h('section', { class: 'panel calling-panel calling-lag', 'aria-labelledby': 'calling-lag-title' },
      h('div', { class: 'calling-panel-head' },
        h('h2', { id: 'calling-lag-title', text: '찾B일부터 만픽 콜링까지' }),
        h('p', { class: 'muted', text: '조회 조건 내 대상자별 첫 만픽 콜링까지의 날짜 차이입니다. 80% 도달 추정은 관측된 만픽 대상자의 분포를 기준으로 계산합니다.' })),
      lag.count ? [
        h('dl', { class: 'calling-lag-metrics' }, lagMetrics.map(([label, value]) =>
          h('div', {}, h('dt', { text: label }), h('dd', { text: lagDays(value) })))),
        h('p', { class: 'muted calling-lag-count', text: '집계 대상 ' + number(lag.count) +
          '명' + (lag.missing ? ' · 날짜 확인 필요 ' + number(lag.missing) + '명' : '') }),
        callingTable([
          { label: '찾B 이후', render: (row) => row.days === 0 ? '당일' : number(row.days) + '일 이내' },
          { label: '누적 만픽 대상자', numeric: true, render: (row) => number(row.count) + '명' },
          { label: '관측 만픽 중 누적 비율', numeric: true, render: (row) => h('div', { class: 'calling-rate-cell calling-rate' },
            row.rate != null ? h('progress', { max: 100, value: row.rate, 'aria-hidden': 'true' }) : null, rate(row.rate)) },
        ], lag.within, '찾B 이후 누적 만픽 대상자'),
      ] : h('p', { class: 'muted calling-lag-count', text: lag.missing
        ? '찾B일과 콜링날짜를 확인할 만픽 대상자가 ' + number(lag.missing) + '명 있습니다.'
        : '소요일을 집계할 만픽 대상자가 없습니다.' })));
}

export async function mount(ctx) {
  if (!document.getElementById('calling-module-style')) {
    document.head.append(h('link', { id: 'calling-module-style', rel: 'stylesheet', href: '/assets/css/calling.css' }));
  }
  const stats = ctx.programId === 'callingStats';
  const apiRoot = '/api/programs/' + encodeURIComponent(ctx.programId);
  const options = await ctx.api.get(apiRoot + '/options');
  const results = h('div', { class: 'calling-results', 'aria-live': 'polite' });
  const formHost = h('div');
  const filters = buildFilters(options, stats, () => load());
  let committed = filters.query();
  let requestId = 0;
  const load = async (offset = 0, reuse = false) => {
    const currentRequest = ++requestId;
    const params = reuse ? committed : filters.query();
    clear(results).append(notice('info', '콜링 기록을 조회하고 있습니다.'));
    try {
      if (stats) {
        const summary = await ctx.api.get(apiRoot + '/summary?' + params);
        if (currentRequest !== requestId) return;
        committed = params;
        clear(results).append(statsPanel(summary));
        return;
      }
      const pageParams = new URLSearchParams(params);
      pageParams.set('offset', offset);
      pageParams.set('limit', 30);
      pageParams.set('includeSummary', 'true');
      const page = await ctx.api.get(apiRoot + '/page?' + pageParams);
      if (currentRequest !== requestId) return;
      if (!page.items.length && offset) return load(0, reuse);
      committed = params;
      clear(results).append(reportPanel(ctx, page.summary, params),
        h('section', { class: 'panel calling-panel calling-history' },
          h('div', { class: 'calling-panel-head' }, h('h2', { text: '콜링 기록' })),
          recordTable(ctx, page.items, options, formHost, refresh), pageFoot(page.offset, page.limit, page.total,
            (next) => load(next, true))));
    } catch (error) {
      if (currentRequest === requestId) clear(results).append(notice('error', errorMessage(error)));
    }
  };
  const refresh = async () => {
    const latest = await ctx.api.get(apiRoot + '/options');
    Object.assign(options, latest);
    const current = filters.caller.value;
    const choices = current && !options.callers.includes(current) ? [...options.callers, current] : options.callers;
    clear(filters.caller).append(...select([...empty('전체 콜링자'), ...choices], current).children);
    await load(0, true);
  };
  const actions = h('div', { class: 'actions calling-actions' },
    !stats && (ctx.permissions.write || ctx.permissions.export) ? actionButton('입력 양식', 'download', run(ctx, () =>
      ctx.api.download(manage + '/template.xlsx', 'SMOA-콜링-입력양식.xlsx'))) : null,
    ...(!stats && ctx.permissions.write ? [['report', '콜링 일보 가져오기'], ['normal', '엑셀 가져오기'], ['migration', 'MIG 엑셀 가져오기']]
      .map(([mode, title]) => actionButton(title, 'upload', () => importEditor(ctx, mode, formHost, refresh))) : []),
    ctx.permissions.export ? actionButton(stats ? '집계 엑셀' : '조회 결과 엑셀', 'download', run(ctx, () =>
      ctx.api.download(apiRoot + '/export/xlsx?' + committed, stats ? 'SMOA-콜링-현황.xlsx' : 'SMOA-콜링-기록.xlsx'))) : null,
    !stats && ctx.permissions.write ? actionButton('콜링 기록 추가', 'plus', () => formMaker(ctx, options, formHost, null, refresh), 'primary') : null);
  ctx.container.append(h('div', { class: 'calling-module' }, actions, filters.form, formHost, results));
  await load();
}
