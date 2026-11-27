import ExcelJS from 'exceljs';
import { HttpError } from './security.js';
import {
  bufferOf, createPreviewStore, domain, draftViolations, dropOutOfScopeRows, guarded, inScope, legacy,
  loadWorkbook, redactDeep, scopeInfo, seoulDate, sessionOf, validatedBaseline, viewClone, xlsxResponse,
} from './daily.js';

/**
 * 보고서 화면 API (/api/reports): 기존 SMOA 양식 내려받기, 구역 범위 결과 내보내기, 엑셀 자료 가져오기(미리보기 → 반영).
 * 금고·.cddshare·암호화 누적 통합문서는 다루지 않는다. 전체 연락처는 어떤 응답·통합문서에도 싣지 않는다.
 */

const FILTER_KEYS = [
  'search', 'worker', 'region', 'className', 'employment', 'stage', 'timeBand', 'transitionFrom', 'transitionTo',
  'place', 'status', 'introducerId', 'orgUnitId', 'basis', 'from', 'to', 'minMinutes', 'maxMinutes', 'classification2',
];

const EXPORTS = [
  ['detail', '대상자 상세'], ['activity', '활동 상세'], ['daily', '일별 활동'], ['person', '사람별 활동'],
  ['class', '반별 현황'], ['employment', '직장인 구분별 현황'], ['timeBand', '시간대별 활동'], ['custom', '사용자 지정 상세'],
  ['region', '구역별 목표 실적'], ['transitions', '단계 변경 이력'], ['stageSummary', '구역별 단계 현황'], ['reported', '구역별 입력 일계'],
];

const TEMPLATES = [
  { id: 'input', label: '자료 입력 양식', description: '대상자·단계변경·탈락복귀·활동·구역일계 시트. 휴대폰 번호 열은 이 웹에서 가져오지 않고, 조직·구성원·공통코드·목표 시트는 관리 화면에서 처리합니다.' },
  { id: 'daily-input', label: '활동·찾기 일보 입력 양식', description: '활동일보·찾기일보 시트와 작성 안내.' },
  { id: 'daily-area', label: '구역 일보 정리본 양식', description: '활동자·찾기·업데이트·활동자보고 4개 시트의 빈 양식. 일보 화면에서 가져올 수 있습니다.' },
  { id: 'activity-records', label: '활동기록 개별 입력 양식', description: '활동기록 시트 하나만 있는 양식. 활동자 명부(조직·구성원)를 먼저 등록한 뒤 자료 가져오기로 올립니다.' },
  { id: 'finding-records', label: '찾기건 개별 입력 양식', description: '찾기건 시트 하나만 있는 양식. 신규 대상자와 만픽일·찾A일·복신일을 함께 입력합니다. 휴대폰 번호 열은 없습니다.' },
  { id: 'person-update', label: '기존 대상자 업데이트 양식', description: '이미 등록된 대상자의 단계·교사·탈락일·사유·단계별 최초 도달일을 고치는 양식. 「기존 대상자 업데이트」 탭에서 올립니다.' },
];

// ───────────────────────── 양식별 시트 안내 (원본 입력 양식의 작성안내를 시트 단위로 옮김) ─────────────────────────

const isPhoneHeader = (label) => /연락처|휴대폰|핸드폰|전화/.test(label);
const cleanLabel = (value) => String(value).replace(/\s+/g, ' ').trim();
const withoutPhone = (headers) => headers.map(cleanLabel).filter((label) => !isPhoneHeader(label));

