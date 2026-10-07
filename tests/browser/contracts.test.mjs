import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { compareResults } from './compare.mjs';
import { LIMITS, UNITS, validateInput, validateResult, validateError, validateProgress, dateSpan } from '../../dashboard/src/content/calculation/contracts.mjs';
import { readTable } from '../../dashboard/src/content/calculation/table-reader.mjs';
import {fixturePath} from './fixture-tools.mjs';

const fixtures = new URL('../fixtures/browser/contract/', import.meta.url);
const load = path => readFileSync(fixturePath(path));
const json = path => JSON.parse(load(path));
const result = path => JSON.parse(gunzipSync(load(path)));
const input = () => ({power:[{name:'p.csv',bytes:new ArrayBuffer(1)}],forecast:[{name:'f.csv',bytes:new ArrayBuffer(1)}],options:{capacity:100,stationName:'合成',start:null,end:null}});

test('input contract: raw bytes, positive capacity, file counts, supported names', () => {
  assert.equal(validateInput(input()).options.capacity,100);
  for (const capacity of [0,-1,NaN,Infinity,true,'100']) {
    const x=input(); x.options.capacity=capacity; assert.throws(()=>validateInput(x));
  }
  for (const mutate of [x=>x.power=[],x=>x.forecast=Array(401).fill(x.forecast[0]),x=>x.power[0].bytes=new ArrayBuffer(0),x=>x.power[0].bytes=new Uint8Array(1),x=>x.power[0].name='p.txt']) {
    const x=input(); mutate(x); assert.throws(()=>validateInput(x));
  }
  const x=input(); x.power[0].bytes=new ArrayBuffer(LIMITS.totalBytes); assert.throws(()=>validateInput(x),/60/);
  x.power[0].bytes=new ArrayBuffer(LIMITS.totalBytes-1); assert.equal(validateInput(x),x);
  const many=input();many.power=Array(400).fill(many.power[0]);assert.equal(validateInput(many),many);
  assert.deepEqual(UNITS,{power:'MW',energy:'MWh',duration:'minute',timezone:'UTC+08:00'});
});

test('explicit reporting dates are inclusive, valid calendar dates and at most 366 days', () => {
  assert.equal(dateSpan('2024-01-01','2024-12-31'),366);
  assert.throws(()=>dateSpan('2024-01-01','2025-01-01'));
  for (const end of ['2026-02-29','2024-01-00','2024-13-01','2024-01-01T00:00','2023-12-31']) assert.throws(()=>dateSpan('2024-01-01',end));
});

test('errors and progress retain request identity and reject accidental coercion', () => {
  validateError({code:'INPUT',message:'错误',file:'p.csv',row:2,field:'时间'});
  validateProgress({requestId:'B',phase:'reading',completed:0,total:2});
  assert.throws(()=>validateError({code:'INPUT',message:'错误',row:'2'}));
  assert.throws(()=>validateProgress({requestId:'B',phase:'reading',completed:3,total:2}));
});

test('comparator reports every difference, first difference and contextual minute inputs', () => {
  const expected={rows:[{timestamp:'2026-08-01T04:46:00+08:00',a:100,f:80,g:60,p:50,included:true,status:'estimated',dispatch:20/60,reasons:[],noiseAbove:null}],summary:{dispatch:1,included:1},meta:{files:[{sha256:'aaa'}]}};
  const actual=structuredClone(expected);
  actual.rows[0].status='excluded'; actual.rows[0].included=false;
  actual.rows[0].dispatch*=60; actual.rows[0].reasons=['错误']; delete actual.rows[0].noiseAbove;
  actual.summary.included+=1e-10; actual.meta.files[0].sha256='bbb';
  const review=compareResults(expected,actual);
  assert.equal(review.equal,false); assert.equal(review.differences.length,7);
  assert.equal(review.first,review.differences[0]);
  const power=review.differences.find(x=>x.path==='$.rows[0].dispatch');
  assert.equal(power.timestamp,expected.rows[0].timestamp);
  assert.deepEqual(power.input,{a:100,f:80,g:60,p:50});
  assert.equal(review.differences.find(x=>x.path.endsWith('.noiseAbove')).kind,'missing');
  const absent=compareResults(expected,{...expected,rows:[]}).first;
  assert.equal(absent.timestamp,expected.rows[0].timestamp);assert.equal(absent.actualPresent,false);
});

test('tolerances apply only to declared power, ratio and energy paths; no coercion', () => {
  const expected={rows:[{dispatch:1,a:1}],summary:{dispatch:1,coverage:1,included:1}};
  const actual=structuredClone(expected); actual.rows[0].dispatch+=5e-10; actual.summary.dispatch+=5e-7;
  assert.equal(compareResults(expected,actual).equal,true);
  actual.rows[0].a+=2e-9; assert.equal(compareResults(expected,actual).equal,false);
  actual.rows[0].a=1; actual.summary.coverage+=2e-9; assert.equal(compareResults(expected,actual).equal,false);
  actual.summary.coverage=1;actual.summary.dispatch=1+2e-6;assert.equal(compareResults(expected,actual).equal,false);
  assert.equal(compareResults({value:1},{value:1+1e-10}).equal,false);
  for (const value of ['1',true,null,NaN,Infinity]) assert.equal(compareResults({rows:[{a:1}]},{rows:[{a:value}]}).equal,false);
  assert.equal(compareResults({rows:[]},{rows:[],extra:null}).equal,false);
});

