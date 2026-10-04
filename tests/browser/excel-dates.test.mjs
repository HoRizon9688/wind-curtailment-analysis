import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readTable,parseWorkbookMetadata} from '../../dashboard/src/content/calculation/table-reader.mjs';
import {excelSerialToDate} from '../../dashboard/src/content/calculation/excel-dates.mjs';
import {parseTime,formatTime} from '../../dashboard/src/content/calculation/time.mjs';
import {inputFile} from './fixture-tools.mjs';
const {unzipSync,zipSync}=createRequire(new URL('../../dashboard/package.json',import.meta.url))('fflate');

test('all 1440 modern minute date serials use Python millisecond precision in BOTH date systems',()=>{
  for(const mac of [false,true]) {
    const epoch=mac?Date.UTC(1904,0,1):Date.UTC(1899,11,30);
    for(let i=0;i<1440;i++) {
      const expected=Date.UTC(2026,7,1)+i*60000;
      assert.equal(excelSerialToDate((expected-epoch)/86400000,mac).getTime(),expected,`${mac}:${i}`);
    }
  }
  assert.equal(excelSerialToDate(1).toISOString(),'1900-01-01T00:00:00.000Z');
  assert.equal(excelSerialToDate(59).getTime(),excelSerialToDate(60).getTime());
});

test('real nonzero seconds/milliseconds survive workbook parsing and are rejected, not rounded to a minute',async()=>{
  for(const [mac,path] of [[false,'inputs/dates-1900-active-sheet-power.xlsx'],[true,'inputs/dates-1904-power.xlsx']]) {
    const original=inputFile(path),parts=unzipSync(new Uint8Array(original.bytes));
    const key=Object.keys(parts).find(k=>/^xl\/worksheets\/.+\.xml$/.test(k)&&new TextDecoder().decode(parts[k]).includes('r="A3"'));
    for(const ms of [1,1000,59999]) {
      const serial=(Date.UTC(2026,7,1,0,15,0,ms)-(mac?Date.UTC(1904,0,1):Date.UTC(1899,11,30)))/86400000;
      const xml=new TextDecoder().decode(parts[key]).replace(/(<c\b[^>]*r="A3"[^>]*>\s*<v>)[^<]+/,`$1${serial}`);
      const bytes=zipSync({...parts,[key]:new TextEncoder().encode(xml)});
      const table=await readTable({name:'synthetic-date.xlsx',bytes});
      assert.equal(table.rows[2][0].getTime(),Date.UTC(2026,7,1,0,15,0,ms));
      assert.throws(()=>parseTime(table.rows[2][0]),/不能自动取整/);
    }
  }
});

test('workbook selection metadata supports namespaces, entities and single-quoted attributes',()=>{
  const xml="<w:workbook xmlns:w='w' xmlns:r='r'><w:workbookPr date1904='true'/><w:bookViews><w:workbookView activeTab='1'/></w:bookViews><w:sheets><w:sheet name='封&amp;面'/><w:sheet name='功率预测'/></w:sheets></w:workbook>";
  assert.deepEqual(parseWorkbookMetadata(xml,'x'),{sheets:['封&面','功率预测'],activeTab:1,date1904:true});
});
test('Excel time-only cells keep Python time semantics rather than becoming a historical date',async()=>{
  const original=inputFile('inputs/dates-1900-active-sheet-power.xlsx'),parts=unzipSync(new Uint8Array(original.bytes));
  const key=Object.keys(parts).find(k=>/^xl\/worksheets\/.+\.xml$/.test(k)&&new TextDecoder().decode(parts[k]).includes('r="A3"'));
  const xml=new TextDecoder().decode(parts[key]).replace(/(<c\b[^>]*r="A3"[^>]*>\s*<v>)[^<]+/,'$10.5');
  const table=await readTable({name:'time-only.xlsx',bytes:zipSync({...parts,[key]:new TextEncoder().encode(xml)})});
  assert.equal(table.rows[2][0],'12:00:00');
  assert.throws(()=>parseTime(table.rows[2][0]));
});
