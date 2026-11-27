"use strict";

const PREVIEW_LIMIT = 200;

function fields(value) {
  if (!value) return null;
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        ([key, item]) =>
          item !== undefined && !["id", "createdAt", "updatedAt"].includes(key),
      )
      .map(([key, item]) => {
        if (item instanceof Date) return [key, item.toISOString().slice(0, 10)];
        if (Array.isArray(item)) return [key, `${item.length}개 기록`];
        const display =
          item && typeof item === "object" ? JSON.stringify(item) : item;
        return [
          key,
          typeof display === "string" && display.length > 400
            ? `${display.slice(0, 400)}…`
            : display,
        ];
      }),
  );
}

function record(value) {
  if (!value) return undefined;
  const label =
    value.name ||
    value.worker ||
    value.label ||
    value.code ||
    value.이름 ||
    value.대상자명 ||
    value.대상자 ||
    value.활동자 ||
    value.활동자명 ||
    value.구역 ||
    "";
  return { label: String(label).slice(0, 100), fields: fields(value) };
}

function duplicateCollector() {
  const duplicates = [];
  let totalDuplicates = 0;
  function add(sheet, row, incoming, existing, options = {}) {
    totalDuplicates++;
    if (duplicates.length < PREVIEW_LIMIT)
      duplicates.push({
        sheet,
        row,
        incoming: record(incoming),
        existing: record(existing),
        reason: "기존 기록과 값이 같아 건너뜁니다.",
        ...options,
      });
  }
  return { add, result: () => ({ duplicates, totalDuplicates }) };
}

module.exports = { PREVIEW_LIMIT, fields, duplicateCollector };
