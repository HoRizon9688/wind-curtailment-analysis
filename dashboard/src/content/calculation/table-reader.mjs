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
import { Unzip, UnzipInflate, unzipSync } from "fflate";
import { readSheet } from "read-excel-file/universal";
import {pythonString,stripText} from './scalar.mjs';
export {numberOrNull} from './scalar.mjs';
import {workbookMetadata,worksheetPart,correctExcelDates} from './excel-dates.mjs';

/** Mirrors `upload_pipeline.table_rows`: the expanded workbook cap. */
export const MAX_UNCOMPRESSED_BYTES = 150_000_000;
/** Mirrors the upload form limit; enforced by the caller, exported for reuse. */
export const MAX_TOTAL_INPUT_BYTES = 60_000_000;
/** Excel's own worksheet bounds, used to reject impossible dimensions. */
export const MAX_SHEET_ROWS = 1_048_576;
export const MAX_SHEET_COLUMNS = 16_384;
/**
 * Fixed input feed size. The output and working-buffer bounds below also
 * account for an unfinished DEFLATE header/block carried between pushes.
 */
export const INFLATE_INPUT_CHUNK = 8192;
// Pinned fflate 0.8.3: <= 1 KiB incomplete Huffman header, <= 64 KiB
// unfinished stored block, <= 258 bytes for a final back-reference. Include
// these on top of the maximum 1032:1 compressed expansion, not just feed size.
export const MAX_INFLATE_EMISSION_BYTES = 1032 * (INFLATE_INPUT_CHUNK + 1024) + 65_536 + 258;
// Inflate retains 32 KiB history. inflt.cbuf doubles a buffer to accommodate
// output + its 128 KiB growth reserve. This bounds a SINGLE working allocation;
// it is not a bound on total process memory, retained XML, DOM or table rows.
export const MAX_INFLATE_TEMP_BYTES = 2 * (32_768 + MAX_INFLATE_EMISSION_BYTES + 131_072);
/** Preferred worksheet, matching `upload_pipeline.table_rows`. */
export const PREFERRED_SHEET = "功率预测";