/** 시트별 반영 위치(destination)와 작성 주의. 이름은 원본 시트 이름과 같다. */
const SHEET_INFO = {
  대상자: {
    to: '대상자 기록과 최초 단계 이력',
    note: '대상자ID는 중복되지 않는 문자 식별번호입니다(예: P-0001). 같은 ID의 기본 정보는 갱신되고, 최초단계는 신규 대상자의 첫 단계입니다. 인도자ID에는 등록된 구성원ID를 적으며 이름으로 자동 연결하지 않습니다. 분류 열이 있는데 셀이 비어 있으면 해당 분류를 비웁니다.',
  },
  단계변경: {
    to: '대상자의 단계 변경 이력',
    note: '변경ID는 건별로 고유하게 입력합니다(예: S-0001). 같은 ID로 다시 가져와도 중복 집계하지 않고 해당 이력을 정정합니다. 적용시각은 YYYY-MM-DD HH:mm 형식입니다.',
  },
  탈락복귀: {
    to: '대상자의 탈락·복귀 이력',
    note: '구분은 탈락 또는 복귀입니다. 원본 대상자와 단계 기록은 삭제하지 않습니다.',
  },
  활동: {
    to: '활동 기록(활동자별 한 행)',
    note: '한 행은 한 활동자의 활동 기록입니다. 활동ID는 고유하게 입력하고, 대상자ID는 연결할 때만 적습니다. 시간은 17, 17:00, 1700, 1710 형식을 쓸 수 있으며 종료가 시작보다 빠르면 익일로 계산합니다.',
  },
  구역일계: {
    to: '구역별 일계(보고 숫자)',
    note: '구역별 보고 숫자를 보관합니다. 개인 상세 실적과 자동으로 합산하지 않으며, 같은 일자+구역은 갱신합니다. 상세 등록과의 차이는 「일계 대조」 탭에서 확인합니다.',
  },
  활동일보: {
    to: '활동 기록(날짜·시간 구간당 한 행)',
    note: '한 사람의 날짜·시간 구간당 한 행입니다. 활동자는 등록된 이름으로 연결하고 겹친 구간은 오류로 표시합니다. 자정이 지나면 익일 종료입니다.',
  },
  찾기일보: {
    to: '대상자 등록과 구역 찾기 일보',
    note: '찾은날짜·도구·대상자·성별·나이·거주지·찾기장소·찾기시간·인도자를 보관합니다. 보고일과 구역을 반드시 적으며, 인도자는 미리 등록한 명부와 연결됩니다.',
  },
  활동자: { to: '구역 일보 정리본의 활동자 시트', note: '구역 일보 화면의 변환 결과와 같은 모양입니다. 구역 일보 화면의 「정리본 파일 가져오기」에서 올립니다.' },
  찾기: { to: '구역 일보 정리본의 찾기 시트', note: '신규 찾B 행입니다. 연락처 열은 웹에서 읽지 않으며 접근 권한이 없는 구역의 행은 제외됩니다.' },
  업데이트: { to: '구역 일보 정리본의 업데이트 시트', note: '단계 향상·탈락 행입니다. 대상자는 대상자ID 또는 이름·인도자·구역으로 찾습니다.' },
  활동자보고: { to: '구역 일보 정리본의 활동자 보고 시트', note: '요약 보고 글과 활동자 명단이 들어가는 시트입니다. 가져오기에서는 읽지 않습니다.' },
  활동기록: {
    to: '활동 기록(날짜·활동자 단위)',
    note: '활동자는 조직의 구성원 명부에 있는 이름이어야 합니다. 시간은 17, 17:00, 1700 형식을 쓸 수 있고 시작·종료를 모두 비우면 0분입니다. 같은 내용을 다시 가져오면 중복은 건너뜁니다.',
  },
  찾기건: {
    to: '대상자 기록(찾기건)과 단계별 최초 도달일',
    note: '날짜·대상자명은 필수입니다. 인도자는 구성원 명부의 이름·ID를 적습니다. 만픽일·찾A일·복신일은 해당 단계에 처음 도달한 날짜입니다. 이 웹에는 휴대폰 번호 열이 없습니다.',
  },
  '대상자 업데이트': {
    to: '기존 대상자의 단계·교사·탈락·사유·단계별 최초 도달일(새 대상자는 만들지 않음)',
    note: '대상자ID 또는 대상자명과 인도자(인도자구역)로 기존 대상자를 찾습니다. 기존 찾기날짜는 유지하고, 교사·날짜의 빈칸은 기존 값을 유지하며, 사유의 빈칸은 기존 사유를 비웁니다. 담당 구역 밖 대상자는 일치하지 않는 것으로 처리됩니다. 휴대폰 번호 열은 이 웹에서 읽지 않습니다.',
  },
};

