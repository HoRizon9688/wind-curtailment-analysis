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

import {
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

test("the last legal worksheet column (XFD) is readable and rows are not padded to it", async () => {
  assert.equal(MAX_SHEET_COLUMNS, 16_384);
  const table = await readTable(fixture("bounds-wide.xlsx"));
  // openpyxl and read-excel-file both return only the cells present in the
  // row, so the XFD value arrives at its compacted position.
  assert.deepEqual(table.rows[0], ["时间", "可用功率", "末列"]);
  assert.deepEqual(table.rows[1], ["2026/8/1 0:00", 29.6, 1.5]);
});

test("empty middle cells compact identically to openpyxl (shared baseline behaviour)", async () => {
  // python-baseline.py, openpyxl read_only:
  //   ['A','B','C']   ['a1','c1']   ['c2']
  // The library agrees on compaction and only pads to the widest row, which is
  // invisible to dictionaryRows because `zip` ignores the extra trailing nulls.
  // Pinned here so any future alignment change is a deliberate contract decision.
  const table = await readTable(fixture("gaps.xlsx"));
  assert.deepEqual(table.rows[0], ["A", "B", "C"]);
  assert.equal(table.rows[1][0], "a1");
  assert.equal(table.rows[1][1], "c1");
  assert.equal(table.rows[2][0], "c2");
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
