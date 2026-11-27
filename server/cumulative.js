import { createRequire } from 'node:module';
import { HttpError } from './security.js';

/**
 * 구역 일보 변환 결과를 사용자가 올린 누적 엑셀에 반영하는 API (POST /api/daily/conversions/:id/cumulative).
 * - 반영 알고리즘은 기존 SMOA 4.0.41의 누적 모듈(server/legacy/daily-area-cumulative.cjs)을 그대로 쓴다.
 * - 변환 결과는 변환 시점에 이미 사용자 구역 안의 행만 남기고(scopedCumulative), 이 라우트는 로그인 세션·구역 서명에 묶인
 *   변환 ID로만 그 결과를 읽는다. 올린 파일과 열기 비밀번호는 요청 처리 중에만 메모리에 두고 저장·기록하지 않는다.
 * - 패키지(@xmldom/xmldom, jszip, officecrypto-tool)는 첫 호출 때 불러온다. 설치 전에도 다른 기능은 그대로 동작한다.
 */

const require = createRequire(import.meta.url);

/** 앱의 binary 라우트 상한(8MiB)과 같다. 앱은 이보다 큰 값을 허용하지 않는다. */
export const MAX_CUMULATIVE_BYTES = 8 * 1024 * 1024;
export const PASSWORD_HEADER = 'x-smoa-workbook-password';
const MAX_PASSWORD = 255;
const MAX_WARNINGS = 8;
const MAX_WARNING_CHARS = 100;
const MAX_SUMMARY_HEADER = 8000;

/** 원본 누적 모듈. 패키지가 아직 설치되지 않았으면 서버가 죽지 않고 503으로 알린다. */
function loadCumulative() {
  try {
    return require('./legacy/daily-area-cumulative.cjs');
  } catch (err) {
    if (err?.code === 'MODULE_NOT_FOUND') {
      throw new HttpError(503, '누적 엑셀 갱신에 필요한 패키지(@xmldom/xmldom, jszip, officecrypto-tool)가 아직 설치되지 않았습니다.');
    }
    throw err;
  }
}

/**
 * 변환 결과의 누적 반영 자료를 사용자 구역 안으로 줄여 돌려준다.
 * - keep(구역 이름) === false 인 변경 건과 활동 구역은 제거한다. keep이 null이면 전체 구역(관리자)이다.
 * - 변경 건은 복제본이며 연락처 칸은 비운다. 응답·로그·누적 엑셀에 새 연락처를 쓰지 않는다.
 * - 보고서 원문 객체는 담지 않는다. 이 값은 서버 메모리의 변환 결과에만 보관한다.
 */
export function scopedCumulative(result, keep, redact) {
  const visible = (label) => !keep || (Boolean(label) && keep(label));
  const clean = (row) =>
    Object.fromEntries(
      Object.entries(row ?? {}).map(([field, value]) => {
        if (field === '연락처') return [field, null];
        return [field, typeof value === 'string' ? redact(value) : value];
      }),
    );
  const cumulativeChanges = (result.cumulativeChanges ?? [])
    .filter((change) => visible(change.district) && (!change.row?.['  구역'] || visible(change.row['  구역'])))
    .map((change) => ({
      district: change.district,
      worker: change.worker,
      status: change.status,
      detailDate: change.detailDate,
      explicitPhone: '', // 끝 네 자리만 남은 번호로는 전화번호 일치 판단을 하지 않는다.
      row: clean(change.row),
    }));
  const activityDistricts = new Set([...(result.activityDistricts ?? [])].filter((label) => visible(label)));
  return { cumulativeChanges, activityDistricts };
}

/** 열기 비밀번호: 퍼센트 인코딩된 짧은 요청 머리글에서만 읽는다. 주소·본문·응답에는 쓰지 않는다. */
export function passwordOf(headers) {
  const raw = headers[PASSWORD_HEADER];
  if (raw == null || raw === '') return '';
  const invalid = () => new HttpError(400, '누적 엑셀의 열기 비밀번호를 확인해 주세요.');
  if (typeof raw !== 'string' || raw.length > MAX_PASSWORD * 12) throw invalid();
  let value;
  try {
    value = decodeURIComponent(raw);
  } catch {
    throw invalid();
  }
  if (value.length > MAX_PASSWORD || /[\u0000-\u001f\u007f]/u.test(value)) throw invalid();
  return value;
}