const FIELD_LABELS = {
  name: '이름', stage: '단계', teacher: '교사', reason: '사유', status: '상태', date: '찾은 날짜', region: '구역', worker: '인도자',
  gender: '성별', age: '나이', residence: '거주지', place: '찾기 장소', tool: '사용 도구', classification1: '분류1',
  classification2: '분류2', notes: '메모', time: '시간', dropoutDate: '탈락일',
};

/** 미리보기의 변경 한 건을 「항목: 이전 → 이후」 문장으로 줄인다. 연락처 항목은 값 없이 변경 사실만 알린다. */
function describeChange(change) {
  const after = change.after && typeof change.after === 'object' ? change.after : {};
  const before = change.before && typeof change.before === 'object' ? change.before : {};
  const parts = Object.keys(after).map((key) => {
    if (/phone|contact/i.test(key)) return '연락처 변경';
    const show = (v) => (v == null || v === '' ? '(비어 있음)' : String(v));
    return `${FIELD_LABELS[key] ?? '기타 항목'}: ${show(before[key])} → ${show(after[key])}`;
  });
  return { action: change.action, target: change.target, summary: parts.join(' · ') };
}

function personUpdateHeaders() {
  return withoutPhone(legacy('person-updates.cjs').TEMPLATE_HEADERS);
}

/** 양식별 대상 시트 모양: [{ name, columns, to, note }]. 연락처 열은 싣지 않는다. */
function templateSheets(id) {
  const make = (name, columns) => ({ name, columns: withoutPhone(columns), ...(SHEET_INFO[name] ?? { to: '', note: '' }) });
  switch (id) {
    case 'input': {
      const { SHEETS } = legacy('importer.cjs');
      return ['대상자', '단계변경', '탈락복귀', '활동', '구역일계'].map((name) => make(name, SHEETS[name]));
    }
    case 'daily-input':
      return Object.entries(legacy('daily.cjs').HEADERS).map(([name, columns]) => make(name, columns));
    case 'daily-area': {
      const W = legacy('daily-area-workbook.cjs');
      return [make('활동자', W.activityHeaders), make('찾기', W.findingHeaders), make('업데이트', W.updateHeaders), make('활동자보고', [])];
    }
    case 'activity-records':
      return [make('활동기록', legacy('simple-records.cjs').HEADERS.활동기록)];
    case 'finding-records':
      return [make('찾기건', legacy('simple-records.cjs').HEADERS.찾기건)];
    case 'person-update':
      return [make('대상자 업데이트', personUpdateHeaders())];
    default:
      return [];
  }
}

const DATE_COLUMNS = new Set(['날짜', '만픽일', '찾A일', '복신일']);

/** 한 시트짜리 입력 양식(머리글·작성안내). 날짜 열은 날짜 서식, 나머지는 일반 서식이다. */
async function singleSheetWorkbook(sheetName, columns, { dateColumns = DATE_COLUMNS, importName = sheetName, guide = [] } = {}) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'SMOA';
  const sheet = workbook.addWorksheet(importName, { views: [{ state: 'frozen', ySplit: 1 }] });
  sheet.addRow(columns);
  const head = sheet.getRow(1);
  head.height = 32;
  head.alignment = { vertical: 'middle', wrapText: true };
  head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF176B58' } };
  columns.forEach((label, i) => {
    const column = sheet.getColumn(i + 1);
    column.width = 18;
    if (dateColumns.has(label)) column.numFmt = 'yyyy-mm-dd';
  });
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
  const help = workbook.addWorksheet('작성안내');
  help.addRows(guide);
  help.getColumn(1).width = 26;
  help.getColumn(2).width = 100;
  help.eachRow((row) => {
    row.alignment = { wrapText: true, vertical: 'middle' };
    row.height = 48;
  });
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

