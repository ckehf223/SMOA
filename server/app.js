import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADMIN_MENU, SCREENS, can, effective, menuFor, scopeFor } from './permissions.js';
import { HttpError, Sessions, parseCookies, verifyPassword } from './security.js';
import { OPTIONS, createStore } from './store.js';
import { businessRoutes } from './business.js';
import { adminRoutes } from './admin.js';
import { organizationRoutes } from './organization.js';
import { callingRoutes } from './calling.js';
import { socialingRoutes } from './socialing.js';
import { dailyRoutes } from './daily.js';
import { reportsRoutes } from './reports.js';
import { recordsRoutes } from './records.js';
import { analyticsRoutes } from './analytics.js';

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(SERVER_DIR, '..', 'public');

const ACTION_NAMES = new Set(['read', 'write', 'export']);
const SCREEN_BY_ID = new Map(SCREENS.map((s) => [s.id, s]));

/**
 * 시작할 때 모든 라우트가 화면·동작을 선언했는지 확인한다.
 * 편집 화면 전용 조회(GET + write)는 의도된 안전한 읽기 작업이므로 허용한다(쓰기 권한은 그대로 필요).
 */
export function validateRoutes(routes) {
  const seen = new Set();
  for (const r of routes) {
    const key = `${r.method} ${r.path}`;
    if (seen.has(key)) throw new Error(`중복된 라우트: ${key}`);
    seen.add(key);
    if (r.binary && r.method !== 'POST') throw new Error(`binary 라우트는 POST만 가능합니다: ${key}`);
    if (r.auth === 'none' || r.path === '/api/me') continue;
    if (r.auth === 'admin' && !r.screen) continue; // 관리 화면 전용(관리자만)
    const screen = SCREEN_BY_ID.get(r.screen);
    if (!screen || !ACTION_NAMES.has(r.action)) throw new Error(`화면·동작 선언이 없는 라우트: ${key}`);
    if (!screen.actions.includes(r.action)) throw new Error(`화면이 지원하지 않는 동작입니다: ${key} (${r.screen}/${r.action})`);
  }
}
const PAGES = { '/login': 'login.html', '/': 'index.html', '/admin': 'admin.html' };
// 정적 자원: 소문자·하이픈 이름의 js/css와, 검토된 로고 PNG 한 개(smoa-mark.png)만 제공한다.
const ASSET_RE = /^\/assets\/([a-z-]+\.(?:js|css)|smoa-mark\.png)$/;
const MIME = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.png': 'image/png' };
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost']);
const COOKIE = 'smoa_sid';
const MAX_BODY = 64 * 1024;
// 긴 붙여넣기 본문(한글 20만 자 ≈ 600KiB)을 받는 경로만 JSON 상한을 넓힌다. 나머지는 MAX_BODY 유지.
const LARGE_JSON_BODY = 1280 * 1024;
const JSON_LIMITS = new Map([
  ['POST /api/daily/convert', LARGE_JSON_BODY],
  ['POST /api/daily/notice', LARGE_JSON_BODY],
  ['POST /api/calling/report/preview', LARGE_JSON_BODY],
]);
const MAX_XLSX = 8 * 1024 * 1024; // binary:true 라우트의 파일 상한(라우트가 maxBytes로 더 줄일 수 있다)
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const BINARY_TYPES = new Set([XLSX_MIME, 'application/octet-stream']);

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};

function toRegExp(p) {
  return new RegExp(`^${p.replace(/:[a-z]+/g, '([^/]+)')}$`);
}

/**
 * 로컬 메모리 모드 앱. 영속 저장소는 없고 127.0.0.1에서만 열린다.
 * opts: now(시계), idleMs, absoluteMs, loginMaxFailures, loginLockMs (테스트용 조정)
 */
