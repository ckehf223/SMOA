// identity 모듈: 프로그램 관리(programs) / 권한 패키지 관리(permissions) / 사용자 관리(users). 총관리자 전용 화면이다.
// 모든 값은 /api/admin/** 로 저장되며(서버가 총관리자 시스템 패키지인지 다시 검사한다) 가상 응답으로 성공을 흉내내지 않는다.
import { badge, clear, confirmAction, errorMessage, field, h, notice, select, table } from '../js/ui.js';
import { menuEditor } from './menu-editor.js';
import { mountPackages } from './permission-packages.js';

const ACTION_KEYS = ['access', 'read', 'write', 'export'];
const ACTION_LABEL = { access: '접근', read: '조회', write: '저장', export: '내보내기' };

export async function mount(ctx) {
  const views = { programs: mountPrograms, permissions: mountPackages, users: mountAccounts };
  const view = views[ctx.programId];
  if (!view) {
    ctx.container.append(notice('warn', '이 프로그램의 화면이 아직 없습니다.'));
    return;
  }
  await view(ctx);
}

function save(ctx, task, success, done) {
  return async () => {
    try {
      await task();
      ctx.toast(success, 'ok');
      await done();
    } catch (error) {
      ctx.toast(errorMessage(error), 'error');
    }
  };
}

// ---------------------------------------------------------------- 프로그램 관리
async function mountPrograms(ctx) {
  const root = ctx.container;
  let view = 'layout';
  let menuSelection = null;
  let renderId = 0;
  async function render(selection = menuSelection) {
    const id = ++renderId;
    menuSelection = selection;
    const [programs, layout, modules] = await Promise.all([
      ctx.api.get('/api/admin/programs'),
      ctx.api.get('/api/admin/menu-layout'),
      view === 'programs' ? ctx.api.get('/api/admin/modules') : null,
    ]);
    if (id !== renderId) return;
    clear(root);
    const tab = (key, label) => h('button', {
      class: view === key ? 'btn primary small' : 'btn small', type: 'button', text: label,
      'aria-pressed': String(view === key),
      onclick: async () => {
        if (view === key) return;
        view = key;
        try {
          await render();
        } catch (error) {
          ctx.toast(errorMessage(error), 'error');
        }
      },
    });
    root.append(h('div', { class: 'actions menu-edit-tabs', 'aria-label': '관리 화면 선택' },
      tab('layout', '메뉴 배치'), tab('programs', '프로그램 정보')));
    if (view === 'layout') {
      root.append(menuEditor({ ...ctx, menuSelection }, programs, layout, render));
      return;
    }
    root.append(notice('warn', '새 화면을 추가하려면 먼저 (1) 모듈 등록(backend ModulesConfig + frontend modules.js)과 (2) 페이지 파일 '
      + '(frontend/pages/<이름>.html)을 만든 뒤, 여기서 프로그램을 등록합니다. 프로그램 ID 는 등록 후 바꿀 수 없습니다.'));
    const formHost = h('div');
    const placement = new Map(layout.placements.map((item) => [item.programId, item]));
    root.append(h('div', { class: 'row' }, h('button', {
      class: 'btn primary', type: 'button', text: '프로그램 등록', onclick: () => showForm(null),
    })), formHost, table([
      { label: 'ID', key: 'programId' }, { label: '이름', key: 'name' },
      { label: '메뉴 경로', render: (p) => placement.get(p.programId)?.group || '최상위' },
      { label: '모듈', key: 'moduleId' }, { label: '페이지', key: 'pagePath' },
      { label: '동작', render: (p) => ['access', ...p.actions].map((a) => ACTION_LABEL[a]).join(', ') },
      { label: '순서', render: (p) => placement.get(p.programId)?.sortOrder ?? p.sortOrder },
      { label: '상태', render: (p) => h('span', {}, badge(p.active ? '사용' : '비활성', p.active ? 'ok' : 'error'), ' ',
        badge(p.moduleConnected ? '데이터 연결' : '연결 준비 중', p.moduleConnected ? 'ok' : 'warn')) },
      { label: '', render: (p) => h('button', { class: 'btn small', type: 'button', text: '수정', onclick: () => showForm(p) }) },
    ], programs));

    function showForm(program) {
      const editing = Boolean(program);
      const id = h('input', { type: 'text', maxlength: 64, value: program?.programId || '', disabled: editing });
      const name = h('input', { type: 'text', maxlength: 50, value: program?.name || '' });
      const page = h('input', { type: 'text', maxlength: 100, value: program?.pagePath || '/pages/' });
      const moduleSel = select(modules.map((m) => [m.moduleId, `${m.moduleId} — ${m.title}`]), program?.moduleId);
      const active = h('input', { type: 'checkbox', checked: program ? program.active : true, disabled: program?.superAdminOnly });
      const actionBoxes = ['read', 'write', 'export'].map((a) => h('input', {
        type: 'checkbox', value: a, checked: program ? program.actions.includes(a) : a === 'read',
      }));
      const form = h('div', { class: 'panel' },
        h('h3', { text: editing ? `프로그램 수정: ${program.programId}` : '프로그램 등록' }),
        h('div', { class: 'grid2' }, field('프로그램 ID', id), field('이름', name),
          field('페이지 경로', page), field('모듈', moduleSel)),
        h('div', { class: 'check-list' },
          ['read', 'write', 'export'].map((a, i) => h('label', {}, actionBoxes[i], ` ${ACTION_LABEL[a]}`)),
          h('label', {}, active, ' 사용(활성)')),
        h('div', { class: 'row' },
          h('button', {
            class: 'btn primary', type: 'button', text: '저장',
            onclick: save(ctx, async () => {
              const actions = actionBoxes.filter((b) => b.checked).map((b) => b.value);
              const body = {
                name: name.value, pagePath: page.value, moduleId: moduleSel.value, actions, active: active.checked,
              };
              if (editing) await ctx.api.patch(`/api/admin/programs/${encodeURIComponent(program.programId)}`, body);
              else await ctx.api.post('/api/admin/programs', { programId: id.value.trim(), category: 'BUSINESS', ...body });
            }, '프로그램을 저장했습니다.', async () => {
              await render();
              await ctx.refreshMenus?.();
            }),
          }),
          h('button', { class: 'btn', type: 'button', text: '취소', onclick: () => clear(formHost) })));
      clear(formHost).append(form);
    }
  }
  await render();
}

