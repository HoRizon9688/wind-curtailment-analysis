/**
 * Browser-side table reader for the curtailment calculation migration.
 *
 * T0 scope: this module exists to prove the reading path can run in the browser
 * with no new npm dependency, so the ordinary Data app build stays usable and
 * `dashboard/package.json` does not have to change.
 *
 * It deliberately has no imports: no bare specifiers, no `node:` builtins, no
 * DOM-only APIs, so the same bytes behave identically under Node tests and in a
 * browser Worker. Everything comes from platform primitives that Node 22 and
 * current Chrome/Edge/Safari/Firefox all provide: `TextDecoder`,
 * `DecompressionStream('deflate-raw')` and `crypto.subtle`.
 *
 * Calculation semantics are untouched: this file only turns bytes into rows.
 * The authoritative contract for time parsing, deduplication and analysis stays
 * with Python (`upload_pipeline.py`). T2 owns hardening this into the final
 * `table-reader.mjs` (shared strings edge cases, every date format, 1904
 * verification, expansion accounting per entry).
 */

/** Mirrors `upload_pipeline.table_rows`: the expanded workbook cap. */
export const MAX_UNCOMPRESSED_BYTES = 150_000_000;
/** Mirrors the upload form limit; enforced by the caller, exported for reuse. */
export const MAX_TOTAL_INPUT_BYTES = 60_000_000;

const ZIP_LOCAL_SIGNATURE = 0x04034b50;
const ZIP_CENTRAL_SIGNATURE = 0x02014b50;
const ZIP_END_SIGNATURE = 0x06054b50;

const FORMULA_PREFIX = /^\s*=/u;
const NUMERIC = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/u;

// Built-in Excel formats that carry a date and/or a time component.
const BUILTIN_DATE_FORMATS = new Set([
  14, 15, 16, 17, 18, 19, 20, 21, 22,
  27, 28, 29, 30, 31, 32, 33, 34, 35, 36,
  45, 46, 47,
  50, 51, 52, 53, 54, 55, 56, 57, 58,
]);

class TableError extends Error {
  constructor(name, detail) {
    super(`${name}：${detail}`);
    this.name = "TableError";
    this.file = name;
  }
}

// --------------------------------------------------------------- byte helpers

function asUint8Array(bytes) {
  if (bytes instanceof Uint8Array) return bytes;
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  if (ArrayBuffer.isView(bytes)) return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  throw new TypeError("readTable expects bytes as ArrayBuffer or a typed array.");
}

/** OOXML is detected from content, never from the extension. */
function isZip(bytes) {
  return bytes.length >= 4
    && bytes[0] === 0x50 && bytes[1] === 0x4b
    && bytes[2] === 0x03 && bytes[3] === 0x04;
}

/** Legacy OLE2 compound files — the old binary `.xls` that must keep failing. */
function isLegacyCompoundFile(bytes) {
  const magic = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
  return bytes.length >= magic.length && magic.every((byte, index) => bytes[index] === byte);
}

async function sha256Hex(bytes) {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// -------------------------------------------------------------------- CSV

/**
 * RFC 4180 CSV/TSV splitter. Empty cells stay as `""` so callers can tell a
 * blank cell from a missing column, matching `csv.reader` in the Python path.
 */
export function parseDelimited(text, delimiter = ",") {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  let index = 0;
  while (index < text.length) {
    const character = text[index];
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          cell += '"';
          index += 2;
          continue;
        }
        quoted = false;
        index += 1;
        continue;
      }
      cell += character;
      index += 1;
      continue;
    }
    if (character === '"' && cell === "") {
      quoted = true;
      index += 1;
      continue;
    }
    if (character === delimiter) {
      row.push(cell);
      cell = "";
      index += 1;
      continue;
    }
    if (character === "\n" || character === "\r") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      index += character === "\r" && text[index + 1] === "\n" ? 2 : 1;
      continue;
    }
    cell += character;
    index += 1;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

/**
 * Strict decode: UTF-8 first, then GB18030. `fatal` is what keeps a broken
 * encoding from being silently swallowed with replacement characters.
 */
function decodeText(bytes, name) {
  for (const encoding of ["utf-8", "gb18030"]) {
    try {
      const decoder = new TextDecoder(encoding, { fatal: true, ignoreBOM: false });
      return decoder.decode(bytes);
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
    }
  }
  throw new TableError(name, "CSV 编码无法识别，请导出 UTF-8 CSV");
}

// ------------------------------------------------------------------- ZIP

