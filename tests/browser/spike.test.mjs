/**
 * Reader assertions for the browser calculation migration.
 *
 * These are Node assertions over the OOXML/CSV adapter. Expected workbook
 * behaviour comes from `tests/fixtures/browser/spike/python-baseline.py`, which
 * reads the same fixtures with openpyxl exactly like
 * `upload_pipeline.table_rows` does. G0 additionally requires browser evidence
 * under the repository sub-path, which lives in tests/browser/browser-spike/.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  INFLATE_INPUT_CHUNK,
  MAX_INFLATE_EMISSION_BYTES,
  MAX_SHEET_COLUMNS,
  MAX_TOTAL_INPUT_BYTES,
  MAX_UNCOMPRESSED_BYTES,
  TableError,
  chooseSheet,
  dictionaryRows,
  inflateWithLimit,
  numberOrNull,
  parseDelimited,
  parseWorkbookMetadata,
  readTable,
} from "../../dashboard/src/content/calculation/table-reader.mjs";
import { makeZip } from "../fixtures/browser/spike/generate.mjs";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "browser", "spike");

function fixture(name) {
  const buffer = readFileSync(join(FIXTURES, name));
  return { name, bytes: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) };
}

function bytesOf(text) {
  return new TextEncoder().encode(text).buffer;
}

// ---------------------------------------------------------------------- CSV

test("CSV preserves empty cells", async () => {
  const bytes = new TextEncoder().encode("时间,可用功率\n2026/8/1 0:00,\n").buffer;
  const table = await readTable({ name: "sample.csv", bytes });
  assert.equal(table.rows[1][0], "2026/8/1 0:00");
  assert.ok(table.rows[1][1] === "" || table.rows[1][1] === null);
});

test("CSV keeps an empty cell instead of shifting later columns", async () => {
  const table = await readTable(fixture("minute-power.csv"));
  assert.equal(table.rows[1][1], "");
  assert.equal(table.rows[1][3], "28.9");
  assert.equal(table.rows[1][4], "21");
});

test("CSV honours quotes, embedded commas and escaped double quotes", async () => {
  assert.deepEqual(parseDelimited('a,"b,1","say ""hi""",d\r\n'), [["a", "b,1", 'say "hi"', "d"]]);
  const table = await readTable(fixture("minute-power.csv"));
  assert.equal(table.rows[3][2], "29,7");
});

test("CSV strips the UTF-8 BOM so the first header keeps its real name", async () => {
  const table = await readTable(fixture("minute-power.csv"));
  assert.equal(table.rows[0][0], "时间");
});

test("CSV falls back to GB18030 without replacement characters", async () => {
  const table = await readTable(fixture("minute-power-gb18030.csv"));
  assert.equal(table.format, "csv");
  assert.deepEqual(table.rows[0], ["时间", "可用功率", "理论功率", "全站总有功_集电线有功之和", "AGC有功设定值"]);
  assert.equal(table.rows[1][0], "2026/8/1 0:00");
  assert.ok(!JSON.stringify(table.rows).includes("\uFFFD"));
  assert.equal(table.rows[3][2], "29,7");
});

test("CSV rejects undecodable bytes instead of silently swallowing them", async () => {
  const bytes = new Uint8Array([0x61, 0x2c, 0xff, 0xfe, 0x0a]).buffer;
  await assert.rejects(() => readTable({ name: "broken.csv", bytes }), TableError);
});

test("a file above the 60 MB input gate is rejected before hashing", async () => {
  const bytes = new Uint8Array(MAX_TOTAL_INPUT_BYTES + 1).buffer;
  const started = performance.now();
  await assert.rejects(
    () => readTable({ name: "huge.csv", bytes }),
    (error) => error instanceof TableError && /60 MB/.test(error.message),
  );
  assert.ok(performance.now() - started < 5_000, "the size gate must reject without hashing");
});

// -------------------------------------------------------------------- OOXML

test("OOXML is detected from content even though the extension says .xls", async () => {
  const table = await readTable(fixture("forecast-ooxml.xls"));
  assert.equal(table.format, "ooxml");
});

test("the preferred 功率预测 sheet wins over the active tab", async () => {
  const table = await readTable(fixture("forecast-ooxml.xls"));
  assert.equal(table.sheetName, "功率预测");
  assert.equal(table.rows[0][3], "考核点2预测结果");
});

test("no 功率预测 sheet falls back to the workbook's ACTIVE sheet, not the first", async () => {
  // Coordinator's regression: the first sheet is a cover, the data is on the
  // active second sheet. openpyxl reads 分钟数据; the reader must agree.
  const table = await readTable(fixture("forecast-active-second.xlsx"));
  assert.equal(table.sheetName, "分钟数据");
  assert.equal(table.rows[0][3], "考核点2预测结果");
  assert.equal(table.rows[1][0], "SYNTHETIC_T0");
});

test("the active-sheet fallback follows activeTab when it points at the first sheet", async () => {
  const table = await readTable(fixture("forecast-active-first.xlsx"));
  assert.equal(table.sheetName, "封面");
  assert.equal(table.rows[0][0], "本表为封面，不是数据表");
});

test("a workbook without 功率预测 and with activeTab 0 reads the first sheet", async () => {
  const table = await readTable(fixture("forecast-no-power-sheet.xls"));
  assert.equal(table.sheetName, "Sheet1");
  assert.equal(table.rows[0][3], "考核点2预测结果");
});

test("workbook metadata parsing pins sheet order, activeTab and date system", () => {
  const xml = (activeTab, date1904 = false) => `<?xml version="1.0"?>
<workbook xmlns:r="x">${date1904 ? '<workbookPr date1904="1"/>' : ""}<bookViews><workbookView activeTab="${activeTab}"/></bookViews><sheets><sheet name="A" sheetId="1" r:id="rId1"/><sheet name="B" sheetId="2" r:id="rId2"/></sheets></workbook>`;
  assert.deepEqual(parseWorkbookMetadata(xml(0), "t"), { sheets: ["A", "B"], activeTab: 0, date1904: false });
  assert.deepEqual(parseWorkbookMetadata(xml(1, true), "t"), { sheets: ["A", "B"], activeTab: 1, date1904: true });
  // No workbookView at all defaults to the first sheet, like openpyxl.
  const bare = `<?xml version="1.0"?><workbook><sheets><sheet name="A"/><sheet name="B"/></sheets></workbook>`;
  assert.equal(parseWorkbookMetadata(bare, "t").activeTab, 0);
  // An out-of-range activeTab must not select a missing sheet.
  assert.equal(parseWorkbookMetadata(xml(9), "t").activeTab, 0);
  assert.equal(chooseSheet({ sheets: ["A", "功率预测"], activeTab: 0 }), "功率预测");
  assert.equal(chooseSheet({ sheets: ["A", "B"], activeTab: 1 }), "B");
});

test("shared strings resolve and inline strings are kept verbatim", async () => {
  const table = await readTable(fixture("forecast-ooxml.xls"));
  assert.deepEqual(table.rows[0].slice(0, 3), ["预测id", "名称", "预测时间"]);
  assert.equal(table.rows[1][0], "SYNTHETIC_T0");
  assert.equal(table.rows[1][1], "合成验证场站");
});

test("a cached formula result is used and the formula is never evaluated", async () => {
  const table = await readTable(fixture("forecast-ooxml.xls"));
  assert.equal(table.rows[1][4], 49);
  assert.equal(table.rows[2][4], 50.5);
});

test("a formula without a cached result is missing, not computed", async () => {
  const table = await readTable(fixture("forecast-ooxml.xls"));
  // `=D2+1` has no <v>; evaluating it would produce 25.5.
  assert.equal(table.rows[1][5], null);
  assert.equal(table.rows[2][5], null);
});

test("a blank cell stays null rather than becoming an empty string", async () => {
  const table = await readTable(fixture("forecast-ooxml.xls"));
  assert.equal(table.rows[3][3], null);
});

test("date cells match the openpyxl baseline for the 1900 date system", async () => {
  const table = await readTable(fixture("forecast-ooxml.xls"));
  const date = table.rows[1][2];
  assert.ok(date instanceof Date, `expected a Date, got ${typeof date}`);
  // python-baseline.py reads the naive datetime 2026-07-31T23:45:00, and the
  // library encodes that wall clock in the Date's UTC fields. Mapping it onto
  // the fixed UTC+08:00 analysis calendar stays `time.mjs`'s responsibility.
  assert.equal(date.toISOString(), "2026-07-31T23:45:00.000Z");
});

test("date cells match the openpyxl baseline for the 1904 date system", async () => {
  const standard = await readTable(fixture("forecast-ooxml.xls"));
  const workbook1904 = await readTable(fixture("forecast-1904.xlsx"));
  assert.equal(standard.date1904, false);
  assert.equal(workbook1904.date1904, true);
  // python-baseline.py reads 2030-08-01T23:45:00, i.e. exactly 1462 days later.
  assert.equal(workbook1904.rows[1][2].getTime() - standard.rows[1][2].getTime(), 1462 * 86_400_000);
  assert.equal(workbook1904.rows[1][2].toISOString(), "2030-08-01T23:45:00.000Z");
});

test("a plain number in a date-formatted column is not turned into a date", async () => {
  const table = await readTable(fixture("minute-power-ooxml.xlsx"));
  assert.ok(table.rows[1][0] instanceof Date);
  assert.equal(table.rows[1][1], 29.5);
  assert.equal(typeof table.rows[1][1], "number");
});

test("the last legal worksheet column (XFD) is readable at its real position", async () => {
  assert.equal(MAX_SHEET_COLUMNS, 16_384);
  const table = await readTable(fixture("bounds-wide.xlsx"));
  // T0-R2: the generator bug let the loop index overwrite the explicit column,
  // so this fixture never actually contained XFD references. Verified directly
  // in the archive XML (XFD1/XFD2 present) and against openpyxl, which reads
  // the row padded to 16384 columns with nulls in the gap.
  const [header, row] = table.rows;
  assert.equal(header.length, MAX_SHEET_COLUMNS, `expected a 16384-wide row, got ${header.length}`);
  assert.equal(header[0], "时间");
  assert.equal(header[1], "可用功率");
  assert.equal(header[MAX_SHEET_COLUMNS - 1], "末列");
  assert.equal(row[0], "2026/8/1 0:00");
  assert.equal(row[1], 29.6);
  assert.equal(row[MAX_SHEET_COLUMNS - 1], 1.5);
  // Intermediate columns stay null, so header mapping cannot misalign.
  assert.equal(row[100], null);
});

test("empty middle cells are preserved as null, matching the openpyxl baseline", async () => {
  // T0-R2: the old fixture was dense (the loop index overwrote cell.column),
  // which made both readers look like they compacted sparse rows. The archive
  // XML now really contains A2/C2/C3 (no B2/B3), and openpyxl reads:
  //   [['A','B','C'], ['a1', None, 'c1'], [None, None, 'c2']]
  // The JS adapter agrees, so empty middle columns keep their position and
  // dictionaryRows cannot map a later value onto an earlier header.
  const table = await readTable(fixture("gaps.xlsx"));
  assert.deepEqual(table.rows[0], ["A", "B", "C"]);
  assert.deepEqual(table.rows[1], ["a1", null, "c1"]);
  assert.deepEqual(table.rows[2], [null, null, "c2"]);
});

test("legacy binary XLS keeps the existing error", async () => {
  await assert.rejects(
    () => readTable(fixture("legacy-binary.xls")),
    (error) => error instanceof TableError && /旧版二进制 XLS/.test(error.message),
  );
});

test("a text file renamed to .xlsx gets the same error the Python baseline gives", async () => {
  // Python: `zipfile.is_zipfile` is false, so it raises the legacy-XLS message.
  await assert.rejects(
    () => readTable(fixture("not-a-workbook.xlsx")),
    (error) => error instanceof TableError && /旧版二进制 XLS/.test(error.message),
  );
});

test("an empty file is rejected", async () => {
  await assert.rejects(() => readTable({ name: "empty.csv", bytes: new ArrayBuffer(0) }), TableError);
});

test("a valid zip that is not a workbook fails with a clear message", async () => {
  await assert.rejects(
    () => readTable(fixture("no-workbook.xlsx")),
    (error) => error instanceof TableError && /xl\/workbook\.xml/.test(error.message),
  );
});

test("a truncated OOXML package fails instead of returning partial rows", async () => {
  await assert.rejects(() => readTable(fixture("corrupt.xlsx")), TableError);
});

// --------------------------------------------- expansion limit (actual bytes)

test("the declared constant still mirrors the 150 MB Python cap", () => {
  assert.equal(MAX_UNCOMPRESSED_BYTES, 150_000_000);
});

test("actual expanded bytes are counted, not the sizes declared in the zip", () => {
  // Patch every declared uncompressed size down to 10 bytes. A check that
  // trusted the central directory would accept this archive.
  const buffer = Buffer.from(readFileSync(join(FIXTURES, "forecast-ooxml.xls")));
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  let patched = 0;
  for (let offset = 0; offset <= buffer.length - 4; offset += 1) {
    const signature = view.getUint32(offset, true);
    if (signature === 0x04034b50) {
      view.setUint32(offset + 22, 10, true);
      patched += 1;
    } else if (signature === 0x02014b50) {
      view.setUint32(offset + 24, 10, true);
      patched += 1;
    }
  }
  assert.ok(patched >= 2, `expected local and central headers to patch, patched ${patched}`);

  // A limit below the real payload must reject even though every declaration says 10.
  assert.throws(() => inflateWithLimit(buffer, { limit: 1_000 }), (error) => error instanceof RangeError);
  // With the real limit the same archive reports its true expanded size.
  const inflated = inflateWithLimit(buffer, { keep: ["xl/workbook.xml"] });
  assert.ok(inflated.expandedBytes > 1_000, `expected real expanded bytes, got ${inflated.expandedBytes}`);
  assert.ok(inflated.kept.has("xl/workbook.xml"));
});

test("readTable reports the 150 MB message and records the real expanded size", async () => {
  assert.throws(() => inflateWithLimit(readFileSync(join(FIXTURES, "forecast-ooxml.xls")), { limit: 10 }), RangeError);
  const table = await readTable(fixture("forecast-ooxml.xls"));
  assert.ok(table.expandedBytes > 0 && table.expandedBytes < MAX_UNCOMPRESSED_BYTES);
  assert.ok(table.expandedBytes >= table.bytes, "expanded size must exceed the compressed size");
});

// ------------------------------------------ expansion limit (real abort, T0-R2)

/**
 * Coordinator's counterexample: two highly compressed entries (2 MB + 3 MB) in
 * a ~5 KB archive. The previous implementation kept expanding every entry after
 * the limit was crossed and only threw at the end, so `emitted` reached 5 MB.
 */
