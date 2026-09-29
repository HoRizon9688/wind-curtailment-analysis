/**
 * Browser-side table adapter for the curtailment calculation migration.
 *
 * Division of responsibility:
 *   - `read-excel-file` parses OOXML cell values (shared strings, inline
 *     strings, cached formula results, dates and the workbook date system).
 *   - `fflate` is used directly for the two things the library does not expose
 *     or enforce: workbook metadata (`activeTab`, sheet order) and a real
 *     expanded-size limit, because the library's own unzip has no size cap.
 *   - This adapter owns everything the project already owned: strict CSV
 *     decoding, original-byte hashing, the input size gate, header rules and
 *     the workbook selection policy that has to match `upload_pipeline.py`.
 *
 * Calculation semantics are untouched. `upload_pipeline.py` and
 * `threshold_allocation.py` remain the authoritative implementations.
 */
import { Unzip, UnzipInflate } from "fflate";
import { readSheet } from "read-excel-file/universal";

/** Mirrors `upload_pipeline.table_rows`: the expanded workbook cap. */
export const MAX_UNCOMPRESSED_BYTES = 150_000_000;
/** Mirrors the upload form limit; enforced by the caller, exported for reuse. */
export const MAX_TOTAL_INPUT_BYTES = 60_000_000;
/** Excel's own worksheet bounds, used to reject impossible dimensions. */
export const MAX_SHEET_ROWS = 1_048_576;
export const MAX_SHEET_COLUMNS = 16_384;
/** Preferred worksheet, matching `upload_pipeline.table_rows`. */
export const PREFERRED_SHEET = "功率预测";

const NUMERIC = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/u;

export class TableError extends Error {
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
  return bytes.length >= magic.length && magic.every((byte, index) => bytes[index] === magic[index]);
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
      return new TextDecoder(encoding, { fatal: true, ignoreBOM: false }).decode(bytes);
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
    }
  }
  throw new TableError(name, "CSV 编码无法识别，请导出 UTF-8 CSV");
}

// ----------------------------------------- ZIP expansion accounting + metadata

function concatChunks(chunks) {
  const size = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * Streams the archive once to (a) measure the **actual** expanded bytes across
 * every entry and abort past the cap, and (b) keep only the entries asked for.
 *
 * The library's unzip has no size cap of its own, so this has to run before the
 * bytes reach it; afterwards the archive is known to expand within the cap.
 * Actual bytes are counted, not the sizes declared in the central directory.
 */
export function inflateWithLimit(bytes, { keep = [], limit = MAX_UNCOMPRESSED_BYTES } = {}) {
  const wanted = new Set(keep);
  const kept = new Map();
  let total = 0;
  let failure = null;

  const unzipper = new Unzip();
  unzipper.register(UnzipInflate);
  unzipper.onfile = (file) => {
    const isWanted = wanted.has(file.name);
    const chunks = [];
    file.ondata = (error, chunk, final) => {
      if (failure) return;
      if (error) {
        failure = new TableError("", "压缩包条目损坏，无法读取");
        return;
      }
      total += chunk.length;
      if (total > limit) {
        failure = new RangeError("EXPANDED_TOO_LARGE");
        return;
      }
      if (isWanted) chunks.push(chunk);
      if (final && isWanted) kept.set(file.name, concatChunks(chunks));
    };
    file.start();
  };

  try {
    unzipper.push(asUint8Array(bytes), true);
  } catch (error) {
    throw new TableError("", `压缩包损坏，无法读取（${error?.message ?? error}）`);
  }
  if (failure) throw failure;
  return { kept, expandedBytes: total };
}

function attribute(tag, name) {
  const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*"([^"]*)"`, "u").exec(tag);
  return match ? match[1] : undefined;
}

/**
 * Reads the workbook's sheet order, active tab and date system.
 *
 * This is workbook metadata, not a second cell parser: `read-excel-file` does
 * not expose `activeTab`, and `upload_pipeline.py` selects the sheet through
 * openpyxl's `workbook.active`, so the same index has to be resolved here. A
 * `workbookView` element is optional and defaults to the first sheet, exactly
 * like openpyxl.
 */
