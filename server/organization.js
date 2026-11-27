import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { scopeFor } from './permissions.js';
import { HttpError } from './security.js';
import { commitWorkspace, domainError, legacyStageId, putPreview, regionLabel, sanitizePhoneText, scopedWorkspace, seoulDateOf, takePreview, webStageId } from './domain.js';

const require = createRequire(import.meta.url);
const M = require('./legacy/model.cjs');
const O = require('./legacy/organization.cjs');
const K = require('./legacy/codes.cjs');
const G = require('./legacy/goals.cjs');
// 엑셀 처리 모듈은 무거우므로 처음 쓸 때 읽는다.
const importer = () => require('./legacy/importer.cjs');

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const bad = (msg) => new HttpError(400, msg);
const safeCell = (v) => (typeof v === 'string' && /^[=+\-@\t\r]/.test(v) ? `'${v}` : v);
const isAdmin = (ctx) => ctx.user.role === 'admin';
const DAY = 86_400_000;
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const PERIOD_UNITS = ['week', 'month', 'custom'];
const MAX_GOAL_ROWS = 1000;

function pick(body, keys) {
  const out = {};
  for (const k of keys) if (Object.hasOwn(body, k)) out[k] = body[k];
  return out;
}

async function workbook(sheets) {
  // 값은 await 전에 복사된 상태로 받는다.
  const { default: ExcelJS } = await import('exceljs');
  const wb = new ExcelJS.Workbook();
  for (const s of sheets) {
    const ws = wb.addWorksheet(s.name);
    ws.columns = s.columns.map(([header, key, width]) => ({ header, key, width }));
    ws.getRow(1).font = { bold: true };
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    for (const row of s.rows) ws.addRow(Object.fromEntries(Object.entries(row).map(([k, v]) => [k, safeCell(v)])));
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const xlsxResponse = (body, name) => ({ raw: true, status: 200, headers: { 'Content-Type': XLSX, 'Content-Disposition': `attachment; filename="${name}"` }, body });

// ---- 기간 계산 (기존 period-goals.js의 주·월·직접 지정 규칙)
/** anchor 날짜가 속한 주(weekStart 요일 시작) 또는 달의 처음과 끝. */
export function periodRange(unit, anchor, weekStart = 0) {
  const t = Date.parse(`${anchor}T00:00:00Z`);
  if (unit === 'week') {
    const start = t - ((new Date(t).getUTCDay() - weekStart + 7) % 7) * DAY;
    return { from: isoDay(start), to: isoDay(start + 6 * DAY) };
  }
  const d = new Date(t);
  return { from: isoDay(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)), to: isoDay(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)) };
}

/** 선택 기간의 바로 앞 기간. 직접 지정은 같은 일수만큼 앞선다. */
export function previousGoalRange({ periodUnit, from, to }, weekStart = 0) {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) throw new Error('목표 기간을 확인하세요.');
  const last = isoDay(start - DAY);
  if (periodUnit === 'week' || periodUnit === 'month') return periodRange(periodUnit, last, weekStart);
  const length = end - start + DAY;
  return { from: isoDay(start - length), to: last };
}

const orgHeaderSets = () => importer().SHEETS;
const ORG_SHEETS = ['조직', '구성원'];
const IGNORED_SHEETS = new Set(['작성안내', '_선택목록']);
const MAX_ORG_IMPORT_ROWS = 10000;
const NODE_FIELD_NAMES = { name: '이름', type: '유형', parentId: '상위 조직', leaderId: '책임자', leaderTitle: '책임자 호칭', reportRegion: '데이터 구역명', active: '상태' };
const MEMBER_FIELD_NAMES = { name: '이름', unitId: '소속 조직', position: '직책', className: '반', employment: '직업 구분', status: '상태', notes: '비고' };

/**
 * 조직·구성원과 구역·반 목표 API.
 * - 조회·내보내기는 사용자 범위로 자른 복사본(scopedWorkspace)만 쓴다.
 * - 조직·구성원 쓰기와 엑셀 가져오기는 관리자 전용이다(조직은 구역 범위의 경계 자체이므로 역할별 위임은 아직 없다).
 * - 목표 쓰기는 배정 구역의 목표만 가능하며, 그 규칙은 commitWorkspace가 다시 확인한다.
 * - 직전 기간 복사와 조직 가져오기는 미리보기를 사용자·세션·구역 범위·원본 버전에 묶고, 반영은 한 번의 커밋으로 끝낸다.
 */