const GENERAL_GUIDE = [
  ['수식', '수식은 가져오지 않습니다. 수식이 있으면 복사 → 값 붙여넣기로 바꿔 주세요.'],
  ['입력 제한', '총 입력 행 최대 10,000행입니다. 시트 이름과 열 이름은 바꾸지 마세요.'],
  ['반영 방식', '가져오기는 먼저 미리보기를 만들고, 오류·변경 건수를 확인한 뒤에만 반영합니다. 담당 구역 밖의 행은 제외됩니다.'],
];

/** 이 화면의 가져오기로는 바꿀 수 없는 전역 설정 시트. */
const BLOCKED_SHEETS = ['공통코드', '조직', '구성원', '목표', '지역·구역', '구성원명부'];
const IMPORT_DISTRICT_COLUMNS = { 대상자: '구역', 활동: '구역', 구역일계: '구역', 활동일보: '구역', 찾기일보: '구역' };

function filtersFrom(query, info) {
  const input = {};
  for (const key of FILTER_KEYS) {
    const value = query.get(key);
    if (value != null && value !== '') input[key] = value.slice(0, 200);
  }
  // 화면에서 다른 구역을 고르더라도 서버가 구역 권한을 다시 확인한다.
  if (input.region && !inScope(info, input.region)) throw new HttpError(403, '접근 권한이 없는 구역입니다.');
  return input;
}

function hasData(sheet) {
  let found = false;
  sheet.eachRow((row, n) => {
    if (n <= 1 || found) return;
    row.eachCell((cell) => {
      if (cell.value != null && cell.value !== '') found = true;
    });
  });
  return found;
}

