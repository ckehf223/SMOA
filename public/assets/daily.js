import { api, getJson, h, sendJson, toast } from './common.js';

/**
 * 구역 일보 화면: 원문 변환 → 확인 → 정리본 엑셀 / 가져오기 미리보기 → 반영.
 * 모든 판단(구역 권한·연락처 마스킹·검증)은 서버가 한다. 이 화면은 서버가 준 결과만 보여 준다.
 * 쓰기·내보내기 버튼은 me.perms.daily가 허용할 때만 나타난다.
 */

export const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const MAX_FILE = 8 * 1024 * 1024; // 서버(binary 라우트)의 실제 상한과 같다.

// ───────────── 다른 화면(보고서)에서도 쓰는 도우미 ─────────────

export async function downloadFile(url, fallbackName) {
  const res = await api('GET', url);
  const objectUrl = URL.createObjectURL(await res.blob());
  const a = h('a', { href: objectUrl, download: /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? fallbackName });
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(objectUrl);
}

/** 엑셀 파일을 그대로 올리는 요청(binary). 성공하면 JSON 응답을 돌려준다. */
export async function uploadXlsx(url, file) {
  if (!file) throw new Error('엑셀 파일(.xlsx)을 선택해 주세요.');
  if (!/\.xlsx$/i.test(file.name)) throw new Error('.xlsx 파일만 올릴 수 있습니다.');
  if (file.size === 0 || file.size > MAX_FILE) throw new Error('엑셀 파일은 1바이트 이상 8MB 이하여야 합니다.');
  const res = await fetch(url, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': XLSX_TYPE },
    body: file,
  });
  if (res.status === 401) {
    location.href = '/login';
    throw new Error('로그인이 필요합니다.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || '파일을 처리하지 못했습니다.');
  return data;
}

export const statusLine = (message, kind = 'error') => h('p', { class: `status ${kind}`, role: kind === 'error' ? 'alert' : 'status' }, message);

export function dataTable(label, headers, rows, total) {
  if (!rows.length) return h('div', { class: 'card empty' }, `${label}: 해당하는 행이 없습니다.`);
  return h('div', null,
    h('div', { class: 'table-wrap', tabindex: '0', role: 'region', 'aria-label': label },
      h('table', null,
        h('thead', null, h('tr', null, headers.map((t) => h('th', { scope: 'col' }, t)))),
        h('tbody', null, rows.map((r) => h('tr', null, r.map((c) => h('td', null, c))))))),
    total > rows.length ? h('p', { class: 'note' }, `${total}행 중 처음 ${rows.length}행만 표시합니다. 전체는 엑셀로 내려받아 확인해 주세요.`) : null);
}

/** replaceChildren은 null을 "null" 글자로 바꾸므로 비어 있는 자리(null·undefined·false)를 빼고 넣는다. 0과 빈 문자열은 그대로 둔다. */
export function setChildren(parent, ...kids) {
  parent.replaceChildren(...kids.filter((k) => k != null && k !== false));
}

export function messageList(title, items, kind) {
  if (!items?.length) return null;
  return h('section', { class: 'card' }, h('h2', null, `${title} (${items.length})`),
    h('ul', { class: kind === 'error' ? 'status error' : 'note' }, items.map((m) => h('li', null, m))));
}

export function countCards(counts) {
  const entries = Object.entries(counts ?? {}).filter(([, v]) => typeof v === 'number');
  if (!entries.length) return null;
  return h('div', { class: 'cards' }, entries.map(([k, v]) =>
    h('div', { class: 'card stat' }, h('div', { class: 'num' }, String(v)), h('div', { class: 'cap' }, k))));
}

/** 버튼을 누르는 동안 비활성화하고, 오류는 지정한 자리에 보여 준다. */
export function runBusy(button, slot, fn) {
  return async () => {
    if (button.disabled) return;
    button.disabled = true;
    slot.replaceChildren();
    try {
      await fn();
    } catch (err) {
      slot.replaceChildren(statusLine(err.message));
    } finally {
      button.disabled = false;
    }
  };
}

const field = (label, control, cls) => h('label', { class: cls }, label, control);
const SCOPE_LABEL = { activity: '활동자', finding: '찾기', updates: '업데이트' };
const SETTING_LIMIT = 100_000; // 서버(compileSettings)가 받는 설정 글의 최대 글자 수
const TEXT_FILE_ACCEPT = '.txt,text/plain';
const LIST_FILE_ACCEPT = '.txt,.tsv,text/plain,text/tab-separated-values';

// ───────────── 일보 원문 합치기 (원본 SMOA 구역 일보 통합 변환의 경계 순서) ─────────────

// 구역 칸의 한 줄에서 "<1구역 일일보고>", "1구역 일보", "구역: 1구역" 같은 제목의 구역 이름만 뽑는 모양.
const TITLE_PATTERN = /^(?:구역\s*[:：]\s*)?([\p{L}\p{N} ·_-]+?\s*구역)\s*(?:(?:일일\s*)?(?:보고|활동\s*(?:계획|보고|일보))|일보)?$/u;

// 보이지 않는 글자(너비 0 공백·이음 글자·글꼴 선택자·BOM)와 굵게 표시(**)
const ZERO_WIDTH_OR_BOLD = new RegExp('[\\u200b-\\u200d\\uFE0F\\uFEFF]|\\*\\*', 'gu');

/** 한 줄의 장식(이모지·굵게 표시·꺾쇠)을 원본과 같은 순서로 벗기고 구역 제목이면 구역 이름을 돌려준다. */
function titleOf(line) {
  const match = line
    .normalize('NFC')
    .replace(ZERO_WIDTH_OR_BOLD, '')
    .replace(/^[\s\p{Extended_Pictographic}▪▫·]+/u, '')
    .replace(/\\\s*$/, '')
    .trim()
    .replace(/^[<＜〈]+|[>＞〉]+$/g, '')
    .trim()
    .match(TITLE_PATTERN);
  return match ? match[1] : null;
}

/**
 * 구역별 칸의 원문을 한 글로 합친다. 입력은 [구역 이름, 원문] 목록이며 주어진 순서대로 이어 붙인다.
 * 비어 있는 칸은 건너뛰고, 제목이 없으면 "<구역 일일보고>"를 앞에 붙이며,
 * 제목이 여러 개이거나 다른 구역의 제목이면 오류로 알린다. 칸 사이는 빈 줄 하나로 구분한다.
 */
export function mergeDistrictTexts(entries) {
  const squash = (name) => name.normalize('NFC').replace(/\s+/g, '');
  return entries.flatMap(([district, entry]) => {
    const text = entry.trim();
    if (!text) return [];
    const titles = text.split(/\r?\n/).map(titleOf).filter(Boolean);
    if (titles.length > 1) throw new Error(`${district} 칸에 일보 제목이 여러 개 있습니다. 전체 붙여넣기 방식을 이용하세요.`);
    if (titles.length) {
      if (squash(titles[0]) !== squash(district)) throw new Error(`${district} 칸에 ${titles[0]} 일보가 들어 있습니다.`);
      return [text];
    }
    return [`<${district} 일일보고>\n${text}`];
  }).join('\n\n');
}

/** 텍스트 파일을 UTF-8로 읽는다(File.text). 브라우저가 읽기 전에 크기를, 읽은 뒤에 글자 수를 확인한다. */
async function readTextFile(file, limit, label) {
  if (!file) return null;
  const tooLong = new Error(`${label}이(가) 너무 깁니다. ${limit.toLocaleString('ko-KR')}자 이하로 나누어 불러오세요.`);
  if (file.size > limit * 4) throw tooLong;
  const text = await file.text();
  if (text.length > limit) throw tooLong;
  return text;
}

/** 누적 엑셀 화면 조각은 별도 모듈이 맡는다. 불러오지 못하면 이유를 화면에 알린다. */
async function loadCumulativeControls(conversionId) {
  try {
    const { cumulativeControls } = await import('./cumulative.js');
    return cumulativeControls(conversionId);
  } catch (err) {
    console.error('누적 엑셀 모듈을 불러오지 못했습니다:', err?.name);
    return h('p', { class: 'note' }, '누적 엑셀 기능을 불러오지 못했습니다. 페이지를 새로 고친 뒤에도 같으면 관리자에게 알려 주세요.');
  }
}

// ───────────── 가져오기 미리보기 결과 ─────────────

function renderImport(box, data, me, { applyUrl = '/api/daily/apply', detailsBase = '/api/daily/imports' } = {}) {
  const perm = me.perms.daily;
  const detailBox = h('div');
  const applySlot = h('div');
  const applyButton = h('button', { type: 'button' }, '미리보기대로 반영');
  applyButton.addEventListener('click', runBusy(applyButton, applySlot, async () => {
    if (!window.confirm('미리보기 내용을 자료에 반영합니다. 계속할까요?')) return;
    const result = await sendJson('POST', applyUrl, { importId: data.importId });
    applyButton.hidden = true;
    applySlot.replaceChildren(statusLine('반영했습니다. 같은 파일을 다시 반영하면 중복은 건너뜁니다.', 'ok'));
    toast('반영했습니다.');
    return result;
  }));
  applyButton.hidden = !(perm.write && data.canApply);

  async function loadDetails(sheet, outcome, page) {
    const qs = new URLSearchParams({ sheet, outcome, page });
    try {
      const d = await getJson(`${detailsBase}/${encodeURIComponent(data.importId)}/details?${qs}`);
      detailBox.replaceChildren(
        h('h3', null, `${sheet} · ${outcome} (${d.total}건)`),
        dataTable('처리 내역', ['행', '처리', '설명', '내용'], d.items.map((r) => [
          String(r.row), r.outcome, r.message, r.fields.map((f) => `${f.label}: ${f.value}`).join(' · '),
        ]), d.total),
        h('div', { class: 'pager' },
          h('button', { type: 'button', class: 'secondary', disabled: d.page <= 1, onclick: () => loadDetails(sheet, outcome, d.page - 1) }, '이전'),
          h('span', null, `${d.page}쪽`),
          h('button', { type: 'button', class: 'secondary', disabled: d.page * d.pageSize >= d.total, onclick: () => loadDetails(sheet, outcome, d.page + 1) }, '다음')));
    } catch (err) {
      detailBox.replaceChildren(statusLine(err.message));
    }
  }

  setChildren(box,
    h('h2', null, `가져오기 미리보기 · 보고일 ${data.date || '-'}`),
    h('p', { class: 'note' }, `선택한 시트: ${data.scopes.map((s) => SCOPE_LABEL[s] ?? s).join(', ')} · 이 미리보기는 ${new Date(data.expiresAt).toLocaleTimeString('ko-KR')}까지 유효합니다.`),
    ...Object.entries(data.counts).map(([sheet, counts]) => h('section', { class: 'card' }, h('h3', null, SCOPE_LABEL[sheet] ?? sheet), countCards(counts))),
    data.notes?.length ? messageList('안내', data.notes, 'note') : null,
    messageList('오류 — 고치기 전에는 반영할 수 없습니다', data.errors, 'error'),
    messageList('확인이 필요한 항목', data.warnings, 'note'),
    data.outcomes.length ? h('section', { class: 'card' }, h('h3', null, '처리 내역 보기'),
      h('div', { class: 'toolbar' }, data.outcomes.map((o) =>
        h('button', { type: 'button', class: 'secondary', onclick: () => loadDetails(o.sheet, o.outcome, 1) }, `${o.sheet} · ${o.outcome} (${o.count})`)))) : null,
    detailBox,
    data.canApply
      ? (perm.write ? h('div', { class: 'toolbar' }, applyButton, applySlot) : h('p', { class: 'note' }, '반영 권한이 없어 미리보기만 확인할 수 있습니다.'))
      : h('p', { class: 'status error' }, '반영할 수 있는 변경이 없거나 오류가 있습니다.'));
}

// ───────────── 화면 ─────────────

async function daily(box, me) {
  const perm = me.perms.daily;
  const info = await getJson('/api/daily/info');
  const settings = {
    excludedText: info.settings.excludedText,
    aliasesText: info.settings.aliasesText,
    activityOrderText: info.settings.activityOrderText,
    slashLayouts: { ...info.settings.slashLayouts },
  };
  const panel = h('div');
  let tab = 'convert';

  // 탭을 오가도 붙여넣은 원문이 사라지지 않도록 변환 입력 상태는 화면 단위로 둔다.
  const draft = { mode: 'all', text: '', byDistrict: new Map(), year: String(info.year), regionId: '' };
  const orderedDistricts = [...info.districts].sort(new Intl.Collator('ko', { numeric: true }).compare);

  // 변환 설정(활동자 제외·이름 변경·순서)은 일보 변환 탭과 변환 설정 탭이 같은 값을 보여 준다.
  let savedSnapshot = JSON.stringify(settings);
  const statusLines = new Set();
  function refreshSettingsStatus() {
    const dirty = JSON.stringify(settings) !== savedSnapshot;
    for (const line of [...statusLines]) {
      if (!line.isConnected) statusLines.delete(line);
      else line.textContent = dirty ? '저장하지 않은 변경은 지금 화면에서 변환할 때만 적용됩니다.' : '저장된 설정을 적용합니다.';
    }
  }

  /** 글 상자 + 텍스트·TSV 파일 불러오기. 파일은 UTF-8로 읽어 상자에 채우며, 설정에 반영하려면 저장하지 않아도 변환에는 바로 쓰인다. */
  function listEditor(key, label, format, placeholder) {
    const id = `daily-setting-${key}`;
    const note = h('p', { class: 'note', role: 'status' });
    const area = h('textarea', { id, rows: '6', placeholder, maxlength: String(SETTING_LIMIT), value: settings[key] });
    area.addEventListener('input', () => { settings[key] = area.value; refreshSettingsStatus(); });
    const picker = h('input', { type: 'file', id: `${id}-file`, accept: LIST_FILE_ACCEPT });
    picker.addEventListener('change', async () => {
      const file = picker.files[0];
      picker.value = '';
      try {
        const text = await readTextFile(file, SETTING_LIMIT, `${label} 목록`);
        if (text == null) return;
        area.value = text;
        settings[key] = text;
        note.textContent = `${file.name} 파일을 불러왔습니다. 저장하거나 변환하면 적용됩니다.`;
        refreshSettingsStatus();
      } catch (err) {
        note.textContent = err.message;
      }
    });
    return h('div', { class: 'stack wide' },
      h('label', { for: id }, label), area,
      h('p', { class: 'note' }, format),
      h('label', { for: `${id}-file` }, `${label} 파일 불러오기 (.txt·.tsv, UTF-8)`), picker, note);
  }

  const rosterEditors = () => [
    listEditor('activityOrderText', '활동자 순서', '부 | 구역 | 반 | 이름 (또는 이름만) 표를 원하는 순서대로 붙여넣으세요. 목록에 없는 활동자는 활동자 시트의 끝에 추가됩니다.', '1구역 | 가나다'),
    listEditor('excludedText', '활동자 제외', '한 줄에 구역 | 이름 형식으로 입력합니다. 규칙을 지우려면 줄을 제거하세요.', '1구역 | 가나다'),
    listEditor('aliasesText', '활동자 이름 변경', '한 줄에 구역 | 이전이름 | 현재이름 형식으로 입력합니다.', '1구역 | 가나다 | 가나다A'),
  ];

  function settingsFooter() {
    const slot = h('div');
    const status = h('p', { class: 'note', role: 'status' });
    statusLines.add(status);
    refreshSettingsStatus();
    const save = h('button', { type: 'button' }, '서버에 저장');
    save.addEventListener('click', runBusy(save, slot, async () => {
      await sendJson('PUT', '/api/daily/settings', settings);
      savedSnapshot = JSON.stringify(settings);
      refreshSettingsStatus();
      slot.replaceChildren(statusLine('저장했습니다. 정리본 파일 가져오기에도 적용됩니다.', 'ok'));
    }));
    return h('div', null, status, perm.write ? h('div', { class: 'buttons' }, save) : h('p', { class: 'note' }, '저장 권한이 없어 이 화면을 닫기 전까지만 적용됩니다.'), slot);
  }

  const tabButtons = [
    ['convert', '일보 변환'], ['text', '텍스트 일보 입력'], ['file', '정리본 파일 가져오기'], ['changes', '찾기 변경 건'],
    ['notice', '활동 공지 변환'], ['analytics', '기간 분석'], ['settings', '변환 설정'],
  ];
  const tabBar = h('div', { class: 'toolbar', role: 'group', 'aria-label': '일보 작업' });
  function show(id) {
    tab = id;
    tabBar.replaceChildren(...tabButtons.map(([key, label]) =>
      h('button', { type: 'button', class: key === tab ? '' : 'secondary', 'aria-pressed': key === tab ? 'true' : 'false', onclick: () => show(key) }, label)));
    panel.replaceChildren(({
      convert: convertPanel, text: textPanel, file: filePanel, changes: changesPanel,
      notice: noticePanel, analytics: analyticsPanel, settings: settingsPanel,
    })[id]());
  }

  const districtSelect = (name, blankLabel) =>
    h('select', { name }, blankLabel == null ? null : h('option', { value: '' }, blankLabel), info.districts.map((d) => h('option', { value: d }, d)));

  /** 찾기 행 검토 표: 서버가 지적한 칸을 고쳐 다시 확인한다. 보고일·구역·대상자ID는 고칠 수 없다. */
  function reviewSection(data, resubmit) {
    const f = data.findings;
    if (!f.rows.length) return null;
    const editable = new Set(data.editableKeys);
    const inputs = [];
    const body = f.rows.map((row, i) => h('tr', null, f.keys.map((key, c) => {
      if (!f.editable || !editable.has(key)) return h('td', null, row[c]);
      const input = h('input', { type: 'text', maxlength: '200', value: row[c], 'aria-label': `${i + 1}행 ${f.headers[c]}` });
      inputs.push([i, key, input]);
      return h('td', null, input);
    })));
    const slot = h('div');
    const button = h('button', { type: 'button', class: 'secondary' }, '고친 내용으로 다시 확인');
    button.addEventListener('click', runBusy(button, slot, async () => {
      const rows = f.rows.map(() => ({}));
      for (const [i, key, input] of inputs) rows[i][key] = input.value;
      await resubmit(rows);
    }));
    const notes = f.reviews.flatMap((list, i) => list.map((m) => `${i + 1}행: ${m}`));
    return h('section', { class: 'card' }, h('h3', null, `찾기 행 검토 (${f.total}행)`),
      messageList('검토가 필요한 행', notes, 'note'),
      h('div', { class: 'table-wrap', tabindex: '0', role: 'region', 'aria-label': '찾기 행 검토' },
        h('table', null, h('thead', null, h('tr', null, f.headers.map((t) => h('th', { scope: 'col' }, t)))), h('tbody', null, body))),
      f.editable ? h('div', { class: 'toolbar' }, button, slot) : h('p', { class: 'note' }, '행이 많아 검토 표에서 고칠 수 없습니다. 원문을 나누어 입력해 주세요.'));
  }

  // 텍스트 일보 입력 (기존 SMOA 활동·찾기 일보 글 → 미리보기 → 반영)
  function textPanel() {
    const slot = h('div');
    const result = h('div');
    const text = h('textarea', { name: 'text', rows: '14', maxlength: String(info.maxSmallTextLength), placeholder: '구역·활동자(시간)·찾기 건수가 들어 있는 일보 글을 붙여 넣으세요.' });
    const date = h('input', { type: 'date', name: 'date' });
    const region = districtSelect('region', '원문에서 읽기');
    const submit = h('button', { type: 'button' }, '변환 확인');

    const sample = () => {
      const [, m, d] = info.today.split('-').map(Number);
      text.value = [
        `${info.today} 일보`, info.districts[0] ?? '1구역', '활동자 : 가나다(19:00-20:00), 라마바(17:00-19:00)', '',
        '찾기 건수', '찾B', `${m}/${d} 여백 예시대상가 남 25 제기동 천호 23시 가나다 신규`,
      ].join('\n');
    };

    function render(data) {
      const applySlot = h('div');
      const applyButton = h('button', { type: 'button' }, '미리보기대로 반영');
      applyButton.addEventListener('click', runBusy(applyButton, applySlot, async () => {
        if (!window.confirm('미리보기 내용을 자료에 반영합니다. 계속할까요?')) return;
        await sendJson('POST', '/api/daily/text-apply', { previewId: data.previewId });
        applyButton.hidden = true;
        applySlot.replaceChildren(statusLine('반영했습니다. 같은 일보를 다시 반영하면 중복은 건너뜁니다.', 'ok'));
        toast('반영했습니다.');
      }));
      setChildren(result,
        h('h2', null, `텍스트 일보 미리보기 · 보고일 ${data.date || '-'}`),
        h('p', { class: 'note' }, `이 미리보기는 ${new Date(data.expiresAt).toLocaleTimeString('ko-KR')}까지 유효합니다.`),
        countCards(data.counts),
        messageList(`오류 — 고치기 전에는 반영할 수 없습니다${data.totalErrors > data.errors.length ? ` (전체 ${data.totalErrors}건 중 일부)` : ''}`, data.errors, 'error'),
        messageList('확인이 필요한 항목', data.warnings, 'note'),
        h('section', { class: 'card' }, h('h3', null, '활동'), dataTable('활동', data.activity.headers, data.activity.rows, data.activity.total)),
        reviewSection(data, (rows) => run(rows)),
        data.canApply
          ? (perm.write ? h('div', { class: 'toolbar' }, applyButton, applySlot) : h('p', { class: 'note' }, '반영 권한이 없어 미리보기만 확인할 수 있습니다.'))
          : h('p', { class: 'status error' }, '반영할 수 있는 변경이 없거나 오류가 있습니다.'));
    }
    async function run(findings) {
      const body = { text: text.value, date: date.value, region: region.value };
      if (findings) body.findings = findings;
      render(await sendJson('POST', '/api/daily/text-preview', body));
    }
    submit.addEventListener('click', runBusy(submit, slot, async () => {
      if (!text.value.trim()) throw new Error('일보 원문을 붙여넣어 주세요.');
      await run();
    }));
    return h('div', null,
      h('div', { class: 'card' },
        h('p', { class: 'note' }, '기존 SMOA의 활동·찾기 일보 글을 읽어 활동 기록과 대상자 등록·단계 변경으로 반영합니다. 활동자와 인도자는 조직의 구성원 명부에 있어야 하며, 연락처는 읽지 않습니다.'),
        h('div', { class: 'form-grid' }, field('보고일 (비워 두면 원문의 날짜 사용)', date), field('구역', region)),
        field('일보 원문', text),
        h('div', { class: 'buttons' }, h('button', { type: 'button', class: 'secondary', onclick: sample }, '예시 넣기'), submit),
        slot),
      result);
  }

  // 찾기 변경 건 (신규 찾B·단계 향상·탈락 → 엑셀 2종)
  function changesPanel() {
    const slot = h('div');
    const result = h('div');
    const text = h('textarea', { name: 'text', rows: '12', maxlength: String(info.maxSmallTextLength), placeholder: '신규·유지·탈락 상태가 들어 있는 찾기 일보 글을 붙여 넣으세요.' });
    const date = h('input', { type: 'date', name: 'date', value: info.today, required: true });
    const region = districtSelect('region', null);
    const submit = h('button', { type: 'button' }, '변경 건 확인');

    function render(data) {
      const exportSlot = h('div');
      const download = (kind, label, file) => {
        const button = h('button', { type: 'button', class: 'secondary' }, label);
        button.addEventListener('click', runBusy(button, exportSlot, async () => {
          await downloadFile(`/api/daily/changes/${encodeURIComponent(data.changesId)}/workbook?kind=${kind}`, file);
          toast('엑셀을 내려받았습니다.');
        }));
        return button;
      };
      setChildren(result,
        h('h2', null, `찾기 변경 건 · ${data.region} · 보고일 ${data.date}`),
        countCards(data.counts),
        messageList(`오류${data.totalErrors > data.errors.length ? ` (전체 ${data.totalErrors}건 중 일부)` : ''}`, data.errors, 'error'),
        messageList('확인이 필요한 항목', data.warnings, 'note'),
        reviewSection(data, (rows) => run(rows)),
        h('section', { class: 'card' }, h('h3', null, '신규 찾B'), dataTable('신규 찾B', data.newTable.headers, data.newTable.rows, data.newTable.total)),
        h('section', { class: 'card' }, h('h3', null, '단계 향상·탈락 업데이트'), dataTable('업데이트', data.updateTable.headers, data.updateTable.rows, data.updateTable.total)),
        perm.export && data.canExport
          ? h('div', { class: 'toolbar' },
            data.newTable.total ? download('new', '신규 찾B 엑셀', 'smoa-daily-changes-new.xlsx') : null,
            data.updateTable.total ? download('update', '업데이트 엑셀', 'smoa-daily-changes-update.xlsx') : null)
          : null,
        exportSlot,
        h('p', { class: 'note' }, '엑셀의 연락처 칸은 비어 있습니다. 파일은 서버에 저장되지 않고 내려받기만 합니다.'));
    }
    async function run(findings) {
      const body = { text: text.value, date: date.value, region: region.value };
      if (findings) body.findings = findings;
      render(await sendJson('POST', '/api/daily/changes-preview', body));
    }
    submit.addEventListener('click', runBusy(submit, slot, async () => {
      if (!text.value.trim()) throw new Error('일보 원문을 붙여넣어 주세요.');
      if (!date.value) throw new Error('보고일을 선택해 주세요.');
      await run();
    }));
    if (!info.districts.length) return h('div', { class: 'card empty' }, '조회할 수 있는 구역이 없습니다. 관리자에게 구역 권한을 요청해 주세요.');
    return h('div', null,
      h('div', { class: 'card' },
        h('div', { class: 'form-grid' }, field('보고일', date), field('구역', region)),
        field('일보 원문', text),
        h('div', { class: 'buttons' }, submit), slot),
      result);
  }

  // 기간 분석 (구역 권한 범위의 집계만)
  function analyticsPanel() {
    const slot = h('div');
    const result = h('div');
    const from = h('input', { type: 'date', name: 'from' });
    const to = h('input', { type: 'date', name: 'to' });
    const region = districtSelect('region', '전체 구역');
    const submit = h('button', { type: 'button' }, '조회');
    const groupTable = (label, list) => h('section', { class: 'card' }, h('h3', null, label),
      dataTable(label, ['구분', '건수'], list.map((x) => [x.label, String(x.value)]), list.length));
    const TITLES = [['person', '개인별'], ['area', '지역별'], ['region', '구역별'], ['class', '반별'], ['hour', '시간대별'], ['date', '일자별']];
    submit.addEventListener('click', runBusy(submit, slot, async () => {
      const qs = new URLSearchParams();
      if (from.value) qs.set('from', from.value);
      if (to.value) qs.set('to', to.value);
      if (region.value) qs.set('region', region.value);
      const a = await getJson(`/api/daily/analytics?${qs}`);
      setChildren(result,
        h('h2', null, `기간 분석 · ${a.filters.from || '처음'} ~ ${a.filters.to || '오늘까지'} · ${a.filters.region || '전체 구역'}`),
        countCards({
          '일보 건수': a.reports, 신규: a.reportedNew, 유지: a.retained, 탈락: a.dropped, '최초 창출': a.creations,
          '활동 건수': a.activityCount, '활동 시간(분)': a.activityMinutes, 활동자: a.totalWorkers,
        }),
        h('section', { class: 'card' }, h('h3', null, '활동자별 활동'),
          dataTable('활동자별', ['이름', '구역', '활동일수', '활동 시간(분)', '활동 건수', '시간 미기록'],
            a.workers.map((w) => [w.name, w.region, String(w.days), String(w.minutes), String(w.count), String(w.unknownTimeCount)]), a.totalWorkers)),
        h('div', { class: 'form-grid' }, groupTable('인도자별 창출', a.byWorker), groupTable('구역별 창출', a.byRegion),
          groupTable('시간대별 창출', a.byHour), groupTable('반별 창출', a.byClass)),
        ...TITLES.map(([key, label]) => h('section', { class: 'card' }, h('h3', null, `${label} 집계`),
          dataTable(`${label} 집계`, [label.replace('별', ''), '활동자', '활동일수', '활동 수', '활동 시간(분)', '창출', '신규', '유지', '탈락'],
            a.dimensions[key].map((b) => [b.label, String(b.workers), String(b.days), String(b.activities), String(b.minutes), String(b.creations), String(b.reportedNew), String(b.retained), String(b.dropped)]),
            a.dimensions[key].length))),
        h('p', { class: 'note' }, '접근 권한이 있는 구역의 자료만 집계합니다. 활동은 시작일, 최초 창출은 찾은 날짜, 보고 상태는 보고일 기준입니다.'));
    }));
    return h('div', null,
      h('div', { class: 'card' },
        h('div', { class: 'form-grid' }, field('시작일', from), field('종료일', to), field('구역', region)),
        h('div', { class: 'buttons' }, submit), slot),
      result);
  }

  // 1) 원문 변환
  function convertPanel() {
    const slot = h('div');
    const result = h('div');
    const year = h('input', { type: 'number', name: 'year', min: '1900', max: '9999', value: draft.year });
    year.addEventListener('input', () => { draft.year = year.value; });
    const area = h('select', { name: 'regionId' }, h('option', { value: '' }, '자동 선택'), info.areas.map((a) => h('option', { value: a.id }, a.name)));
    area.value = draft.regionId;
    area.addEventListener('change', () => { draft.regionId = area.value; });
    const submit = h('button', { type: 'button' }, '변환 확인');
    const inputBox = h('div', { class: 'stack' });
    const modeBar = h('div', { class: 'toolbar', role: 'group', 'aria-label': '일보 입력 방식' });

    /** 글 상자와 텍스트 파일 불러오기 한 벌. 파일은 UTF-8로 읽어 상자를 바꾸고 이전 변환 결과는 지운다. */
    function textInput({ id, label, rows, fileLabel, placeholder, get, set }) {
      const box = h('textarea', { id, rows, maxlength: String(info.maxTextLength), placeholder, value: get() });
      box.addEventListener('input', () => set(box.value));
      const picker = h('input', { type: 'file', id: `${id}-file`, accept: TEXT_FILE_ACCEPT });
      picker.addEventListener('change', async () => {
        const file = picker.files[0];
        picker.value = '';
        try {
          const text = await readTextFile(file, info.maxTextLength, '일보 텍스트');
          if (text == null) return;
          box.value = text;
          set(text);
          result.replaceChildren();
          slot.replaceChildren(statusLine(`${file.name} 파일을 불러왔습니다.`, 'ok'));
        } catch (err) {
          slot.replaceChildren(statusLine(err.message));
        }
      });
      return h('div', { class: 'stack' },
        h('label', { for: id }, label), box,
        h('label', { for: `${id}-file` }, fileLabel), picker);
    }

    function showInput() {
      modeBar.replaceChildren(...[['all', '일보 전체 붙여넣기'], ['districts', '구역별로 입력']].map(([key, text]) =>
        h('button', { type: 'button', class: key === draft.mode ? '' : 'secondary', 'aria-pressed': key === draft.mode ? 'true' : 'false', onclick: () => { draft.mode = key; showInput(); } }, text)));
      if (draft.mode === 'all') {
        inputBox.replaceChildren(textInput({
          id: 'daily-text', label: '일보 원문', rows: '14', fileLabel: '텍스트 파일 불러오기 (.txt, UTF-8)',
          placeholder: '구역별 일보를 그대로 붙여 넣으세요. 여러 구역을 한 번에 넣을 수 있습니다.',
          get: () => draft.text, set: (v) => { draft.text = v; },
        }));
        return;
      }
      inputBox.replaceChildren(
        h('p', { class: 'note' }, '입력한 구역만 변환합니다. 제목이 없는 칸에는 구역 제목을 자동으로 붙이고, 칸은 아래 순서대로 이어 붙입니다. 접근 권한이 있는 구역만 입력할 수 있습니다.'),
        orderedDistricts.length
          ? h('div', { class: 'form-grid' }, orderedDistricts.map((name, i) => textInput({
            id: `daily-text-${i + 1}`, label: `${name} 일보 원문`, rows: '5', fileLabel: `${name} 텍스트 파일 불러오기 (.txt, UTF-8)`,
            placeholder: `${name} 일보를 붙여 넣으세요.`,
            get: () => draft.byDistrict.get(name) ?? '', set: (v) => { draft.byDistrict.set(name, v); },
          })))
          : h('div', { class: 'card empty' }, '입력할 수 있는 구역이 없습니다. 관리자에게 구역 권한을 요청해 주세요.'));
    }

    /** 변환 요청에 보낼 원문. 구역별 입력은 원본의 경계 순서로 합친다. */
    function reportText() {
      const text = draft.mode === 'all'
        ? draft.text.trim()
        : mergeDistrictTexts(orderedDistricts.map((name) => [name, draft.byDistrict.get(name) ?? '']));
      if (!text) throw new Error('변환할 일보를 입력해 주세요.');
      if (text.length > info.maxTextLength) throw new Error(`일보 텍스트가 너무 깁니다. ${info.maxTextLength.toLocaleString('ko-KR')}자 이하로 나누어 변환해 주세요.`);
      return text;
    }

    const sample = () => {
      const [, m, d] = info.today.split('-').map(Number);
      const day = `${m}/${d}`;
      const district = info.districts[0] ?? '1구역';
      const text = [
        `${district} 일보`, `날짜: ${day}`, '활동자 수: 총 2명 (가나다, 라마바)', '1. 적극적 활동자: 가나다 라마바',
        '찾B : 신규 1건', '신규', `${day} 여백 예시대상가 남 25 제기동 천호 23시 가나다`,
      ].join('\n');
      if (draft.mode === 'all') draft.text = text;
      else if (orderedDistricts[0]) draft.byDistrict.set(orderedDistricts[0], text);
      showInput();
    };

    async function convert() {
      const data = await sendJson('POST', '/api/daily/convert', {
        text: reportText(), year: Number(year.value), regionId: area.value, settings,
      });
      const importBox = h('div');
      const importSlot = h('div');
      // 가져올 시트: 기존 정리본 가져오기와 같은 활동자·찾기·업데이트 선택을 변환 결과에서도 고른다.
      const scopeBoxes = Object.entries(SCOPE_LABEL).map(([key, label]) =>
        h('label', { class: 'check' }, h('input', { type: 'checkbox', name: key, checked: true }), label));
      const importButton = h('button', { type: 'button' }, '가져오기 미리보기');
      importButton.addEventListener('click', runBusy(importButton, importSlot, async () => {
        const chosen = scopeBoxes.map((l) => l.querySelector('input')).filter((i) => i.checked).map((i) => i.name);
        if (!chosen.length) throw new Error('가져올 시트를 하나 이상 선택해 주세요.');
        const preview = await sendJson('POST', '/api/daily/import-preview', { conversionId: data.conversionId, scopes: chosen });
        renderImport(importBox, preview, me);
      }));
      const cumulativeSlot = h('div');
      if (perm.export) loadCumulativeControls(data.conversionId).then((controls) => setChildren(cumulativeSlot, controls));
      const exportSlot = h('div');
      const exportButton = h('button', { type: 'button', class: 'secondary' }, '정리본 엑셀 내려받기');
      exportButton.addEventListener('click', runBusy(exportButton, exportSlot, async () => {
        await downloadFile(`/api/daily/conversions/${encodeURIComponent(data.conversionId)}/workbook`, 'smoa-daily.xlsx');
        toast('정리본 엑셀을 내려받았습니다.');
      }));
      setChildren(result,
        h('h2', null, `변환 결과 · 보고일 ${data.date}`),
        h('p', { class: 'note' }, `이 결과는 ${new Date(data.expiresAt).toLocaleTimeString('ko-KR')}까지 서버에 보관됩니다. 미리보기와 변환 엑셀에는 연락처가 끝 네 자리만 표시되며, 가져온 연락처는 저장 자료에 포함되지 않습니다.`),
        countCards(data.counts),
        data.droppedDistricts ? h('p', { class: 'note' }, `접근 권한이 없는 구역 ${data.droppedDistricts}곳은 제외했습니다.`) : null,
        h('section', { class: 'card' }, h('h3', null, '요약 보고'),
          h('div', { class: 'form-grid' },
            field('요약보고', h('textarea', { readonly: true, rows: '4', value: data.summary[0] })),
            field('활동자', h('textarea', { readonly: true, rows: '4', value: data.summary[1] })))),
        messageList('확인이 필요한 항목', data.warnings, 'note'),
        h('section', { class: 'card' }, h('h3', null, '활동자'), dataTable('활동자', data.activity.headers, data.activity.rows, data.activity.total)),
        h('section', { class: 'card' }, h('h3', null, '찾기 (신규 찾B)'), dataTable('찾기', data.finding.headers, data.finding.rows, data.finding.total)),
        h('section', { class: 'card' }, h('h3', null, '업데이트'), dataTable('업데이트', data.updates.headers, data.updates.rows, data.updates.total)),
        perm.write ? h('fieldset', null, h('legend', null, '가져올 시트'), h('div', { class: 'toolbar' }, scopeBoxes)) : null,
        h('div', { class: 'toolbar' },
          perm.export ? exportButton : null,
          perm.write ? importButton : null),
        exportSlot, importSlot,
        perm.export ? h('section', { class: 'card' }, h('h3', null, '누적 엑셀에 반영'), cumulativeSlot) : null,
        !perm.write ? h('p', { class: 'note' }, '가져오기(반영) 권한이 없어 변환 결과 확인만 할 수 있습니다.') : null,
        importBox);
    }
    submit.addEventListener('click', runBusy(submit, slot, async () => {
      await convert();
    }));
    showInput();
    return h('div', null,
      h('div', { class: 'card' },
        h('div', { class: 'form-grid' }, field('기준 연도', year), field('지역', area), field('조회 구역', h('input', { type: 'text', value: info.districts.join(', ') || '없음', readonly: true }))),
        modeBar,
        inputBox,
        h('details', { class: 'card' },
          h('summary', null, '활동자 순서·제외·이름 통합'),
          h('div', { class: 'form-grid' }, rosterEditors()),
          settingsFooter()),
        h('div', { class: 'buttons' }, h('button', { type: 'button', class: 'secondary', onclick: sample }, '예시 넣기'), submit),
        slot),
      result);
  }

  // 2) 정리본 파일 가져오기
  function filePanel() {
    const slot = h('div');
    const result = h('div');
    const file = h('input', { type: 'file', accept: '.xlsx' });
    const date = h('input', { type: 'date', name: 'date' });
    const scopeBoxes = [['activity', '활동자'], ['finding', '찾기'], ['updates', '업데이트']].map(([key, label]) =>
      h('label', { class: 'check' }, h('input', { type: 'checkbox', name: key, checked: true }), label));
    const submit = h('button', { type: 'button' }, '미리보기');
    submit.addEventListener('click', runBusy(submit, slot, async () => {
      const chosen = scopeBoxes.map((l) => l.querySelector('input')).filter((i) => i.checked).map((i) => i.name);
      if (!chosen.length) throw new Error('가져올 시트를 하나 이상 선택해 주세요.');
      const f = file.files[0];
      const qs = new URLSearchParams({ name: f?.name ?? '', scopes: chosen.join(',') });
      if (date.value) qs.set('date', date.value);
      renderImport(result, await uploadXlsx(`/api/daily/import-file?${qs}`, f), me);
    }));
    if (!perm.write) return h('div', { class: 'card empty' }, '정리본 파일을 가져오려면 이 화면의 쓰기 권한이 필요합니다.');
    return h('div', null,
      h('div', { class: 'card' },
        h('p', { class: 'note' }, 'SMOA 구역 일보 정리본(.xlsx)을 올리면 먼저 미리보기를 만듭니다. 연락처 열은 읽지 않고, 접근 권한이 없는 구역의 행은 제외합니다.'),
        h('div', { class: 'form-grid' }, field('정리본 파일', file), field('보고일 (비워 두면 파일 기록 사용)', date),
          h('fieldset', null, h('legend', null, '가져올 시트'), scopeBoxes)),
        h('div', { class: 'buttons' }, submit), slot),
      result);
  }

  // 3) 활동 공지 변환
  function noticePanel() {
    const slot = h('div');
    const result = h('div');
    const text = h('textarea', { name: 'text', rows: '10', maxlength: String(info.maxTextLength), placeholder: '1타임 활동 (17:00-19:00) / 장소 … 형식의 활동 공지를 붙여 넣으세요.' });
    const date = h('input', { type: 'date', name: 'date', value: info.today, required: true });
    const submit = h('button', { type: 'button' }, '변환 확인');
    submit.addEventListener('click', runBusy(submit, slot, async () => {
      const data = await sendJson('POST', '/api/daily/notice', { text: text.value, date: date.value });
      const exportSlot = h('div');
      const exportButton = h('button', { type: 'button', class: 'secondary' }, '활동기록 엑셀 내려받기');
      exportButton.addEventListener('click', runBusy(exportButton, exportSlot, async () => {
        await downloadFile(`/api/daily/notices/${encodeURIComponent(data.noticeId)}/workbook`, 'smoa-activity-notice.xlsx');
      }));
      setChildren(result,
        h('h2', null, `활동 공지 변환 · ${data.date}`),
        countCards(data.counts),
        data.droppedLines ? h('p', { class: 'note' }, `접근 권한이 없는 구역의 공지 ${data.droppedLines}줄은 제외했습니다.`) : null,
        messageList('오류', data.errors, 'error'),
        messageList('확인이 필요한 항목', data.warnings, 'note'),
        dataTable('활동기록', data.headers, data.rows, data.total),
        perm.export && !data.errors.length && data.total ? h('div', { class: 'toolbar' }, exportButton) : null,
        exportSlot,
        h('p', { class: 'note' }, '내려받은 활동기록 엑셀은 보고서 화면의 자료 가져오기에서 반영할 수 있습니다.'));
    }));
    return h('div', null,
      h('div', { class: 'card' }, h('div', { class: 'form-grid' }, field('보고일', date)), field('활동 공지 원문', text),
        h('div', { class: 'buttons' }, submit), slot),
      result);
  }

  // 4) 변환 설정
  function settingsPanel() {
    const layoutInputs = info.stages.map((stage) => {
      const input = h('input', { type: 'text', maxlength: '600', value: settings.slashLayouts[stage] ?? '', placeholder: `기본: ${info.defaultLayouts[stage]}` });
      input.addEventListener('input', () => {
        if (input.value.trim()) settings.slashLayouts[stage] = input.value;
        else delete settings.slashLayouts[stage];
        refreshSettingsStatus();
      });
      return field(`${stage} 행 형식`, input, 'wide');
    });
    return h('div', { class: 'card' },
      h('p', { class: 'note' }, '현재 입력한 설정은 변환할 때마다 함께 적용됩니다. 저장하면 이 계정의 서버 메모리에 보관되며 서버를 다시 시작하면 사라집니다. 순서·제외·이름 변경 목록은 텍스트(.txt)나 탭으로 구분한 파일(.tsv)로 불러올 수 있습니다.'),
      h('div', { class: 'form-grid' },
        rosterEditors(),
        h('fieldset', { class: 'wide' }, h('legend', null, '/ 로 구분한 일보 행 형식 (비워 두면 기본 형식)'),
          h('p', { class: 'note' }, `사용할 수 있는 항목: ${info.fieldLabels.join(' / ')}`),
          h('div', { class: 'form-grid' }, layoutInputs))),
      settingsFooter());
  }

  box.append(h('h1', null, '구역 일보'), tabBar, panel);
  show('convert');
}

export const dailyViews = { daily };
