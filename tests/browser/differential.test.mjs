import test from 'node:test';
import assert from 'node:assert/strict';
import {ThresholdAllocator} from '../../dashboard/src/content/calculation/threshold-allocator.mjs';
import {analyzeFiles} from '../../dashboard/src/content/calculation/analyze.mjs';
import {parseTime,formatTime} from '../../dashboard/src/content/calculation/time.mjs';
import {numberOrNull} from '../../dashboard/src/content/calculation/scalar.mjs';
import {compareResults} from './compare.mjs';
import {oracle,oracleInput} from './python-oracle.mjs';
import {readFileSync} from 'node:fs';

test('random stateful sequences, resets and scale match ACTUAL Python, not the reconstructed reference',async()=>{
  let seed=412;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/2**32;};
  for(const [capacity,scale] of [[56,1],[100,.5],[1500,2],[1e12,1]]) {
    const rows=Array.from({length:1200},(_,i)=>i%173===0?{reset:true}:{a:random()*capacity,f:random()*capacity,g:random()*capacity,p:random()*capacity});
    const expected=await oracle({mode:'allocator',capacity,scale,rows});const model=new ThresholdAllocator(capacity,scale);
    const actual={rows:rows.map(r=>{if(r.reset){model.reset();return {reset:true};}return model.calculate(r.a,r.f,r.g,r.p);})};
    const review=compareResults(expected,actual);assert.equal(review.equal,true,JSON.stringify({capacity,first:review.first}));
  }
});

test('adversarial times and scalar strings match actual Python parsing',async()=>{
  const times=['2026-W31-6T00:15','2026W316T0015','2026-W316','2026W31-6','2026-W31','2026W31','20260801T001500','2026-08-01T00:15:00,000000','2026-08-01T00:15:00.0000001','2026-08-01T00:15:30+08:00:30','2026-08-01T00:15:00.001','2026-08-01T00:15+24:00','2026-W53-1','2026/8/1 0:15','2026-8-1 0:15','2026-08-01 0:15:00',' 2026-08-01T00:15:30 ','2026/8-1 0:15','2026-04-31',null,true];
  const numbers=['\x1c1','\ufeff1','\u00851','1_0.0_5','1e+1_0','0x10','１２','١٢','𝟙𝟚','²','1__0'];
  const expected=await oracle({mode:'scalars',times,numbers});
  for(const c of expected.times)if(c.error)assert.throws(()=>parseTime(c.input),e=>e.message===c.error);else assert.equal(formatTime(parseTime(c.input)),c.expected);
  for(const c of expected.numbers)assert.equal(numberOrNull(c.input),c.expected,JSON.stringify(c.input));
});

function randomDay(capacity) {
  const power=['时间,可用功率,全站总有功_集电线有功之和,AGC有功设定值,理论功率'];
  const forecast=['预测id,名称,预测时间,考核点2预测结果'];let seed=20261004;
  const random=()=>{seed=(Math.imul(seed,1103515245)+12345)>>>0;return seed/2**32;};
  const begin=parseTime('2026-08-01');
  for(let i=0;i<1440*3;i++) {
    if(i%617===0)continue;
    const a=capacity*random(),g=capacity*random(),p=i%757===0?-.1:capacity*random();
    power.push(`${formatTime(begin+i*60000)},${i%811===0?'':a},${p},${g},${a}`);
  }
  for(let i=0;i<=288;i++) {
    if(i===129)continue;
    forecast.push(`SYNTHETIC-3DAY,合成三日,${formatTime(begin+(i-1)*900000)},${i===175?capacity+1:capacity*random()}`);
  }
  const file=(name,text)=>({name,bytes:new TextEncoder().encode(text.join('\n')+'\n').buffer});
  return {power:[file('random-power.csv',power)],forecast:[file('random-forecast.csv',forecast)],options:{capacity,stationName:'',start:null,end:null}};
}
test('three-day random upload for different capacities matches every Python result field',async()=>{
  for(const capacity of [5,56,1500]) {
    const input=randomDay(capacity);const expected=await oracle({mode:'analyze',input:oracleInput(input)});
    const actual=await analyzeFiles(input);const review=compareResults(expected,actual);
    assert.equal(review.equal,true,JSON.stringify({capacity,first:review.first}));
  }
});
test('reused handoff: all 20 scenarios and complete synthetic day match actual repository Python',async()=>{
  const root=new URL('../fixtures/browser/reused-handoff/',import.meta.url);
  const scenarios=JSON.parse(readFileSync(new URL('scenarios.json',root)));
  const rows=scenarios.map(([,a,f,g,p,excluded])=>excluded?{reset:true}:{a,f,g,p});
  const model=new ThresholdAllocator(56);
  const actual={rows:rows.map(r=>{if(r.reset){model.reset();return {reset:true};}return model.calculate(r.a,r.f,r.g,r.p);})};
  const expected=await oracle({mode:'allocator',capacity:56,rows});
  assert.equal(compareResults(expected,actual).equal,true);
  const file=(name)=>{const b=readFileSync(new URL(name,root));return {name,bytes:b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength)};};
  const input={power:[file('fixtures_power.csv')],forecast:[file('fixtures_forecast.csv')],options:{capacity:56,stationName:'测试风场',start:'2026-08-01',end:'2026-08-01'}};
  const original=await oracle({mode:'analyze',input:oracleInput(input)});
  const migrated=await analyzeFiles(input);assert.equal(original.gaps.length,4);assert.equal(migrated.gaps.length,4);
  const comparison=compareResults(original,migrated);assert.equal(comparison.equal,true,JSON.stringify(comparison.first));
});
