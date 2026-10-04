/** T2 entry/exit diagnostic. Never regenerates expectations or rounds timestamps.
 * Run: node tests/browser/audit-table-oracle.mjs [optional-output-json]
 * Exit 1 means the current reader does NOT match the frozen Python cell oracle.
 * T1 revealed a read-excel-file 9.3.10 date floor defect; T2 must make this green.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { readTable, numberOrNull } from '../../dashboard/src/content/calculation/table-reader.mjs';
import { compareResults } from './compare.mjs';

const root=new URL('../fixtures/browser/contract/',import.meta.url);
const tables=JSON.parse(readFileSync(new URL('tables.json',root)));
const numbers=JSON.parse(readFileSync(new URL('numbers.json',root)));
const expected={tables,numbers};const actual={tables:[],numbers:numbers.map(({input})=>({input,expected:numberOrNull(input)}))};
for(const fixture of tables) {
  const bytes=readFileSync(new URL(fixture.path,root));
  const table=await readTable({name:fixture.path.split('/').at(-1),bytes:bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)});
  actual.tables.push({path:fixture.path,rows:table.rows.map(row=>row.map(value=>value instanceof Date?{excelWallTime:value.toISOString().replace(/\.000Z$/,'')}:value))});
}
const review={scope:'all synthetic Python table cells and numeric coercion, including Excel 1900/1904 dates',tables:tables.length,numberCases:numbers.length,...compareResults(expected,actual)};
if(process.argv[2]){mkdirSync(dirname(process.argv[2]),{recursive:true});writeFileSync(process.argv[2],JSON.stringify(review,null,2)+'\n');}
console.log(JSON.stringify(review,null,2));
process.exitCode=review.equal?0:1;
