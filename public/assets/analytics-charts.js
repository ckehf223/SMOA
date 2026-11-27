import { num } from './records.js';

/**
 * 분석 화면의 SVG 그래프. 모두 createElementNS로 만들고 색과 굵기는 analytics.css 의 클래스가 정한다.
 * (CSP 때문에 style 속성을 쓰지 않는다. 좌표는 SVG 속성으로만 지정한다.)
 */

const NS = 'http://www.w3.org/2000/svg';

export function svgEl(name, attrs, ...kids) {
  const el = document.createElementNS(NS, name);
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value != null && value !== false) el.setAttribute(key, String(value));
  }
  el.append(...kids.flat(Infinity).filter((kid) => kid != null && kid !== false));
  return el;
}

const svgText = (attrs, text) => svgEl('text', attrs, text);
const hint = (text) => svgEl('title', null, text);

/* ---------- 단계 실적: 구역별 8주 추이 ---------- */

/** 원본과 같은 표시 규칙: 비율은 소수 한 자리 %, 그 밖에는 N건. */
export function stageValue(value, metric) {
  if (!Number.isFinite(value)) return '—';
  return metric === 'rate' ? `${Number(value).toLocaleString('ko-KR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%` : `${num(value)}건`;
}

/** 모든 선이 같은 세로축을 쓰도록 0 ~ 최댓값을 4칸으로 나눈다. 값이 없으면 null. */
export function trendAxis(series, metric) {
  const values = series.flatMap((row) => row.values.filter(Number.isFinite));
  if (!values.length) return null;
  const maximum = Math.max(...values, 1);
  const scale = 10 ** Math.floor(Math.log10(maximum / 4));
  const step = Math.max(metric === 'rate' ? 0.1 : 1, Math.ceil(maximum / (4 * scale)) * scale);
  return [0, step, step * 2, step * 3, step * 4];
}

/**
 * weeks: 서버 weekly 배열, series: [{ label, values }] (첫 선은 원, 둘째 선은 사각형 표시)
 * compact는 구역별 작은 그래프다. 진행 중인 주의 구간은 점선(an-partial)으로 그린다.
 */
export function trendChart(weeks, series, metric, axis, { title, id, compact = false }) {
  const { left, right, top, bottom } = compact ? { left: 68, right: 342, top: 13, bottom: 117 } : { left: 80, right: 742, top: 18, bottom: 183 };
  const [width, height, dateY, partialY] = compact ? [368, 165, 138, 154] : [792, 238, 207, 224];
  const x = (index) => left + ((right - left) * index) / Math.max(weeks.length - 1, 1);
  const y = (value) => bottom - ((bottom - top) * value) / axis.at(-1);
  const partialAt = weeks.findIndex((week) => week.partial);

  const lines = series.map(({ label, values }, index) => {
    const segments = values.flatMap((value, i) => (!i || !Number.isFinite(value) || !Number.isFinite(values[i - 1])
      ? []
      : [svgEl('line', { class: `an-line an-series-${index}${i === partialAt ? ' an-partial' : ''}`, x1: x(i - 1), y1: y(values[i - 1]), x2: x(i), y2: y(value) })]));
    const points = values.flatMap((value, i) => {
      if (!Number.isFinite(value)) return [];
      const text = hint(`${label} · ${weeks[i].from} ~ ${weeks[i].to} · ${stageValue(value, metric)}`);
      return [index === 0
        ? svgEl('circle', { class: `an-point an-series-${index}`, cx: x(i), cy: y(value), r: 4 }, text)
        : svgEl('rect', { class: `an-point an-series-${index}`, x: x(i) - 4, y: y(value) - 4, width: 8, height: 8, rx: 1 }, text)];
    });
    return svgEl('g', { 'data-series': index }, segments, points);
  });

  const guides = axis.flatMap((value) => [
    svgEl('line', { class: 'an-grid', x1: left, y1: y(value), x2: right, y2: y(value) }),
    svgText({ class: 'an-axis', x: left - 12, y: y(value) + 4, 'text-anchor': 'end' }, stageValue(value, metric)),
  ]);
  const dates = weeks.flatMap((week, index) => [
    svgText({ class: 'an-axis', x: x(index), y: dateY, 'text-anchor': 'middle' }, week.from.slice(5).replace('-', '.')),
    week.partial ? svgText({ class: 'an-axis an-axis-partial', x: x(index), y: partialY, 'text-anchor': 'middle' }, '진행 중') : null,
  ]);
  const description = compact
    ? weeks.map((week, index) => `${week.from} ~ ${week.to} ${stageValue(series[0].values[index], metric)}`).join(' · ')
    : '각 주의 수치는 아래 표에서도 볼 수 있습니다.';

  return svgEl('svg', {
    viewBox: `0 0 ${width} ${height}`, class: `an-chart${compact ? ' an-chart-compact' : ''}`, role: 'img', 'aria-labelledby': id, 'aria-describedby': `${id}-desc`,
  }, svgEl('title', { id }, title), svgEl('desc', { id: `${id}-desc` }, description), guides, dates, lines);
}