test("an over-limit archive aborts before later entries are expanded", () => {
  const bomb = makeZip([
    { name: "first.bin", data: Buffer.alloc(2_000_000, 0x61) },
    { name: "second.bin", data: Buffer.alloc(3_000_000, 0x62) },
  ]);
  assert.ok(bomb.length < 20_000, `expected a small archive, got ${bomb.length} bytes`);

  let failure = null;
  try {
    inflateWithLimit(bomb, { limit: 1_000 });
  } catch (error) {
    failure = error;
  }
  assert.ok(failure instanceof RangeError, `expected the abort to throw, got ${failure}`);
  // The abort must happen while the FIRST entry is expanding: the second entry
  // must never be started, let alone expanded to its 3 MB.
  assert.deepEqual(
    Object.keys(failure.perFile ?? {}),
    ["first.bin"],
    `later entries were expanded before the abort: ${JSON.stringify(failure.perFile)}`,
  );
  assert.ok(
    failure.expandedBytes <= 2_000_000,
    `output continued past the first entry: ${failure.expandedBytes} bytes emitted`,
  );
  // A bound on the overshoot: at most one emission past the limit.
  assert.ok(
    failure.largestEmission <= MAX_INFLATE_EMISSION_BYTES,
    `single emission ${failure.largestEmission} exceeds the chunk-based bound`,
  );
  assert.ok(
    failure.expandedBytes <= 1_000 + failure.largestEmission,
    "emitted more than limit plus one emission past the abort point",
  );
});

