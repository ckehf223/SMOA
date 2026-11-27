import { h } from './common.js';

/**
 * 누적 엑셀 갱신 조작부 (구역 일보 화면의 변환 결과 아래에 붙인다).
 * - 변환 결과(conversionId)를 사용자가 고른 누적 엑셀에 반영한 새 파일을 내려받는다. 원본 파일은 바뀌지 않는다.
 * - 구역 권한·반영 규칙·연락처 처리는 서버가 한다. 이 조작부는 파일을 그대로 올리고 서버가 준 요약만 보여 준다.
 * - 파일과 열기 비밀번호는 이 화면의 메모리에만 두고 저장하지 않는다(localStorage·주소·본문에 쓰지 않는다).
 * - 내보내기 권한은 부모 화면이 판단한다. me.perms.daily.export가 허용될 때만 이 함수를 호출해 넣는다.
 */

const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const MAX_FILE = 8 * 1024 * 1024; // 서버(binary 라우트)의 실제 상한과 같다.
const MAX_PASSWORD = 255;
const COUNT_LABELS = [['활동', '활동수'], ['찾기DB', '찾기DB'], ['교사DB', '교사DB']];

/** 서버가 요약 머리글(퍼센트 인코딩된 JSON)에 담은 반영 건수와 경고를 읽는다. */
function readSummary(response) {
  try {
    return JSON.parse(decodeURIComponent(response.headers.get('X-SMOA-Cumulative') ?? ''));
  } catch {
    return null;
  }
}

function downloadName(response) {
  const disposition = response.headers.get('Content-Disposition') ?? '';
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
  if (encoded) {
    try {
      return decodeURIComponent(encoded);
    } catch {
      /* 아래 기본 이름을 쓴다 */
    }
  }
  return /filename="([^"]+)"/.exec(disposition)?.[1] ?? 'smoa-cumulative.xlsx';
}

function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const link = h('a', { href: url, download: name });
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/** 갱신 요청. 비밀번호는 퍼센트 인코딩한 요청 머리글로만 보낸다. */
async function requestCumulative(conversionId, file, password) {
  const headers = { 'Content-Type': XLSX_TYPE };
  if (password) headers['X-SMOA-Workbook-Password'] = encodeURIComponent(password);
  const response = await fetch(`/api/daily/conversions/${encodeURIComponent(conversionId)}/cumulative?name=${encodeURIComponent(file.name)}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers,
    body: file,
  });
  if (response.status === 401) {
    location.href = '/login';
    throw new Error('로그인이 필요합니다.');
  }
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || '누적 엑셀을 갱신하지 못했습니다.');
  }
  return response;
}

function resultView(summary, name) {
  const counts = summary?.counts ?? {};
  const changedTotal = COUNT_LABELS.reduce((sum, [key]) => sum + (Number(counts[key]) || 0), 0);
  const headline = summary?.changed === false || changedTotal === 0
    ? `반영할 변경이 없어 파일 내용은 그대로입니다. (${name})`
    : `누적 엑셀을 갱신했습니다. (${name})`;
  const warnings = summary?.warnings ?? [];
  return h('div', null,
    h('p', { class: 'status ok' }, headline),
    summary ? h('ul', null, COUNT_LABELS.map(([key, label]) => h('li', null, `${label}: ${Number(counts[key]) || 0}행 반영`))) : null,
    warnings.length
      ? h('div', null,
        h('p', { class: 'note' }, `확인이 필요한 항목 ${summary.totalWarnings}건${summary.totalWarnings > warnings.length ? ` 중 처음 ${warnings.length}건` : ''}`),
        h('ul', null, warnings.map((w) => h('li', null, w))))
      : null);
}

/**
 * 누적 엑셀 갱신 조작부 DOM을 만든다.
 * 같은 변환 결과로 여러 번 실행할 수 있다. 반영은 서버에서 같은 날짜·같은 대상자를 다시 쓰지 않도록 처리한다.
 */
export function cumulativeControls(conversionId) {
  const fileInput = h('input', { type: 'file', accept: '.xlsx', name: 'cumulative-file' });
  const passwordInput = h('input', {
    type: 'password',
    name: 'cumulative-password',
    autocomplete: 'off',
    maxLength: MAX_PASSWORD,
    spellcheck: false,
  });
  const result = h('div', { 'aria-live': 'polite', 'aria-atomic': 'true' });
  const run = h('button', { type: 'submit' }, '누적 엑셀 갱신');
  const clear = h('button', { type: 'button', class: 'secondary' }, '선택 지우기');

  const show = (...kids) => result.replaceChildren(...kids.filter(Boolean));
  const fail = (message) => show(h('p', { class: 'status error', role: 'alert' }, message));

  clear.addEventListener('click', () => {
    fileInput.value = '';
    passwordInput.value = '';
    result.replaceChildren();
    fileInput.focus();
  });

  const form = h('form', { class: 'card', 'aria-labelledby': 'cumulative-title', novalidate: true },
    h('h3', { id: 'cumulative-title' }, '누적 엑셀 갱신'),
    h('p', { class: 'note' },
      '이 변환 결과를 내 누적 엑셀(.xlsx)에 반영해 새 파일로 내려받습니다. 고른 파일은 바뀌지 않고, 파일과 열기 비밀번호는 서버에 저장되지 않습니다. 열기 비밀번호가 걸린 파일은 같은 비밀번호로 다시 저장됩니다.'),
    h('label', null, '누적 엑셀 파일', fileInput),
    h('label', null, '열기 비밀번호 (비밀번호가 없는 파일이면 비워 두세요)', passwordInput),
    h('div', { class: 'actions' }, run, clear),
    result);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const file = fileInput.files?.[0];
    const password = passwordInput.value;
    if (!file) return fail('누적 엑셀 파일(.xlsx)을 선택해 주세요.');
    if (!/\.xlsx$/i.test(file.name)) return fail('.xlsx 파일만 올릴 수 있습니다.');
    if (file.size === 0 || file.size > MAX_FILE) return fail('엑셀 파일은 1바이트 이상 8MB 이하여야 합니다.');
    if (password.length > MAX_PASSWORD) return fail(`열기 비밀번호는 ${MAX_PASSWORD}자 이내로 입력해 주세요.`);

    run.disabled = true;
    form.setAttribute('aria-busy', 'true');
    show(h('p', { class: 'status', role: 'status' }, '누적 엑셀을 갱신하는 중입니다…'));
    try {
      const response = await requestCumulative(conversionId, file, password);
      const summary = readSummary(response);
      const name = downloadName(response);
      saveBlob(await response.blob(), name);
      passwordInput.value = '';
      show(resultView(summary, name));
    } catch (err) {
      fail(err.message || '누적 엑셀을 갱신하지 못했습니다.');
    } finally {
      run.disabled = false;
      form.removeAttribute('aria-busy');
    }
  });

  return form;
}
