/** Optional audit of the original, user-supplied synthetic handoff.
 * Explicitly executes its reviewed JS modules; never required by a fresh clone.
 * Exit 1 intentionally reports differences from ACTUAL repository Python.
 */
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {loadJson} from './fixture-tools.mjs';
import {compareResults} from './compare.mjs';
import {oracle,oracleInput} from './python-oracle.mjs';

if(!process.argv[2])throw new Error('Usage: node tests/browser/audit-handoff.mjs <reviewed t3_handoff directory> [report.json]');
const base=resolve(process.argv[2]);
const {ThresholdAllocator}=await import(pathToFileURL(join(base,'allocator_real.mjs')));
const {parseTime,numberOrNull}=await import(pathToFileURL(join(base,'time.mjs')));
const {analyzeUploads}=await import(pathToFileURL(join(base,'analyze.mjs')));
const bytes=name=>readFileSync(join(base,name));
const file=(source,name)=>{const b=bytes(source);return {name,bytes:b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength)};};
const input={power:[file('fixtures_power.csv','power.csv')],forecast:[file('fixtures_forecast.csv','forecast.csv')],options:{capacity:56,stationName:'测试风场',start:'2026-08-01',end:'2026-08-01'}};
const expected=await oracle({mode:'analyze',input:oracleInput(input)});
const actual=analyzeUploads(input.power.map(f=>[f.name,new Uint8Array(f.bytes)]),input.forecast.map(f=>[f.name,new Uint8Array(f.bytes)]),input.options);
const allocator=loadJson('allocator.json').map(c=>{const m=new ThresholdAllocator(c.capacity);return {id:c.id,...compareResults({rows:c.expected},{rows:c.inputs.map(x=>m.calculate(x.a,x.f,x.g,x.p))})};});
const invalidTimes=['2026-02-29','2026-08-01T00:00:00.001'].map(x=>{try{return {input:x,accepted:parseTime(x)};}catch(e){return {input:x,error:e.message};}});
const hashes=Object.fromEntries(['allocator_real.mjs','time.mjs','analyze.mjs','read_tables.mjs','table_io.mjs','fixtures_power.csv','fixtures_forecast.csv'].map(name=>[name,createHash('sha256').update(bytes(name)).digest('hex')]));
const report={hashes,allocator,full:compareResults(expected,actual),expectedGaps:expected.gaps.length,actualGaps:actual.gaps.length,invalidTimes,blankNumber:numberOrNull('   ')};
if(process.argv[3]){mkdirSync(dirname(process.argv[3]),{recursive:true});writeFileSync(process.argv[3],JSON.stringify(report,null,2)+'\n');}
console.log(JSON.stringify({allocatorPassed:allocator.filter(c=>c.equal).length,allocatorCases:allocator.length,fullDifferences:report.full.differences.length,first:report.full.first,expectedGaps:report.expectedGaps,actualGaps:report.actualGaps,invalidTimes,blankNumber:report.blankNumber},null,2));
process.exitCode=report.full.equal?0:1;