/**
 * A single temporary output allocation must be bounded by the input chunk fed
 * to the inflater, not by the entry size: a finite 16 MB incompressible entry
 * exceeds the input chunk and must be emitted in pieces.
 */
test("a single emission is bounded by the input chunk fed to the inflater", () => {
  // A repeated 256 KiB block exceeds DEFLATE's 32 KiB back-reference window,
  // so it remains largely incompressible. High-ratio expansion is checked
  // separately by the isolated 16 MB repeated-byte allocation probe.
  const block = Buffer.alloc(256 * 1024);
  let state = 0x9e3779b9;
  for (let index = 0; index < block.length; index += 1) {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5; state >>>= 0;
    block[index] = state & 0xff;
  }
  const data = Buffer.concat(Array.from({ length: 64 }, () => block));
  const bomb = makeZip([{ name: "big.bin", data }]);
  assert.ok(bomb.length > INFLATE_INPUT_CHUNK, "expected the compressed entry to exceed one input chunk");

  let failure = null;
  try {
    inflateWithLimit(bomb, { limit: 4_000_000 });
  } catch (error) {
    failure = error;
  }
  assert.ok(failure instanceof RangeError, `expected the abort to throw, got ${failure}`);
  // The bound includes incomplete block/header carry between input pushes.
  assert.ok(
    failure.largestEmission <= MAX_INFLATE_EMISSION_BYTES,
    `largest emission ${failure.largestEmission} exceeds 1032 x chunk (${1032 * INFLATE_INPUT_CHUNK})`,
  );
  // Piecewise emission for entries larger than the chunk: no single emission
  // may carry a meaningful fraction of the whole entry.
  assert.ok(
    failure.largestEmission <= data.length / 4,
    `the whole entry was expanded in one step: ${failure.largestEmission} of ${data.length}`,
  );
  assert.ok(failure.expandedBytes <= 4_000_000 + failure.largestEmission);
  assert.deepEqual(Object.keys(failure.perFile ?? {}), ["big.bin"]);
});

