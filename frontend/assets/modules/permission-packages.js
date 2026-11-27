import { badge, clear, confirmAction, errorMessage, field, h, table } from '../js/ui.js';

const PACKAGE_URL = '/api/admin/packages';
const ACTIONS = { access: '접근', write: '저장', export: '내보내기' };
const emptyPermission = () => ({ access: false, read: false, write: false, export: false });
const districtKey = (district) => JSON.stringify([district.regionCode, district.districtCode]);
const packageUrl = (pkg) => PACKAGE_URL + '/' + encodeURIComponent(pkg.packageId);
const scopeLabel = (scope) => scope.type === 'ALL' ? '전체' : `지정 구역 ${scope.districts.length}개`;
const sameScope = (a, b) => a.type === b.type && JSON.stringify(a.districts.map(districtKey).sort()) ===
  JSON.stringify(b.districts.map(districtKey).sort());

function samePermissions(a, b) {
  const ids = Object.keys(a);
  return ids.length === Object.keys(b).length && ids.every((id) => Object.hasOwn(b, id) &&
    Object.keys(emptyPermission()).every((key) => Boolean(a[id][key]) === Boolean(b[id][key])));
}

export async function mountPackages(ctx) {
  const [initialPackages, programs, reference] = await Promise.all([
    ctx.api.get(PACKAGE_URL), ctx.api.get('/api/admin/programs'), ctx.api.get('/api/admin/reference'),
  ]);
  let packages = initialPackages;
  let selected = null;
  let previous = null;
  let changed = () => false;
  let busy = false;

  const list = h('div');
  const editor = h('section', { class: 'panel package-editor', 'aria-labelledby': 'package-editor-title' });
  const addPackage = h('button', {
    class: 'btn primary small', type: 'button', text: '패키지 추가', onclick: () => selectPackage(null),
  });
  ctx.container.append(h('div', { class: 'package-layout' },
    h('aside', { class: 'panel package-list', 'aria-labelledby': 'package-list-title' },
      h('div', { class: 'package-section-header' }, h('h3', { id: 'package-list-title', text: '패키지 목록' }), addPackage),
      list), editor));

  function defaultPackage() {
    return packages.find((pkg) => !pkg.superAdmin) ?? packages[0] ?? null;
  }

  function renderList() {
    clear(list).append(table([
      { label: '패키지', render: (pkg) => h('button', {
        class: 'package-select', type: 'button', 'aria-pressed': String(selected?.packageId === pkg.packageId),
        onclick: () => selectPackage(pkg),
      }, h('strong', { text: pkg.name }), h('small', { text: scopeLabel(pkg.dataScope) }),
      pkg.superAdmin ? badge('시스템 보호', 'warn') : pkg.active ? null : badge('비활성', 'error')) },
      { label: '계정', key: 'accountCount' },
    ], packages, '등록된 패키지가 없습니다.'));
  }

  function selectPackage(pkg) {
    if (busy || selected?.packageId === pkg?.packageId ||
        (changed() && !confirmAction('저장하지 않은 변경을 취소할까요?'))) return;
    previous = selected;
    show(pkg, true);
  }

  function show(pkg, focus = false) {
    selected = pkg;
    changed = () => false;
    renderList();
    const title = h('h3', {
      id: 'package-editor-title', tabindex: -1,
      text: pkg?.superAdmin ? pkg.name : pkg ? '패키지 편집' : '새 패키지',
    });
    clear(editor).append(title);
    if (focus) title.focus();
    if (pkg?.superAdmin) {
      editor.append(h('div', { class: 'package-system-summary' },
        badge('시스템 보호', 'warn'),
        h('p', { text: '프로그램 권한 전체 · 데이터 범위 전체' }),
        h('p', { class: 'muted', text: `연결된 계정 ${pkg.accountCount}개` })));
      return;
    }

    const name = h('input', { type: 'text', required: true, maxlength: 50, value: pkg?.name ?? '' });
    const active = h('input', { type: 'checkbox', checked: pkg?.active ?? true });
    const scope = scopePicker(reference, pkg?.dataScope);
    const grid = programPermissions(ctx.container, programs, pkg?.permissions ?? {});
    const original = {
      name: pkg?.name ?? '', active: pkg?.active ?? true, permissions: pkg?.permissions ?? {},
      dataScope: pkg?.dataScope ?? { type: 'ORG', districts: [] },
    };
    function changes() {
      const patch = {};
      if (name.value.trim() !== original.name) patch.name = name.value.trim();
      if (active.checked !== original.active) patch.active = active.checked;
      const permissions = grid.value();
      if (!samePermissions(permissions, original.permissions)) patch.permissions = permissions;
      const dataScope = scope.value();
      if (!sameScope(dataScope, original.dataScope)) patch.dataScope = dataScope;
      return patch;
    }
    changed = () => Object.keys(changes()).length > 0;

    const controls = h('fieldset', { class: 'package-fields' },
      h('div', { class: 'package-editor-basics' },
        field('패키지 이름', name), h('label', { class: 'package-status' }, active, ' 사용')),
      grid.node,
      scope.node,
      h('div', { class: 'row package-editor-actions' },
        h('button', { type: 'submit', class: 'btn primary', text: '패키지 저장' }),
        h('button', { type: 'button', class: 'btn', text: '취소', onclick: () => show(pkg ?? previous ?? defaultPackage(), true) }),
        pkg ? h('button', { type: 'button', class: 'btn danger', text: '패키지 삭제', onclick: () => remove(pkg, controls) }) : null));
    editor.append(h('form', { onsubmit: async (event) => {
      event.preventDefault();
      if (busy) return;
      const patch = changes();
      if (pkg && !Object.keys(patch).length) return;
      await mutate(controls, async () => {
        const saved = pkg ? await ctx.api.patch(packageUrl(pkg), patch) : await ctx.api.post(PACKAGE_URL, {
          name: name.value.trim(), active: active.checked, permissions: grid.value(), dataScope: scope.value(),
        });
        packages = pkg ? packages.map((item) => item.packageId === saved.packageId ? saved : item) : [...packages, saved];
        show(saved, true);
      }, '패키지를 저장했습니다.');
    } }, controls));
  }

  async function remove(pkg, controls) {
    if (busy || !confirmAction(`'${pkg.name}' 패키지를 삭제할까요?`)) return;
    await mutate(controls, async () => {
      await ctx.api.del(packageUrl(pkg));
      packages = packages.filter((item) => item.packageId !== pkg.packageId);
      previous = null;
      show(defaultPackage(), true);
    }, '패키지를 삭제했습니다.');
  }

  async function mutate(controls, action, message) {
    busy = true;
    controls.disabled = true;
    addPackage.disabled = true;
    try {
      await action();
      ctx.toast(message, 'ok');
    } catch (error) {
      ctx.toast(errorMessage(error), 'error');
    } finally {
      busy = false;
      controls.disabled = false;
      addPackage.disabled = false;
    }
  }

  show(defaultPackage());
}