export function organizationRoutes(store) {
  const boundIds = () => new Set(store.districts.map((d) => d.id));
  const districtNames = () => new Set(store.districts.map((d) => d.name));
  const weekStart = () => (Number.isInteger(store.settings.weekStart) && store.settings.weekStart >= 0 && store.settings.weekStart <= 6 ? store.settings.weekStart : 0);
  const sessionKey = (ctx) => createHash('sha256').update(String(ctx.token ?? '')).digest('hex');

  /** 구역 연동 조직이 바뀌었거나, 연동되지 않은 조직이 구역 이름을 쓰면 사유 목록을 돌려준다. */
  function organizationViolations(before, after) {
    const reasons = [];
    const old = new Map(before.nodes.map((n) => [n.id, n]));
    for (const id of boundIds()) {
      const prev = old.get(id);
      const next = after.nodes.find((n) => n.id === id);
      if (!prev || !next) continue;
      if (['name', 'type', 'reportRegion', 'active'].some((k) => prev[k] !== next[k])) reasons.push(`'${prev.name}'은(는) 구역과 연동된 조직이라 이름·유형·구역명·사용 상태를 바꿀 수 없습니다.`);
    }
    for (const n of after.nodes) {
      const label = regionLabel(n);
      if (label && districtNames().has(label) && !boundIds().has(n.id)) reasons.push(`'${label}'은(는) 연동된 구역 이름이라 다른 조직에 쓸 수 없습니다.`);
    }
    return reasons;
  }

  /** 초안(복사본)에 변경을 적용하고 commitWorkspace로 합친다. */
  function mutate(ctx, apply) {
    try {
      const draft = scopedWorkspace(store, ctx.user);
      const out = apply(draft, ctx.user.displayName);
      for (const n of draft.organization.nodes) {
        const label = regionLabel(n);
        if (label && districtNames().has(label) && !boundIds().has(n.id)) throw bad(`'${label}'은(는) 연동된 구역 이름이라 다른 조직에 쓸 수 없습니다.`);
      }
      return { out, result: commitWorkspace(store, ctx.user, draft) };
    } catch (error) {
      throw domainError(error);
    }
  }

  // ---- 조직 조회
  function view(ctx) {
    const ws = scopedWorkspace(store, ctx.user);
    const org = ws.organization;
    const admin = isAdmin(ctx);
    const scope = scopeFor(store, ctx.user);
    const regions = new Set(store.districts.filter((d) => scope.has(d.id)).map((d) => d.name));
    const byId = new Map(org.nodes.map((n) => [n.id, n]));
    const inside = (n) => {
      for (let cur = n, i = 0; cur && i < 14; cur = byId.get(cur.parentId), i++) if (regions.has(regionLabel(cur))) return true;
      return false;
    };
    const memberName = new Map(org.members.map((m) => [m.id, m.name]));
    const counts = new Map();
    for (const m of org.members) counts.set(m.unitId, (counts.get(m.unitId) ?? 0) + 1);
    const introduced = new Map();
    for (const p of ws.people) if (p.introducerId) introduced.set(p.introducerId, (introduced.get(p.introducerId) ?? 0) + 1);
    const leads = new Map();
    for (const n of org.nodes) if (n.leaderId) leads.set(n.leaderId, [...(leads.get(n.leaderId) ?? []), `${n.name} ${n.leaderTitle}`]);
    const bound = boundIds();
    const sortNodes = (parentId, depth) =>
      org.nodes
        .filter((n) => n.parentId === parentId)
        .sort((a, b) => a.name.localeCompare(b.name, 'ko', { numeric: true }))
        .flatMap((n) => [{ n, depth }, ...sortNodes(n.id, depth + 1)]);
    const ordered = [...sortNodes('', 0), ...org.nodes.filter((n) => n.parentId && !byId.has(n.parentId)).map((n) => ({ n, depth: 0 }))];
    const opt = (key) => K.options(ws, key).map(([value, label]) => ({ value, label }));
    // 별칭으로 저장된 값도 현재 코드값으로 모아 보여 준다(필터가 같은 값끼리 묶이도록).
    const code = (key, v) => K.find(ws, key, v)?.value || v;
    const members = org.members
      .map((m) => {
        const className = code('className', m.className);
        const employment = code('employment', m.employment);
        const position = code('position', m.position);
        return {
          id: m.id, code: m.code, name: m.name, unitId: m.unitId, unitPath: O.pathName(org, m.unitId),
          position, positionLabel: K.label(ws, 'position', position), className, classLabel: K.label(ws, 'className', className),
          employment, employmentLabel: K.label(ws, 'employment', employment), status: m.status, notes: sanitizePhoneText(m.notes),
          linkedPeople: introduced.get(m.id) ?? 0, leads: leads.get(m.id) ?? [],
        };
      })
      .sort((a, b) => a.unitPath.localeCompare(b.unitPath, 'ko', { numeric: true }) || a.name.localeCompare(b.name, 'ko', { numeric: true }));
    return {
      editable: admin,
      nodes: ordered.map(({ n, depth }) => ({
        id: n.id, code: n.code, name: n.name, type: n.type, parentId: n.parentId, depth: Math.min(depth, 11),
        leaderId: n.leaderId, leaderName: memberName.get(n.leaderId) ?? '', leaderTitle: n.leaderTitle,
        reportRegion: n.reportRegion, active: n.active, memberCount: counts.get(n.id) ?? 0,
        linked: bound.has(n.id), context: !admin && !inside(n), path: O.pathName(org, n.id),
      })),
      members,
      metrics: { nodes: org.nodes.filter((n) => n.active).length, members: org.members.length, linkedPeople: ws.people.filter((p) => p.introducerId).length },
      options: { className: opt('className'), employment: opt('employment'), position: opt('position') },
    };
  }

  const nodeFields = ['code', 'name', 'type', 'parentId', 'leaderId', 'leaderTitle', 'reportRegion', 'active'];
  const memberFields = ['code', 'name', 'unitId', 'position', 'className', 'employment', 'status', 'notes'];

  function saveNode(ctx) {
    const id = ctx.params[0];
    return mutate(ctx, (draft, actor) => {
      const before = id ? draft.organization.nodes.find((n) => n.id === id) : null;
      if (id && !before) throw new HttpError(404, '조직을 찾을 수 없습니다.');
      const input = { ...(before ?? {}), ...pick(ctx.body, nodeFields), ...(id ? { id } : {}) };
      if (typeof input.active !== 'boolean' && input.active !== undefined) throw bad('조직 사용 상태를 확인해 주세요.');
      if (before && boundIds().has(before.id)) {
        for (const k of ['name', 'type', 'reportRegion', 'active']) {
          if (input[k] !== before[k]) throw bad('구역과 연동된 조직은 이름·유형·구역명·사용 상태를 바꿀 수 없습니다.');
        }
      }
      // 구역을 새로 만들면 일보 구역명은 조직 이름을 따른다(기존 프로그램과 같다).
      if (!before && input.type === '구역' && !input.reportRegion) input.reportRegion = String(input.name ?? '').trim();
      const { after } = O.saveNode(draft, input);
      M.audit(draft, actor, id ? '조직 수정' : '조직 등록', after.id, before, after);
      return after.id;
    });
  }

  function saveMember(ctx) {
    const id = ctx.params[0];
    return mutate(ctx, (draft, actor) => {
      const before = id ? draft.organization.members.find((m) => m.id === id) : null;
      if (id && !before) throw new HttpError(404, '구성원을 찾을 수 없습니다.');
      const fields = pick(ctx.body, memberFields);
      // 화면에는 연락처 모양 문장이 가려진 채 나가므로, 가려진 그대로 돌아온 비고는 기존 값을 유지한다.
      if (before && typeof fields.notes === 'string' && fields.notes === sanitizePhoneText(before.notes)) delete fields.notes;
      const input = { ...(before ?? {}), ...fields, ...(id ? { id } : {}) };
      // 소속이 바뀌면 발령일·사유를 이력에 남긴다.
      let transfer = null;
      if (before && input.unitId !== before.unitId) {
        const date = ctx.body.transferDate === undefined || ctx.body.transferDate === '' ? seoulDateOf(store.now()) : ctx.body.transferDate;
        const reason = ctx.body.transferReason ?? '';
        if (typeof date !== 'string' || typeof reason !== 'string') throw bad('발령일과 사유를 확인해 주세요.');
        transfer = { date: M.date(date), reason: M.text(reason, 200), fromPath: O.pathName(draft.organization, before.unitId), toPath: '' };
      }
      const { before: b, after } = O.saveMember(draft, input);
      if (transfer) transfer.toPath = O.pathName(draft.organization, after.member.unitId);
      M.audit(draft, actor, id ? '구성원 수정' : '구성원 등록', after.member.id, b, transfer ? { ...after, transfer } : after);
      return after.member.id;
    });
  }

  /** 구성원의 소속 변경 이력. 조회 범위 안의 구성원만 볼 수 있고, 범위 밖 조직 이름은 알려 주지 않는다. */
  function transfers(ctx) {
    const ws = scopedWorkspace(store, ctx.user);
    const member = ws.organization.members.find((m) => m.id === ctx.params[0]);
    if (!member) throw new HttpError(404, '구성원을 찾을 수 없습니다.');
    const admin = isAdmin(ctx);
    const known = new Set(ws.organization.nodes.map((n) => n.id));
    const pathOf = (unitId, stored) => (admin ? stored || (known.has(unitId) ? O.pathName(ws.organization, unitId) : '') : known.has(unitId) ? O.pathName(ws.organization, unitId) : '(배정 구역 밖 조직)');
    const items = ws.history
      .filter((h) => h.target === member.id)
      .map((h) => ({ h, from: h.before?.member ?? h.before, to: h.after?.member ?? h.after }))
      .filter(({ from, to }) => from?.unitId && to?.unitId && from.unitId !== to.unitId)
      .map(({ h, from, to }) => ({
        date: h.after?.transfer?.date ?? String(h.at).slice(0, 10),
        fromPath: pathOf(from.unitId, h.after?.transfer?.fromPath),
        toPath: pathOf(to.unitId, h.after?.transfer?.toPath),
        reason: h.after?.transfer?.reason || '소속 변경',
        actor: h.actor,
      }))
      .reverse();
    return { items };
  }

  // ---- 조직 엑셀 가져오기 (관리자 전용: 조직·구성원 시트만 읽고, 다른 시트에 자료가 있으면 거부한다)
  const cellText = (v) => importer().cellText(v);
  const hasRows = (sheet) => {
    let found = false;
    sheet.eachRow((row, n) => {
      if (n > 1 && !found && row.values.some((v) => v !== null && v !== undefined && v !== '')) found = true;
    });
    return found;
  };

  async function parseOrganizationFile(buffer) {
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
      throw bad('엑셀 파일을 읽지 못했습니다. 조직 양식을 내려받아 사용해 주세요.');
    }
    const errors = [];
    const rows = { 조직: [], 구성원: [] };
    const foreign = wb.worksheets.filter((s) => !ORG_SHEETS.includes(s.name) && !IGNORED_SHEETS.has(s.name) && hasRows(s)).map((s) => s.name);
    if (foreign.length) throw bad(`이 화면에서는 조직·구성원 시트만 가져옵니다. 다음 시트의 내용은 가져올 수 없습니다: ${foreign.join(', ')}`);
    let total = 0;
    for (const name of ORG_SHEETS) {
      const sheet = wb.getWorksheet(name);
      if (!sheet) continue;
      if (sheet.actualRowCount > MAX_ORG_IMPORT_ROWS + 1) {
        errors.push(`${name}: 시트당 최대 ${MAX_ORG_IMPORT_ROWS.toLocaleString('ko-KR')}행입니다.`);
        continue;
      }
      const expected = orgHeaderSets()[name];
      const headers = [];
      try {
        sheet.getRow(1).eachCell({ includeEmpty: true }, (cell, i) => { headers[i - 1] = cellText(cell.value); });
      } catch (error) {
        errors.push(`${name} 머리글: ${error.message}`);
        continue;
      }
      while (headers.length && headers.at(-1) === '') headers.pop();
      if (new Set(headers).size !== headers.length || headers.length !== expected.length || expected.some((h) => !headers.includes(h))) {
        errors.push(`${name}: 열 이름이 양식과 다르거나 중복됩니다.`);
        continue;
      }
      sheet.eachRow((row, index) => {
        if (index === 1 || !row.values.some((v) => v !== null && v !== undefined && v !== '')) return;
        if (++total > MAX_ORG_IMPORT_ROWS) return;
        try {
          rows[name].push({ index, data: Object.fromEntries(headers.map((h, i) => [h, cellText(row.getCell(i + 1).value)])) });
        } catch (error) {
          errors.push(`${name} ${index}행: ${error.message}`);
        }
      });
    }
    if (total > MAX_ORG_IMPORT_ROWS) errors.push(`한 번에 가져올 수 있는 총 입력 행은 ${MAX_ORG_IMPORT_ROWS.toLocaleString('ko-KR')}행입니다.`);
    if (!total && !errors.length) errors.push('가져올 조직·구성원 행이 없습니다.');
    return { rows, errors };
  }

  /** 시트 행을 O.importRows가 받는 입력으로 바꾼다. 행 단위 오류는 행 번호와 함께 모은다. */
  function organizationInput(rows, errors) {
    const nodes = [];
    const members = [];
    const seen = new Set();
    const once = (sheet, key, index, label) => {
      const id = `${sheet}\u0000${key}`;
      if (key && seen.has(id)) errors.push(`${sheet} ${index}행: ${label}가 파일 안에서 중복됩니다: ${key}`);
      seen.add(id);
    };
    for (const { index, data: d } of rows.조직) {
      once('조직', d.조직ID, index, '조직ID');
      const state = d.사용상태 || '사용';
      if (!['사용', '보관'].includes(state)) {
        errors.push(`조직 ${index}행: 사용상태는 사용/보관으로 입력해 주세요.`);
        continue;
      }
      nodes.push({ code: d.조직ID, name: d.조직명, type: d.조직유형, parentCode: d.상위조직ID, leaderCode: d.책임자구성원ID, leaderTitle: d.책임자호칭 || '책임자', reportRegion: d.데이터구역명, active: state === '사용' });
    }
    for (const { index, data: d } of rows.구성원) {
      once('구성원', d.구성원ID, index, '구성원ID');
      const state = d.상태 || '활동 중';
      if (!['활동 중', '보관'].includes(state)) {
        errors.push(`구성원 ${index}행: 상태는 활동 중/보관으로 입력해 주세요.`);
        continue;
      }
      members.push({ code: d.구성원ID, name: d.이름, unitCode: d.소속조직ID, position: d.직책, className: d.반, employment: d.직장인구분 || '미입력', status: state === '보관' ? 'inactive' : 'active', notes: d.메모 });
    }
    return { nodes, members };
  }

  /** 초안에 가져오기를 적용한 결과와 변경 요약. 호출한 쪽이 초안을 버리면 아무것도 바뀌지 않는다. */
  function applyOrganizationInput(draft, input) {
    const before = structuredClone(draft.organization);
    const changes = O.importRows(draft, input.nodes, input.members);
    const reasons = organizationViolations(before, draft.organization);
    if (reasons.length) throw bad(reasons[0]);
    M.validateWorkspace(draft); // 조직·구성원이 다른 설정(코드·구역)과 맞는지 반영 전에 확인한다.
    return changes;
  }

  function describeChanges(draft, changes) {
    const org = draft.organization;
    const unit = (id) => (org.nodes.some((n) => n.id === id) ? O.pathName(org, id) : '');
    const person = (id) => org.members.find((m) => m.id === id)?.name ?? '';
    const show = (kind, key, value) => (key === 'parentId' || key === 'unitId' ? unit(value) : key === 'leaderId' ? person(value) : key === 'active' ? (value ? '사용' : '보관') : key === 'status' ? (value === 'active' ? '활동 중' : '보관') : value);
    return changes.map((c) => {
      const names = c.kind === 'nodes' ? NODE_FIELD_NAMES : MEMBER_FIELD_NAMES;
      const fields = c.before
        ? Object.keys(names).filter((k) => c.before[k] !== c.after[k]).map((k) => ({ field: names[k], ...(k === 'notes' ? {} : { before: String(show(c.kind, k, c.before[k]) ?? ''), after: String(show(c.kind, k, c.after[k]) ?? '') }) }))
        : [];
      return { kind: c.kind === 'nodes' ? '조직' : '구성원', status: c.before ? '수정' : '신규', code: c.after.code, name: c.after.name, fields };
    });
  }

  async function importPreview(ctx) {
    const revision = store.workspace.revision; // 파일을 읽는 동안 원본이 바뀌었는지 비교할 기준
    const { rows, errors } = await parseOrganizationFile(ctx.file);
    ctx.recheck();
    const input = organizationInput(rows, errors);
    const draft = scopedWorkspace(store, ctx.user);
    let changes = [];
    if (!errors.length) {
      try {
        changes = applyOrganizationInput(draft, input);
      } catch (error) {
        // 4.0.41 검증 오류(Error)와 서버 규칙 오류(HttpError)는 사유를 그대로 보여 주고, 그 밖의 오류는 일반 문구만 낸다.
        const known = error instanceof HttpError || (error && error.constructor === Error);
        errors.push(known ? String(error.message).slice(0, 300) : '조직 자료를 확인하지 못했습니다.');
      }
    }
    if (store.workspace.revision !== revision) throw new HttpError(409, '파일을 읽는 사이 자료가 바뀌었습니다. 다시 시도해 주세요.');
    const canApply = !errors.length && changes.length > 0;
    const described = errors.length ? [] : describeChanges(draft, changes);
    const count = (kind, status) => described.filter((c) => c.kind === kind && c.status === status).length;
    return {
      previewId: canApply ? putPreview(store, ctx.user, 'orgImport', { input, session: sessionKey(ctx) }) : null,
      canApply,
      expiresInSeconds: 900,
      counts: { 조직신규: count('조직', '신규'), 조직수정: count('조직', '수정'), 구성원신규: count('구성원', '신규'), 구성원수정: count('구성원', '수정'), 변경없음: input.nodes.length + input.members.length - changes.length },
      errors: errors.slice(0, 100),
      totalErrors: errors.length,
      changes: described.slice(0, 300),
      totalChanges: described.length,
    };
  }

  function importApply(ctx) {
    const id = typeof ctx.body.previewId === 'string' ? ctx.body.previewId : '';
    const data = takePreview(store, ctx.user, id, 'orgImport', { consume: false });
    if (data.session !== sessionKey(ctx)) throw new HttpError(403, '미리보기를 만든 로그인 세션에서만 반영할 수 있습니다. 다시 만들어 주세요.');
    const { out } = mutate(ctx, (draft, actor) => {
      const changes = applyOrganizationInput(draft, data.input);
      if (!changes.length) throw bad('바뀌는 내용이 없습니다.');
      for (const c of changes) M.audit(draft, actor, c.kind === 'nodes' ? '엑셀 조직 변경' : '엑셀 구성원 변경', c.after.id, c.before, c.after);
      return changes.length;
    });
    store.previews.delete(id);
    return { applied: out };
  }

  // ---- 목표
  const ownRegions = (ctx) => {
    const scope = scopeFor(store, ctx.user);
    return new Set(store.districts.filter((d) => scope.has(d.id)).map((d) => d.name));
  };

  function goalRows(ctx, ws) {
    const q = ctx.query;
    const from = q.get('from') ?? '';
    const to = q.get('to') ?? '';
    const region = q.get('region') ?? '';
    try {
      if (from) M.date(from);
      if (to) M.date(to);
    } catch (error) {
      throw domainError(error);
    }
    if (region && !isAdmin(ctx) && !ownRegions(ctx).has(region)) throw new HttpError(403, '접근할 수 없는 구역입니다.');
    const cache = new Map();
    const attain = (stage) => {
      if (!cache.has(stage)) cache.set(stage, G.attainments(ws, stage));
      return cache.get(stage);
    };
    return ws.goals
      .filter((g) => (!from || g.to >= from) && (!to || g.from <= to) && (!region || g.region === region))
      .sort((a, b) => b.from.localeCompare(a.from) || a.region.localeCompare(b.region, 'ko', { numeric: true }) || String(a.stageId).localeCompare(String(b.stageId)))
      .slice(0, 1000)
      .map((g) => {
        const p = G.progress(ws, g, attain(g.stageId || '*'));
        const stage = g.stageId && g.stageId !== '*' ? g.stageId : '';
        return {
          id: g.id, region: g.region, className: g.className ?? '', classLabel: g.className ? K.label(ws, 'className', g.className) : '', from: g.from, to: g.to, periodUnit: g.periodUnit ?? 'custom',
          stageId: stage ? webStageId(stage) : '*', stageName: stage ? (ws.stageNames[stage] ?? stage) : '전체(찾은 인원)',
          target: g.target, actual: p.actual, shortfall: p.shortfall, rate: p.rate,
        };
      });
  }

  /** 본문에서 목표 입력만 추려 기존 형식으로 바꾼다. 구역 범위는 여기서 먼저, commitWorkspace가 다시 확인한다. */
  function goalInput(ctx) {
    const b = pick(ctx.body, ['region', 'className', 'from', 'to', 'stageId', 'target', 'periodUnit']);
    for (const k of ['region', 'className', 'from', 'to', 'stageId', 'periodUnit']) {
      if (b[k] !== undefined && typeof b[k] !== 'string') throw bad('목표 입력 형식을 확인해 주세요.');
    }
    if (b.target !== undefined && typeof b.target !== 'number' && typeof b.target !== 'string') throw bad('목표 건수를 확인해 주세요.');
    if (b.stageId && b.stageId !== '*') {
      b.stageId = legacyStageId(b.stageId);
      if (!b.stageId) throw bad('단계를 확인해 주세요.');
    }
    return b;
  }
  function checkGoalRegion(ctx, region) {
    if (isAdmin(ctx)) return;
    if (!region) throw new HttpError(403, '구역을 지정하지 않은 목표는 관리자만 다룰 수 있습니다.');
    if (!ownRegions(ctx).has(region)) throw new HttpError(403, '배정된 구역의 목표만 다룰 수 있습니다.');
  }

  const classValue = (ws, value) => (value ? K.find(ws, 'className', value)?.value || value : '');
  const stageLabel = (ws, stageId) => (stageId && stageId !== '*' ? (ws.stageNames[stageId] ?? stageId) : '전체(찾은 인원)');
  const checkedDate = (value, label) => {
    if (typeof value !== 'string') throw bad(`${label}을 확인해 주세요.`);
    try {
      return M.date(value);
    } catch (error) {
      return domainError(error);
    }
  };

  // ---- 직전 기간 목표 복사 (미리보기 → 한 번에 반영)
  function copyInput(ctx) {
    const b = ctx.body;
    const periodUnit = typeof b.periodUnit === 'string' ? b.periodUnit : '';
    if (!PERIOD_UNITS.includes(periodUnit)) throw bad('기간 단위를 확인해 주세요.');
    const from = checkedDate(b.from, '시작일');
    const to = checkedDate(b.to, '종료일');
    if (from > to) throw bad('목표 기간을 확인해 주세요.');
    if (b.regionScope !== undefined && typeof b.regionScope !== 'string') throw bad('복사 범위를 확인해 주세요.');
    const regionScope = (b.regionScope ?? '').trim();
    if (regionScope.length > 60) throw bad('복사 범위를 확인해 주세요.');
    if (regionScope && !isAdmin(ctx) && !ownRegions(ctx).has(regionScope)) throw new HttpError(403, '접근할 수 없는 구역입니다.');
    const conflict = b.conflict ?? 'keep';
    if (!['keep', 'overwrite'].includes(conflict)) throw bad('이미 있는 목표의 처리 방법을 확인해 주세요.');
    return { periodUnit, from, to, regionScope, conflict };
  }

  function copyPreview(ctx) {
    const input = copyInput(ctx);
    const ws = scopedWorkspace(store, ctx.user);
    const admin = isAdmin(ctx);
    const own = ownRegions(ctx);
    let source;
    try {
      source = previousGoalRange(input, weekStart());
    } catch (error) {
      throw domainError(error);
    }
    // 배정 구역의 목표만 본다(scopedWorkspace가 이미 자르지만 한 번 더 확인한다).
    const within = (g, range) => g.from === range.from && g.to === range.to && (!input.regionScope || g.region === input.regionScope) && (admin || (g.region && own.has(g.region)));
    const keyOf = (g) => JSON.stringify([g.region, classValue(ws, g.className), g.stageId || '*']);
    const existing = new Map(ws.goals.filter((g) => within(g, input)).map((g) => [keyOf(g), g]));
    const prior = ws.goals
      .filter((g) => within(g, source))
      .sort((a, b) => a.region.localeCompare(b.region, 'ko', { numeric: true }) || classValue(ws, a.className).localeCompare(classValue(ws, b.className), 'ko', { numeric: true }) || String(a.stageId).localeCompare(String(b.stageId)));
    const priorCounts = new Map();
    for (const g of prior) priorCounts.set(keyOf(g), (priorCounts.get(keyOf(g)) ?? 0) + 1);
    const available = new Set(K.options(ws, 'className').map(([value]) => value));
    const rows = [];
    const counts = { copy: 0, overwrite: 0, keep: 0, skip: 0 };
    const items = prior.map((g) => {
      const key = keyOf(g);
      const current = existing.get(key);
      const className = classValue(ws, g.className);
      const stageId = g.stageId || '*';
      const item = { region: g.region, className, classLabel: className ? K.label(ws, 'className', className) : '', stageId: stageId === '*' ? '*' : webStageId(stageId), stageName: stageLabel(ws, stageId), target: g.target, current: current ? current.target : null };
      const row = { region: g.region, className, stageId, target: g.target, from: input.from, to: input.to, periodUnit: input.periodUnit };
      let status;
      let reason = '';
      if (current) {
        if (input.conflict === 'overwrite' && current.target !== g.target) {
          status = 'overwrite';
          reason = '기존 목표를 직전 기간 값으로 바꿈';
        } else {
          status = 'keep';
          reason = current.target === g.target ? '이미 같은 목표가 있음' : '기존 목표 유지';
        }
      } else if (className && !available.has(className)) {
        status = 'skip';
        reason = '보관·미등록 반 제외';
      } else if (priorCounts.get(key) > 1) {
        status = 'skip';
        reason = '같은 반 코드의 목표 중복';
      } else status = 'copy';
      if (status === 'copy' || status === 'overwrite') rows.push(row);
      counts[status]++;
      return { ...item, status, reason };
    });
    const tooMany = rows.length > MAX_GOAL_ROWS;
    const canApply = rows.length > 0 && !tooMany;
    return {
      previewId: canApply ? putPreview(store, ctx.user, 'goalCopy', { rows, session: sessionKey(ctx) }) : null,
      canApply,
      source,
      destination: { from: input.from, to: input.to, periodUnit: input.periodUnit },
      counts,
      items,
      message: tooMany ? `한 번에 ${MAX_GOAL_ROWS.toLocaleString('ko-KR')}건까지 저장할 수 있습니다. 구역 범위를 선택해 주세요.` : !prior.length ? '직전 기간에 저장된 목표가 없습니다.' : '',
    };
  }

  function copyApply(ctx) {
    const id = typeof ctx.body.previewId === 'string' ? ctx.body.previewId : '';
    const data = takePreview(store, ctx.user, id, 'goalCopy', { consume: false });
    if (data.session !== sessionKey(ctx)) throw new HttpError(403, '미리보기를 만든 로그인 세션에서만 반영할 수 있습니다. 다시 만들어 주세요.');
    for (const row of data.rows) checkGoalRegion(ctx, row.region);
    const { out } = mutate(ctx, (draft, actor) => G.saveBatch(draft, data.rows, actor)); // 한 번의 검증과 커밋. 하나라도 실패하면 전부 반영하지 않는다.
    store.previews.delete(id);
    return { applied: data.rows.length, changed: out };
  }

  // ---- 기간 목표 표 (여러 구역·반의 목표를 한 번에 저장·삭제)
  function matrixParams(ctx, get) {
    const scope = get('scope') || 'region';
    if (!['region', 'class'].includes(scope)) throw bad('목표 대상을 확인해 주세요.');
    if (scope === 'class' && !isAdmin(ctx)) throw new HttpError(403, '구역 없이 반 전체에 거는 목표는 관리자만 다룰 수 있습니다.');
    const from = checkedDate(get('from'), '시작일');
    const to = checkedDate(get('to'), '종료일');
    if (from > to) throw bad('목표 기간을 확인해 주세요.');
    const periodUnit = get('periodUnit') || 'custom';
    if (!PERIOD_UNITS.includes(periodUnit)) throw bad('기간 단위를 확인해 주세요.');
    const web = get('stageId') || '*';
    const stage = web === '*' ? '*' : legacyStageId(web);
    if (!stage || (stage !== '*' && !store.workspace.stages.includes(stage))) throw bad('목표 항목을 확인해 주세요.');
    const region = (get('region') ?? '').trim();
    if (region && !isAdmin(ctx) && !ownRegions(ctx).has(region)) throw new HttpError(403, '접근할 수 없는 구역입니다.');
    return { scope, from, to, periodUnit, stage, region };
  }
  const queryGetter = (ctx) => (key) => ctx.query.get(key) ?? undefined;
  const bodyGetter = (ctx) => (key) => {
    const v = ctx.body[key];
    if (v !== undefined && typeof v !== 'string') throw bad('목표 표 입력 형식을 확인해 주세요.');
    return v;
  };

  /** 같은 기간의 (사용자 범위 안) 목표 상태 서명. 표를 불러온 뒤 다른 곳에서 바뀌었는지 가려낸다. */
  const matrixVersion = (ws, p) => M.hash(ws.goals
    .filter((g) => g.from === p.from && g.to === p.to)
    .map((g) => [g.id, g.region, g.className || '', g.stageId || '*', g.target, g.periodUnit || ''])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])))).slice(0, 32);

  function matrixRegions(ctx, ws) {
    const all = new Set([...ws.organization.nodes.filter((n) => n.active).map(regionLabel).filter(Boolean), ...ws.goals.map((g) => g.region).filter(Boolean)]);
    const own = ownRegions(ctx);
    return [...all].filter((r) => isAdmin(ctx) || own.has(r)).sort((a, b) => a.localeCompare(b, 'ko', { numeric: true }));
  }

  function matrix(ctx) {
    const p = matrixParams(ctx, queryGetter(ctx));
    const ws = scopedWorkspace(store, ctx.user);
    const regions = matrixRegions(ctx, ws);
    const found = (region, className) => ws.goals.find((g) => g.region === region && classValue(ws, g.className) === className && g.from === p.from && g.to === p.to && (g.stageId || '*') === p.stage);
    let targets;
    if (p.scope === 'class') {
      const classes = [...new Set([...K.options(ws, 'className').map(([value]) => value), ...ws.goals.filter((g) => !g.region && g.className && g.from === p.from && g.to === p.to && (g.stageId || '*') === p.stage).map((g) => classValue(ws, g.className))])];
      targets = classes.map((className) => ({ region: '', className }));
    } else targets = regions.filter((r) => !p.region || r === p.region).map((region) => ({ region, className: '' }));
    if (targets.length > MAX_GOAL_ROWS) throw bad(`한 번에 ${MAX_GOAL_ROWS.toLocaleString('ko-KR')}개 목표까지 저장합니다. 구역 범위를 선택해 주세요.`);
    return {
      scope: p.scope, from: p.from, to: p.to, periodUnit: p.periodUnit, stageId: p.stage === '*' ? '*' : webStageId(p.stage),
      version: matrixVersion(ws, p),
      rows: targets.map((t) => {
        const g = found(t.region, t.className);
        return { region: t.region, className: t.className, classLabel: t.className ? K.label(ws, 'className', t.className) : '', goalId: g?.id ?? null, target: g ? g.target : null };
      }),
    };
  }

  function matrixSave(ctx) {
    const p = matrixParams(ctx, bodyGetter(ctx));
    const { rows, deleteIds = [], version } = ctx.body;
    if (!Array.isArray(rows) || !Array.isArray(deleteIds) || typeof version !== 'string') throw bad('목표 표 입력 형식을 확인해 주세요.');
    if (rows.length + deleteIds.length < 1 || rows.length + deleteIds.length > MAX_GOAL_ROWS) throw bad(`한 번에 목표 1~${MAX_GOAL_ROWS.toLocaleString('ko-KR')}건을 저장하거나 삭제할 수 있습니다.`);
    if (deleteIds.some((id) => typeof id !== 'string')) throw bad('삭제할 목표를 확인해 주세요.');
    const known = new Set(matrixRegions(ctx, scopedWorkspace(store, ctx.user)));
    const full = rows.map((r) => {
      if (!r || typeof r !== 'object' || Array.isArray(r) || typeof r.region !== 'string' || (r.className !== undefined && typeof r.className !== 'string')) throw bad('목표 표 행 형식을 확인해 주세요.');
      // 빈칸은 보내지 않는다. 0은 0건 목표로 저장하므로 숫자(또는 숫자 문자)만 받는다.
      if (!(typeof r.target === 'number' || (typeof r.target === 'string' && r.target.trim() !== ''))) throw bad('목표 건수를 확인해 주세요. 비워 둘 행은 보내지 말고, 0건은 0으로 입력합니다.');
      const className = r.className ?? '';
      if (p.scope === 'region' ? !r.region || className : r.region || !className) throw bad('목표 대상이 표의 구분과 맞지 않습니다.');
      checkGoalRegion(ctx, r.region);
      if (r.region && !known.has(r.region)) throw bad(`알 수 없는 구역입니다: ${r.region}`);
      return { region: r.region, className, from: p.from, to: p.to, stageId: p.stage, periodUnit: p.periodUnit, target: r.target };
    });
    const { out } = mutate(ctx, (draft, actor) => {
      if (matrixVersion(draft, p) !== version) throw new HttpError(409, '표를 불러온 뒤 목표가 바뀌었습니다. 표를 다시 불러와 주세요.');
      for (const id of deleteIds) {
        const g = draft.goals.find((x) => x.id === id);
        if (!g) throw bad('삭제할 목표를 찾을 수 없습니다. 표를 다시 불러와 주세요.');
        checkGoalRegion(ctx, g.region);
        if (g.from !== p.from || g.to !== p.to || (g.stageId || '*') !== p.stage) throw bad('표의 기간·항목과 다른 목표는 함께 삭제할 수 없습니다.');
      }
      return G.saveBatch(draft, full, actor, deleteIds);
    });
    return { changed: out, saved: full.length, deleted: deleteIds.length };
  }

  const R = (method, path, screen, action, handler, extra = {}) => ({ method, path, screen, action, handler, ...extra });
  const A = (method, path, handler, extra = {}) => R(method, path, 'organization', 'write', handler, { auth: 'admin', ...extra });

  return [
    R('GET', '/api/organization', 'organization', 'read', view),
    R('GET', '/api/organization/export', 'organization', 'export', async (ctx) => {
      const data = view(ctx);
      const nameOf = new Map(data.nodes.map((n) => [n.id, n.path]));
      const buffer = await workbook([
        {
          name: '조직',
          columns: [['조직ID', 'code', 14], ['이름', 'name', 20], ['유형', 'type', 10], ['상위 조직', 'parent', 28], ['경로', 'path', 40], ['책임자', 'leader', 16], ['구성원 수', 'count', 10], ['상태', 'state', 8]],
          rows: data.nodes.map((n) => ({ code: n.code, name: n.name, type: n.type, parent: nameOf.get(n.parentId) ?? '', path: n.path, leader: n.leaderName, count: n.memberCount, state: n.active ? '사용' : '보관' })),
        },
        {
          name: '구성원',
          columns: [['구성원ID', 'code', 16], ['이름', 'name', 20], ['소속', 'unit', 40], ['직책', 'position', 12], ['반', 'className', 8], ['직업 구분', 'employment', 12], ['상태', 'state', 8], ['비고', 'notes', 40]],
          rows: data.members.map((m) => ({ code: m.code, name: m.name, unit: m.unitPath, position: m.positionLabel, className: m.classLabel, employment: m.employmentLabel, state: m.status === 'active' ? '활동' : '보관', notes: m.notes })),
        },
      ]);
      ctx.recheck();
      return xlsxResponse(buffer, `smoa-organization-${seoulDateOf(store.now()).replaceAll('-', '')}.xlsx`);
    }),
    R('GET', '/api/organization/members/:id/transfers', 'organization', 'read', transfers),
    A('POST', '/api/organization/nodes', (ctx) => ({ id: saveNode({ ...ctx, params: [] }).out })),
    A('PUT', '/api/organization/nodes/:id', (ctx) => ({ id: saveNode(ctx).out })),
    A('DELETE', '/api/organization/nodes/:id', (ctx) => {
      if (boundIds().has(ctx.params[0])) throw bad('구역과 연동된 조직은 삭제할 수 없습니다.');
      mutate(ctx, (draft, actor) => {
        const { before } = O.removeNode(draft, { id: ctx.params[0] });
        M.audit(draft, actor, '조직 삭제', before.id, before, null);
      });
      return { ok: true };
    }),
    A('POST', '/api/organization/members', (ctx) => ({ id: saveMember({ ...ctx, params: [] }).out })),
    A('PUT', '/api/organization/members/:id', (ctx) => ({ id: saveMember(ctx).out })),
    A('DELETE', '/api/organization/members/:id', (ctx) => {
      mutate(ctx, (draft, actor) => {
        const { before } = O.removeMember(draft, { id: ctx.params[0] });
        M.audit(draft, actor, '구성원 삭제', ctx.params[0], before, null);
      });
      return { ok: true };
    }),
    A('POST', '/api/organization/classes', (ctx) => {
      const { districtId, rows } = ctx.body;
      if (typeof districtId !== 'string' || !Array.isArray(rows) || rows.some((r) => !r || typeof r.memberId !== 'string' || typeof r.className !== 'string')) throw bad('반 지정 입력을 확인해 주세요.');
      const { out } = mutate(ctx, (draft, actor) => {
        const changes = O.assignClasses(draft, districtId, rows.map((r) => ({ memberId: r.memberId, className: r.className })));
        if (changes.length) M.audit(draft, actor, '구성원 반 지정', districtId, changes.map((c) => ({ id: c.id, name: c.name, className: c.before })), changes.map((c) => ({ id: c.id, name: c.name, className: c.after })));
        return changes.length;
      });
      return { changed: out };
    }),

    // 조직 엑셀 양식·가져오기: 관리자만. 양식은 현재 조직·구성원이 채워져 있어 고쳐서 다시 올릴 수 있다.
    A('GET', '/api/organization/template', async (ctx) => {
      const ws = scopedWorkspace(store, ctx.user);
      const buffer = Buffer.from(await importer().createOrganizationWorkbook(ws));
      ctx.recheck();
      return xlsxResponse(buffer, `smoa-organization-template-${seoulDateOf(store.now()).replaceAll('-', '')}.xlsx`);
    }),
    A('POST', '/api/organization/import/preview', importPreview, { binary: true, maxBytes: 4 * 1024 * 1024 }),
    A('POST', '/api/organization/import/apply', importApply),

    // ---- 구역·반 목표
    R('GET', '/api/goals', 'goals', 'read', (ctx) => {
      const ws = scopedWorkspace(store, ctx.user);
      const regions = isAdmin(ctx) ? store.districts.map((d) => d.name) : [...ownRegions(ctx)];
      return {
        items: goalRows(ctx, ws),
        regions,
        classes: K.options(ws, 'className').map(([value, label]) => ({ value, label })),
        today: seoulDateOf(store.now()),
        weekStart: weekStart(),
        anyRegionAllowed: isAdmin(ctx),
      };
    }),
    R('GET', '/api/goals/export', 'goals', 'export', async (ctx) => {
      const rows = goalRows(ctx, scopedWorkspace(store, ctx.user));
      const buffer = await workbook([
        {
          name: '목표',
          columns: [['구역', 'region', 12], ['반', 'cls', 8], ['시작일', 'from', 12], ['종료일', 'to', 12], ['항목', 'stage', 18], ['목표', 'target', 8], ['달성', 'actual', 8], ['부족', 'shortfall', 8], ['달성률(%)', 'rate', 10]],
          rows: rows.map((g) => ({ region: g.region, cls: g.classLabel || g.className, from: g.from, to: g.to, stage: g.stageName, target: g.target, actual: g.actual, shortfall: g.shortfall, rate: g.rate === null ? '' : Math.round(g.rate * 10) / 10 })),
        },
      ]);
      ctx.recheck();
      return xlsxResponse(buffer, `smoa-goals-${seoulDateOf(store.now()).replaceAll('-', '')}.xlsx`);
    }),
    R('GET', '/api/goals/matrix', 'goals', 'write', matrix),
    R('POST', '/api/goals/batch', 'goals', 'write', matrixSave),
    R('POST', '/api/goals/copy/preview', 'goals', 'write', copyPreview),
    R('POST', '/api/goals/copy/apply', 'goals', 'write', copyApply),
    R('POST', '/api/goals', 'goals', 'write', (ctx) => {
      const input = goalInput(ctx);
      checkGoalRegion(ctx, input.region ?? '');
      const { out } = mutate(ctx, (draft, actor) => G.save(draft, input, actor));
      return { saved: out };
    }),
    R('PUT', '/api/goals/:id', 'goals', 'write', (ctx) => {
      const input = goalInput(ctx);
      if (input.region !== undefined) checkGoalRegion(ctx, input.region);
      const { out } = mutate(ctx, (draft, actor) => {
        const before = draft.goals.find((g) => g.id === ctx.params[0]);
        if (!before) throw new HttpError(404, '목표를 찾을 수 없습니다.');
        checkGoalRegion(ctx, input.region ?? before.region);
        return G.update(draft, { ...input, id: before.id }, actor);
      });
      return { saved: out };
    }),
    R('DELETE', '/api/goals/:id', 'goals', 'write', (ctx) => {
      mutate(ctx, (draft, actor) => {
        const goal = draft.goals.find((g) => g.id === ctx.params[0]);
        if (!goal) throw new HttpError(404, '목표를 찾을 수 없습니다.');
        checkGoalRegion(ctx, goal.region);
        G.remove(draft, ctx.params[0], actor);
      });
      return { ok: true };
    }),
  ];
}