test("the successful path reports per-entry emissions and the largest chunk", () => {
  const inflated = inflateWithLimit(readFileSync(join(FIXTURES, "forecast-ooxml.xls")), {
    keep: ["xl/workbook.xml"],
  });
  assert.ok(inflated.largestEmission > 0);
  assert.ok(
    inflated.largestEmission <= MAX_INFLATE_EMISSION_BYTES,
    `largest emission ${inflated.largestEmission} exceeds the chunk-based bound`,
  );
  // Every entry in the workbook archive was started and fully accounted for.
  const totalFromEntries = Object.values(inflated.perFile ?? {}).reduce((sum, entry) => sum + entry.bytes, 0);
  assert.equal(totalFromEntries, inflated.expandedBytes);
});

test('real inflater allocations stay within an explicit temporary bound', async () => {
  const probe = await promisify(execFile)(process.execPath, [fileURLToPath(new URL('./inflate-allocation-probe.mjs', import.meta.url))],
    { encoding: 'utf8', timeout: 30_000 });
  const result = JSON.parse(probe.stdout.trim());
  assert.ok(Number.isFinite(result.declaredAllocationBound), 'temporary allocation bound must be explicit');
  assert.ok(result.maximumAllocation > result.largestEmission, 'observe working buffers, not only emitted chunks');
  assert.ok(result.maximumAllocation <= result.declaredAllocationBound, JSON.stringify(result));
  assert.deepEqual(result.entries, ['first.bin']);
  console.log('# allocation probe: ' + JSON.stringify(result));
});

