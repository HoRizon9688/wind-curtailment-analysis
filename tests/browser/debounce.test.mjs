import test from 'node:test';
import assert from 'node:assert/strict';
import {ThresholdAllocator} from '../../dashboard/src/content/calculation/threshold-allocator.mjs';
import {analyzeFiles} from '../../dashboard/src/content/calculation/analyze.mjs';
const calculate=gaps=>{const m=new ThresholdAllocator(100);return gaps.map(gap=>m.calculate(100,80,80-gap,60));};
test('three-minute entry and exit confirmation is causal; pending entry is other',()=>{
  const rows=calculate([20,20,20,.5,.5,.5]);
  assert.deepEqual(rows.map(r=>r.dispatchState),[false,false,true,true,true,false]);
  for(const r of rows.slice(0,2)){
    assert.equal(r.dispatch,0);assert.equal(r.prediction,0);
    assert.equal(r.unexplainedAbove*60,40);assert.match(r.note,/进入待确认/);
    assert.doesNotMatch(r.note,/明显高于预测/);
  }
  assert.equal(rows[2].dispatch*60,20);assert.equal(rows[2].prediction*60,20);
  assert.match(rows[3].note,/退出待确认/);
});
test('interruption, equality and explicit reset clear the confirmation streak',()=>{
  assert.deepEqual(calculate([2,2,1,2,2,2,.5,.5,.7,.5,.5,.5]).map(r=>r.dispatchState),
    [false,false,false,false,false,true,true,true,true,true,true,false]);
  assert.ok(calculate([1,1,1,2,2,0]).every(r=>!r.dispatchState));
  const m=new ThresholdAllocator(100);m.calculate(100,80,60,60);m.calculate(100,80,60,60);m.reset();
  assert.equal(m.calculate(100,80,60,60).dispatchState,false);
});
test('pending exit cannot attribute clearly elevated AGC to prediction',()=>{
  const m=new ThresholdAllocator(100);for(let i=0;i<3;i++)m.calculate(100,80,60,60);
  const r=m.calculate(100,80,95,75);assert.equal(r.dispatchState,true);
  assert.equal(r.dispatch,0);assert.equal(r.prediction,0);
  assert.equal(r.unexplainedAbove*60,5);assert.match(r.note,/原因待核实/);
});
test('upload confirmation continues across midnight and resets on missing or negative minutes',async()=>{
  const file=(name,lines)=>({name,bytes:new TextEncoder().encode(lines.join('\n')).buffer});
  const fh=['预测id,名称,预测时间,考核点2预测结果'];
  const ph=['时间,可用功率,全站总有功_集电线有功之和,AGC有功设定值'];
  const forecast=[file('forecast.csv',[...fh,'S,合成,2026-08-01 23:30,80','S,合成,2026-08-01 23:45,80','S,合成,2026-08-02 00:00,80'])];
  const p=[...ph,'2026-08-01 23:58,100,60,60','2026-08-01 23:59,100,60,60','2026-08-02 00:00,100,60,60'];
  const options={capacity:100,stationName:'',start:'2026-08-01',end:'2026-08-02'};
  const cross=await analyzeFiles({power:[file('power.csv',p)],forecast,options});
  assert.deepEqual(cross.rows.slice(1438,1441).map(r=>r.dispatchState),[false,false,true]);
  for(const negative of [false,true]){
    const lines=[...p,...(negative?['2026-08-02 00:01,100,-.1,60']:[]),
      '2026-08-02 00:02,100,60,60','2026-08-02 00:03,100,60,60','2026-08-02 00:04,100,60,60'];
    const r=await analyzeFiles({power:[file('power.csv',lines)],forecast,options});
    assert.equal(r.rows[1441].included,false);
    assert.deepEqual(r.rows.slice(1442,1445).map(r=>r.dispatchState),[false,false,true]);
  }
});