/** 내려받을 파일 이름: 올린 파일 이름에서 확장자·이전 누적·날짜 꼬리를 떼고 안전한 글자만 남긴다. */
function outputName(uploadName, date) {
  const stem = String(uploadName ?? '')
    .split(/[\\/]/u)
    .pop()
    .replace(/\.xlsx$/iu, '')
    .replace(/^누적-/u, '')
    .replace(/-\d{4}-\d{2}-\d{2}(?:-\d+)?$/u, '')
    .replace(/[^\p{L}\p{N}_ -]/gu, '')
    .trim()
    .slice(0, 85);
  return { ascii: `smoa-cumulative-${date.replaceAll('-', '')}.xlsx`, korean: `누적-${stem || '통합문서'}-${date}.xlsx` };
}

/** 응답 머리글에 실을 반영 요약. 경고는 개수·길이를 제한하고 연락처를 가린다. */
function summaryHeader(output, changed, redact) {
  const all = (output.warnings ?? []).map((w) => redact(String(w)).slice(0, MAX_WARNING_CHARS));
  const summary = { counts: output.counts, changed, totalWarnings: all.length, warnings: all.slice(0, MAX_WARNINGS) };
  let encoded = encodeURIComponent(JSON.stringify(summary));
  while (encoded.length > MAX_SUMMARY_HEADER && summary.warnings.length) {
    summary.warnings.pop();
    encoded = encodeURIComponent(JSON.stringify(summary));
  }
  return encoded;
}

/**
 * 라우트 정의. daily.js의 dailyRoutes가 자신의 미리보기 저장소와 도우미를 넘겨 등록한다.
 * helpers: previews, scopeInfo, sessionOf, guarded, xlsxResponse, redact
 */
export function cumulativeRoute(store, helpers) {
  const { previews, scopeInfo, sessionOf, guarded, xlsxResponse, redact } = helpers;
  const running = new Set(); // 암호 해독·XML 처리는 무거우므로 사용자당 한 번에 하나만 처리한다.

  return {
    method: 'POST',
    path: '/api/daily/conversions/:id/cumulative',
    screen: 'daily',
    action: 'export',
    binary: true,
    allowEncryptedOffice: true,
    maxBytes: MAX_CUMULATIVE_BYTES,
    async handler(ctx) {
      const info = scopeInfo(store, ctx.user);
      const saved = previews.get(sessionOf(ctx, info), ctx.params[0], 'conversion');
      const source = ctx.file;
      if (!Buffer.isBuffer(source) || !source.length) throw new HttpError(400, '누적 엑셀 파일을 선택해 주세요.');
      if (source.length > MAX_CUMULATIVE_BYTES) throw new HttpError(413, '파일이 너무 큽니다.');
      const password = passwordOf(ctx.req.headers);
      const { cumulativeWorkbook } = loadCumulative();

      if (running.has(ctx.user.id)) throw new HttpError(429, '이전 누적 엑셀 갱신이 끝난 뒤 다시 시도해 주세요.');
      running.add(ctx.user.id);
      let output;
      try {
        output = await guarded(() => cumulativeWorkbook(source, password, saved.data.result));
      } finally {
        running.delete(ctx.user.id);
      }
      ctx.recheck();

      const changed = Buffer.compare(output.bytes, source) !== 0;
      const name = outputName(ctx.query.get('name'), saved.data.result.date);
      const response = xlsxResponse(name.ascii, output.bytes);
      response.headers['Content-Disposition'] =
        `attachment; filename="${name.ascii}"; filename*=UTF-8''${encodeURIComponent(name.korean)}`;
      response.headers['X-SMOA-Cumulative'] = summaryHeader(output, changed, redact);
      return response;
    },
  };
}
