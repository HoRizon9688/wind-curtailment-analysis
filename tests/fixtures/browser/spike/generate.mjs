// Deterministic generator for the T0 spike fixtures.
//
// Only synthetic values are produced here. No measurement, forecast or report
// file is read. Run with the project Node runtime from the repository root:
//
//   node tests/fixtures/browser/spike/generate.mjs
//
// The GB18030 CSV additionally needs tests/fixtures/browser/spike/generate-gb18030.py
// because Node cannot encode anything other than UTF-8.
import { deflateRawSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------- ZIP writer
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

// A fixed DOS timestamp keeps regenerated fixture bytes reproducible.
export function makeZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of files) {
    const nameBytes = Buffer.from(name, "utf8");
    const raw = Buffer.from(data);
    const comp = deflateRawSync(raw, { level: 9 });
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, comp);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + comp.length;
  }
  const centralBuffer = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuffer, end]);
}

// ------------------------------------------------------------- XLSX builder
const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;

// numFmtId 164 is a custom date/time format; 0 is General.
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd\\ hh:mm"/></numFmts><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs></styleSheet>`;

const COLUMNS = ["A", "B", "C", "D", "E", "F", "G", "H"];

function columnIndex(reference) {
  const letters = /^([A-Z]+)/u.exec(reference)?.[1] ?? "";
  let index = 0;
  for (const letter of letters) index = index * 26 + (letter.charCodeAt(0) - 64);
  return index - 1;
}

function cellXml(cell, rowIndex) {
  if (!cell || cell.blank) return "";
  const reference = `${COLUMNS[cell.column ?? 0]}${rowIndex}`;
  if (cell.inlineString !== undefined) {
    return `<c r="${reference}" t="inlineStr"><is><t xml:space="preserve">${cell.inlineString}</t></is></c>`;
  }
  if (cell.sharedString !== undefined) {
    return `<c r="${reference}" t="s"><v>${cell.sharedString}</v></c>`;
  }
  if (cell.formula !== undefined) {
    const cached = cell.cached === undefined ? "" : `<v>${cell.cached}</v>`;
    return `<c r="${reference}"><f>${cell.formula}</f>${cached}</c>`;
  }
  const style = cell.style ? ` s="${cell.style}"` : "";
  return `<c r="${reference}"${style}><v>${cell.value}</v></c>`;
}

