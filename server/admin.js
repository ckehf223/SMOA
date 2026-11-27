import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { SCREENS, normalizePerm } from './permissions.js';
import { HttpError, hashPassword, validatePassword } from './security.js';
import { addStage, applyCanonical, domainError, putPreview, seoulDateOf, takePreview, updateStage } from './domain.js';

const require = createRequire(import.meta.url);
const M = require('./legacy/model.cjs');
const K = require('./legacy/codes.cjs');
// 엑셀 처리 모듈은 무거우므로 처음 쓸 때 읽는다.
const importer = () => require('./legacy/importer.cjs');

const USERNAME_RE = /^[a-z][a-z0-9_.-]{2,31}$/;
const CONTROL = /[\u0000-\u001F\u007F]/;
const bad = (msg) => new HttpError(400, msg);
const has = (o, k) => Object.hasOwn(o, k);
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
/** 사용자 항목 유형(기존 4.0.41 model.cjs TYPES와 같다). 화면 이름은 화면에서 붙인다. */
const FIELD_TYPES = ['text', 'number', 'date', 'select', 'boolean'];
const MAX_FIELDS = 30;
const IGNORED_SHEETS = new Set(['작성안내', '_선택목록']);
const MAX_CODE_IMPORT_ROWS = 10000;
const hasValue = (v) => v !== undefined && v !== null && v !== '' && v !== false;

function label(v, name, max) {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s || s.length > max || CONTROL.test(s)) throw bad(`${name}: 1~${max}자로 입력해 주세요.`);
  return s;
}