function programPermissions(host, programs, stored) {
  const byId = new Map(programs.map((program) => [program.programId, program]));
  const entries = new Map(Object.entries(stored).map(([id, perm]) => [id, { ...perm }]));
  const body = h('tbody');
  const add = h('button', {
    type: 'button', class: 'btn small', text: '프로그램 추가',
    onclick: () => choosePrograms(host, programs.filter((p) => p.active && !p.superAdminOnly && !entries.has(p.programId)),
      (selected) => {
        for (const program of selected) {
          entries.set(program.programId, { ...emptyPermission(), access: true, read: program.actions.includes('read') });
        }
        render();
      }, add),
  });
  const node = h('section', { class: 'package-editor-section' },
    h('div', { class: 'package-section-header' }, h('h4', { text: '프로그램별 권한' }), add),
    h('p', { class: 'muted package-hint', text: '접근을 켜면 메뉴와 조회 권한이 함께 열립니다.' }),
    h('div', { class: 'table-wrap' }, h('table', { class: 'data perm-grid' },
      h('thead', {}, h('tr', {},
        h('th', { scope: 'col', text: '프로그램' }),
        Object.values(ACTIONS).map((text) => h('th', { scope: 'col', text })),
        h('th', { scope: 'col', 'aria-label': '제거' }))), body)));
  render();

  function render() {
    clear(body);
    let visiblePrograms = 0;
    for (const [id, permission] of entries) {
      const program = byId.get(id);
      if (!program?.active || program.superAdminOnly) continue;
      visiblePrograms++;
      const name = program.name;
      const supports = (action) => program.actions.includes(action);
      const row = h('tr', {});
      const nameCell = h('td', { class: 'package-program-name' },
        h('span', { text: name }),
        h('small', { class: 'muted', text: program.group }));
      const menuOnly = h('small', { class: 'muted', text: '메뉴만', hidden: true });
      nameCell.append(menuOnly);
      row.append(nameCell);
      const boxes = {};
      for (const [key, label] of Object.entries(ACTIONS)) {
        const input = h('input', {
          type: 'checkbox', 'aria-label': `${name} ${label}`,
          onchange: () => {
            if (key === 'access') {
              if (input.checked) {
                permission.access = true;
                permission.read = supports('read');
              } else Object.assign(permission, emptyPermission());
            } else {
              permission[key] = input.checked;
              if (input.checked) permission.read = true;
            }
            sync();
          },
        });
        boxes[key] = input;
        row.append(h('td', {}, input));
      }
      const remove = h('button', {
        class: 'btn small', type: 'button', text: '제거', 'aria-label': `${name} 제거`,
        onclick: () => {
          entries.delete(id);
          render();
          add.focus();
        },
      });
      row.append(h('td', {}, remove));
      function sync() {
        boxes.access.checked = Boolean(permission.access);
        for (const key of ['write', 'export']) {
          boxes[key].checked = Boolean(permission[key]);
          boxes[key].disabled = !permission.access || !supports('read') || !supports(key);
        }
        menuOnly.hidden = !permission.access || permission.read || !supports('read');
      }
      sync();
      body.append(row);
    }
    if (!visiblePrograms) {
      body.append(h('tr', {}, h('td', { colspan: 5, class: 'muted', text: '프로그램을 추가해 주세요.' })));
    }
  }

  return { node, value: () => Object.fromEntries([...entries].filter(([, permission]) => permission.access)) };
}

