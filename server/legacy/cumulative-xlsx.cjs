"use strict";

const path = require("node:path").posix;
const { DOMParser, XMLSerializer } = require("@xmldom/xmldom");
const Zip = require("jszip");
const Office = require("officecrypto-tool");
const { assert, date } = require("./model.cjs");
const { checkZip } = require("./importer.cjs");

const DAY = 86400000;
const MAX_ROW = 1048576;
const DEFAULT_DATE_FORMAT = 'm"월" d"일"';
const elements = (node, name) =>
  Array.from(node?.childNodes || []).filter(
    (child) => child.nodeType === 1 && (!name || child.localName === name),
  );
const child = (node, name) => elements(node, name)[0];
const text = (node) => node?.textContent || "";
const readText = (node) =>
  elements(node)
    .map((item) =>
      item.localName === "r"
        ? text(child(item, "t"))
        : item.localName === "t"
          ? text(item)
          : "",
    )
    .join("");
const normalized = (value) =>
  String(value ?? "")
    .normalize("NFKC")
    .trim();
const headerKey = (value) =>
  normalized(value).replace(/\s+/gu, "").toUpperCase();
const columnIndex = (letters) =>
  [...letters].reduce(
    (index, letter) => index * 26 + letter.charCodeAt(0) - 64,
    0,
  );
