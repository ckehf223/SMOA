/** 공통 도우미. 화면은 DOM 노드로 만들어 사용자 입력이 HTML로 해석되지 않는다. */
import { renderNavigation } from './navigation.js';

export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k in el && k !== 'list') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  el.append(...kids.flat(Infinity).filter((c) => c != null && c !== false));
  if (tag === 'select' && attrs?.value != null) el.value = attrs.value;
  return el;
}

export async function api(method, url, body) {
  const mutating = method !== 'GET';
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: mutating ? { 'Content-Type': 'application/json' } : undefined,
    body: mutating ? JSON.stringify(body ?? {}) : undefined,
  });
  if (res.status === 401 && !url.startsWith('/api/login')) {
    location.href = '/login';
    throw new Error('로그인이 필요합니다.');
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw Object.assign(new Error(data.error || '요청을 처리하지 못했습니다.'), { status: res.status });
  }
  return res;
}
export const getJson = async (url) => (await api('GET', url)).json();
export const sendJson = async (method, url, body) => (await api(method, url, body)).json();

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** 엑셀 파일(File/Blob)을 그대로 올린다. 서버는 Origin과 이 Content-Type, 8MiB 상한을 확인한다. */
export async function postXlsx(url, file) {
  const res = await fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': XLSX_MIME }, body: file });
  if (res.status === 401) {
    location.href = '/login';
    throw new Error('로그인이 필요합니다.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || '파일을 처리하지 못했습니다.'), { status: res.status });
  return data;
}

/** GET 주소의 파일을 내려받는다. 파일 이름은 응답의 Content-Disposition을 따른다. */
export async function downloadFile(url, fallbackName = 'smoa.xlsx') {
  const res = await api('GET', url);
  const blobUrl = URL.createObjectURL(await res.blob());
  const a = h('a', { href: blobUrl, download: /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? fallbackName });
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(blobUrl);
}

let toastTimer;
export function toast(message, kind = 'ok') {
  document.querySelector('.toast')?.remove();
  const el = h('div', { class: `toast ${kind === 'error' ? 'error' : ''}`, role: kind === 'error' ? 'alert' : 'status' }, message);
  document.body.append(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), 4000);
}

export const nameOf = (list, id) => list.find((x) => x.id === id)?.name ?? '(알 수 없음)';

/** 대화상자 폼: onSubmit이 던진 오류는 대화상자 안에 표시한다. */
export function formDialog({ title, body, submitLabel = '저장', onSubmit }) {
  const status = h('p', { class: 'status error', role: 'alert' });
  const submitButton = h('button', { type: 'submit' }, submitLabel);
  const form = h('form', { method: 'dialog' }, h('h2', null, title), body, status,
    h('div', { class: 'buttons' },
      h('button', { type: 'button', class: 'secondary', onclick: () => dialog.close() }, '취소'),
      submitButton));
  const dialog = h('dialog', null, form);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (submitButton.disabled) return; // 저장 중 중복 제출 방지
    submitButton.disabled = true;
    status.textContent = '';
    try {
      await onSubmit(new FormData(form));
      dialog.close();
    } catch (err) {
      status.textContent = err.message;
      submitButton.disabled = false;
    }
  });
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
}

/**
 * 공통 셸: 메뉴와 권한은 항상 서버(/api/me)가 알려 준다. 화면 이동마다 다시 읽어 변경이 바로 반영된다.
 * navOf(me) → 메뉴 목록, views[id](container, me)
 */
