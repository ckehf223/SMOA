import { scopedWorkspace } from './domain.js';
import { HttpError } from './security.js';
import { allowedRegions, guard, isAdmin, legacy, redact, todayOf, weekStartOf } from './records.js';

/**
 * 대시보드 개요 API (화면 id: dashboard, 동작: read). 읽기 전용이다.
 * 기존 4.0.41 지역 대시보드의 집계(server/legacy/regional-analytics.cjs)를 요청자 구역으로 잘린
 * scopedWorkspace 사본에서만 계산한다. 응답은 집계 값뿐이며 대상자·구성원 기록과 연락처를 담지 않는다.
 */

const UNITS = new Set(['week', 'month']);
const FIRST_YEAR = 2000;
const LAST_YEAR = 2100;

/** YYYY-MM-DD가 실제 달력 날짜인지 확인한다. */
function isCalendarDay(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!m) return false;
  const [year, month, day] = m.slice(1).map(Number);
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

/**
 * 조회 기간을 정한다. period: week|month(기본 week), anchor: 기준일(월별은 YYYY-MM도 허용, 기본 오늘(KST)).
 * 주는 설정의 주 시작 요일, 월은 달력 월로 맞춘다.
 */
export function periodOf(store, query) {
  const unit = query.get('period') || 'week';
  if (!UNITS.has(unit)) throw new HttpError(400, '집계 단위는 주별 또는 월별만 선택할 수 있습니다.');
  let anchor = (query.get('anchor') || '').trim();
  if (unit === 'month' && /^\d{4}-\d{2}$/.test(anchor)) anchor = `${anchor}-01`;
  if (!anchor) anchor = todayOf(store);
  if (!isCalendarDay(anchor)) throw new HttpError(400, '기준일을 YYYY-MM-DD 형식의 올바른 날짜로 입력해 주세요.');
  const year = Number(anchor.slice(0, 4));
  if (year < FIRST_YEAR || year > LAST_YEAR) throw new HttpError(400, `기준일은 ${FIRST_YEAR}년부터 ${LAST_YEAR}년 사이로 지정해 주세요.`);
  const weekStart = weekStartOf(store, query);
  const { from, to } = legacy('regional-analytics').calendarRange(anchor, unit, weekStart);
  return { unit, anchor, weekStart, from, to };
}

/** 요청자가 볼 수 있는 구역만 담은 개요. 관리자는 전체 구역이다. */
export function dashboardOverview(store, ctx) {
  const period = periodOf(store, ctx.query);
  const ws = scopedWorkspace(store, ctx.user);
  const result = guard(() => legacy('regional-analytics').regionalSummary(ws, {
    from: period.from, to: period.to, periodUnit: period.unit, weekStart: period.weekStart,
  }));

  // 사본이 이미 구역 범위로 잘려 있지만, 구역 행은 배정 구역 이름으로 한 번 더 걸러 다른 구역 이름이 나가지 않게 한다.
  const admin = isAdmin(ctx);
  const allowed = admin ? null : allowedRegions(store, ctx);
  const visible = (row) => !allowed || allowed.has(row.region);
  const districts = [...(admin ? [] : allowed)].sort((a, b) => a.localeCompare(b, 'ko', { numeric: true }));

  return redact({
    ...result,
    districts: result.districts.filter(visible),
    findingChanges: result.findingChanges.filter(visible),
    period: { unit: period.unit, anchor: period.anchor, from: period.from, to: period.to, weekStart: period.weekStart, today: todayOf(store) },
    scope: { all: admin, districts },
  });
}