function choosePrograms(host, programs, addSelected, trigger) {
  const dialog = h('dialog', { class: 'package-program-picker', 'aria-labelledby': 'program-picker-title' });
  const search = h('input', { type: 'search', placeholder: '이름, 그룹, ID', autofocus: true });
  const choices = h('div', { class: 'package-program-choices' });
  const count = h('span', { class: 'muted', role: 'status' });
  const selected = new Set();
  const submit = h('button', { type: 'submit', class: 'btn primary', text: '선택한 프로그램 추가' });
  const checkboxes = programs.map((program) => ({
    input: h('input', { type: 'checkbox', onchange: (event) => {
      if (event.target.checked) selected.add(program);
      else selected.delete(program);
      updateCount();
    } }),
    program,
  }));
  const items = checkboxes.map(({ input, program }) => ({
    text: `${program.name} ${program.group ?? ''} ${program.programId}`.toLocaleLowerCase('ko'),
    node: h('label', { class: 'package-program-choice' }, input,
      h('span', {}, h('strong', { text: program.name }),
        h('small', { class: 'muted', text: [program.group, program.programId].filter(Boolean).join(' · ') }))),
  }));
  const empty = h('p', { class: 'muted' });
  function filter() {
    const term = search.value.trim().toLocaleLowerCase('ko');
    for (const item of items) item.node.hidden = !item.text.includes(term);
    empty.hidden = items.some((item) => !item.node.hidden);
    empty.textContent = items.length ? '검색에 맞는 프로그램이 없습니다.' : '추가할 수 있는 프로그램이 없습니다.';
  }
  function updateCount() {
    submit.disabled = selected.size === 0;
    count.textContent = `${selected.size}개 선택`;
  }
  search.addEventListener('input', filter);
  choices.append(...items.map((item) => item.node), empty);
  dialog.append(h('form', { onsubmit: (event) => {
    event.preventDefault();
    if (!selected.size) return;
    addSelected(programs.filter((program) => selected.has(program)));
    dialog.close();
  } }, h('h3', { id: 'program-picker-title', text: '프로그램 선택' }),
  h('p', { class: 'muted package-hint', text: '추가할 때 접근 권한이 기본으로 선택됩니다.' }),
  field('프로그램 검색', search), choices,
  h('div', { class: 'package-picker-actions' }, count,
    h('button', { type: 'button', class: 'btn', text: '취소', onclick: () => dialog.close() }), submit)));
  dialog.addEventListener('close', () => {
    dialog.remove();
    trigger.focus();
  }, { once: true });
  host.append(dialog);
  filter();
  updateCount();
  dialog.showModal();
}