export async function runShell({ navOf, views, adminShell }) {
  const nav = document.getElementById('nav');
  const main = document.getElementById('main');
  let me;
  let renderSeq = 0; // 빠르게 메뉴를 바꿀 때 늦게 끝난 이전 화면이 새 화면을 덮어쓰지 않도록 순번을 둔다.
  let shownId = null;

  document.getElementById('logout').addEventListener('click', async () => {
    try { await api('POST', '/api/logout'); } finally { location.href = '/login'; }
  });

  async function render() {
    const seq = ++renderSeq;
    const stale = () => seq !== renderSeq;
    try {
      me = await getJson('/api/me');
    } catch (err) {
      if (!stale()) main.replaceChildren(h('p', { class: 'status error', role: 'alert' }, err.message));
      return;
    }
    if (stale()) return;
    if (adminShell && !me.isAdmin) { location.href = '/'; return; }
    document.title = `${me.siteName} ${adminShell ? '관리' : '업무'}`;
    document.getElementById('brand').textContent = me.siteName;
    document.getElementById('who').textContent = `${me.user.displayName} (${me.user.roleName})`;
    document.getElementById('avatar')?.replaceChildren(Array.from(me.user.displayName)[0] ?? '');
    document.getElementById('switch').replaceChildren(
      me.isAdmin ? h('a', { href: adminShell ? '/' : '/admin' }, adminShell ? '업무 화면' : '관리 화면') : '');

    const items = navOf(me);
    let id = location.hash.replace(/^#\//, '');
    if (!items.some((i) => i.id === id)) {
      id = items[0]?.id ?? '';
      if (id) history.replaceState(null, '', `#/${id}`);
    }
    // 메뉴: navigation.js가 서버가 허용한 items와 이 브라우저의 메뉴 구성을 교집합으로 그린다(스크롤·초점 유지 포함).
    await renderNavigation(nav, { items, activeId: id, scope: encodeURIComponent(String(me.user.username ?? '').normalize('NFC').trim().toLowerCase()), tree: !adminShell, isCurrent: () => !stale() });
    if (stale()) return;
    document.getElementById('crumb')?.replaceChildren(items.find((i) => i.id === id)?.label ?? '');
    if (id !== shownId) { shownId = id; window.scrollTo(0, 0); } // 다른 화면으로 옮길 때만 맨 위에서 시작
    if (!id) {
      main.replaceChildren(h('div', { class: 'card empty' }, '사용할 수 있는 화면이 없습니다. 관리자에게 접근 권한을 요청해 주세요.'));
      return;
    }
    if (!adminShell && me.perms?.[id] && !me.perms[id].read) {
      main.replaceChildren(h('div', { class: 'card empty' }, '이 화면은 열 수 있지만 읽기 권한이 없어 자료를 볼 수 없습니다. 관리자에게 읽기 권한을 요청해 주세요.'));
      return;
    }
    main.replaceChildren(h('p', { class: 'status' }, '불러오는 중…'));
    try {
      if (typeof views[id] !== 'function') throw new Error('이 화면을 불러오지 못했습니다. 페이지를 새로 고쳐 주세요.');
      const container = h('div');
      await views[id](container, me);
      if (stale()) return;
      decoratePageHead(container, me);
      main.replaceChildren(container);
      main.focus({ preventScroll: true });
    } catch (err) {
      if (stale()) return;
      main.replaceChildren(h('p', { class: 'status error', role: 'alert' }, err.message),
        h('button', { type: 'button', class: 'secondary', onclick: render }, '다시 불러오기'));
    }
  }
  window.addEventListener('hashchange', render);
  render();
}

/**
 * 화면의 첫 제목(h1)을 머리글 띠(.page-head)로 묶는다. 제목·버튼 노드와 이벤트는 그대로 두고 감싸는 요소의 class만 더한다.
 * - h1이 최상위에 있으면 그 자리에서 div로 감싼다(폼·표·카드는 감싸지 않는다).
 * - h1이 제목과 버튼만 담은 최상위 줄(.toolbar 등)에 있으면 그 줄을 머리글로 쓴다.
 * - 그 밖의 깊은 위치(카드·폼 안)는 건드리지 않는다.
 */
function decoratePageHead(container, me) {
  const h1 = container.querySelector('h1');
  if (!h1 || h1.closest('.page-head')) return;
  let head;
  if (h1.parentElement === container) {
    head = document.createElement('div');
    container.insertBefore(head, h1);
    head.append(h1);
  } else if (h1.parentElement.parentElement === container
    && !h1.parentElement.querySelector('form, table, .card, input, select, textarea')) {
    head = h1.parentElement;
  } else if (h1.parentElement.matches('.dashboard-root')) {
    head = document.createElement('div');
    h1.parentElement.insertBefore(head, h1);
    head.append(h1);
  } else {
    return;
  }
  head.classList.add('page-head');
  if (h1.parentElement.closest('.dashboard-root') && !head.querySelector('.page-head-sub')) {
    const sub = document.createElement('p');
    sub.className = 'page-head-sub';
    sub.textContent = me.isAdmin
      ? '전체 지역의 참여와 실적을 주별·월별로 확인하세요'
      : '배정된 지역의 참여와 실적을 주별·월별로 확인하세요';
    h1.after(sub);
  }
}