// ---------------------------------------------------------------- 사용자 관리
async function mountAccounts(ctx) {
  const root = ctx.container;
  async function render() {
    clear(root);
    const [accounts, packages, otpPolicy] = await Promise.all([
      ctx.api.get('/api/admin/accounts'),
      ctx.api.get('/api/admin/packages'),
      ctx.api.get('/api/auth/otp-policy').catch(() => null),
    ]);
    const otpRequired = otpPolicy?.required === true;
    const otpColumn = otpRequired && accounts.some((account) => typeof account.otpEnrolled === 'boolean')
      ? [{ label: 'OTP', render: (account) => badge(account.otpEnrolled ? '등록 완료' : '등록 대기', account.otpEnrolled ? 'ok' : 'warn') }]
      : [];
    const assignable = packages.filter((p) => p.active);
    const formHost = h('div');
    root.append(h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'button', text: '계정 추가', onclick: () => showForm(null) })),
      formHost, table([
        { label: '로그인 ID', key: 'username' }, { label: '표시명', key: 'displayName' },
        { label: '권한 패키지', key: 'packageName' },
        { label: '상태', render: (a) => badge(a.active ? '사용' : '비활성', a.active ? 'ok' : 'error') },
        ...otpColumn,
        { label: '', render: (a) => h('div', { class: 'actions' },
          h('button', { class: 'btn small', type: 'button', text: '수정', onclick: () => showForm(a) }),
          h('button', { class: 'btn small', type: 'button', text: '비밀번호 초기화', onclick: () => showReset(a) }),
          otpRequired && a.active && a.otpEnrolled !== true && a.id !== ctx.me?.accountId
            ? h('button', {
              class: 'btn small', type: 'button', text: 'OTP 등록 키 발급',
              onclick: (event) => issueOtpKey(a, event.currentTarget),
            })
            : null) },
      ], accounts));

    async function issueOtpKey(account, trigger) {
      if (!confirmAction(`${account.username} 계정의 OTP 등록 키를 발급하시겠습니까?`)) return;
      trigger.disabled = true;
      try {
        const issued = await ctx.api.post(`/api/admin/accounts/${encodeURIComponent(account.id)}/otp`);
        if (!trigger.isConnected) return;
        if (typeof issued?.secret !== 'string' || !/^[A-Z2-7]{16,128}$/.test(issued.secret)) {
          throw new Error('OTP 등록 키를 확인할 수 없습니다.');
        }
        showOtpKey(root, account.username, issued.secret, trigger);
      } catch (error) {
        ctx.toast(errorMessage(error), 'error');
      } finally {
        trigger.disabled = false;
      }
    }

    function showForm(account) {
      const editing = Boolean(account);
      const username = h('input', { type: 'text', maxlength: 32, value: account?.username || '', disabled: editing, autocomplete: 'off' });
      const displayName = h('input', { type: 'text', maxlength: 50, value: account?.displayName || '' });
      const password = h('input', { type: 'password', maxlength: 128, autocomplete: 'new-password' });
      const pkgOptions = assignable.map((p) => [p.packageId, p.name]);
      if (editing && !assignable.some((p) => p.packageId === account.packageId)) pkgOptions.unshift([account.packageId, `${account.packageName} (비활성)`]);
      const pkg = select(pkgOptions, account?.packageId);
      const active = h('input', { type: 'checkbox', checked: account ? account.active : true });
      clear(formHost).append(h('div', { class: 'panel' },
        h('h3', { text: editing ? `계정 수정: ${account.username}` : '계정 추가' }),
        h('div', { class: 'grid2' }, field('로그인 ID', username), field('표시명', displayName),
          editing ? null : field('초기 비밀번호', password, '12자 이상, 소문자·대문자·숫자·기호 중 3종류'),
          field('권한 패키지(하나)', pkg)),
        h('div', { class: 'check-list' }, h('label', {}, active, ' 사용(활성)')),
        h('div', { class: 'row' },
          h('button', {
            class: 'btn primary', type: 'button', text: '저장',
            onclick: save(ctx, async () => {
              if (editing) {
                await ctx.api.patch(`/api/admin/accounts/${encodeURIComponent(account.id)}`,
                  { displayName: displayName.value, active: active.checked, packageId: pkg.value });
              } else {
                await ctx.api.post('/api/admin/accounts', {
                  username: username.value.trim(), displayName: displayName.value, password: password.value,
                  packageId: pkg.value, active: active.checked,
                });
              }
              password.value = '';
            }, '계정을 저장했습니다.', render),
          }),
          h('button', { class: 'btn', type: 'button', text: '취소', onclick: () => clear(formHost) }))));
    }

    function showReset(account) {
      const password = h('input', { type: 'password', maxlength: 128, autocomplete: 'new-password' });
      clear(formHost).append(h('div', { class: 'panel' },
        h('h3', { text: `비밀번호 초기화: ${account.username}` }),
        notice('warn', '초기화하면 이 계정의 로그인 세션이 모두 종료됩니다.'),
        field('새 비밀번호', password),
        h('div', { class: 'row' },
          h('button', {
            class: 'btn primary', type: 'button', text: '초기화',
            onclick: save(ctx, async () => {
              await ctx.api.put(`/api/admin/accounts/${encodeURIComponent(account.id)}/password`, { newPassword: password.value });
              password.value = '';
            }, '비밀번호를 초기화했습니다.', render),
          }),
          h('button', { class: 'btn', type: 'button', text: '취소', onclick: () => clear(formHost) }))));
    }
  }
  await render();
}