/* ---------- 찾기 통계: 일자·시간대 그래프 ---------- */

/** data: [{ label, value }]. type 'bar'는 막대, 'line'은 꺾은선. */
export function countPlot(data, title, type = 'bar') {
  const [w, h, left, right, top, bottom] = [760, 260, 44, 18, 30, 42];
  const plotW = w - left - right;
  const plotH = h - top - bottom;
  const max = Math.max(1, ...data.map((r) => r.value));
  const step = plotW / data.length;
  const x = (i) => left + step * (i + 0.5);
  const y = (v) => top + plotH * (1 - v / max);
  const base = top + plotH;
  const stride = Math.max(1, Math.ceil(data.length / 9));
  const grid = [0, 0.5, 1].flatMap((v) => [
    svgEl('line', { class: 'an-grid', x1: left, x2: w - right, y1: y(max * v), y2: y(max * v) }),
    svgText({ class: 'an-axis', x: left - 8, y: y(max * v) + 4, 'text-anchor': 'end' }, Number((max * v).toFixed(1))),
  ]);
  const marks = data.flatMap((r, i) => [
    type === 'bar'
      ? svgEl('rect', { class: 'an-bar', x: x(i) - step * 0.34, y: y(r.value), width: step * 0.68, height: base - y(r.value) }, hint(`${r.label} · ${r.value}건`))
      : svgEl('circle', { class: 'an-point an-series-0', cx: x(i), cy: y(r.value), r: data.length > 90 ? 1.8 : 3.5 }, hint(`${r.label} · ${r.value}건`)),
    data.length <= 31 ? svgText({ class: 'an-axis', x: x(i), y: y(r.value) - 9, 'text-anchor': 'middle' }, r.value) : null,
    i % stride === 0 || i === data.length - 1
      ? svgText({ class: 'an-axis', x: x(i), y: h - 16, 'text-anchor': 'middle' }, r.label.length === 10 ? r.label.slice(5) : r.label)
      : null,
  ]);
  const line = type === 'line' ? svgEl('polyline', { class: 'an-line an-series-0', points: data.map((r, i) => `${x(i)},${y(r.value)}`).join(' ') }) : null;
  return svgEl('svg', { class: 'an-chart an-chart-wide', viewBox: `0 0 ${w} ${h}`, role: 'img', 'aria-label': title },
    svgEl('title', null, title), grid, line, marks, svgText({ class: 'an-axis', x: left, y: 16 }, '건'));
}

/** 시간대별 활동자 수(명)와 찾기 건수(건) 비교. hours: [{ label, workers, findings, minutes }] */
export function hourComparisonPlot(hours) {
  const [w, h, left, right, top, bottom] = [920, 300, 48, 16, 28, 42];
  const max = Math.max(1, ...hours.flatMap((d) => [d.workers, d.findings]));
  const plotH = h - top - bottom;
  const step = (w - left - right) / 24;
  const y = (v) => top + plotH * (1 - v / max);
  const base = top + plotH;
  const title = '시간대별 활동자 수와 찾기 건수 비교';
  const grid = [0, 0.5, 1].flatMap((n) => [
    svgEl('line', { class: 'an-grid', x1: left, x2: w - right, y1: y(max * n), y2: y(max * n) }),
    svgText({ class: 'an-axis', x: left - 8, y: y(max * n) + 4, 'text-anchor': 'end' }, Number((max * n).toFixed(1))),
  ]);
  const bars = hours.map((d, i) => {
    const cx = left + step * (i + 0.5);
    const bar = step * 0.28;
    return svgEl('g', null,
      hint(`${d.label} · 활동자 ${d.workers}명 · 찾기 ${d.findings}건 · 누적 활동 ${(d.minutes / 60).toFixed(2)}인시간`),
      svgEl('rect', { class: 'an-bar an-bar-workers', x: cx - bar - 1, y: y(d.workers), width: bar, height: base - y(d.workers), rx: 2 }),
      svgEl('rect', { class: 'an-bar an-bar-findings', x: cx + 1, y: y(d.findings), width: bar, height: base - y(d.findings), rx: 2 }),
      i % 3 === 0 || i === 23 ? svgText({ class: 'an-axis', x: cx, y: h - 16, 'text-anchor': 'middle' }, d.label) : null);
  });
  return svgEl('svg', { class: 'an-chart an-chart-wide', viewBox: `0 0 ${w} ${h}`, role: 'img', 'aria-label': title },
    svgEl('title', null, title), grid, bars, svgText({ class: 'an-axis', x: left, y: 16 }, '명 / 건'));
}