test('sparse fixtures contain real C2/C3 and XFD cell references in the XML', () => {
  const xml = (name) => new TextDecoder().decode(inflateWithLimit(fixture(name).bytes,
    { keep: ['xl/worksheets/sheet1.xml'] }).kept.get('xl/worksheets/sheet1.xml'));
  const gaps = xml('gaps.xlsx');
  assert.match(gaps, /r="C2"/u);
  assert.match(gaps, /r="C3"/u);
  assert.doesNotMatch(gaps, /r="B[23]"/u);
  const wide = xml('bounds-wide.xlsx');
  assert.match(wide, /r="XFD1"/u);
  assert.match(wide, /r="XFD2"/u);
});

test('oversized central-directory allocation hints are rejected before library parsing', async () => {
  const bytes = Buffer.from(readFileSync(join(FIXTURES, 'forecast-ooxml.xls')));
  for (let offset = 0; offset <= bytes.length - 28; offset += 1) {
    if (bytes.readUInt32LE(offset) === 0x02014b50) {
      bytes.writeUInt32LE(MAX_UNCOMPRESSED_BYTES + 1, offset + 24);
      break;
    }
  }
  await assert.rejects(() => readTable({ name: 'metadata-size.xlsx', bytes }),
    (error) => error instanceof TableError && /150 MB/u.test(error.message));
});