function readEndOfCentralDirectory(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = bytes.length - 22; offset >= 0; offset -= 1) {
    if (view.getUint32(offset, true) !== ZIP_END_SIGNATURE) continue;
    return {
      offset,
      total: view.getUint16(offset + 10, true),
      start: view.getUint32(offset + 16, true),
    };
  }
  throw new Error("missing end of central directory");
}

/** Lists entries and refuses an archive whose expanded size exceeds the cap. */
function readCentralDirectory(bytes, name) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let { start, total, offset } = readEndOfCentralDirectory(bytes);
  const entries = [];
  let expanded = 0;
  let cursor = start;
  for (let index = 0; index < total; index += 1) {
    if (view.getUint32(cursor, true) !== ZIP_CENTRAL_SIGNATURE) {
      throw new TableError(name, "压缩包目录损坏，无法读取");
    }
    const method = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const uncompressedSize = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const entryName = new TextDecoder().decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
    expanded += uncompressedSize;
    // Check before inflating, so a zip bomb is never expanded on disk or in memory.
    if (expanded > MAX_UNCOMPRESSED_BYTES) {
      throw new TableError(name, "解压后超过 150 MB，请拆分文件");
    }
    entries.push({ entryName, method, compressedSize, uncompressedSize, localOffset });
    cursor += 46 + nameLength + extraLength + commentLength;
    offset = cursor;
  }
  void offset;
  return entries;
}

async function inflateRaw(chunk) {
  const stream = new Blob([chunk]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function readEntry(bytes, entry) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(entry.localOffset, true) !== ZIP_LOCAL_SIGNATURE) {
    throw new Error(`corrupt local header for ${entry.entryName}`);
  }
  const nameLength = view.getUint16(entry.localOffset + 26, true);
  const extraLength = view.getUint16(entry.localOffset + 28, true);
  const start = entry.localOffset + 30 + nameLength + extraLength;
  const chunk = bytes.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return chunk;
  if (entry.method === 8) return inflateRaw(chunk);
  throw new Error(`unsupported compression method ${entry.method}`);
}

// --------------------------------------------------------------- XML helpers

const ENTITIES = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

export function decodeXmlText(value) {
  return value.replace(/&(#x?[\da-f]+|lt|gt|amp|quot|apos);/giu, (match, entity) => {
    const lower = entity.toLowerCase();
    if (lower.startsWith("#x")) return String.fromCodePoint(Number.parseInt(lower.slice(2), 16));
    if (lower.startsWith("#")) return String.fromCodePoint(Number.parseInt(lower.slice(1), 10));
    return ENTITIES[lower] ?? match;
  });
}

function attribute(tag, name) {
  const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*"([^"]*)"`, "u").exec(tag);
  return match ? decodeXmlText(match[1]) : undefined;
}

function textOf(fragment) {
  let out = "";
  for (const match of fragment.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/gu)) out += decodeXmlText(match[1]);
  return out;
}

// ------------------------------------------------------------- XLSX reader

function columnIndexFromReference(reference) {
  const letters = /^([A-Za-z]+)/u.exec(reference)?.[1] ?? "A";
  let index = 0;
  for (const letter of letters.toUpperCase()) index = index * 26 + (letter.charCodeAt(0) - 64);
  return index - 1;
}

async function readSharedStrings(entries, bytes) {
  const entry = entries.find((candidate) => candidate.entryName === "xl/sharedStrings.xml");
  if (!entry) return [];
  const xml = new TextDecoder().decode(await readEntry(bytes, entry));
  return [...xml.matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/gu)].map(([, body]) => textOf(body));
}

async function readDateStyles(entries, bytes) {
  const entry = entries.find((candidate) => candidate.entryName === "xl/styles.xml");
  if (!entry) return { cellFormats: [], customFormats: new Map() };
  const xml = new TextDecoder().decode(await readEntry(bytes, entry));
  const customFormats = new Map();
  for (const match of xml.matchAll(/<numFmt\b([^>]*)\/?>/gu)) {
    const id = Number(attribute(match[1], "numFmtId"));
    const code = attribute(match[1], "formatCode") ?? "";
    if (Number.isFinite(id)) customFormats.set(id, code);
  }
  const cellXfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/u.exec(xml)?.[1] ?? "";
  const cellFormats = [...cellXfs.matchAll(/<xf\b([^>]*?)(?:\/>|>)/gu)]
    .map((match) => Number(attribute(match[1], "numFmtId") ?? "0"));
  return { cellFormats, customFormats };
}