function showOtpKey(root, username, secret, trigger) {
  const key = h('code', { class: 'otp-registration-key', text: secret, 'aria-label': 'OTP 등록 키' });
  const dialog = h('dialog', { class: 'otp-key-dialog panel', 'aria-labelledby': 'otp-key-title' },
    h('h3', { id: 'otp-key-title', text: 'OTP 등록 키' }),
    h('p', { text: `${username} 계정의 사용자에게 안전한 경로로 전달해 주세요.` }),
    key,
    h('ol', {},
      h('li', { text: '인증 앱에서 계정을 추가하고 설정 키를 직접 입력합니다.' }),
      h('li', { text: '시간 기반으로 설정하고 30초마다 바뀌는 6자리 코드를 확인합니다.' }),
      h('li', { text: 'SMOA에 로그인하면 등록이 완료됩니다.' })),
    h('div', { class: 'row' },
      h('button', { class: 'btn primary', type: 'button', text: '닫기', onclick: () => dialog.close() })));
  const removeKey = () => {
    key.textContent = '';
    dialog.remove();
    window.removeEventListener('pagehide', removeKey);
    window.removeEventListener('hashchange', removeKey);
    if (trigger.isConnected) trigger.focus();
  };
  dialog.addEventListener('close', removeKey, { once: true });
  window.addEventListener('pagehide', removeKey, { once: true });
  window.addEventListener('hashchange', removeKey, { once: true });
  root.append(dialog);
  dialog.showModal();
}