function columnName(index) {
  let result = "";
  for (; index > 0; index = Math.floor((index - 1) / 26))
    result = String.fromCharCode(65 + ((index - 1) % 26)) + result;
  return result;
}
function address(value) {
  const parts = /^([A-Z]+)([1-9]\d*)$/u.exec(value);
  return parts ? [columnIndex(parts[1]), Number(parts[2])] : [];
}
function bounds(ref) {
  const [first, last = first] = ref.split(":");
  return [...address(first), ...address(last)];
}
function addElement(parent, name, before = null) {
  const node = parent.ownerDocument.createElementNS(
    parent.namespaceURI,
    parent.prefix ? `${parent.prefix}:${name}` : name,
  );
  parent.insertBefore(node, before);
  return node;
}
function relationshipPart(part) {
  return path.join(path.dirname(part), "_rels", path.basename(part) + ".rels");
}
function relatedPart(part, rel) {
  const target = rel?.getAttribute("Target") || "";
  if (!target || rel.getAttribute("TargetMode") === "External") return "";
  return target.startsWith("/")
    ? path.normalize(target.slice(1))
    : path.join(path.dirname(part), target);
}
function relationId(node) {
  return Array.from(node.attributes).find(
    (attr) => attr.localName === "id" && attr.namespaceURI,
  )?.value;
}
function readXml(value) {
  assert(!/<!DOCTYPE/i.test(value), "엑셀 XML 구조를 확인해 주세요.");
  let invalid = false;
  const dom = new DOMParser({
    errorHandler: {
      warning() {},
      error() {
        invalid = true;
      },
      fatalError() {
        invalid = true;
      },
    },
  }).parseFromString(value, "application/xml");
  assert(!invalid && dom.documentElement, "엑셀 XML 구조를 확인해 주세요.");
  return dom.documentElement;
}
function isDateFormat(value) {
  return /[yd]/i.test(value.replace(/"[^"]*"|\\.|\[[^\]]*\]/g, ""));
}

class Workbook {
  constructor(zip) {
    this.zip = zip;
    this.changed = new Map();
  }
  async xml(part) {
    const member = this.zip.file(part);
    return member ? readXml(await member.async("string")) : null;
  }
  async relationships(part) {
    return new Map(
      elements(await this.xml(relationshipPart(part)), "Relationship").map(
        (rel) => [rel.getAttribute("Id"), rel],
      ),
    );
  }
  async open(names) {
    this.bookPart = "xl/workbook.xml";
    this.book = await this.xml(this.bookPart);
    assert(
      this.book?.localName === "workbook",
      "엑셀 통합 문서 구조를 확인해 주세요.",
    );
    const relationships = await this.relationships(this.bookPart);
    const related = (type) =>
      relatedPart(
        this.bookPart,
        [...relationships.values()].find((rel) =>
          rel.getAttribute("Type").endsWith(`/${type}`),
        ),
      );
    const strings = await this.xml(related("sharedStrings"));
    this.strings = elements(strings, "si").map(readText);
    this.stylesPart = related("styles");
    this.styles = await this.xml(this.stylesPart);
    this.xfs = child(this.styles, "cellXfs");
    this.formats = new Map(
      elements(child(this.styles, "numFmts"), "numFmt").map((format) => [
        Number(format.getAttribute("numFmtId")),
        format.getAttribute("formatCode"),
      ]),
    );
    this.styleList = elements(this.xfs, "xf");
    this.dateStyles = new Map();
    this.dateOrigin = ["1", "true"].includes(
      child(this.book, "workbookPr")?.getAttribute("date1904"),
    )
      ? Date.UTC(1904, 0, 1)
      : Date.UTC(1899, 11, 30);
    const sheets = elements(child(this.book, "sheets"), "sheet");
    return Object.fromEntries(
      await Promise.all(
        names.map(async (name) => {
          const match = sheets.find(
            (sheet) =>
              headerKey(sheet.getAttribute("name")) === headerKey(name),
          );
          const part =
            match &&
            relatedPart(this.bookPart, relationships.get(relationId(match)));
          const root = part && (await this.xml(part));
          assert(
            root?.localName === "worksheet",
            `누적 엑셀에 ${name} 시트가 필요합니다.`,
          );
          const tables = [];
          const tableParts = elements(child(root, "tableParts"), "tablePart");
          if (tableParts.length) {
            const rels = await this.relationships(part);
            for (const node of tableParts) {
              const tablePart = relatedPart(part, rels.get(relationId(node)));
              const table = await this.xml(tablePart);
              if (table) tables.push({ part: tablePart, root: table });
            }
          }
          return [name, new Sheet(this, name, root, part, tables)];
        }),
      ),
    );
  }
  readDate(value, reference) {
    if (!value) return "";
    try {
      if (typeof value === "number")
        return new Date(this.dateOrigin + Math.floor(value) * DAY)
          .toISOString()
          .slice(0, 10);
      const match = normalized(value).match(
        /^(?:(\d{4})[.\/-])?(\d{1,2})[.\/-](\d{1,2})(?:\.|T.*)?$/u,
      );
      if (!match) return "";
      const [, fullYear, month, day] = match;
      const year =
        fullYear ||
        Number(reference.slice(0, 4)) -
          Number(reference.slice(5, 7) === "01" && Number(month) === 12);
      return date(`${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`);
    } catch {
      return "";
    }
  }
  dateFormat(index) {
    const id = Number(this.styleList[index]?.getAttribute("numFmtId"));
    if (
      (id >= 14 && id <= 17) ||
      id === 22 ||
      (id >= 27 && id <= 31) ||
      (id >= 34 && id <= 36) ||
      (id >= 50 && id <= 58) ||
      isDateFormat(this.formats.get(id) || "")
    ) return id;
  }
  defaultDateFormat() {
    for (const [id, format] of this.formats)
      if (format === DEFAULT_DATE_FORMAT) return id;

    const id = Math.max(163, ...this.formats.keys()) + 1;
    const formats = child(this.styles, "numFmts") ||
      addElement(this.styles, "numFmts", elements(this.styles)[0]);
    const entry = addElement(formats, "numFmt");
    entry.setAttribute("numFmtId", String(id));
    entry.setAttribute("formatCode", DEFAULT_DATE_FORMAT);
    this.formats.set(id, DEFAULT_DATE_FORMAT);
    formats.setAttribute("count", String(this.formats.size));
    return id;
  }
  dateStyle(index, columnFormat) {
    if (this.dateFormat(index) !== undefined) return index;
    const base = this.styleList[index] || this.styleList[0];
    if (!base) return null;
    const format = columnFormat ?? this.defaultDateFormat();
    const key = `${index}:${format}`;
    if (this.dateStyles.has(key)) return this.dateStyles.get(key);
    const entry = base.cloneNode(true);
    entry.setAttribute("numFmtId", String(format));
    entry.setAttribute("applyNumberFormat", "1");
    this.xfs.appendChild(entry);
    const newIndex = this.styleList.push(entry) - 1;
    this.xfs.setAttribute("count", String(this.styleList.length));
    this.dateStyles.set(key, newIndex);
    this.changed.set(this.stylesPart, this.styles);
    return newIndex;
  }
  recalculateOnOpen() {
    const calc = child(this.book, "calcPr");
    if (calc && calc.getAttribute("fullCalcOnLoad") !== "1") {
      calc.setAttribute("fullCalcOnLoad", "1");
      this.changed.set(this.bookPart, this.book);
    }
  }
  async save() {
    const serializer = new XMLSerializer();
    for (const [part, root] of this.changed)
      this.zip.file(part, serializer.serializeToString(root.ownerDocument), {
        createFolders: false,
      });
    return this.zip.generateAsync({
      type: "nodebuffer",
      compression: "DEFLATE",
    });
  }
}

class Sheet {
  constructor(book, name, root, part, tables) {
    Object.assign(this, { book, name, root, part, tables });
    this.data = child(root, "sheetData");
    assert(this.data, `${name} 시트의 데이터 영역을 확인해 주세요.`);
    this.styledColumns = elements(root, "cols")
      .flatMap((group) => elements(group, "col"))
      .filter((node) => node.hasAttribute("style"));
    this.dateFormats = new Map();
    this.rows = new Map(
      elements(this.data, "row").map((node) => [
        Number(node.getAttribute("r")),
        {
          node,
          cells: new Map(
            elements(node, "c").map((cell) => [
              address(cell.getAttribute("r"))[0],
              cell,
            ]),
          ),
        },
      ]),
    );
  }
  value(row, col) {
    const cell = this.rows.get(row)?.cells.get(col);
    const raw = text(child(cell, "v"));
    switch (cell?.getAttribute("t")) {
      case "s":
        return raw ? this.book.strings[Number(raw)] || "" : "";
      case "inlineStr":
        return readText(child(cell, "is"));
      case "str":
      case "d":
        return raw;
      case "e":
        return "";
      default:
        return raw && Number.isFinite(Number(raw)) ? Number(raw) : raw;
    }
  }
  formula(row, col) {
    return Boolean(child(this.rows.get(row)?.cells.get(col), "f"));
  }
  header(fields, required) {
    for (const [row, { cells }] of this.rows) {
      if (row > 20) break;
      const columns = new Map(
        [...cells.keys()].map((col) => [headerKey(this.value(row, col)), col]),
      );
      const found = Object.fromEntries(
        Object.entries(fields).map(([key, aliases]) => [
          key,
          aliases.map((alias) => columns.get(headerKey(alias))).find(Boolean),
        ]),
      );
      if (required.every((key) => found[key])) return { row, columns: found };
    }
    throw new Error(
      `${this.name} 시트에서 ${required.map((key) => fields[key][0]).join("·")} 열을 확인해 주세요.`,
    );
  }
  extraColumn(header, label) {
    const index = Math.max(...this.rows.get(header).cells.keys(), 0) + 1;
    assert(
      index <= 16384,
      `${this.name} 시트에 ${label} 열을 추가할 수 없습니다.`,
    );
    this.set(header, index, label, false, index - 1, header);
    return index;
  }
  nextRow(header, lastDataRow, columns) {
    let row = lastDataRow + 1;
    while (
      this.rows.has(row) &&
      columns.some(
        (col) =>
          !this.formula(row, col) && String(this.value(row, col)).trim() !== "",
      )
    )
      row++;
    assert(row <= MAX_ROW, `${this.name} 시트의 행 수 한도를 넘었습니다.`);
    for (const { root } of this.tables) {
      const [, first, , last] = bounds(root.getAttribute("ref"));
      const totals = Number(root.getAttribute("totalsRowCount"));
      assert(
        first !== header || !totals || row < last,
        `${this.name} 표의 합계 행 위에 빈 행을 만들어 주세요.`,
      );
    }
    return row;
  }
  columnStyle(col) {
    const column = this.styledColumns.find(
      (node) => col >= Number(node.getAttribute("min")) &&
        col <= Number(node.getAttribute("max")),
    );
    return column ? Number(column.getAttribute("style")) : 0;
  }
  columnDateFormat(col, columnStyle) {
    if (!this.dateFormats.has(col)) {
      let format = this.book.dateFormat(columnStyle);
      let blankFormat;
      for (const [row, { cells }] of this.rows) {
        if (format !== undefined) break;
        const existing = cells.get(col);
        if (!existing?.hasAttribute("s")) continue;
        const sampleFormat = this.book.dateFormat(Number(existing.getAttribute("s")));
        if (sampleFormat === undefined) continue;
        if (typeof this.value(row, col) === "number" || existing.getAttribute("t") === "d")
          format = sampleFormat;
        else blankFormat ??= sampleFormat;
      }
      this.dateFormats.set(col, format ?? blankFormat);
    }
    return this.dateFormats.get(col);
  }
  set(row, col, value, isDate, styleColumn = col, styleRow) {
    let record = this.rows.get(row);
    if (!record) {
      const next = elements(this.data, "row").find(
        (node) => Number(node.getAttribute("r")) > row,
      );
      const node = addElement(this.data, "row", next);
      node.setAttribute("r", String(row));
      record = { node, cells: new Map() };
      this.rows.set(row, record);
    }
    let cell = record.cells.get(col);
    if (!cell) {
      const next = elements(record.node, "c").find(
        (node) => address(node.getAttribute("r"))[0] > col,
      );
      cell = addElement(record.node, "c", next || child(record.node, "extLst"));
      cell.setAttribute("r", `${columnName(col)}${row}`);
      const model = this.rows.get(styleRow)?.cells.get(styleColumn);
      if (model?.hasAttribute("s"))
        cell.setAttribute("s", model.getAttribute("s"));
      record.cells.set(col, cell);
    }
    record.node.removeAttribute("spans");
    for (const content of elements(cell))
      if (["v", "is"].includes(content.localName)) cell.removeChild(content);
    if (isDate) {
      const columnStyle = this.columnStyle(col);
      const hasRowStyle = ["1", "true"].includes(record.node.getAttribute("customFormat"));
      const base = cell.hasAttribute("s") ? Number(cell.getAttribute("s"))
        : hasRowStyle ? Number(record.node.getAttribute("s"))
        : columnStyle;
      const style = this.book.dateStyle(base, this.columnDateFormat(col, columnStyle));
      if (style !== null) {
        cell.setAttribute("s", String(style));
        value = (Date.parse(`${value}T00:00:00Z`) - this.book.dateOrigin) / DAY;
      }
    }
    const extension = child(cell, "extLst");
    if (typeof value === "number") {
      cell.removeAttribute("t");
      addElement(cell, "v", extension).textContent = String(value);
    } else {
      cell.setAttribute("t", "inlineStr");
      const node = addElement(addElement(cell, "is", extension), "t");
      if (value !== value.trim())
        node.setAttributeNS(
          "http://www.w3.org/XML/1998/namespace",
          "xml:space",
          "preserve",
        );
      node.textContent = value;
    }
    const dimension = child(this.root, "dimension");
    const [c1, r1, c2, r2] = bounds(dimension?.getAttribute("ref") || "");
    if (dimension && (row < r1 || row > r2 || col < c1 || col > c2)) {
      dimension.setAttribute(
        "ref",
        `${columnName(Math.min(col, c1))}${Math.min(row, r1)}:${columnName(Math.max(col, c2))}${Math.max(row, r2)}`,
      );
    }
    this.book.changed.set(this.part, this.root);
  }
  extendRanges(header, row, previous) {
    const extend = (node) => {
      const [left, first, right, last] = bounds(
        node?.getAttribute("ref") || "",
      );
      if (first !== header || last < previous || row <= last) return false;
      node.setAttribute(
        "ref",
        `${columnName(left)}${first}:${columnName(right)}${row}`,
      );
      return true;
    };
    extend(child(this.root, "autoFilter"));
    for (const { root, part } of this.tables) {
      if (extend(root)) {
        extend(child(root, "autoFilter"));
        this.book.changed.set(part, root);
      }
    }
  }
}

async function updateWorkbook(source, password, names, apply) {
  assert(
    Buffer.isBuffer(source) && source.length <= 15 * 1024 * 1024,
    "엑셀 파일은 최대 15MB입니다.",
  );
  let decrypted;
  let changed;
  try {
    let encrypted = false;
    try {
      // The Office reader attaches cursor properties to its Buffer argument.
      const input = source.subarray();
      encrypted = Office.isEncrypted(input);
      if (encrypted && !password)
        throw new Error("누적 엑셀의 열기 비밀번호를 입력해 주세요.");
      if (encrypted) decrypted = await Office.decrypt(input, { password });
    } catch (error) {
      if (encrypted && !password) throw error;
      throw new Error(
        "누적 엑셀의 열기 비밀번호 또는 파일 형식을 확인해 주세요.",
      );
    }
    const input = decrypted || source;
    checkZip(input, { allowPrinterSettings: true });
    const workbook = new Workbook(await Zip.loadAsync(input));
    const sheets = await workbook.open(names);
    const result = apply(sheets);
    if (!workbook.changed.size) return { ...result, bytes: source };
    workbook.recalculateOnOpen();
    changed = await workbook.save();
    return {
      ...result,
      bytes: encrypted ? Office.encrypt(changed, { password }) : changed,
    };
  } finally {
    decrypted?.fill(0);
    if (decrypted) changed?.fill(0);
  }
}

module.exports = { updateWorkbook };