export async function createApp(opts = {}) {
  const now = opts.now ?? Date.now;
  const store = await createStore(now);
  const sessions = new Sessions({ now, idleMs: opts.idleMs ?? 30 * 60_000, absoluteMs: opts.absoluteMs ?? 8 * 3_600_000 });
  const maxFailures = opts.loginMaxFailures ?? 5;
  const lockMs = opts.loginLockMs ?? 60_000;
  const failures = new Map();

  const all = [
    { method: 'GET', path: '/api/public/info', auth: 'none', handler: () => ({ siteName: store.settings.siteName }) },
    { method: 'POST', path: '/api/login', auth: 'none', handler: login },
    { method: 'POST', path: '/api/logout', auth: 'none', handler: logout },
    { method: 'GET', path: '/api/me', auth: 'user', handler: (ctx) => meFor(ctx.user) },
    ...businessRoutes(store),
    ...organizationRoutes(store),
    ...callingRoutes(store),
    ...socialingRoutes(store),
    ...dailyRoutes(store),
    ...reportsRoutes(store),
    ...recordsRoutes(store),
    ...analyticsRoutes(store),
    ...adminRoutes(store, sessions),
  ];
  validateRoutes(all);
  const routes = all.map((r) => ({ ...r, re: toRegExp(r.path) }));

  function meFor(user) {
    const scope = scopeFor(store, user);
    const isAdmin = user.role === 'admin';
    return {
      user: { id: user.id, username: user.username, displayName: user.displayName, role: user.role, roleName: store.roles.find((r) => r.id === user.role)?.name ?? '' },
      siteName: store.settings.siteName,
      isAdmin,
      menu: menuFor(store, user),
      perms: Object.fromEntries(SCREENS.map((s) => [s.id, effective(store, user, s.id)])),
      districts: store.districts.filter((d) => scope.has(d.id)),
      stages: store.stages,
      options: OPTIONS,
      adminMenu: isAdmin ? ADMIN_MENU : [],
    };
  }

  function scopeSnapshot(user) {
    return { id: user.id, role: user.role, districts: user.role === 'admin' ? null : [...scopeFor(store, user)].sort().join(',') };
  }
  function sameScope(snap, user) {
    const now2 = scopeSnapshot(user);
    return snap.id === now2.id && snap.role === now2.role && snap.districts === now2.districts;
  }

  function authenticate(req) {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    const session = sessions.get(token);
    if (!session) return null;
    const user = store.users.get(session.userId);
    if (!user || !user.active) {
      sessions.destroy(token);
      return null;
    }
    return { user, token };
  }

  const cookie = (value, maxAge) => `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict${maxAge === undefined ? '' : `; Max-Age=${maxAge}`}`;

  async function login(ctx) {
    const { username, password } = ctx.body;
    if (typeof username !== 'string' || typeof password !== 'string' || username.length > 64 || password.length > 128) throw new HttpError(400, '아이디와 비밀번호를 입력해 주세요.');
    const key = `${ctx.req.socket.remoteAddress}|${username}`;
    const f = failures.get(key);
    if (f && f.count >= maxFailures && now() < f.until) throw new HttpError(429, '로그인 시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.');
    const user = [...store.users.values()].find((u) => u.username === username);
    const checkedHash = user?.passwordHash;
    const ok = await verifyPassword(password, checkedHash ?? store.dummyHash);
    // 확인하는 동안 비밀번호가 재설정되었거나 계정이 꺼졌다면 세션을 만들지 않는다.
    if (!ok || !user || !user.active || user.passwordHash !== checkedHash) {
      const count = (f && now() < f.until ? f.count : 0) + 1;
      failures.set(key, { count, until: now() + lockMs });
      throw new HttpError(401, '아이디 또는 비밀번호가 올바르지 않습니다.');
    }
    failures.delete(key);
    sessions.destroy(parseCookies(ctx.req.headers.cookie)[COOKIE]);
    const token = sessions.create(user.id);
    return { raw: true, status: 200, headers: { 'Set-Cookie': cookie(token), 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify({ home: user.role === 'admin' ? '/admin' : '/' }) };
  }

  function logout(ctx) {
    sessions.destroy(parseCookies(ctx.req.headers.cookie)[COOKIE]);
    return { raw: true, status: 200, headers: { 'Set-Cookie': cookie('', 0), 'Content-Type': 'application/json; charset=utf-8' }, body: '{"ok":true}' };
  }

  function send(res, status, headers, body) {
    res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
    res.end(body);
  }
  const sendJson = (res, status, data) => send(res, status, { 'Content-Type': 'application/json; charset=utf-8' }, JSON.stringify(data));

  async function readBody(req, limit = MAX_BODY) {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) throw new HttpError(413, '요청이 너무 큽니다.');
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > limit) throw new HttpError(413, '요청이 너무 큽니다.');
      chunks.push(c);
    }
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    } catch {
      throw new HttpError(400, '요청 형식을 확인해 주세요.');
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, '요청 형식을 확인해 주세요.');
    return body;
  }

  /** 변경 요청 방어: 같은 출처(Origin)와 application/json만 허용한다. */
  function checkMutation(req) {
    let originHost = null;
    try {
      originHost = new URL(req.headers.origin ?? '').host;
    } catch {
      /* 아래에서 거부 */
    }
    if (!originHost || originHost !== req.headers.host) throw new HttpError(403, '허용되지 않은 요청 출처입니다.');
    if (!String(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) throw new HttpError(415, 'JSON 요청만 허용됩니다.');
  }

  /** 엑셀 업로드 전용(binary:true) 변경 요청 방어: 같은 출처와 엑셀·octet-stream 형식만 허용한다. */
  function checkBinaryMutation(req) {
    let originHost = null;
    try {
      originHost = new URL(req.headers.origin ?? '').host;
    } catch {
      /* 아래에서 거부 */
    }
    if (!originHost || originHost !== req.headers.host) throw new HttpError(403, '허용되지 않은 요청 출처입니다.');
    const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    if (!BINARY_TYPES.has(type)) throw new HttpError(415, '엑셀(.xlsx) 파일만 올릴 수 있습니다.');
  }

  // 열기 비밀번호가 걸린 엑셀은 ZIP이 아니라 Office 복합 문서(CFB) 머리글로 시작한다. 라우트가 명시한 경우에만 받는다.
  const CFB_SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

  async function readBinary(req, limit, allowEncryptedOffice = false) {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) throw new HttpError(413, '파일이 너무 큽니다.');
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > limit) throw new HttpError(413, '파일이 너무 큽니다.');
      chunks.push(c);
    }
    const data = Buffer.concat(chunks);
    if (!data.length) throw new HttpError(400, '파일이 비어 있습니다.');
    // .xlsx는 ZIP 형식(PK\x03\x04)이다.
    const isZip = data.length >= 4 && data[0] === 0x50 && data[1] === 0x4b && data[2] === 3 && data[3] === 4;
    const isProtectedOffice = allowEncryptedOffice && data.length >= CFB_SIGNATURE.length && data.subarray(0, CFB_SIGNATURE.length).equals(CFB_SIGNATURE);
    if (!isZip && !isProtectedOffice) throw new HttpError(400, '엑셀(.xlsx) 파일만 올릴 수 있습니다.');
    return data;
  }

  /** 현재 세션·관리자 역할·화면 권한을 확인하고 로그인 정보를 돌려준다. */
  function checkAccess(req, route) {
    const auth = authenticate(req);
    if (route.auth !== 'none' && !auth) throw new HttpError(401, '로그인이 필요합니다.');
    if (route.auth === 'admin' && auth.user.role !== 'admin') throw new HttpError(403, '관리자만 사용할 수 있습니다.');
    if (route.screen && !can(store, auth.user, route.screen, route.action)) throw new HttpError(403, '이 기능을 사용할 권한이 없습니다.');
    return auth;
  }

  async function handleApi(req, res, url) {
    const matches = routes.filter((r) => r.re.test(url.pathname));
    if (!matches.length) throw new HttpError(404, '찾을 수 없습니다.');
    const route = matches.find((r) => r.method === req.method);
    if (!route) throw new HttpError(405, '허용되지 않는 요청 방식입니다.');
    if (req.method !== 'GET') (route.binary ? checkBinaryMutation : checkMutation)(req);

    checkAccess(req, route); // 본문을 읽기 전에 먼저 거른다.
    const body = req.method === 'GET' ? {} : route.binary ? await readBinary(req, Math.min(route.maxBytes ?? MAX_XLSX, MAX_XLSX), route.allowEncryptedOffice === true) : await readBody(req, JSON_LIMITS.get(`${route.method} ${route.path}`) ?? MAX_BODY);
    const auth = checkAccess(req, route); // 본문을 기다리는 동안 바뀐 세션·권한을 다시 확인한다.
    // 요청 시작 시점의 신원과 구역 범위(객체 참조가 아닌 값 복사)를 기록해, 비동기 작업 뒤 달라졌는지 비교한다.
    const snapshot = auth && route.auth !== 'admin' ? scopeSnapshot(auth.user) : null;
    let params;
    try {
      params = route.re.exec(url.pathname).slice(1).map(decodeURIComponent);
    } catch {
      throw new HttpError(400, '요청 주소를 확인해 주세요.');
    }
    // recheck: 비밀번호 해시처럼 오래 걸리는 작업 뒤, 저장 직전에 다시 호출한다.
    // 권한뿐 아니라 같은 사용자·역할·구역 범위인지도 확인한다(관리자 전용 계정 라우트는 권한만 확인).
    const recheck = () => {
      const again = checkAccess(req, route);
      if (snapshot && !sameScope(snapshot, again.user)) throw new HttpError(403, '접근 권한 또는 구역이 변경되어 요청을 완료할 수 없습니다. 다시 시도해 주세요.');
      return again;
    };
    // binary 라우트는 body가 엑셀 Buffer이고 file도 같은 Buffer다.
    const result = await route.handler({ req, user: auth?.user, token: auth?.token, body, file: route.binary ? body : undefined, query: url.searchParams, params, recheck });
    if (route.screen) recheck(); // 화면 응답은 보내기 직전에 항상 다시 확인한다(핸들러가 빠뜨려도 이전 범위 자료가 나가지 않는다).
    if (result?.raw) send(res, result.status, result.headers, result.body);
    else sendJson(res, 200, result);
  }

  async function handlePage(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, '허용되지 않는 요청 방식입니다.');
    const redirect = (to) => send(res, 302, { Location: to }, '');
    const auth = authenticate(req);
    let file = PAGES[url.pathname];
    if (file) {
      if (url.pathname === '/login' && auth) return redirect(auth.user.role === 'admin' ? '/admin' : '/');
      if (url.pathname !== '/login' && !auth) return redirect('/login');
      if (url.pathname === '/admin' && auth.user.role !== 'admin') return redirect('/');
    } else {
      const m = ASSET_RE.exec(url.pathname);
      if (!m) throw new HttpError(404, '찾을 수 없습니다.');
      file = `assets/${m[1]}`;
    }
    let data;
    try {
      data = await readFile(path.join(PUBLIC_DIR, file));
    } catch {
      throw new HttpError(404, '찾을 수 없습니다.');
    }
    send(res, 200, { 'Content-Type': MIME[path.extname(file)] }, req.method === 'HEAD' ? '' : data);
  }

  const server = http.createServer(async (req, res) => {
    try {
      let hostname = '';
      try {
        hostname = new URL(`http://${req.headers.host}`).hostname;
      } catch {
        /* 아래에서 거부 */
      }
      if (!LOOPBACK_HOSTS.has(hostname)) throw new HttpError(403, '로컬 주소(127.0.0.1)로만 접속할 수 있습니다.');
      const url = new URL(req.url, 'http://local');
      if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
      else await handlePage(req, res, url);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error('서버 오류:', err?.name); // 요청 내용·비밀번호는 기록하지 않는다.
      if (!res.headersSent) sendJson(res, status, { error: status === 500 ? '서버 오류가 발생했습니다.' : err.message });
      else res.end();
    }
  });

  return {
    server,
    store,
    sessions,
    listen: (port = 0) =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => resolve(server.address().port));
      }),
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