// ------------------------------------------------------------------ hashing

test("the reported hash covers the original bytes, not the decoded text", async () => {
  const file = fixture("minute-power-gb18030.csv");
  const table = await readTable(file);
  const expected = createHash("sha256").update(Buffer.from(file.bytes)).digest("hex");
  assert.equal(table.sha256, expected);
  assert.equal(table.bytes, file.bytes.byteLength);
});

// ------------------------------------------------------------- header rules

test("dictionaryRows reports every missing column together", async () => {
  const table = await readTable({ name: "headers.csv", bytes: bytesOf("时间,可用功率\n2026/8/1 0:00,1\n") });
  assert.throws(
    () => dictionaryRows(table, ["时间", "可用功率", "AGC有功设定值"]),
    (error) => error instanceof TableError && /缺少列 AGC有功设定值/.test(error.message),
  );
});

test("dictionaryRows rejects duplicated non-empty column names", async () => {
  const table = await readTable({ name: "dupes.csv", bytes: bytesOf("时间,时间,可用功率\n2026/8/1 0:00,2026/8/1 0:00,1\n") });
  assert.throws(() => dictionaryRows(table, ["时间"]), (error) => /列名重复/.test(error.message));
});

test("dictionaryRows skips blank lines but keeps the spreadsheet line number", async () => {
  const table = await readTable({
    name: "blanks.csv",
    bytes: bytesOf("时间,可用功率\n2026/8/1 0:00,1\n,,\n2026/8/1 0:01,2\n"),
  });
  const rows = dictionaryRows(table, ["时间", "可用功率"]);
  assert.deepEqual(rows.map((row) => row.line), [2, 4]);
  assert.equal(rows[1].values["可用功率"], "2");
});

test("dictionaryRows maps workbook cells to headers like the Python baseline", async () => {
  const table = await readTable(fixture("forecast-ooxml.xls"));
  const rows = dictionaryRows(table, ["预测id", "名称", "预测时间", "考核点2预测结果"]);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].values["预测id"], "SYNTHETIC_T0");
  assert.equal(rows[0].values["考核点2预测结果"], 24.5);
  assert.equal(rows[2].values["考核点2预测结果"], null);
});

test("numberOrNull mirrors upload_pipeline.number and never coerces a Date", () => {
  assert.equal(numberOrNull("29.6"), 29.6);
  assert.equal(numberOrNull(""), null);
  assert.equal(numberOrNull("abc"), null);
  assert.equal(numberOrNull(true), null);
  assert.equal(numberOrNull(Number.NaN), null);
  assert.equal(numberOrNull(Number.POSITIVE_INFINITY), null);
  assert.equal(numberOrNull(new Date()), null);
  assert.equal(numberOrNull(0), 0);
});

// ------------------------------------------------------------------ volume

test("a 31-day minute table reads in a bounded time (Node baseline)", async () => {
  const rows = ["时间,可用功率,理论功率,全站总有功_集电线有功之和,AGC有功设定值"];
  const total = 31 * 1440;
  for (let minute = 0; minute < total; minute += 1) {
    const day = Math.floor(minute / 1440) + 1;
    const hour = Math.floor((minute % 1440) / 60);
    const rest = minute % 60;
    rows.push(`2026-08-${String(day).padStart(2, "0")} ${String(hour).padStart(2, "0")}:${String(rest).padStart(2, "0")},29.5,29.6,28.9,21`);
  }
  const bytes = bytesOf(rows.join("\r\n"));
  const started = performance.now();
  const table = await readTable({ name: "day-31.csv", bytes });
  const elapsed = performance.now() - started;
  assert.equal(table.rows.length, total + 1);
  console.log(`# 31-day CSV: ${bytes.byteLength} bytes, ${table.rows.length} rows, read in ${elapsed.toFixed(1)} ms (Node)`);
  assert.ok(elapsed < 30_000, `reading 31 days took ${elapsed} ms`);
});
