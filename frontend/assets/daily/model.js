export const PERSON_CLASSIFICATIONS = {
  classification1: ['개척', '지인', '가족'],
  classification2: ['노방', '소셜링', '온라인', '세미나', '기타'],
};

export function assert(ok, message) {
  if (!ok) throw new Error(message);
}

export function text(value, max = 200, required = false) {
  assert(typeof value === 'string' && value.length <= max, `문자 항목은 ${max}자 이내로 입력해 주세요.`);
  const clean = value.trim();
  assert(!required || clean.length, '필수 항목을 입력해 주세요.');
  return clean;
}

export function date(value, required = true) {
  if (!value && !required) return '';
  const parsed = new Date(value + 'T00:00:00Z');
  assert(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value, '날짜를 확인해 주세요.');
  return value;
}

export function time(value, required = false) {
  if (!value && !required) return '';
  assert(typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value), '시간을 확인해 주세요.');
  return value;
}