test('frozen synthetic files and Python sources have verified SHA-256; tests never generate expectations', () => {
  const manifest=json('manifest.json');
  assert.equal(manifest.syntheticOnly,true);
  assert.match(manifest.baselineCommit,/^[0-9a-f]{40}$/);
  for (const entry of manifest.files) {
    const bytes=load(entry.path);
    assert.equal(bytes.length,entry.bytes,entry.path);
    assert.equal(createHash('sha256').update(bytes).digest('hex'),entry.sha256,entry.path);
  }
  for (const entry of manifest.sources) {
    // Git checkout may normalize LF to CRLF. Hash algorithm source as LF, not working-tree line endings.
    const bytes=readFileSync(fileURLToPath(new URL('../../'+entry.path,import.meta.url))).toString('utf8').replaceAll('\r\n','\n');
    assert.equal(createHash('sha256').update(bytes).digest('hex'),entry.sha256,entry.path);
  }
});

test('all full Python results satisfy frozen schema; row mutation and unit mistakes fail comparison', () => {
  const manifest=json('manifest.json');
  for (const fixture of manifest.cases.filter(x=>x.kind==='analysis' && x.expected)) {
    const expected=result(fixture.expected); validateResult(expected);
    assert.equal(compareResults(expected,structuredClone(expected)).equal,true,fixture.id);
    const actual=structuredClone(expected); actual.rows[0].status='wrong';
    assert.equal(compareResults(expected,actual).equal,false,fixture.id);
  }
  const expected=result('expected/normal.json.gz');
  for (const mutate of [x=>delete x.calibration,x=>x.rows[0].included='true',x=>x.rows[0].dispatch=null,x=>x.rows[1].dispatchState=false,x=>x.meta.timezone='UTC',x=>x.summary.included=.5,x=>x.rows[0].a=-1,x=>x.rows[0].rightF=101,x=>x.rows[0].weight=1.1]) {
    const actual=structuredClone(expected); mutate(actual); assert.throws(()=>validateResult(actual));
  }
});

test('independent hand arithmetic and state sequences agree with frozen Python allocator outputs', () => {
  const cases=json('allocator.json');
  for (const fixture of cases) {
    for (const [i,checks] of fixture.hand.entries()) for (const [key,value] of Object.entries(checks)) {
      const actual=fixture.expected[i][key];
      if (typeof value==='number') assert.ok(Math.abs(actual-value)<=1e-9,`${fixture.id}[${i}].${key}`);
      else assert.equal(actual,value,`${fixture.id}[${i}].${key}`);
    }
  }
});

test('current reader matches frozen CSV and non-date-cell OOXML tables (date-cell audit is a T2 gate)', async () => {
  for(const fixture of json('tables.json').filter(x=>!x.path.includes('/dates-'))) {
    const buffer=load(fixture.path);
    const actual=await readTable({name:fixture.path.split('/').at(-1),bytes:buffer.buffer.slice(buffer.byteOffset,buffer.byteOffset+buffer.byteLength)});
    const cells=actual.rows.map(row=>row.map(v=>v instanceof Date?{excelWallTime:v.toISOString().replace(/\.000Z$/,'')}:v));
    assert.deepEqual(cells,fixture.rows,fixture.path);
  }
});

test('cross-day state persists, missing/negative minutes reset, endpoint and full Python range boundaries are explicit', () => {
  const cross=result('expected/cross-midnight.json.gz');
  // This legacy input has only one entry-qualifying minute; it cannot confirm v2.
  assert.deepEqual(cross.rows.slice(1438,1442).map(r=>r.dispatchState),[false,false,false,false]);
  for(const id of ['negative-and-reset','missing-and-reset']) {
    const r=result(`expected/${id}.json.gz`);
    assert.equal(r.rows[0].dispatchState,false);assert.equal(r.rows[1].included,false);assert.equal(r.rows[2].dispatchState,false);
  }
  const endpoint=result('expected/inferred-midnight-endpoint.json.gz');
  assert.equal(endpoint.rows.length,1440);assert.equal(endpoint.meta.powerOutsidePeriod,1);
  const boundary=result('expected/range-366.json.gz');
  assert.equal(boundary.summary.expected,527040);assert.equal(boundary.daily.length,366);
  assert.equal(Object.hasOwn(boundary,'rows'),false);
  const manifest=json('manifest.json');
  assert.equal(manifest.cases.find(x=>x.id==='range-367').error.code,'RANGE');
  const day=result('expected/continuous-day-56mw.json.gz');
  assert.equal(day.summary.included,1440);assert.equal(day.summary.excluded,0);assert.equal(day.summary.coverage,1);
  for(const fixture of manifest.cases.filter(x=>x.error)) validateError({code:fixture.error.code,message:fixture.error.message});
});