/**
 * A format counts as a date when Excel's built-in date ids are used, or when a
 * custom format shows date/time tokens. Quoted literals and escaped characters
 * are removed first so `"h"` in a literal does not look like an hour token.
 */
export function isDateFormat(numFmtId, formatCode) {
  if (BUILTIN_DATE_FORMATS.has(numFmtId)) return true;
  if (numFmtId < 164 || typeof formatCode !== "string") return false;
  const withoutLiterals = formatCode
    .replace(/"[^"]*"/gu, "")
    .replace(/\[[^\]]*\]/gu, "")
    .replace(/\\./gu, "")
    .replace(/_.|@/gu, "");
  return /[ymdhs]/iu.test(withoutLiterals);
}

/**
 * Converts an Excel date serial into a `Date` whose UTC fields hold the sheet's
 * wall-clock value. The result never depends on the machine timezone; mapping
 * wall clock onto the fixed UTC+08:00 analysis calendar is `time.mjs`'s job.
 */
export function excelSerialToDate(serial, date1904 = false) {
  const base = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  return new Date(base + Math.round(serial * 86_400_000));
}

function cellValue(cellTag, body, context) {
  const type = attribute(cellTag, "t");
  const styleIndex = Number(attribute(cellTag, "s") ?? "0");
  const cached = /<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/u.exec(body)?.[1];

  if (type === "inlineStr") return textOf(body);
  if (type === "s") {
    if (cached === undefined) return null;
    return context.sharedStrings[Number(cached)] ?? null;
  }
  if (type === "str") return cached === undefined ? null : decodeXmlText(cached);
  if (type === "b") return cached === undefined ? null : cached.trim() === "1";
  if (type === "e") return null;

  // Numeric or date. A formula without a cached result must stay missing:
  // the browser must never evaluate Excel formulas itself.
  const isFormula = /<f(?:\s[^>]*)?>|<f(?:\s[^>]*)?\/>/u.test(body);
  if (isFormula && cached === undefined) return null;
  if (cached === undefined) return null;

  const raw = decodeXmlText(cached).trim();
  if (!NUMERIC.test(raw)) return raw;
  const numeric = Number(raw);
  const numFmtId = context.cellFormats[styleIndex] ?? 0;
  if (isDateFormat(numFmtId, context.customFormats.get(numFmtId))) {
    return excelSerialToDate(numeric, context.date1904);
  }
  return numeric;
}

function readSheetRows(xml, context) {
  const rows = [];
  let width = 0;
  for (const rowMatch of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/gu)) {
    const rowNumber = Number(attribute(rowMatch[1], "r") ?? "0");
    const body = rowMatch[2] ?? "";
    const cells = [];
    for (const cellMatch of body.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/gu)) {
      const reference = attribute(cellMatch[1], "r");
      const index = reference ? columnIndexFromReference(reference) : cells.length;
      while (cells.length < index) cells.push(null);
      cells[index] = cellValue(cellMatch[1], cellMatch[2] ?? "", context);
    }
    width = Math.max(width, cells.length);
    const target = rowNumber > 0 ? rowNumber - 1 : rows.length;
    while (rows.length < target) rows.push([]);
    rows[target] = cells;
  }
  // openpyxl pads every row to the sheet's widest row, so a column that only
  // exists in the header still yields null instead of `undefined` downstream.
  for (const row of rows) while (row.length < width) row.push(null);
  return rows;
}

const PREFERRED_SHEET = "功率预测";

