import { downloadFile, formDialog, getJson, h, nameOf, postXlsx, runShell, sendJson, toast } from './common.js';

const field = (label, control, cls) => h('label', { class: cls }, label, control);
const th = (t) => h('th', { scope: 'col' }, t);

// ---- 사용자 관리
async function users(box, me) {
  const { users: list, roles, districts } = await getJson('/api/admin/users');
  const reload = () => { box.replaceChildren(); return users(box, me); };
  const roleName = (id) => nameOf(roles, id);
  const districtText = (u) => (u.role === 'admin' ? '전체' : u.districts.map((d) => nameOf(districts, d)).join(', '));

  function districtBoxes(selected, disabled) {
    return h('fieldset', null, h('legend', null, '배정 구역'),
      districts.map((d) => h('label', { class: 'check' },
        h('input', { type: 'checkbox', name: 'districts', value: d.id, checked: selected.includes(d.id), disabled }), d.name)));
  }
  const roleSelect = (cur) => h('select', { name: 'role', required: true }, roles.map((r) => h('option', { value: r.id, selected: r.id === cur }, r.name)));
  const bindRole = (form) => {
    const sync = () => form.querySelectorAll('input[name="districts"]').forEach((c) => { c.disabled = form.role.value === 'admin'; });
    form.role.addEventListener('change', sync);
    sync();
  };

  function create() {
    formDialog({
      title: '계정 추가',
      submitLabel: '추가',
      body: h('div', { class: 'form-grid' },
        field('아이디 (영문 소문자·숫자)', h('input', { type: 'text', name: 'username', required: true, maxlength: '32', autocomplete: 'off' })),
        field('이름', h('input', { type: 'text', name: 'displayName', required: true, maxlength: '50' })),
        field('초기 비밀번호 (10자 이상)', h('input', { type: 'password', name: 'password', required: true, minlength: '10', maxlength: '128', autocomplete: 'new-password' })),
        field('역할', roleSelect('viewer')),
        h('div', { class: 'wide' }, districtBoxes([], false))),
      onSubmit: async (fd) => {
        await sendJson('POST', '/api/admin/users', {
          username: fd.get('username'), displayName: fd.get('displayName'), password: fd.get('password'),
          role: fd.get('role'), districts: fd.getAll('districts'),
        });
        toast('계정을 추가했습니다.');
        reload();
      },
    });
    const dlg = document.querySelector('dialog form');
    bindRole(dlg);
  }

  function edit(u) {
    const locked = u.root || u.id === me.user.id;
    formDialog({
      title: `계정 수정 · ${u.username}`,
      body: h('div', { class: 'form-grid' },
        field('이름', h('input', { type: 'text', name: 'displayName', value: u.displayName, required: true, maxlength: '50' })),
        field('역할', roleSelect(u.role)),
        locked ? h('p', { class: 'note wide' }, '본인 또는 기본 관리자 계정의 역할은 바꿀 수 없습니다.') : null,
        h('div', { class: 'wide' }, districtBoxes(u.districts, false))),
      onSubmit: async (fd) => {
        const body = { displayName: fd.get('displayName'), districts: fd.getAll('districts') };
        if (fd.has('role')) body.role = fd.get('role'); // 잠긴 계정은 역할을 보내지 않는다.
        await sendJson('PATCH', `/api/admin/users/${encodeURIComponent(u.id)}`, body);
        toast('저장했습니다.');
        reload();
      },
    });
    const form = document.querySelector('dialog form');
    if (locked) form.role.disabled = true;
    else bindRole(form);
  }

  function resetPassword(u) {
    formDialog({
      title: `비밀번호 재설정 · ${u.username}`,
      submitLabel: '재설정',
      body: h('div', null,
        h('p', { class: 'note' }, '재설정하면 해당 계정의 기존 로그인이 모두 종료됩니다.'),
        field('새 비밀번호 (10자 이상)', h('input', { type: 'password', name: 'password', required: true, minlength: '10', maxlength: '128', autocomplete: 'new-password' }))),
      onSubmit: async (fd) => {
        await sendJson('POST', `/api/admin/users/${encodeURIComponent(u.id)}/password`, { password: fd.get('password') });
        toast('비밀번호를 재설정했습니다.');
      },
    });
  }

  async function toggle(u) {
    try {
      await sendJson('PATCH', `/api/admin/users/${encodeURIComponent(u.id)}`, { active: !u.active });
      toast(u.active ? '비활성화했습니다.' : '활성화했습니다.');
      reload();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  // 표 한 줄을 만든다.
  function userRow(u) {
    const stateCell = h('span', { class: `pill ${u.active ? '' : 'off'}` }, u.active ? '사용' : '비활성');
    const editButton = h('button', { type: 'button', class: 'secondary', onclick: () => edit(u) }, '수정');
    const passwordButton = h('button', { type: 'button', class: 'secondary', onclick: () => resetPassword(u) }, '비밀번호');
    const toggleButton = h('button', {
      type: 'button',
      class: u.active ? 'danger' : 'secondary',
      disabled: u.root || u.id === me.user.id,
      onclick: () => toggle(u),
    }, u.active ? '비활성화' : '활성화');
    const actions = h('div', { class: 'row-actions' }, editButton, passwordButton, toggleButton);
    return h('tr', null,
      h('td', { class: 'strong' }, u.username),
      h('td', null, u.displayName),
      h('td', null, roleName(u.role)),
      h('td', null, districtText(u)),
      h('td', null, stateCell),
      h('td', null, actions));
  }

  const headerRow = h('tr', null, ['아이디', '이름', '역할', '구역', '상태', '관리'].map((t) => h('th', { scope: 'col' }, t)));
  const table = h('table', null, h('thead', null, headerRow), h('tbody', null, list.map(userRow)));
  const tableWrap = h('div', { class: 'table-wrap', tabindex: '0', role: 'region', 'aria-label': '사용자 목록' }, table);

  box.append(
    h('div', { class: 'toolbar' }, h('h1', null, '사용자 관리'), h('span', { class: 'spacer' }),
      h('button', { type: 'button', onclick: create }, '계정 추가')),
    h('p', { class: 'note' }, '공개 가입은 없습니다. 계정은 관리자만 만들고, 비밀번호는 화면에 표시되지 않습니다.'),
    tableWrap);
}

// ---- 접근 권한 관리
async function permissions(box) {
  const data = await getJson('/api/admin/permissions');
  const ACTIONS = [['access', '화면 접근'], ['read', '읽기'], ['write', '쓰기'], ['export', '내보내기']];
  box.append(h('h1', null, '접근 권한 관리'),
    h('p', { class: 'note' }, '화면 접근이 꺼지면 메뉴와 모든 기능이 막히고, 읽기가 꺼지면 쓰기·내보내기도 사용할 수 없습니다. 변경은 접속 중인 사용자에게도 다음 요청부터 적용됩니다.'),
    h('div', { class: 'card' }, h('h2', null, '관리자'), h('p', { class: 'note' }, '관리자는 모든 화면 권한과 관리 기능을 가지며 변경할 수 없습니다.')));

  for (const role of data.roles.filter((r) => r.id !== 'admin')) {
    const perms = data.permissions[role.id];
    const checks = new Map();
    const syncDeps = (sid) => {
      const get = (a) => checks.get(`${sid}.${a}`);
      const applicable = (a) => a === 'access' || data.screens.find((s) => s.id === sid).actions.includes(a); // 화면에 없는 동작은 켤 수 없다
      get('read').disabled = !get('access').checked || !applicable('read');
      get('write').disabled = !get('access').checked || !get('read').checked || !applicable('write');
      get('export').disabled = !get('access').checked || !get('read').checked || !applicable('export');
    };
    const rows = data.screens.map((s) => h('tr', null, h('th', { scope: 'row' }, s.label, h('span', { class: 'note' }, ` · ${s.group}`)),
      ACTIONS.map(([a, name]) => {
        const input = h('input', { type: 'checkbox', checked: perms[s.id][a], 'aria-label': `${role.name} ${s.label} ${name}`, onchange: () => syncDeps(s.id) });
        checks.set(`${s.id}.${a}`, input);
        return h('td', null, input);
      })));
    const status = h('span', { class: 'status', role: 'status' });
    const save = async () => {
      const screens = Object.fromEntries(data.screens.map((s) => [s.id, Object.fromEntries(ACTIONS.map(([a]) => [a, checks.get(`${s.id}.${a}`).checked]))]));
      try {
        const res = await sendJson('PUT', `/api/admin/permissions/${encodeURIComponent(role.id)}`, { screens });
        data.screens.forEach((s) => ACTIONS.forEach(([a]) => { checks.get(`${s.id}.${a}`).checked = res.permissions[s.id][a]; }));
        data.screens.forEach((s) => syncDeps(s.id));
        status.className = 'status ok';
        status.textContent = '저장했습니다.';
      } catch (err) {
        status.className = 'status error';
        status.textContent = err.message;
      }
    };
    box.append(h('section', { class: 'card' }, h('h2', null, role.name),
      h('div', { class: 'table-wrap' }, h('table', null,
        h('thead', null, h('tr', null, h('th', { scope: 'col' }, '화면'), ACTIONS.map(([, n]) => h('th', { scope: 'col' }, n)))),
        h('tbody', null, rows))),
      h('div', { class: 'toolbar' }, h('button', { type: 'button', onclick: save }, `${role.name} 권한 저장`), status)));
    data.screens.forEach((s) => syncDeps(s.id));
  }
}

// ---- 공통코드 그룹·항목 (반·직업 구분·직책·활동 종류·활동 장소 등)
let selectedGroupId = '';
// 선택 그룹 항목 검색어. 그룹을 바꾸면 비우고, 저장·가져오기·삭제 후 다시 그릴 때는 유지한다(실행판과 같은 동작).
let codeSearch = '';
const codeSearchText = (i) => [i.label, i.value, ...(i.aliases ?? [])].join(' ').toLocaleLowerCase();

function codeGroups(groups, reload) {
  if (!groups.some((g) => g.id === selectedGroupId)) { selectedGroupId = groups[0]?.id ?? ''; codeSearch = ''; }
  const group = groups.find((g) => g.id === selectedGroupId);
  const base = '/api/admin/codes/groups';
  const run = async (method, url, body, msg) => {
    try {
      await sendJson(method, url, body);
      toast(msg);
      reload();
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  const picker = h('select', { name: 'group', 'aria-label': '코드 그룹', onchange: (e) => { selectedGroupId = e.target.value; codeSearch = ''; reload(); } },
    groups.map((g) => h('option', { value: g.id, selected: g.id === selectedGroupId }, `${g.label}${g.active ? '' : ' (보관)'}`)));
  const groupName = h('input', { type: 'text', name: 'groupLabel', value: group?.label ?? '', maxlength: '60', 'aria-label': '그룹 이름' });
  const newGroup = h('input', { type: 'text', name: 'newGroup', required: true, maxlength: '60' });

  const head = h('div', { class: 'card' },
    h('h2', null, '코드 그룹'),
    h('p', { class: 'note' }, '코드값은 한 번 만들면 바뀌지 않고, 표시명을 바꾸면 이전 표시명이 별칭으로 남아 기존 자료와 계속 연결됩니다. 기존 기록·구성원·목표에서 쓰는 항목은 삭제할 수 없으니 "사용 안 함"으로 바꿔 주세요.'),
    h('form', { class: 'toolbar', onsubmit: (e) => {
      e.preventDefault();
      run('POST', base, { label: newGroup.value }, '그룹을 추가했습니다.');
    } }, field('새 그룹 이름', newGroup), h('div', { class: 'actions' }, h('button', { type: 'submit' }, '그룹 추가'))),
    group ? h('div', { class: 'toolbar' },
      field('그룹 선택', picker),
      field('그룹 이름', groupName),
      h('div', { class: 'actions' },
        h('button', { type: 'button', class: 'secondary', onclick: () => run('PATCH', `${base}/${encodeURIComponent(group.id)}`, { label: groupName.value }, '그룹 이름을 저장했습니다.') }, '이름 저장'),
        group.system ? null : h('button', { type: 'button', class: group.active ? 'danger' : 'secondary', onclick: () => run('PATCH', `${base}/${encodeURIComponent(group.id)}`, { active: !group.active }, group.active ? '그룹을 보관했습니다.' : '그룹을 다시 사용합니다.') }, group.active ? '그룹 보관' : '그룹 사용'),
        group.system ? null : h('button', { type: 'button', class: 'danger', onclick: () => run('DELETE', `${base}/${encodeURIComponent(group.id)}`, undefined, '그룹을 삭제했습니다.') }, '그룹 삭제'))) : null,
    group?.system ? h('p', { class: 'note' }, '기본 그룹은 보관하거나 삭제할 수 없습니다.') : null);
  if (!group) return [head];

  const itemUrl = (i) => `${base}/${encodeURIComponent(group.id)}/items/${encodeURIComponent(i.id)}`;
  const addLabel = h('input', { type: 'text', name: 'itemLabel', required: true, maxlength: group.id === 'activityPlace' ? '200' : '60' });
  const addValue = h('input', { type: 'text', name: 'itemValue', maxlength: '60', placeholder: '비워 두면 자동 부여' });

  const rows = group.items.map((i) => {
    const labelInput = h('input', { type: 'text', value: i.label, maxlength: group.id === 'activityPlace' ? '200' : '60', 'aria-label': `${i.value} 표시명` });
    const orderInput = h('input', { type: 'number', value: String(i.order), min: '0', max: '9999', 'aria-label': `${i.value} 순서` });
    const tr = h('tr', null,
      h('td', { class: 'code' }, i.value),
      h('td', null, labelInput),
      h('td', null, i.aliases.join(', ')),
      h('td', null, orderInput),
      h('td', null, h('span', { class: `pill ${i.active ? '' : 'off'}` }, i.active ? '사용' : '사용 안 함')),
      h('td', null, h('div', { class: 'row-actions' },
        h('button', { type: 'button', class: 'secondary', onclick: () => run('PATCH', itemUrl(i), { label: labelInput.value, order: Number(orderInput.value) }, '저장했습니다.') }, '저장'),
        h('button', { type: 'button', class: i.active ? 'danger' : 'secondary', onclick: () => run('PATCH', itemUrl(i), { active: !i.active }, i.active ? '사용 안 함으로 바꿨습니다.' : '다시 사용합니다.') }, i.active ? '사용 안 함' : '사용'),
        h('button', { type: 'button', class: 'danger', onclick: () => run('DELETE', itemUrl(i), undefined, '삭제했습니다.') }, '삭제'))));
    return { tr, text: codeSearchText(i) };
  });

  // 검색은 이미 받은 현재 그룹 항목의 행만 숨기거나 보이므로 입력 초점·커서와 행 안의 수정 중 입력값이 그대로 남는다.
  const noMatch = h('tr', { hidden: true }, h('td', { colspan: '6', class: 'empty' }, '검색 조건에 맞는 항목이 없습니다. 검색어를 지우면 전체 항목이 다시 보입니다.'));
  const searchCount = h('span', { class: 'note', 'aria-live': 'polite' });
  const applySearch = () => {
    const q = codeSearch.trim().toLocaleLowerCase();
    let shown = 0;
    for (const r of rows) {
      r.tr.hidden = Boolean(q) && !r.text.includes(q);
      if (!r.tr.hidden) shown += 1;
    }
    noMatch.hidden = shown > 0;
    searchCount.textContent = q ? `${rows.length}개 중 ${shown}개` : `${rows.length}개`;
  };
  if (!rows.length) codeSearch = ''; // 검색 상자가 없는 빈 그룹에서는 숨은 검색어가 남지 않게 한다.
  const search = h('input', { type: 'search', name: 'codeSearch', value: codeSearch, autocomplete: 'off', 'aria-label': '공통코드 검색', placeholder: '표시명·코드값·이전 이름 검색',
    oninput: (e) => { codeSearch = e.target.value; applySearch(); } });
  applySearch();

  return [head, h('section', { class: 'card' },
    h('h2', null, `${group.label} 항목`),
    rows.length ? h('div', { class: 'toolbar' }, field('항목 검색', search), searchCount) : null,
    h('form', { class: 'toolbar', onsubmit: (e) => {
      e.preventDefault();
      const body = { label: addLabel.value };
      if (addValue.value.trim()) body.value = addValue.value;
      run('POST', `${base}/${encodeURIComponent(group.id)}/items`, body, '항목을 추가했습니다.');
    } }, field('표시명', addLabel), field('코드값 (선택)', addValue), h('div', { class: 'actions' }, h('button', { type: 'submit' }, '항목 추가'))),
    rows.length
      ? h('div', { class: 'table-wrap', tabindex: '0', role: 'region', 'aria-label': `${group.label} 항목 목록` },
        h('table', null,
          h('thead', null, h('tr', null, ['코드값', '표시명', '이전 표시명', '순서', '상태', '관리'].map((t) => h('th', { scope: 'col' }, t)))),
          h('tbody', null, rows.map((r) => r.tr), noMatch)))
      : h('p', { class: 'empty' }, '등록된 항목이 없습니다.'))];
}

// ---- 공통코드 엑셀 (내려받기 · 미리보기 후 가져오기)
function codeExcel(reload) {
  function importForm() {
    const file = h('input', { type: 'file', name: 'file', accept: '.xlsx' });
    const result = h('div');
    let previewId = null;
    const reset = () => { previewId = null; result.replaceChildren(); };
    file.addEventListener('change', reset);
    const show = (p) => result.replaceChildren(
      h('p', { class: 'note' }, `바뀌는 그룹·항목 ${p.totalChanges}건 · 변경 없음 ${p.unchanged}건`),
      p.errors.length ? h('ul', { class: 'status error', role: 'alert' }, p.errors.map((e) => h('li', null, e)), p.totalErrors > p.errors.length ? h('li', null, `그 밖의 오류 ${p.totalErrors - p.errors.length}건`) : null) : null,
      p.changes.length
        ? h('div', { class: 'table-wrap', tabindex: '0', role: 'region', 'aria-label': '공통코드 가져오기 변경 내용' }, h('table', null,
          h('thead', null, h('tr', null, ['구분', '처리', '그룹ID', '코드값', '표시명'].map(th))),
          h('tbody', null, p.changes.map((c) => h('tr', null, h('td', null, c.kind), h('td', null, c.status), h('td', { class: 'code' }, c.group), h('td', { class: 'code' }, c.value || '-'), h('td', null, c.label))))))
        : null,
      p.totalChanges > p.changes.length ? h('p', { class: 'note' }, `변경 ${p.totalChanges}건 중 ${p.changes.length}건만 표시했습니다.`) : null,
      h('p', { class: 'note' }, p.canApply ? `확인 후 아래 반영을 누르세요. 미리보기는 약 ${Math.round(p.expiresInSeconds / 60)}분 동안 유효하며, 그 사이 설정이 바뀌면 다시 만들어야 합니다.` : '반영할 수 없습니다. 오류를 고친 파일로 다시 미리보기를 만들어 주세요.'));
    formDialog({
      title: '공통코드 엑셀 가져오기',
      submitLabel: '미리보기 내용 반영',
      body: h('div', null,
        h('p', { class: 'note' }, '“공통코드 엑셀” 파일의 공통코드 시트만 읽습니다. 코드값은 만든 뒤 바뀌지 않고, 표시명을 바꾸면 이전 표시명이 남으며, 엑셀에 없는 그룹·항목은 삭제되지 않습니다.'),
        h('div', { class: 'toolbar' }, field('엑셀 파일 (.xlsx)', file),
          h('div', { class: 'actions' }, h('button', { type: 'button', onclick: async (e) => {
            const button = e.currentTarget;
            const chosen = file.files?.[0];
            if (!chosen) return toast('엑셀 파일을 선택해 주세요.', 'error');
            button.disabled = true;
            reset();
            try {
              const p = await postXlsx('/api/admin/codes/import/preview', chosen);
              previewId = p.previewId;
              show(p);
            } catch (err) {
              result.replaceChildren(h('p', { class: 'status error', role: 'alert' }, err.message));
            } finally { button.disabled = false; }
          } }, '미리보기'))),
        result),
      onSubmit: async () => {
        if (!previewId) throw new Error('오류 없이 반영할 수 있는 미리보기를 먼저 만들어 주세요.');
        const res = await sendJson('POST', '/api/admin/codes/import/apply', { previewId });
        previewId = null;
        toast(`공통코드 ${res.applied}건을 반영했습니다.`);
        reload();
      },
    });
  }
  return h('div', { class: 'toolbar card' },
    h('p', { class: 'note' }, '코드 그룹·항목은 엑셀로 내려받아 고친 뒤 다시 올릴 수 있습니다. 가져오기는 미리보기로 확인한 뒤 한 번에 반영됩니다.'),
    h('div', { class: 'actions' },
      h('button', { type: 'button', class: 'secondary', onclick: () => downloadFile('/api/admin/codes/export', 'smoa-codes.xlsx').then(() => toast('공통코드 엑셀을 내려받았습니다.'), (err) => toast(err.message, 'error')) }, '공통코드 엑셀 내려받기'),
      h('button', { type: 'button', class: 'secondary', onclick: importForm }, '공통코드 엑셀 가져오기')));
}

// ---- 사용자 항목 (대상자에 덧붙이는 입력 항목)
const FIELD_TYPE_NAMES = { text: '문자', number: '숫자', date: '날짜', select: '선택', boolean: '체크' };

function customFields({ fields, types, groups, max }, reload) {
  const toList = (text) => text.split('\n').map((s) => s.trim()).filter(Boolean);
  const groupName = (id) => groups.find((g) => g.id === id)?.label ?? id;

  function createForm() {
    const type = h('select', { name: 'type', required: true }, types.map((t) => h('option', { value: t }, FIELD_TYPE_NAMES[t] ?? t)));
    const group = h('select', { name: 'codeGroupId' }, h('option', { value: '' }, '(직접 입력한 선택지)'), groups.filter((g) => g.active).map((g) => h('option', { value: g.id }, g.label)));
    const options = h('textarea', { name: 'options', maxlength: '4000', placeholder: '한 줄에 선택지 하나' });
    const selectBox = h('div', { class: 'wide', hidden: true }, h('div', { class: 'form-grid' },
      field('코드 그룹 연결 (선택)', group), field('선택지 (코드 그룹을 쓰지 않을 때)', options, 'wide')));
    type.addEventListener('change', () => { selectBox.hidden = type.value !== 'select'; });
    group.addEventListener('change', () => { options.disabled = group.value !== ''; });
    formDialog({
      title: '사용자 항목 추가',
      submitLabel: '추가',
      body: h('div', { class: 'form-grid' },
        field('항목 이름', h('input', { type: 'text', name: 'label', required: true, maxlength: '60' })),
        field('유형 (만든 뒤에는 바꿀 수 없음)', type), selectBox),
      onSubmit: async (fd) => {
        const body = { label: fd.get('label'), type: fd.get('type') };
        if (body.type === 'select') {
          if (fd.get('codeGroupId')) body.codeGroupId = fd.get('codeGroupId');
          else body.options = toList(String(fd.get('options') ?? ''));
        }
        await sendJson('POST', '/api/admin/fields', body);
        toast('사용자 항목을 추가했습니다.');
        reload();
      },
    });
  }

  function editForm(f) {
    const editableOptions = f.type === 'select' && !f.codeGroupId;
    formDialog({
      title: `사용자 항목 수정 · ${f.label}`,
      body: h('div', { class: 'form-grid' },
        field('항목 이름', h('input', { type: 'text', name: 'label', value: f.label, required: true, maxlength: '60' })),
        editableOptions ? field('선택지 (한 줄에 하나)', h('textarea', { name: 'options', maxlength: '4000', value: f.options.join('\n') }), 'wide') : null,
        h('p', { class: 'note wide' }, '입력된 값이 있는 선택지는 뺄 수 없습니다. 유형과 코드 그룹은 바꿀 수 없습니다.')),
      onSubmit: async (fd) => {
        const body = { label: fd.get('label') };
        if (editableOptions) body.options = toList(String(fd.get('options') ?? ''));
        await sendJson('PATCH', `/api/admin/fields/${encodeURIComponent(f.id)}`, body);
        toast('저장했습니다.');
        reload();
      },
    });
  }

  async function remove(f) {
    if (!confirm(`'${f.label}' 항목을 삭제할까요? 삭제 전 내용은 변경 이력에 남습니다.`)) return;
    try {
      await sendJson('DELETE', `/api/admin/fields/${encodeURIComponent(f.id)}`);
      toast('삭제했습니다.');
      reload();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  return [
    h('div', { class: 'toolbar' }, h('h2', null, '사용자 항목'), h('span', { class: 'spacer' }),
      h('button', { type: 'button', disabled: fields.length >= max, onclick: createForm }, '사용자 항목 추가')),
    h('p', { class: 'note' }, `대상자에 덧붙여 입력하는 항목입니다. 최대 ${max}개이며, 대상자에게 값이 입력된 항목은 삭제할 수 없습니다.`),
    fields.length
      ? h('div', { class: 'table-wrap', tabindex: '0', role: 'region', 'aria-label': '사용자 항목 목록' }, h('table', null,
        h('thead', null, h('tr', null, ['항목 이름', '유형', '선택지·코드 그룹', '값이 입력된 대상자', '관리'].map(th))),
        h('tbody', null, fields.map((f) => h('tr', null,
          h('td', { class: 'strong' }, f.label), h('td', null, FIELD_TYPE_NAMES[f.type] ?? f.type),
          h('td', { class: 'wrapcell' }, f.codeGroupId ? `코드 그룹: ${groupName(f.codeGroupId)}` : f.options.join(', ') || '-'),
          h('td', null, `${f.used}명`),
          h('td', null, h('div', { class: 'row-actions' },
            h('button', { type: 'button', class: 'secondary small', onclick: () => editForm(f) }, '수정'),
            h('button', { type: 'button', class: 'danger small', disabled: f.used > 0, onclick: () => remove(f) }, '삭제'))))))))
      : h('p', { class: 'empty' }, '등록된 사용자 항목이 없습니다.'),
  ];
}

// ---- 공통코드 관리 (단계 + 코드 그룹 + 사용자 항목)
async function codes(box) {
  const [{ stages, groups }, fieldData] = await Promise.all([getJson('/api/admin/codes'), getJson('/api/admin/fields')]);
  const reload = () => { box.replaceChildren(); return codes(box); };
  const addInput = h('input', { type: 'text', name: 'name', required: true, maxlength: '20' });
  const patch = async (s, body, msg) => {
    try {
      await sendJson('PATCH', `/api/admin/codes/stages/${encodeURIComponent(s.id)}`, body);
      toast(msg);
      reload();
    } catch (err) {
      toast(err.message, 'error');
    }
  };
  box.append(h('h1', null, '공통코드 관리'),
    h('p', { class: 'note' }, '단계 이름은 대상자 관리의 검색 조건과 등록·수정 화면에 그대로 쓰입니다. 이름을 바꿔도 ID가 유지되어 기존 대상자의 단계 연결은 변하지 않습니다. 삭제 대신 "사용 안 함"으로 바꿀 수 있습니다.'),
    h('form', { class: 'toolbar card', onsubmit: async (e) => {
      e.preventDefault();
      try {
        await sendJson('POST', '/api/admin/codes/stages', { name: addInput.value });
        toast('단계를 추가했습니다.');
        reload();
      } catch (err) {
        toast(err.message, 'error');
      }
    } }, field('새 단계 이름', addInput), h('div', { class: 'actions' }, h('button', { type: 'submit' }, '단계 추가'))),
    h('div', { class: 'table-wrap', tabindex: '0', role: 'region', 'aria-label': '단계 목록' },
      h('table', null,
        h('thead', null, h('tr', null, ['ID', '단계 이름', '상태', '관리'].map((t) => h('th', { scope: 'col' }, t)))),
        h('tbody', null, stages.map((s) => {
          const input = h('input', { type: 'text', value: s.name, maxlength: '20', 'aria-label': `${s.id} 단계 이름` });
          return h('tr', null,
            h('td', { class: 'code' }, s.id),
            h('td', null, input),
            h('td', null, h('span', { class: `pill ${s.active ? '' : 'off'}` }, s.active ? '사용' : '사용 안 함')),
            h('td', null, h('div', { class: 'row-actions' },
              h('button', { type: 'button', class: 'secondary', onclick: () => patch(s, { name: input.value }, '이름을 저장했습니다.') }, '이름 저장'),
              h('button', { type: 'button', class: s.active ? 'danger' : 'secondary', onclick: () => patch(s, { active: !s.active }, s.active ? '사용 안 함으로 바꿨습니다.' : '다시 사용합니다.') }, s.active ? '사용 안 함' : '사용'))));
        })))),
    h('h2', null, '코드 그룹'),
    codeExcel(reload),
    ...codeGroups(groups ?? [], reload),
    ...customFields(fieldData, reload));
}

// ---- 설정
async function settings(box) {
  const cur = await getJson('/api/admin/settings');
  const input = h('input', { type: 'text', name: 'siteName', value: cur.siteName, required: true, maxlength: '40' });
  const days = ['일', '월', '화', '수', '목', '금', '토'];
  const weekStart = h('select', { name: 'weekStart' },
    days.map((d, i) => h('option', { value: String(i), selected: i === (cur.weekStart ?? 0) }, `${d}요일`)));
  const status = h('p', { class: 'status', role: 'status' });
  box.append(h('h1', null, '설정'),
    h('form', { class: 'card', onsubmit: async (e) => {
      e.preventDefault();
      try {
        const res = await sendJson('PUT', '/api/admin/settings', { siteName: input.value, weekStart: Number(weekStart.value) });
        document.getElementById('brand').textContent = res.siteName;
        status.className = 'status ok';
        status.textContent = '저장했습니다. 사이트 이름은 모든 접속자의 화면 상단에, 주 시작 요일은 활동 기록·통계의 주간 집계에 다음 조회부터 적용됩니다.';
      } catch (err) {
        status.className = 'status error';
        status.textContent = err.message;
      }
    } },
    field('사이트 이름 (상단·로그인 화면에 표시)', input),
    field('한 주의 시작 요일 (주간 집계 기준)', weekStart), status, h('button', { type: 'submit' }, '저장')));
}

runShell({ adminShell: true, navOf: (me) => me.adminMenu, views: { users, permissions, codes, settings } });
