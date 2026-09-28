/**
 * T0 spike: proves the browser-side reading path before any interface freeze.
 *
 * These Node assertions cover the reading mechanism only. G0 additionally
 * requires browser evidence under the repository subpath, which lives in
 * tests/browser/browser-spike/ and is not satisfied by Node alone.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  MAX_UNCOMPRESSED_BYTES,
  TableError,
  dictionaryRows,
  excelSerialToDate,
  isDateFormat,
  parseDelimited,
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
  const rows = parseDelimited('a,"b,1","say ""hi""",d\r\n');
  assert.deepEqual(rows, [["a", "b,1", 'say "hi"', "d"]]);
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
  // 0xFF is invalid in both UTF-8 and GB18030 lead-byte positions.
  const bytes = new Uint8Array([0x61, 0x2c, 0xff, 0xfe, 0x0a]).buffer;
  await assert.rejects(() => readTable({ name: "broken.csv", bytes }), TableError);
});

// -------------------------------------------------------------------- OOXML

test("OOXML is detected from content even though the extension says .xls", async () => {
  const table = await readTable(fixture("forecast-ooxml.xls"));
  assert.equal(table.format, "ooxml");
});

test("the preferred 功率预测 sheet is read instead of the workbook's first sheet", async () => {
  const table = await readTable(fixture("forecast-ooxml.xls"));
  assert.equal(table.sheetName, "功率预测");
  assert.equal(table.rows[0][3], "考核点2预测结果");
});

test("shared strings resolve and inline strings are kept verbatim", async () => {
  const table = await readTable(fixture("forecast-ooxml.xls"));
  assert.deepEqual(table.rows[0].slice(0, 3), ["预测id", "名称", "预测时间"]);
  assert.equal(table.rows[1][0], "SYNTHETIC_T0");
  assert.equal(table.rows[1][1], "合成验证场站");
});

test("a cached formula result is used and the formula is never evaluated", async () => {
  const table = await readTable(fixture("forecast-ooxml.xls"));
  // D2 = 24.5 with `=D2*2` cached as 49.
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

test("date-formatted cells become Dates using the 1900 date system", async () => {
  const table = await readTable(fixture("minute-power-ooxml.xlsx"));
  const first = table.rows[1][0];
  assert.ok(first instanceof Date, `expected a Date, got ${typeof first}`);
  assert.equal(first.toISOString().slice(0, 10), "2026-08-01");
  assert.equal(first.toISOString().slice(11, 16), "00:00");
  // A plain number in the same column must not be turned into a date.
  assert.equal(table.rows[1][1], 29.5);
});

test("the 1904 date system shifts the same serial by exactly 1462 days", async () => {
  const standard = await readTable(fixture("forecast-ooxml.xls"));
  const shifted = await readTable(fixture("forecast-1904.xlsx"));
  assert.equal(standard.date1904, false);
  assert.equal(shifted.date1904, true);
  // Same cell, same serial, only the workbook date system differs.
  const delta = shifted.rows[1][2].getTime() - standard.rows[1][2].getTime();
  assert.equal(delta, 1462 * 86_400_000);
});

test("a workbook without 功率预测 falls back to the first sheet", async () => {
  const table = await readTable(fixture("forecast-no-power-sheet.xls"));
  assert.equal(table.sheetName, "Sheet1");
});

test("legacy binary XLS keeps the existing error", async () => {
  await assert.rejects(
    () => readTable(fixture("legacy-binary.xls")),
    (error) => error instanceof TableError && /旧版二进制 XLS/.test(error.message),
  );
});

test("a text file renamed to .xlsx is rejected as a workbook", async () => {
  await assert.rejects(
    () => readTable(fixture("not-a-workbook.xlsx")),
    (error) => error instanceof TableError && /旧版二进制 XLS/.test(error.message),
  );
});

test("an empty file is rejected", async () => {
  await assert.rejects(() => readTable({ name: "empty.csv", bytes: new ArrayBuffer(0) }), TableError);
});

test("the expanded-size cap is enforced before inflating", async () => {
  assert.equal(MAX_UNCOMPRESSED_BYTES, 150_000_000);
  const buffer = Buffer.from(readFileSync(join(FIXTURES, "minute-power-ooxml.xlsx")));
  // Inflate the declared size of the first entry in the central directory only.
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  let patched = false;
  for (let offset = 0; offset <= buffer.length - 4; offset += 1) {
    if (view.getUint32(offset, true) === 0x02014b50) {
      view.setUint32(offset + 24, MAX_UNCOMPRESSED_BYTES + 1, true);
      patched = true;
      break;
    }
  }
  assert.ok(patched, "expected a central directory entry to patch");
  const bytes = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  await assert.rejects(
    () => readTable({ name: "bomb.xlsx", bytes }),
    (error) => error instanceof TableError && /150 MB/.test(error.message),
  );
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

// ---------------------------------------------------------------- utilities

test("date format detection ignores quoted literals and escapes", () => {
  assert.equal(isDateFormat(14, undefined), true);
  assert.equal(isDateFormat(0, "0.00"), false);
  assert.equal(isDateFormat(164, '"header y"0.0'), false);
  assert.equal(isDateFormat(164, "yyyy-mm-dd hh:mm"), true);
});

test("excelSerialToDate maps the epoch without touching the local timezone", () => {
  assert.equal(excelSerialToDate(46235).toISOString(), "2026-08-01T00:00:00.000Z");
  assert.equal(excelSerialToDate(0, true).toISOString(), "1904-01-01T00:00:00.000Z");
  // Half a day must survive as a wall-clock time, not drift by timezone offset.
  assert.equal(excelSerialToDate(46235.5).toISOString(), "2026-08-01T12:00:00.000Z");
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
  const text = rows.join("\r\n");
  const bytes = bytesOf(text);
  const started = performance.now();
  const table = await readTable({ name: "day-31.csv", bytes });
  const elapsed = performance.now() - started;
  assert.equal(table.rows.length, total + 1);
  // Recorded as evidence, not as a performance promise.
  console.log(`# 31-day CSV: ${bytes.byteLength} bytes, ${table.rows.length} rows, read in ${elapsed.toFixed(1)} ms (Node)`);
  assert.ok(elapsed < 30_000, `reading 31 days took ${elapsed} ms`);
});
