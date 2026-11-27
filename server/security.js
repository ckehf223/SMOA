import { scrypt, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  const [alg, salt, key] = String(stored).split('$');
  if (alg !== 'scrypt' || !salt || !key) return false;
  const expected = Buffer.from(key, 'base64');
  const actual = await scryptAsync(password, Buffer.from(salt, 'base64'), expected.length);
  return timingSafeEqual(actual, expected);
}

export function validatePassword(password, username) {
  if (typeof password !== 'string' || password.length < 10 || password.length > 128) {
    throw new HttpError(400, '비밀번호는 10자 이상 128자 이하로 입력해 주세요.');
  }
  if (username && password.toLowerCase().includes(username.toLowerCase())) {
    throw new HttpError(400, '비밀번호에 아이디를 포함할 수 없습니다.');
  }
}

/** 서버 측 세션: 토큰은 해시로만 보관하고, 유휴·절대 만료를 서버에서 판단한다. */
export class Sessions {
  #map = new Map();

  constructor({ now = Date.now, idleMs, absoluteMs }) {
    this.now = now;
    this.idleMs = idleMs;
    this.absoluteMs = absoluteMs;
  }

  #key(token) {
    return createHash('sha256').update(token).digest('hex');
  }

  create(userId) {
    const token = randomBytes(32).toString('base64url');
    const t = this.now();
    this.#map.set(this.#key(token), { userId, created: t, seen: t });
    return token;
  }

  get(token) {
    if (typeof token !== 'string' || token.length > 100) return null;
    const key = this.#key(token);
    const s = this.#map.get(key);
    if (!s) return null;
    const t = this.now();
    if (t - s.created > this.absoluteMs || t - s.seen > this.idleMs) {
      this.#map.delete(key);
      return null;
    }
    s.seen = t;
    return s;
  }

  destroy(token) {
    if (typeof token === 'string') this.#map.delete(this.#key(token));
  }

  destroyUser(userId, exceptToken) {
    const keep = exceptToken ? this.#key(exceptToken) : null;
    for (const [key, s] of this.#map) {
      if (s.userId === userId && key !== keep) this.#map.delete(key);
    }
  }
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}
