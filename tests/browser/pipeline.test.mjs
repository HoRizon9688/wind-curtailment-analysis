import test from 'node:test';
import assert from 'node:assert/strict';
import {analyzeFiles,analyzeNormalized} from '../../dashboard/src/content/calculation/analyze.mjs';
import {aggregate,gapIntervals} from '../../dashboard/src/content/calculation/aggregate.mjs';
import {validateResult} from '../../dashboard/src/content/calculation/contracts.mjs';
import {compareResults} from './compare.mjs';
import {loadJson,loadExpected,fixtureInput} from './fixture-tools.mjs';
import {readTable} from '../../dashboard/src/content/calculation/table-reader.mjs';
import {normalizeInputs} from '../../dashboard/src/content/calculation/input-model.mjs';

test('full Python pipeline: all 19 results and all 8 fatal errors match unrounded fields',async()=>{
  let maxMinuteError=0,maxAggregateEnergyError=0,rows=0;
  for(const c of loadJson('manifest.json').cases.filter(x=>x.kind!=='range-boundary')) {
    if(c.error)await assert.rejects(analyzeFiles(fixtureInput(c)),e=>e.message===c.error.message&&e.code===c.error.code,c.id);
    else {
      const actual=await analyzeFiles(fixtureInput(c));validateResult(actual);
      const review=compareResults(loadExpected(c.expected),actual);assert.equal(review.equal,true,JSON.stringify({id:c.id,first:review.first}));
      maxMinuteError=Math.max(maxMinuteError,review.maxMinuteError);maxAggregateEnergyError=Math.max(maxAggregateEnergyError,review.maxAggregateEnergyError);rows+=actual.rows.length;
    }
  }
  console.log('T3 full fixture comparison:',JSON.stringify({rows,differingRows:0,maxMinuteError,maxAggregateEnergyError}));
});
test('same input repeat is identical and normalized input is not mutated',async()=>{
  const c=loadJson('manifest.json').cases.find(c=>c.id==='continuous-day-56mw');
  const first=await analyzeFiles(fixtureInput(c));const second=await analyzeFiles(fixtureInput(c));assert.deepEqual(first,second);
  const input=fixtureInput(c);
  const normalized=normalizeInputs(await Promise.all(input.power.map(readTable)),await Promise.all(input.forecast.map(readTable)));
  const before=structuredClone(normalized);
  assert.deepEqual(analyzeNormalized(normalized,input.options),first);
  assert.deepEqual(normalized,before);
});
test('async entry rejects missing date keys and wrong date types before calculation',async()=>{
  const c=loadJson('manifest.json').cases.find(c=>c.id==='continuous-day-56mw');
  const input=fixtureInput(c);delete input.options.start;
  await assert.rejects(analyzeFiles(input),e=>e.field==='options.start');
  input.options.start=42;
  await assert.rejects(analyzeFiles(input),e=>e.field==='start');
});
test('per-reason gaps are unique half-open intervals; overlapping reasons do not duplicate rows',()=>{
  const rows=Array.from({length:3},(_,i)=>({timestamp:`2026-08-01T00:0${i}:00+08:00`,reasons:i<2?['分钟功率缺行','预测缺失（不外推、不跨缺点）']:[]}));
  const gaps=gapIntervals(rows);assert.equal(gaps.length,2);assert.ok(gaps.every(g=>g.minutes===2&&g.end==='2026-08-01T00:02:00+08:00'));
});
test('366-day full minute grid matches the explicit Python audit projection, with no truncation',async()=>{
  const c=loadJson('manifest.json').cases.find(c=>c.kind==='range-boundary');
  const result=await analyzeFiles(fixtureInput(c));
  assert.equal(result.rows.length,527040);assert.equal(result.rows.at(-1).timestamp,'2027-08-01T23:59:00+08:00');
  const actual=Object.fromEntries(c.projection.map(k=>[k,result[k]]));
  const review=compareResults(loadExpected(c.expected),actual);assert.equal(review.equal,true,JSON.stringify(review.first));
});