export class TableError extends Error {
  constructor(name, detail, code='TABLE') {
    super(`${name}：${detail}`);
    this.name = "TableError";
    this.file = name;
    this.code = code;
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
 * Streams the archive to (a) measure the **actual** expanded bytes across every
 * entry and abort past the cap, and (b) keep only the entries asked for.
 *
 * The library's unzip has no size cap of its own, so this has to run before the
 * bytes reach it; afterwards the archive is known to expand within the cap.
 * Actual bytes are counted, not the sizes declared in the central directory.
 *
 * Aborting for real (T0-R2): `Unzip.push` is synchronous and recursive, so an
 * early `return` from the data callback only skips *accounting* — the stream
 * keeps expanding later entries. The abort therefore has to **throw** out of
 * the callback, unwinding fflate's frames so the next entry's header is never
 * parsed. `UnzipInflate.push` catches exceptions from its inner `Inflate` and
 * reroutes them to the callback as an error; the callback rethrows its own
 * abort, which escapes that catch block and propagates to the feeding loop.
 *
 * Output-allocation bound (T0-R2): feed in fixed pieces; allow for incomplete
 * blocks and fflate's growing working buffers via the two exported bounds.
 * Total emitted output at abort is <= limit + one emission. Neither bound
 * claims to limit all subsequent XML parsing memory.
 *
 * @returns {{kept: Map<string, Uint8Array>, expandedBytes: number, largestEmission: number, perFile: Record<string, {emissions: number, bytes: number}>}}
 * @throws {RangeError} with the same metrics attached (`expandedBytes`,
 *   `largestEmission`, `perFile`) when the archive expands past `limit`.
 */
export function inflateWithLimit(bytes, { keep = [], limit = MAX_UNCOMPRESSED_BYTES } = {}) {
  const wanted = new Set(keep);
  const kept = new Map();
  const perFile = Object.create(null);
  let total = 0;
  let largestEmission = 0;
  let failure = null;

  const unzipper = new Unzip();
  unzipper.register(UnzipInflate);
  unzipper.onfile = (file) => {
    const isWanted = wanted.has(file.name);
    const chunks = [];
    perFile[file.name] = { emissions: 0, bytes: 0 };
    file.ondata = (error, chunk, final) => {
      // Throwing is the abort mechanism: returning early would let the
      // synchronous stream continue into later entries (see the header note).
      if (failure) throw failure;
      if (error) {
        failure = new TableError("", "压缩包条目损坏，无法读取");
        throw failure;
      }
      const record = perFile[file.name];
      record.emissions += 1;
      record.bytes += chunk.length;
      total += chunk.length;
      if (chunk.length > largestEmission) largestEmission = chunk.length;
      if (total > limit) {
        failure = new RangeError("EXPANDED_TOO_LARGE");
        failure.expandedBytes = total;
        failure.largestEmission = largestEmission;
        failure.perFile = perFile;
        throw failure;
      }
      if (isWanted) chunks.push(chunk);
      if (final && isWanted) kept.set(file.name, concatChunks(chunks));
    };
    file.start();
  };

  const input = asUint8Array(bytes);
  try {
    for (let offset = 0; offset < input.length; ) {
      const end = Math.min(offset + INFLATE_INPUT_CHUNK, input.length);
      unzipper.push(input.subarray(offset, end), end === input.length);
      if (failure) break; // fflate swallowed the throw somewhere; do not feed more
      offset = end;
    }
    // A final empty push lets fflate surface truncation on complete input.
    if (!failure && !input.length) unzipper.push(new Uint8Array(0), true);
  } catch (error) {
    if (failure) throw failure;
    throw new TableError("", `压缩包损坏，无法读取（${error?.message ?? error}）`);
  }
  if (failure) throw failure;
  return { kept, expandedBytes: total, largestEmission, perFile };
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
  let result;
  try {result=workbookMetadata(xml);}catch(error){throw new TableError(name,`工作簿元数据无效：${error.message}`);}
  if(!result.sheets.length)throw new TableError(name,'工作簿没有工作表');
  return result;
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
    throw new TableError(name, "文件超过 60 MB，请拆分后上传",'RESOURCE');
  }

  const sha256 = await sha256Hex(bytes);
  const digest = { name, sha256, bytes: bytes.length };

  if (isZip(bytes)) {
    let inflated;
    try {
      // The public readSheet() API unpacks the archive a second time and uses
      // CENTRAL-directory size hints to allocate output. Bound those hints as
      // well, so a tiny real entry with an inflated size cannot bypass the
      // streaming cap. filter=false enumerates metadata without decompression.
      let declaredTotal = 0;
      unzipSync(bytes, { filter(entry) {
        const size = entry.originalSize;
        if (!Number.isSafeInteger(size) || size < 0) throw new TableError(name, '压缩包条目大小无效');
        declaredTotal += size;
        if (declaredTotal > MAX_UNCOMPRESSED_BYTES) throw new RangeError('DECLARED_TOO_LARGE');
        return false;
      } });
      inflated = inflateWithLimit(bytes, { keep: ["xl/workbook.xml","xl/_rels/workbook.xml.rels"] });
    } catch (error) {
      if (error instanceof RangeError) throw new TableError(name, "解压后超过 150 MB，请拆分文件",'RESOURCE');
      throw new TableError(name, String(error?.message ?? error).replace(/^[^：]*：/u, ""));
    }
    const workbookXml = inflated.kept.get("xl/workbook.xml");
    if (!workbookXml) throw new TableError(name, "工作簿缺少 xl/workbook.xml，无法读取");
    const metadata = parseWorkbookMetadata(new TextDecoder().decode(workbookXml), name);
    const sheetName = chooseSheet(metadata);

    let rows;
    try {
      const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      rows = await readSheet(buffer, sheetName, {trim:false});
      if(rows.some(row=>row.some(value=>value instanceof Date))) {
        const decode=b=>new TextDecoder().decode(b);
        const rels=inflated.kept.get('xl/_rels/workbook.xml.rels');
        if(!rels)throw new Error('工作簿关系缺失');
        const part=worksheetPart(decode(workbookXml),decode(rels),sheetName);
        const sheet=inflateWithLimit(bytes,{keep:[part]}).kept.get(part);
        if(!sheet)throw new Error('所选工作表文件缺失');
        correctExcelDates(rows,decode(sheet),metadata.date1904);
      }
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
  const headers = (rows[0] ?? []).map((value) => (value === null || value === undefined ? "" : stripText(pythonString(value))));
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