function buildXlsx({ sheetName, rows, date1904 = false }) {
  const sheetData = rows
    .map((cells, index) => {
      const rowNumber = index + 1;
      const body = cells
        .map((cell, column) => cellXml({ ...cell, column }, rowNumber))
        .filter(Boolean)
        .join("");
      return `<row r="${rowNumber}">${body}</row>`;
    })
    .join("");
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetData}</sheetData></worksheet>`;
  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${date1904 ? '<workbookPr date1904="1"/>' : ""}<sheets><sheet name="${sheetName}" sheetId="1" r:id="rId1"/><sheet name="Cover" sheetId="2" r:id="rId2"/></sheets></workbook>`;
  const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>`;
  const cover = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>cover</t></is></c></row></sheetData></worksheet>`;

  return makeZip([
    { name: "[Content_Types].xml", data: CONTENT_TYPES },
    { name: "_rels/.rels", data: ROOT_RELS },
    { name: "xl/workbook.xml", data: workbook },
    { name: "xl/_rels/workbook.xml.rels", data: workbookRels },
    { name: "xl/styles.xml", data: STYLES },
    { name: "xl/sharedStrings.xml", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="4" uniqueCount="4"><si><t>时间</t></si><si><t>预测id</t></si><si><t>名称</t></si><si><t>预测时间</t></si></sst>` },
    { name: "xl/worksheets/sheet1.xml", data: sheet },
    { name: "xl/worksheets/sheet2.xml", data: cover },
  ]);
}

// ------------------------------------------------------------------- fixtures
// Excel serial for 2026-08-01 00:00 with the 1900 date system.
const SERIAL_2026_08_01 = 46235;
const S = (text) => ({ inlineString: text });
const N = (value) => ({ value });

function minutePowerRows() {
  const rows = [[S("时间"), S("可用功率"), S("理论功率"), S("全站总有功_集电线有功之和"), S("AGC有功设定值"), S("备注")]];
  for (let minute = 0; minute < 8; minute += 1) {
    const time = `2026-08-01 ${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
    rows.push([
      { value: SERIAL_2026_08_01 + minute / 1440, style: 1 }, // date cell, not text
      N(29.5 + minute * 0.1),
      N(29.6 + minute * 0.1),
      N(28.9 + minute * 0.1),
      N(21 + minute * 0.1),
      S(time),
    ]);
  }
  return rows;
}

function forecastRows() {
  // The reader must take 考核点2预测结果 only. 平均预测结果 is deliberately absent.
  const rows = [
    [{ sharedString: 1 }, { sharedString: 2 }, { sharedString: 3 }, S("考核点2预测结果"), S("缓存公式列"), S("无缓存公式列")],
    [S("SYNTHETIC_T0"), S("合成验证场站"), { value: SERIAL_2026_08_01 - 15 / 1440, style: 1 }, N(24.5), { formula: "D2*2", cached: 49 }, { formula: "D2+1" }],
    [S("SYNTHETIC_T0"), S("合成验证场站"), { value: SERIAL_2026_08_01, style: 2 }, N(25.25), { formula: "D3*2", cached: 50.5 }, { formula: "D3+1" }],
    // Blank 考核点2预测结果 must be skipped by the caller, but the cell itself is readable.
    [S("SYNTHETIC_T0"), S("合成验证场站"), { value: SERIAL_2026_08_01 + 15 / 1440, style: 2 }, { blank: true }, { blank: true }, { blank: true }],
  ];
  return rows;
}

function csv(rows) {
  return rows
    .map((row) =>
      row
        .map((value) => {
          const text = value === null || value === undefined ? "" : String(value);
          return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
        })
        .join(","),
    )
    .join("\r\n")
    .concat("\r\n");
}

function minutePowerCsv() {
  const rows = [["时间", "可用功率", "理论功率", "全站总有功_集电线有功之和", "AGC有功设定值"]];
  // Row 2 keeps an empty 可用功率 cell so the reader must not shift columns.
  rows.push(["2026/8/1 0:00", "", "29.6", "28.9", "21"]);
  rows.push(["2026/8/1 0:01", "29.6", "29.7", "29", "21.1"]);
  // The comma inside this value must survive quoting and reappear unquoted.
  rows.push(["2026/8/1 0:02", "29.7", "29,7", "29.1", "21.2"]);
  return rows;
}

export function generate() {
  const written = [];
  const write = (name, data) => {
    writeFileSync(join(HERE, name), data);
    written.push(`${name} (${Buffer.byteLength(data)} bytes)`);
  };

  write("minute-power.csv", "\uFEFF" + csv(minutePowerCsv()));
  write("forecast-ooxml.xls", buildXlsx({ sheetName: "功率预测", rows: forecastRows() }));
  write("minute-power-ooxml.xlsx", buildXlsx({ sheetName: "功率预测", rows: minutePowerRows() }));
  write("forecast-1904.xlsx", buildXlsx({ sheetName: "功率预测", rows: forecastRows(), date1904: true }));
  write(
    "forecast-no-power-sheet.xls",
    buildXlsx({ sheetName: "Sheet1", rows: forecastRows() }),
  );
  // Legacy OLE2 compound file: must keep failing exactly like today.
  write("legacy-binary.xls", Buffer.concat([Buffer.from("d0cf11e0a1b11ae1", "hex"), Buffer.alloc(2048)]));
  // A text file that merely claims to be a workbook.
  write("not-a-workbook.xlsx", "时间,可用功率\n2026/8/1 0:00,29.6\n");

  return written;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replaceAll("\\", "/")}`).href) {
  for (const line of generate()) console.log(`wrote ${line}`);
}

export { buildXlsx, csv };
