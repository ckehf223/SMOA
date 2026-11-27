"use strict";
const HOUR = 3600000;
const hour = (at) => Math.floor(at / HOUR) * HOUR;
// A stored whole hour is a reporting bucket. Keep minute-specific records precise.
function contains(span, at) {
  return at === hour(at)
    ? at >= hour(span.start) && at <= hour(span.end)
    : at >= span.start && at < span.end;
}
function matches(spans, at) {
  const rounded = at === hour(at);
  let lo = 0,
    hi = spans.length - 1,
    candidate = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if ((rounded ? hour(spans[mid].start) : spans[mid].start) <= at) {
      candidate = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return candidate >= 0 && contains(spans[candidate], at);
}
module.exports = { contains, matches };
