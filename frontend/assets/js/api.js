// 공통 API 클라이언트(같은 출처 전용). 인증 토큰은 HttpOnly 세션 쿠키뿐이며 JS 는 CSRF 토큰만 메모리에 둔다.
// localStorage/sessionStorage 에는 아무것도 저장하지 않는다. 변경 요청(POST/PUT/PATCH/DELETE)은 자동 재시도하지 않는다.
export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

let csrf = null;

export async function refreshCsrf() {
  const response = await fetch('/api/auth/csrf', { credentials: 'same-origin', headers: { Accept: 'application/json' } });
  if (!response.ok) throw new ApiError(response.status, 'CSRF', '보안 토큰을 받지 못했습니다.');
  const body = await response.json();
  csrf = { header: body.headerName, token: body.token };
  return csrf;
}

async function parseError(response) {
  let code = '';
  let message = '요청을 처리하지 못했습니다.';
  try {
    const body = await response.json();
    code = body.code || '';
    message = body.message || message;
  } catch (ignore) { /* 본문 없음 */ }
  return new ApiError(response.status, code, message);
}

/** 401 은 한 번 알려서 로그인 화면으로 보낸다(요청을 다시 보내지 않는다). */
function handleUnauthorized(status) {
  if (status === 401) window.dispatchEvent(new CustomEvent('smoa:unauthorized'));
}

export async function request(method, url, body, options = {}) {
  const headers = { Accept: options.accept || 'application/json' };
  const init = { method, credentials: 'same-origin', headers };
  if (method !== 'GET' && method !== 'HEAD') {
    if (!csrf) await refreshCsrf();
    headers[csrf.header] = csrf.token;
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
  }
  const response = await fetch(url, init);
  if (!response.ok) {
    handleUnauthorized(response.status);
    // 세션 교체 등으로 토큰이 낡았을 수 있다: 다음 요청을 위해 갱신만 하고 이 요청은 재시도하지 않는다.
    if (response.status === 403 && method !== 'GET') refreshCsrf().catch(() => {});
    throw await parseError(response);
  }
  if (options.blob) return response.blob();
  if (response.status === 204) return null;
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

export const api = {
  get: (url) => request('GET', url),
  post: (url, body) => request('POST', url, body ?? {}),
  put: (url, body) => request('PUT', url, body ?? {}),
  patch: (url, body) => request('PATCH', url, body ?? {}),
  del: (url) => request('DELETE', url),
  /** 서버가 권한을 검사한 뒤 파일을 내려준다. Blob 으로 받아 저장한다(경로 노출·외부 이동 없음). */
  async download(url, filename, body) {
    const blob = await request(body === undefined ? 'GET' : 'POST', url, body, { blob: true, accept: '*/*' });
    const link = document.createElement('a');
    const objectUrl = URL.createObjectURL(blob);
    link.href = objectUrl;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  },
};

/** 로그인: csrf 획득 → formLogin → 새 csrf → me. */
export async function login(username, password, otp) {
  await refreshCsrf();
  const form = new URLSearchParams({ username, password });
  if (otp !== undefined) form.set('otp', otp);
  const response = await fetch('/api/auth/login', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', [csrf.header]: csrf.token },
    body: form,
  });
  if (!response.ok) throw await parseError(response);
  await refreshCsrf();
  return api.get('/api/auth/me');
}

/** 로그아웃 후 CSRF 토큰도 버린다. */
export async function logout() {
  try {
    if (!csrf) await refreshCsrf();
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin', headers: { [csrf.header]: csrf.token } });
  } finally {
    csrf = null;
  }
}

export const me = () => api.get('/api/auth/me');