/** 관리자 전용 API. app.js가 auth:'admin'으로 가드하며, 이 모듈은 입력 검증과 잠금 방지 규칙을 맡는다. */
export function adminRoutes(store, sessions) {
  const R = (method, path, handler, extra = {}) => ({ method, path, auth: 'admin', handler, ...extra });
  const sessionKey = (ctx) => createHash('sha256').update(String(ctx.token ?? '')).digest('hex');
  const publicUser = (u) => ({
    id: u.id,
    username: u.username,
    displayName: u.displayName,
    role: u.role,
    districts: [...u.districts],
    active: u.active,
    root: u.root,
    createdAt: u.createdAt,
  });
  const roleId = (v) => {
    if (typeof v !== 'string' || !store.roles.some((r) => r.id === v)) throw bad('역할: 선택 항목을 확인해 주세요.');
    return v;
  };
  const districtIds = (v) => {
    if (!Array.isArray(v) || v.some((d) => typeof d !== 'string' || !store.districts.some((x) => x.id === d))) throw bad('구역: 선택 항목을 확인해 주세요.');
    return [...new Set(v)];
  };
  const activeAdmins = (exceptId) => [...store.users.values()].filter((u) => u.active && u.role === 'admin' && u.id !== exceptId).length;
  const userOr404 = (ctx) => {
    const u = store.users.get(ctx.params[0]);
    if (!u) throw new HttpError(404, '계정을 찾을 수 없습니다.');
    return u;
  };

  const settingsDto = () => {
    const saved = store.settings.weekStart;
    return { ...store.settings, weekStart: Number.isInteger(saved) && saved >= 0 && saved <= 6 ? saved : 0 };
  };
  const bool = (v) => {
    if (typeof v !== 'boolean') throw bad('상태 값을 확인해 주세요.');
    return v;
  };
  const itemDto = (i) => ({ id: i.id, value: i.value, label: i.label, aliases: [...i.aliases], active: i.active, order: i.order });
  const groupDto = (g) => ({
    id: g.id,
    label: g.label,
    system: g.system,
    active: g.active,
    items: [...g.items].sort((a, b) => a.order - b.order || a.label.localeCompare(b.label, 'ko', { numeric: true })).map(itemDto),
  });
  /** 요청 본문에서 항목 입력만 골라 검증한다. 생략한 값은 기존 항목 값을 유지한다(코드값은 만든 뒤 바꿀 수 없다). */
  function itemInput(g, b, old) {
    const max = g.id === 'activityPlace' ? 200 : 60;
    const out = { label: has(b, 'label') || !old ? label(b.label, '표시명', max) : old.label };
    if (has(b, 'value')) out.value = label(b.value, '코드값', 60);
    else if (old) out.value = old.value;
    if (has(b, 'aliases')) {
      if (!Array.isArray(b.aliases) || b.aliases.length > 30) throw bad('이전 표시명은 30개 이하의 목록이어야 합니다.');
      out.aliases = b.aliases.map((a) => label(a, '이전 표시명', 200));
    }
    out.active = has(b, 'active') ? bool(b.active) : (old?.active ?? true);
    if (has(b, 'order')) {
      if (!Number.isInteger(b.order) || b.order < 0 || b.order > 9999) throw bad('순서: 0~9999 사이 정수로 입력해 주세요.');
      out.order = b.order;
    } else if (old) out.order = old.order;
    return out;
  }
  /** 원본 작업 영역의 복사본에 적용하고 검증한 뒤 교체한다(applyCanonical). 4.0.41 검증 오류는 400이다. */
  function codeChange(ctx, apply) {
    try {
      return applyCanonical(store, (ws) => apply(ws, ctx.user.displayName));
    } catch (error) {
      throw domainError(error);
    }
  }

  // ---- 사용자 항목(대상자에 덧붙이는 입력 항목): 만든 뒤에는 유형과 코드 그룹을 바꿀 수 없다
  const usedCount = (ws, id) => ws.people.filter((p) => hasValue(p.custom?.[id])).length;
  const fieldDto = (ws, f) => ({ id: f.id, label: f.label, type: f.type, codeGroupId: f.codeGroupId ?? '', options: [...f.options], used: usedCount(ws, f.id) });
  const fieldOr404 = (ws, id) => {
    const f = ws.fields.find((x) => x.id === id);
    if (!f) throw new HttpError(404, '사용자 항목을 찾을 수 없습니다.');
    return f;
  };
  function optionList(v) {
    if (!Array.isArray(v) || v.length > 50) throw bad('선택지는 50개 이하의 목록이어야 합니다.');
    const list = v.map((o) => label(o, '선택지', 80));
    if (new Set(list).size !== list.length) throw bad('선택지가 중복되었습니다.');
    return list;
  }

  // ---- 공통코드 엑셀 가져오기 (공통코드 시트만. 미리보기 → 원본 버전이 같을 때만 한 번에 반영)
  async function readCodeRows(buffer) {
    try {
      importer().checkZip(buffer);
    } catch (error) {
      throw domainError(error);
    }
    const { default: ExcelJS } = await import('exceljs');
    const wb = new ExcelJS.Workbook();
    try {
      await wb.xlsx.load(buffer, { ignoreNodes: ['drawing', 'legacyDrawing', 'extLst'] });
    } catch {
      throw bad('엑셀 파일을 읽지 못했습니다. 공통코드 양식을 내려받아 사용해 주세요.');
    }
    const cellText = (v) => importer().cellText(v);
    const filled = (row) => row.values.some((v) => v !== null && v !== undefined && v !== '');
    const foreign = wb.worksheets.filter((s) => s.name !== '공통코드' && !IGNORED_SHEETS.has(s.name) && (() => {
      let found = false;
      s.eachRow((row, n) => { if (n > 1 && !found && filled(row)) found = true; });
      return found;
    })()).map((s) => s.name);
    if (foreign.length) throw bad(`이 화면에서는 공통코드 시트만 가져옵니다. 다음 시트의 내용은 가져올 수 없습니다: ${foreign.join(', ')}`);
    const sheet = wb.getWorksheet('공통코드');
    if (!sheet) throw bad('공통코드 시트가 없습니다. 공통코드 양식을 사용해 주세요.');
    if (sheet.actualRowCount > MAX_CODE_IMPORT_ROWS + 1) throw bad(`공통코드는 최대 ${MAX_CODE_IMPORT_ROWS.toLocaleString('ko-KR')}행까지 가져올 수 있습니다.`);
    const expected = importer().SHEETS['공통코드'];
    const headers = [];
    try {
      sheet.getRow(1).eachCell({ includeEmpty: true }, (cell, i) => { headers[i - 1] = cellText(cell.value); });
    } catch (error) {
      throw bad(`공통코드 머리글: ${error.message}`);
    }
    while (headers.length && headers.at(-1) === '') headers.pop();
    if (new Set(headers).size !== headers.length || headers.length !== expected.length || expected.some((h) => !headers.includes(h))) throw bad('공통코드: 열 이름이 양식과 다르거나 중복됩니다.');
    const rows = [];
    const errors = [];
    sheet.eachRow((row, index) => {
      if (index === 1 || !filled(row)) return;
      try {
        const d = Object.fromEntries(headers.map((h, i) => [h, cellText(row.getCell(i + 1).value)]));
        const state = d.사용상태 || '사용';
        const groupState = d.그룹상태 || '사용';
        if (!['사용', '보관'].includes(state) || !['사용', '보관'].includes(groupState)) throw new Error('공통코드 상태는 사용/보관으로 입력해 주세요.');
        let aliases = [];
        if (d.이전표시명JSON) {
          aliases = JSON.parse(d.이전표시명JSON);
          if (!Array.isArray(aliases) || !aliases.every((a) => typeof a === 'string')) throw new Error('이전표시명JSON은 문자 배열로 입력해 주세요.');
        }
        const order = d.정렬순서 === '' ? undefined : Number(d.정렬순서);
        if (order !== undefined && !Number.isFinite(order)) throw new Error('정렬순서는 숫자로 입력해 주세요.');
        rows.push({ groupId: d.그룹ID, groupLabel: d.그룹명, value: d.코드값, label: d.표시명, aliases, active: state === '사용', groupActive: groupState === '사용', order });
      } catch (error) {
        errors.push(`공통코드 ${index}행: ${error instanceof SyntaxError ? '이전표시명JSON 형식이 올바르지 않습니다.' : error.message}`);
      }
    });
    if (!rows.length && !errors.length) errors.push('가져올 공통코드 행이 없습니다.');
    return { rows, errors };
  }

  /** 공통코드 가져오기를 초안에 적용한다. 오류는 4.0.41 규칙 그대로 던진다. */
  function applyCodeRows(ws, rows) {
    const result = K.importRows(ws, rows);
    M.validateWorkspace(ws);
    return result;
  }
  const codeChangeLabel = (c) => ({
    kind: c.after.value === undefined ? '그룹' : '항목', // 그룹 변경에는 코드값이 없다
    status: c.before ? '수정' : '신규',
    group: c.groupId,
    value: c.after.value ?? '',
    label: c.after.label,
  });

  async function codeImportPreview(ctx) {
    const revision = store.workspace.revision;
    const { rows, errors } = await readCodeRows(ctx.file);
    ctx.recheck();
    let changes = [];
    if (!errors.length) {
      try {
        changes = applyCodeRows(structuredClone(store.workspace), rows).changes;
      } catch (error) {
        const known = error instanceof HttpError || (error && error.constructor === Error);
        errors.push(known ? String(error.message).slice(0, 300) : '공통코드를 확인하지 못했습니다.');
      }
    }
    if (store.workspace.revision !== revision) throw new HttpError(409, '파일을 읽는 사이 자료가 바뀌었습니다. 다시 시도해 주세요.');
    const canApply = !errors.length && changes.length > 0;
    return {
      previewId: canApply ? putPreview(store, ctx.user, 'codeImport', { rows, session: sessionKey(ctx) }) : null,
      canApply,
      expiresInSeconds: 900,
      errors: errors.slice(0, 100),
      totalErrors: errors.length,
      changes: changes.slice(0, 300).map(codeChangeLabel),
      totalChanges: changes.length,
      unchanged: rows.length - changes.length,
    };
  }

  function codeImportApply(ctx) {
    const id = typeof ctx.body.previewId === 'string' ? ctx.body.previewId : '';
    const data = takePreview(store, ctx.user, id, 'codeImport', { consume: false });
    if (data.session !== sessionKey(ctx)) throw new HttpError(403, '미리보기를 만든 로그인 세션에서만 반영할 수 있습니다. 다시 만들어 주세요.');
    const applied = codeChange(ctx, (ws, actor) => {
      const { changes } = applyCodeRows(ws, data.rows);
      if (!changes.length) throw bad('바뀌는 내용이 없습니다.');
      for (const c of changes) M.audit(ws, actor, '엑셀 공통코드 변경', c.after.id, c.before, { ...c.after, groupId: c.groupId });
      return changes.length;
    });
    store.previews.delete(id);
    return { applied };
  }

  return [
    // ---- 사용자 관리
    R('GET', '/api/admin/users', () => ({
      users: [...store.users.values()].map(publicUser),
      roles: store.roles,
      districts: store.districts,
    })),
    R('POST', '/api/admin/users', async (ctx) => {
      const b = ctx.body;
      const username = typeof b.username === 'string' ? b.username : '';
      if (!USERNAME_RE.test(username)) throw bad('아이디: 영문 소문자로 시작하는 3~32자(영문 소문자·숫자·._-)로 입력해 주세요.');
      const displayName = label(b.displayName, '이름', 50);
      const role = roleId(b.role);
      const districts = role === 'admin' ? [] : districtIds(b.districts);
      if (role !== 'admin' && districts.length === 0) throw bad('구역을 하나 이상 선택해 주세요.');
      validatePassword(b.password, username);
      const passwordHash = await hashPassword(b.password);
      ctx.recheck(); // 해시하는 동안 관리자 권한이 사라졌다면 만들지 않는다.
      if ([...store.users.values()].some((u) => u.username === username)) throw new HttpError(409, '이미 사용 중인 아이디입니다.');
      const user = { id: randomUUID(), username, displayName, role, districts, active: true, root: false, passwordHash, createdAt: new Date(store.now()).toISOString() };
      store.users.set(user.id, user);
      return { user: publicUser(user) };
    }),
    R('PATCH', '/api/admin/users/:id', (ctx) => {
      const u = userOr404(ctx);
      const b = ctx.body;
      const next = { displayName: u.displayName, role: u.role, districts: u.districts, active: u.active };
      if (has(b, 'displayName')) next.displayName = label(b.displayName, '이름', 50);
      if (has(b, 'role')) next.role = roleId(b.role);
      if (has(b, 'districts')) next.districts = districtIds(b.districts);
      if (has(b, 'active')) {
        if (typeof b.active !== 'boolean') throw bad('상태 값을 확인해 주세요.');
        next.active = b.active;
      }
      if (next.role === 'admin') next.districts = [];
      else if (next.districts.length === 0) throw bad('구역을 하나 이상 선택해 주세요.');

      const loses = next.role !== 'admin' || !next.active;
      if (u.root && loses) throw bad('기본 관리자 계정은 비활성화하거나 역할을 바꿀 수 없습니다.');
      if (u.id === ctx.user.id && (next.role !== u.role || !next.active)) throw bad('본인 계정의 역할 변경과 비활성화는 할 수 없습니다.');
      if (u.role === 'admin' && u.active && loses && activeAdmins(u.id) === 0) throw bad('활성 관리자가 한 명 이상 있어야 합니다.');

      Object.assign(u, next); // 세션은 요청마다 사용자 상태를 다시 읽으므로 역할·구역 변경은 즉시 적용된다.
      if (!u.active) sessions.destroyUser(u.id);
      return { user: publicUser(u) };
    }),
    R('POST', '/api/admin/users/:id/password', async (ctx) => {
      const u = userOr404(ctx);
      validatePassword(ctx.body.password, u.username);
      const hash = await hashPassword(ctx.body.password);
      ctx.recheck(); // 해시하는 동안 관리자 권한이 사라졌다면 바꾸지 않는다.
      u.passwordHash = hash;
      sessions.destroyUser(u.id, u.id === ctx.user.id ? ctx.token : undefined);
      return { ok: true };
    }),

    // ---- 접근 권한 관리
    R('GET', '/api/admin/permissions', () => ({
      roles: store.roles,
      screens: SCREENS,
      permissions: Object.fromEntries([...store.permissions].map(([role, perms]) => [role, perms])),
    })),
    R('PUT', '/api/admin/permissions/:role', (ctx) => {
      const role = ctx.params[0];
      if (role === 'admin') throw bad('관리자 역할의 권한은 변경할 수 없습니다.');
      if (!store.roles.some((r) => r.id === role)) throw new HttpError(404, '역할을 찾을 수 없습니다.');
      const screens = ctx.body.screens;
      if (!screens || typeof screens !== 'object' || Array.isArray(screens)) throw bad('권한 값을 확인해 주세요.');
      const next = { ...store.permissions.get(role) };
      for (const [id, p] of Object.entries(screens)) {
        if (!SCREENS.some((s) => s.id === id)) throw bad('알 수 없는 화면입니다.');
        if (!p || typeof p !== 'object' || ['access', 'read', 'write', 'export'].some((k) => has(p, k) && typeof p[k] !== 'boolean')) throw bad('권한 값을 확인해 주세요.');
        next[id] = normalizePerm(p, id);
      }
      store.permissions.set(role, next);
      return { role, permissions: next };
    }),

    // ---- 공통코드 관리 (단계)
    R('GET', '/api/admin/codes', () => ({ stages: store.stages, groups: K.catalog(store.workspace).groups.map(groupDto) })),
    // 단계는 작업 영역의 stages·stageNames·inactiveStages가 원본이다(웹 ID s1…은 고정 단계 ID에 대응).
    R('POST', '/api/admin/codes/stages', (ctx) => {
      const name = label(ctx.body.name, '단계 이름', 20);
      return { stage: addStage(store, ctx.user.displayName, name) };
    }),
    R('PATCH', '/api/admin/codes/stages/:id', (ctx) => {
      const stage = store.stages.find((s) => s.id === ctx.params[0]);
      if (!stage) throw new HttpError(404, '단계를 찾을 수 없습니다.');
      const b = ctx.body;
      const change = {};
      if (has(b, 'name')) change.name = label(b.name, '단계 이름', 20);
      if (has(b, 'active')) {
        if (typeof b.active !== 'boolean') throw bad('상태 값을 확인해 주세요.');
        change.active = b.active;
      }
      return { stage: updateStage(store, ctx.user.displayName, stage.id, change) }; // ID는 유지되어 기존 대상자 연결이 보존된다.
    }),

    // ---- 공통코드 그룹·항목 (기존 4.0.41 codes.cjs 규칙: 코드값 고정, 이전 표시명 보존, 사용 중 항목 삭제 차단)
    R('POST', '/api/admin/codes/groups', (ctx) => {
      const b = ctx.body;
      const input = { label: label(b.label, '그룹 이름', 60) };
      if (has(b, 'active')) input.active = bool(b.active);
      return codeChange(ctx, (ws, actor) => {
        const { before, after } = K.saveGroup(ws, input);
        M.audit(ws, actor, '공통코드 그룹 추가', after.id, before, after);
        return { group: groupDto(K.group(ws, after.id)) };
      });
    }),
    R('PATCH', '/api/admin/codes/groups/:id', (ctx) =>
      codeChange(ctx, (ws, actor) => {
        const old = K.group(ws, ctx.params[0]);
        if (!old) throw new HttpError(404, '코드 그룹을 찾을 수 없습니다.');
        const b = ctx.body;
        const input = { id: old.id, label: old.label, active: old.active };
        if (has(b, 'label')) input.label = label(b.label, '그룹 이름', 60);
        if (has(b, 'active')) input.active = bool(b.active);
        if (old.system && !input.active) throw bad('기본 코드 그룹은 보관할 수 없습니다. 항목을 사용 안 함으로 바꿔 주세요.');
        const { before, after } = K.saveGroup(ws, input);
        M.audit(ws, actor, '공통코드 그룹 수정', old.id, before, after);
        return { group: groupDto(K.group(ws, old.id)) };
      })),
    R('DELETE', '/api/admin/codes/groups/:id', (ctx) =>
      codeChange(ctx, (ws, actor) => {
        if (!K.group(ws, ctx.params[0])) throw new HttpError(404, '코드 그룹을 찾을 수 없습니다.');
        const { before } = K.removeGroup(ws, { id: ctx.params[0] });
        M.audit(ws, actor, '공통코드 그룹 삭제', before.id, { ...before, items: before.items.length }, null);
        return { ok: true };
      })),
    R('POST', '/api/admin/codes/groups/:id/items', (ctx) =>
      codeChange(ctx, (ws, actor) => {
        const g = K.group(ws, ctx.params[0]);
        if (!g) throw new HttpError(404, '코드 그룹을 찾을 수 없습니다.');
        const { groupId, before, after } = K.saveItem(ws, { groupId: g.id, ...itemInput(g, ctx.body, null) });
        M.audit(ws, actor, '공통코드 항목 추가', after.id, { groupId }, after);
        return { item: itemDto(after, before) };
      })),
    R('PATCH', '/api/admin/codes/groups/:id/items/:itemid', (ctx) =>
      codeChange(ctx, (ws, actor) => {
        const g = K.group(ws, ctx.params[0]);
        const old = g?.items.find((i) => i.id === ctx.params[1]);
        if (!old) throw new HttpError(404, '코드 항목을 찾을 수 없습니다.');
        const { groupId, before, after } = K.saveItem(ws, { groupId: g.id, id: old.id, ...itemInput(g, ctx.body, old) });
        if (JSON.stringify(before) !== JSON.stringify(after)) M.audit(ws, actor, '공통코드 항목 수정', after.id, { groupId, ...before }, { groupId, ...after });
        return { item: itemDto(after) };
      })),
    R('DELETE', '/api/admin/codes/groups/:id/items/:itemid', (ctx) =>
      codeChange(ctx, (ws, actor) => {
        const g = K.group(ws, ctx.params[0]);
        if (!g?.items.some((i) => i.id === ctx.params[1])) throw new HttpError(404, '코드 항목을 찾을 수 없습니다.');
        // 기존 기록·구성원·목표가 쓰는 값이면 codes.cjs가 거부한다(보관: 사용 안 함으로 전환).
        const { groupId, before } = K.removeItem(ws, { groupId: g.id, id: ctx.params[1] });
        M.audit(ws, actor, '공통코드 항목 삭제', before.id, { groupId, ...before }, null);
        return { ok: true };
      })),

    // ---- 공통코드 엑셀: 현재 코드가 채워진 양식을 내려받아 고친 뒤 다시 올린다(미리보기 후 반영)
    R('GET', '/api/admin/codes/export', async (ctx) => {
      const buffer = Buffer.from(await importer().createCodeWorkbook(store.workspace));
      ctx.recheck();
      return { raw: true, status: 200, headers: { 'Content-Type': XLSX, 'Content-Disposition': `attachment; filename="smoa-codes-${seoulDateOf(store.now()).replaceAll('-', '')}.xlsx"` }, body: buffer };
    }),
    R('POST', '/api/admin/codes/import/preview', codeImportPreview, { binary: true, maxBytes: 4 * 1024 * 1024 }),
    R('POST', '/api/admin/codes/import/apply', codeImportApply),

    // ---- 사용자 항목 관리 (기존 4.0.41 model.validateFields 규칙: 최대 30개, 이름 중복 금지, 선택 항목은 코드 그룹 또는 선택지)
    R('GET', '/api/admin/fields', () => ({
      fields: store.workspace.fields.map((f) => fieldDto(store.workspace, f)),
      types: FIELD_TYPES,
      groups: K.catalog(store.workspace).groups.map((g) => ({ id: g.id, label: g.label, active: g.active })),
      max: MAX_FIELDS,
    })),
    R('POST', '/api/admin/fields', (ctx) => {
      const b = ctx.body;
      const type = typeof b.type === 'string' ? b.type : '';
      if (!FIELD_TYPES.includes(type)) throw bad('항목 유형을 확인해 주세요.');
      const name = label(b.label, '항목 이름', 60);
      const groupId = typeof b.codeGroupId === 'string' ? b.codeGroupId : '';
      if (groupId && type !== 'select') throw bad('코드 그룹은 선택 항목에만 연결할 수 있습니다.');
      const options = type === 'select' && !groupId ? optionList(b.options) : [];
      if (type === 'select' && !groupId && !options.length) throw bad('선택지를 하나 이상 입력하거나 코드 그룹을 선택해 주세요.');
      return codeChange(ctx, (ws, actor) => {
        if (groupId && !K.group(ws, groupId)) throw bad('코드 그룹을 찾을 수 없습니다.');
        const field = { id: `f-${randomUUID().replaceAll('-', '').slice(0, 12)}`, label: name, type, ...(groupId ? { codeGroupId: groupId } : {}), options };
        ws.fields = M.validateFields([...ws.fields, field]);
        M.audit(ws, actor, '사용자 항목 추가', field.id, null, field);
        return { field: fieldDto(ws, field) };
      });
    }),
    R('PATCH', '/api/admin/fields/:id', (ctx) =>
      codeChange(ctx, (ws, actor) => {
        const old = fieldOr404(ws, ctx.params[0]);
        const b = ctx.body;
        if (has(b, 'type') && b.type !== old.type) throw bad('항목 유형은 만든 뒤 바꿀 수 없습니다. 새 항목을 만들어 주세요.');
        if (has(b, 'codeGroupId') && (b.codeGroupId || '') !== (old.codeGroupId ?? '')) throw bad('연결된 코드 그룹은 만든 뒤 바꿀 수 없습니다.');
        const next = { ...old, label: has(b, 'label') ? label(b.label, '항목 이름', 60) : old.label };
        if (has(b, 'options')) {
          if (old.type !== 'select' || old.codeGroupId) throw bad('선택지는 직접 입력하는 선택 항목에서만 바꿀 수 있습니다.');
          next.options = optionList(b.options);
          if (!next.options.length) throw bad('선택지를 하나 이상 남겨 주세요.');
          // 이미 대상자에게 입력된 선택지를 빼면 기존 값이 선택지 밖에 놓이므로 막는다.
          const inUse = new Set(ws.people.map((p) => p.custom?.[old.id]).filter(hasValue));
          const dropped = old.options.find((o) => !next.options.includes(o) && inUse.has(o));
          if (dropped !== undefined) throw bad(`선택지 '${dropped}'은(는) 대상자에게 입력되어 있어 뺄 수 없습니다.`);
        }
        const fields = M.validateFields(ws.fields.map((f) => (f.id === old.id ? next : f)));
        const after = fields.find((f) => f.id === old.id);
        if (JSON.stringify(old) !== JSON.stringify(after)) {
          ws.fields = fields;
          M.audit(ws, actor, '사용자 항목 수정', old.id, old, after);
        }
        return { field: fieldDto(ws, after) };
      })),
    R('DELETE', '/api/admin/fields/:id', (ctx) =>
      codeChange(ctx, (ws, actor) => {
        const old = fieldOr404(ws, ctx.params[0]);
        const used = usedCount(ws, old.id);
        if (used) throw bad(`${used}명의 대상자에게 입력된 값이 있어 삭제할 수 없습니다. 값을 정리한 뒤 삭제해 주세요.`);
        ws.fields = ws.fields.filter((f) => f.id !== old.id);
        for (const p of ws.people) if (p.custom) delete p.custom[old.id]; // 값이 없는 빈 칸만 남아 있으므로 함께 정리한다.
        M.audit(ws, actor, '사용자 항목 삭제', old.id, old, null);
        return { ok: true };
      })),

    // ---- 설정 (보낸 항목만 바꾼다)
    R('GET', '/api/admin/settings', () => settingsDto()),
    R('PUT', '/api/admin/settings', (ctx) => {
      const b = ctx.body;
      if (!has(b, 'siteName') && !has(b, 'weekStart')) throw bad('바꿀 설정 값을 보내 주세요.');
      const next = {};
      if (has(b, 'siteName')) next.siteName = label(b.siteName, '사이트 이름', 40);
      if (has(b, 'weekStart')) {
        if (!Number.isInteger(b.weekStart) || b.weekStart < 0 || b.weekStart > 6) throw bad('주 시작 요일: 0(일)~6(토) 중에서 선택해 주세요.');
        next.weekStart = b.weekStart;
      }
      Object.assign(store.settings, next); // 검증을 모두 마친 뒤에 적용하므로 일부만 바뀌지 않는다.
      return settingsDto();
    }),
  ];
}