async function readWorkbook(bytes, name) {
  const entries = readCentralDirectory(bytes, name);
  const byName = new Map(entries.map((entry) => [entry.entryName, entry]));
  const workbookEntry = byName.get("xl/workbook.xml");
  const workbookRelsEntry = byName.get("xl/_rels/workbook.xml.rels");
  if (!workbookEntry) throw new TableError(name, "工作簿缺少 xl/workbook.xml，无法读取");

  const workbookXml = new TextDecoder().decode(await readEntry(bytes, workbookEntry));
  const date1904 = /<workbookPr\b[^>]*date1904\s*=\s*"(?:1|true)"/iu.test(workbookXml);
  const sheets = [...workbookXml.matchAll(/<sheet\b([^>]*?)\/?>/gu)].map((match) => ({
    name: attribute(match[1], "name") ?? "",
    relationshipId: attribute(match[1], "r:id"),
  }));
  if (!sheets.length) throw new TableError(name, "工作簿没有工作表");

  const relationships = new Map();
  if (workbookRelsEntry) {
    const relsXml = new TextDecoder().decode(await readEntry(bytes, workbookRelsEntry));
    for (const match of relsXml.matchAll(/<Relationship\b([^>]*?)\/?>/gu)) {
      relationships.set(attribute(match[1], "Id"), attribute(match[1], "Target"));
    }
  }

  // Preferred sheet first, otherwise the workbook's own sheet order.
  const chosen = sheets.find((sheet) => sheet.name === PREFERRED_SHEET) ?? sheets[0];
  const target = relationships.get(chosen.relationshipId) ?? "worksheets/sheet1.xml";
  const entry = byName.get(target.startsWith("/") ? target.slice(1) : `xl/${target}`) ?? byName.get(target);
  if (!entry) throw new TableError(name, `找不到工作表「${chosen.name}」的数据`);

  const context = {
    sharedStrings: await readSharedStrings(entries, bytes),
    ...(await readDateStyles(entries, bytes)),
    date1904,
  };
  const sheetXml = new TextDecoder().decode(await readEntry(bytes, entry));
  return { sheetName: chosen.name, rows: readSheetRows(sheetXml, context), date1904 };
}

// ------------------------------------------------------------------ public

/**
 * Reads one uploaded table.
 *
 * Format is decided by content: a ZIP package is parsed as OOXML no matter what
 * its extension says, and everything else is decoded as CSV/text. A legacy
 * binary `.xls` keeps the existing failure instead of being silently accepted.
 *
 * @returns {Promise<{name: string, sha256: string, bytes: number, format: string, sheetName?: string, date1904?: boolean, rows: Array<Array<string|number|boolean|Date|null>>}>}
 */
export async function readTable(file) {
  const name = file?.name ?? "";
  const bytes = asUint8Array(file?.bytes);
  if (!name) throw new TypeError("readTable requires a file name.");
  if (!bytes.length) throw new TableError(name, "空文件");
  if (!/\.(?:csv|xlsx?|xls)$/iu.test(name)) {
    throw new TableError(name, "仅支持 CSV、XLSX 和系统导出的 OOXML 格式 XLS");
  }
  if (Number.isNaN(bytes.length)) throw new TableError(name, "无法读取文件内容");

  const sha256 = await sha256Hex(bytes);
  const digest = { name, sha256, bytes: bytes.length };

  if (isZip(bytes)) {
    const workbook = await readWorkbook(bytes, name);
    return { ...digest, format: "ooxml", sheetName: workbook.sheetName, date1904: workbook.date1904, rows: workbook.rows };
  }
  if (isLegacyCompoundFile(bytes)) {
    throw new TableError(name, "旧版二进制 XLS 不支持，请另存为 XLSX；现有数据下载表的 XLS 可直接读取");
  }
  if (/\.xlsx?$/iu.test(name)) {
    throw new TableError(name, "旧版二进制 XLS 不支持，请另存为 XLSX；现有数据下载表的 XLS 可直接读取");
  }

  const text = decodeText(bytes, name);
  return { ...digest, format: "csv", rows: parseDelimited(text) };
}

/**
 * Header validation matching `upload_pipeline.dictionaries`: trimmed headers,
 * missing columns reported together, duplicated non-empty names rejected, and
 * fully blank lines skipped while keeping the original spreadsheet line number.
 */
export function dictionaryRows(table, required) {
  const rows = table?.rows ?? [];
  if (!rows.length) throw new TableError(table.name, "空文件");
  const headers = (rows[0] ?? []).map((value) => (value === null || value === undefined ? "" : String(value).trim()));
  const missing = required.filter((column) => !headers.includes(column));
  if (missing.length) throw new TableError(table.name, `缺少列 ${[...missing].sort().join("、")}`);
  const present = headers.filter(Boolean);
  if (present.length !== new Set(present).size) throw new TableError(table.name, "列名重复");
  const out = [];
  for (let index = 1; index < rows.length; index += 1) {
    const row = rows[index] ?? [];
    if (!row.some((value) => value !== null && value !== undefined && value !== "")) continue;
    out.push({ line: index + 1, values: Object.fromEntries(headers.map((header, column) => [header, row[column] ?? null])) });
  }
  return out;
}

/** Visible for tests: formula detection used when rejecting computed values. */
export function looksLikeFormula(text) {
  return typeof text === "string" && FORMULA_PREFIX.test(text);
}

export { TableError };