export function parseWorkbookMetadata(xml, name) {
  const sheets = [...xml.matchAll(/<sheet\b([^>]*?)\/?>/gu)]
    .map((match) => attribute(match[1], "name") ?? "")
    .filter(Boolean);
  if (!sheets.length) throw new TableError(name, "工作簿没有工作表");
  const viewTag = /<workbookView\b([^>]*?)\/?>/u.exec(xml)?.[1];
  const parsed = viewTag === undefined ? 0 : Number(attribute(viewTag, "activeTab") ?? "0");
  return {
    sheets,
    activeTab: Number.isInteger(parsed) && parsed >= 0 && parsed < sheets.length ? parsed : 0,
    date1904: /<workbookPr\b[^>]*date1904\s*=\s*"(?:1|true)"/iu.test(xml),
  };
}

/** Preferred sheet, otherwise the workbook's active sheet, matching Python. */
export function chooseSheet({ sheets, activeTab }) {
  return sheets.includes(PREFERRED_SHEET) ? PREFERRED_SHEET : sheets[activeTab];
}

// ------------------------------------------------------------------ public

/**
 * Reads one uploaded table.
 *
 * Format is decided by content: a ZIP package is parsed as OOXML no matter what
 * its extension says, and everything else is decoded as CSV/text. A legacy
 * binary `.xls` keeps the existing failure instead of being silently accepted.
 *
 * @returns {Promise<{name: string, sha256: string, bytes: number, format: string, sheetName?: string, date1904?: boolean, expandedBytes?: number, rows: Array<Array<string|number|boolean|Date|null>>}>}
 */
export async function readTable(file) {
  const name = file?.name ?? "";
  const bytes = asUint8Array(file?.bytes);
  if (!name) throw new TypeError("readTable requires a file name.");
  if (!bytes.length) throw new TableError(name, "空文件");
  if (!/\.(?:csv|xlsx?|xls)$/iu.test(name)) {
    throw new TableError(name, "仅支持 CSV、XLSX 和系统导出的 OOXML 格式 XLS");
  }
  if (bytes.length > MAX_TOTAL_INPUT_BYTES) {
    throw new TableError(name, "文件超过 60 MB，请拆分后上传");
  }

  const sha256 = await sha256Hex(bytes);
  const digest = { name, sha256, bytes: bytes.length };

  if (isZip(bytes)) {
    let inflated;
    try {
      inflated = inflateWithLimit(bytes, { keep: ["xl/workbook.xml"] });
    } catch (error) {
      if (error instanceof RangeError) throw new TableError(name, "解压后超过 150 MB，请拆分文件");
      throw new TableError(name, String(error?.message ?? error).replace(/^[^：]*：/u, ""));
    }
    const workbookXml = inflated.kept.get("xl/workbook.xml");
    if (!workbookXml) throw new TableError(name, "工作簿缺少 xl/workbook.xml，无法读取");
    const metadata = parseWorkbookMetadata(new TextDecoder().decode(workbookXml), name);
    const sheetName = chooseSheet(metadata);

    let rows;
    try {
      const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      rows = await readSheet(buffer, sheetName);
    } catch (error) {
      throw new TableError(name, `无法读取工作表「${sheetName}」：${error?.message ?? error}`);
    }
    if (!Array.isArray(rows)) throw new TableError(name, "工作表内容无法解析");
    if (rows.length > MAX_SHEET_ROWS) throw new TableError(name, "工作表行数超过 Excel 上限");
    return {
      ...digest,
      format: "ooxml",
      sheetName,
      date1904: metadata.date1904,
      expandedBytes: inflated.expandedBytes,
      rows,
    };
  }

  if (isLegacyCompoundFile(bytes) || /\.xlsx?$/iu.test(name)) {
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
    out.push({
      line: index + 1,
      values: Object.fromEntries(headers.map((header, column) => [header, row[column] ?? null])),
    });
  }
  return out;
}

/** Numeric coercion matching `upload_pipeline.number`; dates are not numeric. */
export function numberOrNull(value) {
  if (typeof value === "boolean" || value === null || value === undefined) return null;
  if (value instanceof Date) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const text = String(value).trim();
  if (!NUMERIC.test(text)) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}
