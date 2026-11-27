import { clear, confirmAction, errorMessage, field, h, notice, select, table } from '../js/ui.js';

export const column = (key, label, render) => ({ key, label, render });
export const input = (name, value = '', attrs = {}) => h('input', { name, value, ...attrs });
export const action = (text, onclick, style = '') =>
  h('button', { type: 'button', class: `btn ${style}`.trim(), text, onclick });

export function districtKey(row) {
  return row.regionCode && row.districtCode ? JSON.stringify([row.regionCode, row.districtCode]) : '';
}

export function districtSelect(districts, name = 'scope', value = '', emptyLabel = '전체 구역') {
  return select([['', emptyLabel], ...districts.map((row) => [districtKey(row),
    [row.regionName || row.regionCode, row.districtName || row.districtCode].join(' / ')])], value, { name });
}

export function queryValues(form) {
  const values = Object.fromEntries(new FormData(form));
  const scope = values.scope;
  delete values.scope;
  if (scope) [values.regionCode, values.districtCode] = JSON.parse(scope);
  return values;
}

export function anyText(row, term, keys) {
  const keyword = (term || '').trim().toLocaleLowerCase();
  return !keyword || keys.some((key) => String(row[key] || '').toLocaleLowerCase().includes(keyword));
}

export async function mountData(ctx, view) {
  const page = ctx.container;
  const base = `/api/programs/${ctx.programId}`;
  const clientKeys = view.clientKeys || [];
  let values = { ...view.defaults };
  let busy = false;
  let lastQuery = '';
  const controls = h('section', { class: 'panel' });
  const result = h('section', { class: 'panel', 'aria-live': 'polite' });
  const status = h('div', { role: 'status' });
  clear(page).append(controls, status, result);

  async function load() {
    if (busy) return;
    busy = true;
    status.replaceChildren(notice('info', '자료를 조회하는 중입니다.'));
    const params = new URLSearchParams();
    Object.entries(values).forEach(([key, value]) => {
      if (value !== '' && !clientKeys.includes(key)) params.set(key, value);
    });
    const query = params.size ? '?' + params.toString() : '';
    try {
      const data = await ctx.api.get(base + (view.path || '/data/list') + query);
      lastQuery = query;
      renderControls(data);
      clear(result).append(...view.render(data, values, ctx, load).filter(Boolean));
      clear(status);
    } catch (error) {
      const message = notice('error', errorMessage(error));
      if (!controls.firstChild) message.append(action('다시 시도', load));
      status.replaceChildren(message);
      clear(result);
    } finally {
      busy = false;
    }
  }

  function renderControls(data) {
    const fields = view.fields(data, values).filter(Boolean);
    if (!fields.length) {
      controls.hidden = true;
      return;
    }
    const submit = h('button', { class: 'btn primary', type: 'submit', text: '조회' });
    const form = h('form', { class: 'row dashboard-reading-filters', onsubmit: (event) => {
      event.preventDefault();
      if (busy) return;
      values = queryValues(form);
      load();
    } }, fields, submit);
    if (ctx.permissions?.export && view.xlsx) {
      form.append(action('엑셀 내보내기', async () => {
        try {
          await ctx.api.download(base + '/export' + lastQuery, view.xlsx);
        } catch (error) {
          status.replaceChildren(notice('error', errorMessage(error)));
        }
      }));
    }
    clear(controls).append(form);
  }

  await load();
}

export function section(title, columns, rows, emptyText) {
  return h('section', {}, h('h3', { text: title }), table(columns, rows, emptyText));
}

export function dateFields(values) {
  return [
    field('시작일', input('from', values.from, { type: 'date' })),
    field('종료일', input('to', values.to, { type: 'date' })),
  ];
}

export function editor(ctx, heading, fields, save, refresh) {
  const status = h('div', { role: 'alert' });
  const submit = h('button', { type: 'submit', class: 'btn primary', text: '저장' });
  const cancel = action('취소', () => dialog.close());
  const form = h('form', { onsubmit: async (event) => {
    event.preventDefault();
    submit.disabled = true;
    cancel.disabled = true;
    try {
      await save(queryValues(form));
      dialog.close();
      ctx.toast('저장되었습니다.', 'ok');
      await refresh();
    } catch (error) {
      status.textContent = errorMessage(error);
      submit.disabled = false;
      cancel.disabled = false;
    }
  } },
  h('div', { class: 'grid2' }, fields), status, h('div', { class: 'actions' }, submit, cancel));
  const dialog = h('dialog', { class: 'panel', 'aria-labelledby': 'business-editor-title',
    onclose: () => dialog.remove(), oncancel: (event) => { if (submit.disabled) event.preventDefault(); } },
  h('h3', { id: 'business-editor-title', text: heading }), form);
  ctx.container.append(dialog);
  dialog.showModal();
}

export function editorActions(ctx, endpoint, row, open, refresh, operation = '삭제') {
  const url = endpoint + '/' + encodeURIComponent(row.id);
  const controls = h('div', { class: 'actions' }, action('편집', () => open(row)));
  controls.append(action(operation, async (event) => {
    if (!confirmAction(`이 자료를 ${operation}하시겠습니까?`)) return;
    const button = event.currentTarget;
    button.disabled = true;
    try {
      await ctx.api.del(url + '?version=' + encodeURIComponent(row.version));
      ctx.toast(`${operation}되었습니다.`, 'ok');
      await refresh();
    } catch (error) {
      ctx.toast(errorMessage(error), 'error');
      button.disabled = false;
    }
  }));
  return controls;
}

export async function saveRow(ctx, endpoint, row, body) {
  if (row.id) {
    return ctx.api.put(endpoint + '/' + encodeURIComponent(row.id), { ...body, version: row.version });
  }
  return ctx.api.post(endpoint, body);
}