export function reportsRoutes(store) {
  const previews = createPreviewStore(store.now, {});

  const viewFor = async (ctx) => {
    const D = await domain();
    const info = scopeInfo(store, ctx.user);
    return { D, info, ws: D.scopedWorkspace(store, ctx.user) };
  };

  async function info(ctx) {
    const { info: scope, ws } = await viewFor(ctx);
    const view = viewClone(ws, scope);
    const K = legacy('codes.cjs');
    const R = legacy('reports.cjs');
    const codeOptions = (group) => {
      try {
        return K.options(view, group).map(([value]) => ({ value, label: K.label(view, group, value) }));
      } catch {
        return [];
      }
    };
    // 상세 조건 선택 목록: 권한 구역 사본(view)에서 ID·표시 이름만 만든다. 연락처·대상자 상세나 다른 구역 자료는 싣지 않는다.
    const O = legacy('organization.cjs');
    const M = legacy('model.cjs');
    const C = legacy('classification-scope.cjs');
    const safe = (fn, fallback) => {
      try {
        return fn();
      } catch {
        return fallback;
      }
    };
    const org = safe(() => O.get(view), { nodes: [], members: [] });
    const visible = (unitId) => scope.admin || inScope(scope, safe(() => O.regionOf(org, unitId), ''));
    const byLabel = (a, b) => a.label.localeCompare(b.label, 'ko', { numeric: true });
    const orgUnits = org.nodes
      .filter((n) => visible(n.id))
      .map((n) => ({ value: n.id, label: safe(() => O.pathName(org, n.id), n.name) || n.name }))
      .sort(byLabel);
    const introducers = org.members
      .filter((m) => visible(m.unitId))
      .map((m) => ({ value: m.id, label: `${m.name}${m.code ? ` (${m.code})` : ''}${m.status === 'active' ? '' : ' · 보관'}` }))
      .sort(byLabel);
    const workers = [...new Set((view.people ?? []).map((p) => p.worker).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b, 'ko', { numeric: true }));
    return redactDeep({
      today: seoulDate(store.now()),
      exports: EXPORTS.map(([id, label]) => ({ id, label })),
      templates: TEMPLATES.map((t) => ({ ...t, sheets: templateSheets(t.id) })),
      regions: scope.districts.map((d) => d.name),
      stages: view.stages.map((id) => ({ id, label: view.stageNames[id] ?? id, inactive: view.inactiveStages.includes(id) })),
      classes: codeOptions('className'),
      employments: codeOptions('employment'),
      columns: R.columns(view).map(({ key, label }) => ({ key, label })),
      blockedSheets: BLOCKED_SHEETS,
      filters: {
        places: codeOptions('activityPlace').map((o) => o.label),
        classification2: [
          ...M.PERSON_CLASSIFICATIONS.classification2.map((v) => ({ value: v, label: v })),
          { value: C.UNCLASSIFIED, label: '미입력' },
        ],
        statuses: [{ value: 'active', label: '진행' }, { value: 'dropped', label: '탈락' }],
        timeBands: ['새벽', '오전', '오후', '저녁', '미입력'],
        introducers,
        orgUnits,
        workers,
      },
    });
  }

  async function summary(ctx) {
    const { info: scope, ws } = await viewFor(ctx);
    const input = filtersFrom(ctx.query, scope);
    return guarded(() => {
      const view = viewClone(ws, scope);
      const s = legacy('model.cjs').query(view, input).summary;
      return redactDeep({
        people: s.people,
        activities: s.activities,
        minutes: s.minutes,
        workers: s.workers,
        stages: s.stages,
        classes: s.classes,
        regions: s.regions.map(({ label, value }) => ({ label, value })),
        bands: s.bands,
        transitionCount: s.transitionCount,
      });
    });
  }

  async function exportReport(ctx) {
    const { info: scope, ws } = await viewFor(ctx);
    const input = filtersFrom(ctx.query, scope);
    const template = String(ctx.query.get('template') ?? 'detail');
    if (!EXPORTS.some(([id]) => id === template)) throw new HttpError(400, '출력 양식을 확인해 주세요.');
    const selected = template === 'custom' ? String(ctx.query.get('columns') ?? '').split(',').filter(Boolean) : undefined;
    const buffer = await guarded(() => legacy('reports.cjs').createReport(viewClone(ws, scope), input, template, selected));
    ctx.recheck(); // 비동기 작성 뒤 권한이 그대로인지 확인한 후에만 내려보낸다.
    return xlsxResponse(`smoa-report-${template}-${seoulDate(store.now()).replaceAll('-', '')}.xlsx`, buffer);
  }

  async function template(ctx) {
    const { info: scope, ws } = await viewFor(ctx);
    const id = ctx.params[0];
    const buffer = await guarded(async () => {
      if (id === 'input') return legacy('importer.cjs').createTemplate(viewClone(ws, scope));
      if (id === 'daily-input') return legacy('daily.cjs').workbook();
      if (id === 'daily-area') {
        return legacy('daily-area-workbook.cjs').workbook({
          date: '', activityRows: [], findingRows: [], updateRows: [], summary: ['', ''], activityDistricts: new Set(),
        });
      }
      if (id === 'activity-records' || id === 'finding-records') {
        const [sheet] = templateSheets(id);
        return singleSheetWorkbook(sheet.name, sheet.columns, { guide: [[sheet.name, sheet.note], ...GENERAL_GUIDE] });
      }
      if (id === 'person-update') {
        const [sheet] = templateSheets(id);
        const dateColumns = new Set(legacy('person-updates.cjs').DATE_HEADERS);
        return singleSheetWorkbook(sheet.name, sheet.columns, { dateColumns, importName: 'Sheet1', guide: [[sheet.name, sheet.note], ...GENERAL_GUIDE] });
      }
      throw new HttpError(404, '양식을 찾을 수 없습니다.');
    });
    ctx.recheck();
    return xlsxResponse(`smoa-template-${id}.xlsx`, buffer);
  }

  /**
   * 엑셀 가져오기 미리보기. mode가 'person-update'이면 기존 대상자만 고치는 업데이트 양식으로 읽는다.
   * 두 방식 모두 같은 구역 범위 확인·연락처 제거·초안 검증을 거치고, 반영은 같은 apply 경로(미리보기 토큰)로만 한다.
   */
  const importPreview = (mode) => async function preview(ctx) {
    const update = mode === 'person-update';
    const revision = store.workspace.revision; // 비동기 읽기·쓰기 전에 정본 revision을 잡아 둔다.
    const buffer = bufferOf(ctx);
    const { D, info: scope } = await viewFor(ctx);
    const session = sessionOf(ctx, scope);
    const { workbook, phoneCells } = await guarded(() => loadWorkbook(buffer));

    let droppedRows = 0;
    if (update) {
      // 업데이트 양식의 시트 이름은 자유이므로 모든 시트에서 인도자구역 열(별칭 포함)로 담당 밖 행을 비운다.
      for (const header of ['인도자구역', '인도구역', '구역']) {
        droppedRows += dropOutOfScopeRows(workbook, scope, Object.fromEntries(workbook.worksheets.map((s) => [s.name, header])));
      }
    } else {
      const blocked = workbook.worksheets.filter((s) => BLOCKED_SHEETS.includes(s.name) && hasData(s)).map((s) => s.name);
      if (blocked.length) throw new HttpError(400, `${blocked.join('·')} 시트는 이 화면에서 가져올 수 없습니다. 조직·공통코드·목표는 관리 화면에서 처리해 주세요.`);
      if (['활동자', '찾기', '업데이트'].every((n) => workbook.getWorksheet(n))) {
        throw new HttpError(400, '구역 일보 정리본은 구역 일보 화면에서 가져와 주세요.');
      }
      droppedRows = dropOutOfScopeRows(workbook, scope, IMPORT_DISTRICT_COLUMNS);
    }
    const clean = Buffer.from(await workbook.xlsx.writeBuffer());
    ctx.recheck();
    if (store.workspace.revision !== revision) throw new HttpError(409, '파일을 읽는 사이 자료가 바뀌었습니다. 다시 시도해 주세요.');

    const ws = D.scopedWorkspace(store, ctx.user);
    const baseline = validatedBaseline(ws);
    const outcome = await guarded(() => legacy('importer.cjs').previewImport(ws, clean, ctx.user.displayName, update ? { mode: 'person-update' } : {}));
    ctx.recheck();
    if (store.workspace.revision !== revision) throw new HttpError(409, '미리보기를 만드는 사이 자료가 바뀌었습니다. 다시 시도해 주세요.');

    const violations = draftViolations(baseline, outcome.draft, scope);
    const errors = [...outcome.errors, ...violations];
    const canApply = !errors.length && outcome.totalChanges > 0;
    const saved = previews.put(session, revision, 'import', {
      draft: canApply ? outcome.draft : null,
      counts: outcome.counts,
    });
    const notes = [];
    if (droppedRows) notes.push(`접근 권한이 없는 구역의 행 ${droppedRows}건은 제외했습니다.`);
    if (phoneCells) {
      notes.push(update
        ? '휴대폰 번호 열은 보안 정책상 읽지 않고 지웠습니다. 대상자는 대상자ID 또는 대상자명·인도자로 찾으며, 기존 연락처는 그대로 유지됩니다.'
        : '휴대폰 번호 열은 보안 정책상 읽지 않고 지웠습니다. 기존 대상자의 연락처는 그대로 유지됩니다.');
    }
    return redactDeep({
      mode: update ? 'person-update' : 'import',
      importId: saved.id,
      expiresAt: saved.expiresAt,
      canApply,
      counts: outcome.counts,
      errors: errors.slice(0, 300),
      totalErrors: errors.length,
      warnings: outcome.warnings.slice(0, 300),
      changes: outcome.changes.map(describeChange),
      totalChanges: outcome.totalChanges,
      duplicates: outcome.duplicates,
      totalDuplicates: outcome.totalDuplicates,
      notes,
    });
  };

  const DAY = /^\d{4}-\d{2}-\d{2}$/;
  const TOTALS_LIMIT = 100;

  /**
   * 입력 일계(구역 보고 숫자)와 상세 등록 대상자 수의 대조. 구역 권한 안의 일계·대상자만 센다.
   * 차이가 있어도 개인 기록을 만들어 내지 않는다.
   */
  async function dailyTotals(ctx) {
    const { info: scope, ws } = await viewFor(ctx);
    const input = filtersFrom(ctx.query, scope);
    for (const key of ['from', 'to']) {
      if (input[key] && !DAY.test(input[key])) throw new HttpError(400, '기간은 YYYY-MM-DD 형식으로 입력해 주세요.');
    }
    if (input.from && input.to && input.from > input.to) throw new HttpError(400, '시작일은 종료일보다 늦을 수 없습니다.');
    return guarded(() => {
      const view = viewClone(ws, scope);
      const rows = (view.dailyReports ?? [])
        .filter((d) => (!input.from || d.date >= input.from) && (!input.to || d.date <= input.to) && (!input.region || d.region === input.region))
        .sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(a.region).localeCompare(String(b.region), 'ko', { numeric: true }));
      const registered = new Map();
      for (const p of view.people ?? []) {
        if (p.dateUnknown) continue;
        const key = `${p.date}|${p.region}`;
        registered.set(key, (registered.get(key) ?? 0) + 1);
      }
      return redactDeep({
        total: rows.length,
        limit: TOTALS_LIMIT,
        items: rows.slice(0, TOTALS_LIMIT).map((d) => {
          const detailed = registered.get(`${d.date}|${d.region}`) ?? 0;
          return { date: d.date, region: d.region, entered: d.found, detailed, difference: d.found - detailed, advanced: d.advanced, dropped: d.dropped };
        }),
      });
    });
  }

  async function apply(ctx) {
    const D = await domain();
    const scope = scopeInfo(store, ctx.user);
    const saved = previews.get(sessionOf(ctx, scope), ctx.body.importId, 'import');
    if (!saved.data.draft) throw new HttpError(400, '오류가 있거나 바뀌는 내용이 없어 반영할 수 없는 미리보기입니다.');
    if (store.workspace.revision !== saved.revision) {
      previews.delete(ctx.body.importId);
      throw new HttpError(409, '그 사이 자료가 바뀌었습니다. 파일을 다시 올려 미리보기를 확인해 주세요.');
    }
    ctx.recheck();
    await guarded(() => D.commitWorkspace(store, ctx.user, saved.data.draft));
    previews.delete(ctx.body.importId);
    return { applied: true, counts: saved.data.counts };
  }

  return [
    { method: 'GET', path: '/api/reports/info', screen: 'reports', action: 'read', handler: info },
    { method: 'GET', path: '/api/reports/summary', screen: 'reports', action: 'read', handler: summary },
    { method: 'GET', path: '/api/reports/export', screen: 'reports', action: 'export', handler: exportReport },
    { method: 'GET', path: '/api/reports/templates/:id', screen: 'reports', action: 'read', handler: template },
    { method: 'GET', path: '/api/reports/daily-totals', screen: 'reports', action: 'read', handler: dailyTotals },
    { method: 'POST', path: '/api/reports/import-preview', screen: 'reports', action: 'write', binary: true, handler: importPreview('import') },
    { method: 'POST', path: '/api/reports/target-update-preview', screen: 'reports', action: 'write', binary: true, handler: importPreview('person-update') },
    { method: 'POST', path: '/api/reports/apply', screen: 'reports', action: 'write', handler: apply },
  ];
}
