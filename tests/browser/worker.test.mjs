import test from 'node:test';
import assert from 'node:assert/strict';
import {Worker} from 'node:worker_threads';
import {fixtureInput,loadJson,loadExpected} from './fixture-tools.mjs';
import {compareResults} from './compare.mjs';
import {validateProgress,validateError,validateResult} from '../../dashboard/src/content/calculation/contracts.mjs';
import {syntheticInput} from './performance-input.mjs';
import {analyzeFiles} from '../../dashboard/src/content/calculation/analyze.mjs';
function run(input,id='node-worker',type='calculate') {
  return new Promise((resolve,reject)=>{
    const w=new Worker(new URL('./worker-node-entry.mjs',import.meta.url)),progress=[],parts=[];
    const timeout=setTimeout(()=>{w.terminate();reject(new Error('worker test timeout'));},30000);
    w.on('error',e=>{clearTimeout(timeout);w.terminate();reject(e);});
    w.on('message',m=>{if(m.type==='progress'){const {type,...p}=m;validateProgress(p);progress.push(p);}else if(m.type==='result-part'){parts.push(m);}else {clearTimeout(timeout);w.terminate();if(m.rowCount!==undefined){const rows=[];for(const p of parts){assert.equal(p.offset,rows.length);assert.ok(p.rows.length<=1024);rows.push(...p.rows);}assert.equal(rows.length,m.rowCount);m.result.rows=rows;}resolve({message:m,progress,parts});}});
    w.postMessage({type,requestId:id,input},[...new Set([...input.power,...input.forecast].map(f=>f.bytes))]);
  });
}
test('real Worker produces full frozen Result, hashes and genuine monotonic phase counts',async()=>{
  const c=loadJson('manifest.json').cases.find(c=>c.id==='continuous-day-56mw');
  const {message,progress}=await run(fixtureInput(c));assert.equal(message.type,'result');assert.equal(message.requestId,'node-worker');
  validateResult(message.result);assert.equal(compareResults(loadExpected(c.expected),message.result).equal,true);
  assert.deepEqual([...new Set(progress.map(p=>p.phase))],['reading','validating','calculating','aggregating']);
  for(const phase of ['reading','validating','calculating','aggregating']) {
    const updates=progress.filter(p=>p.phase===phase);assert.equal(updates[0].completed,0);
    assert.equal(updates.at(-1).completed,updates.at(-1).total);
    assert.ok(updates.every((p,i)=>p.requestId==='node-worker'&&(!i||p.completed>=updates[i-1].completed)));
  }
  assert.equal(progress.find(p=>p.phase==='calculating').total,1440);
});
test('large real Worker result uses bounded parts and matches direct core field for field',async()=>{
  const expected=await analyzeFiles(syntheticInput(15));
  const {message,parts}=await run(syntheticInput(15));assert.ok(parts.length>1);
  assert.equal(compareResults(expected,message.result).equal,true);validateResult(message.result);
});
test('real Worker maps frozen errors and malformed requests into structured errors',async()=>{
  const c=loadJson('manifest.json').cases.find(c=>c.error);
  const {message}=await run(fixtureInput(c),'bad-file');assert.equal(message.type,'error');validateError(message.error);assert.equal(message.error.message,c.error.message);assert.equal(message.error.code,c.error.code);
  const malformed=await run(fixtureInput(c),'wrong-type','unknown');assert.equal(malformed.message.error.code,'INPUT');validateError(malformed.message.error);
});
