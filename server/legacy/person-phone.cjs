"use strict";

const PHONE_HEADER = "휴대폰 번호";
const phoneHeaders = new Set([
  "휴대폰번호", "휴대폰", "핸드폰번호", "핸드폰", "전화번호", "연락처",
]);

function isPhoneHeader(value) {
  const label = String(value ?? "").normalize("NFC").replace(/\s+/g, "");
  return phoneHeaders.has(label.replace(/^대상자/u, ""));
}

function readPhone(value) {
  if (value == null) return "";
  let phone = typeof value === "string" ? value.trim() : "";
  if (typeof value === "string" && /^(?:-|–|—|x|×|없음|미기록|미입력)?$/iu.test(phone))
    return "";
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
    phone = String(value);
    if (/^1[016789]\d{7,8}$/u.test(phone)) phone = `0${phone}`;
  }
  if (
    !/^\+?[\d() .-]{7,40}$/u.test(phone) ||
    !/^\d{7,15}$/u.test(phone.replace(/\D/g, ""))
  ) {
    throw new Error("휴대폰 번호 형식을 확인해 주세요.");
  }
  return phone;
}

function phoneKey(value) {
  try {
    return readPhone(value)
      .replace(/\D/gu, "")
      .replace(/^(?:0082|82)0?(1[016789]\d{7,8})$/u, "0$1")
      .replace(/^(1[016789]\d{7,8})$/u, "0$1");
  } catch {
    return "";
  }
}

module.exports = { PHONE_HEADER, isPhoneHeader, readPhone, phoneKey };