function scopePicker(reference, scope) {
  const all = h('input', { type: 'radio', name: 'package-scope', checked: scope?.type === 'ALL' });
  const org = h('input', { type: 'radio', name: 'package-scope', checked: scope?.type !== 'ALL' });
  const existing = new Map((scope?.districts ?? []).map((district) => [districtKey(district), district]));
  const activeRegions = new Map(reference.regions.map((region) => [region.regionCode, region]));
  const groups = new Map();
  const inputs = [];
  for (const district of reference.districts) {
    const region = activeRegions.get(district.regionCode);
    const key = districtKey(district);
    const active = Boolean(district.active && region?.active);
    if (!active && !existing.has(key)) continue;
    const input = h('input', { type: 'checkbox', checked: existing.has(key) });
    if (!active) input.addEventListener('change', () => { input.disabled = true; });
    inputs.push({ input, district });
    if (!groups.has(district.regionCode)) groups.set(district.regionCode, []);
    groups.get(district.regionCode).push(h('label', {}, input, ' ', district.name, active ? null : ' (비활성)'));
    existing.delete(key);
  }
  for (const district of existing.values()) {
    const input = h('input', { type: 'checkbox', checked: true, onchange: () => { input.disabled = true; } });
    if (!groups.has(district.regionCode)) groups.set(district.regionCode, []);
    groups.get(district.regionCode).push(h('label', {}, input, ` ${district.districtCode} (등록되지 않은 구역)`));
    inputs.push({ input, district });
  }
  const districts = h('div', { class: 'package-districts' },
    [...groups].map(([code, labels]) => h('fieldset', { class: 'package-district-region' },
      h('legend', { text: activeRegions.get(code)?.name ?? code }), h('div', { class: 'check-list' }, labels))),
    h('p', { class: 'muted package-hint', text: inputs.length
      ? '선택한 구역이 없으면 데이터 접근이 제한됩니다.' : '선택할 수 있는 구역이 없습니다.' }));
  const update = () => { districts.hidden = all.checked; };
  all.addEventListener('change', update);
  org.addEventListener('change', update);
  update();
  const node = h('fieldset', { class: 'package-editor-section package-scope' },
    h('legend', { text: '데이터 범위' }),
    h('div', { class: 'check-list' }, h('label', {}, all, ' 전체'), h('label', {}, org, ' 지정 구역')),
    districts);
  return { node, value: () => ({
    type: all.checked ? 'ALL' : 'ORG',
    districts: all.checked ? [] : inputs.filter(({ input }) => input.checked)
      .map(({ district: { regionCode, districtCode } }) => ({ regionCode, districtCode })),
  }) };
}
