import test from 'node:test';
import assert from 'node:assert/strict';
import { totals, bands, filterRows, clock, stepPath } from '../dashboard/src/content/dashboard/wind-model.mjs';
// Synthetic fixtures keep tests independent of private uploaded snapshots.
const rows = Array.from({length:1440},(_,minute)=>({minute,time:clock(minute),a:100,p:50,g:60,f:minute<15?null:80,
 included:minute>=15,dispatch:minute<15?null:20/60,prediction:minute<15?null:20/60,other:minute<15?null:10/60,
 above:0,below:minute<15?null:10/60,gap:minute<15?null:50/60}));
test('valid totals close and excluded minutes contribute no energy',()=>{
 const s=totals(rows);
 assert.ok(Math.abs(s.dispatch-475)<1e-9);
 assert.ok(Math.abs(s.prediction-475)<1e-9);
 assert.ok(Math.abs(s.other-237.5)<1e-9);
 assert.equal(s.excluded,15);
 assert.ok(Math.abs(s.gap-s.dispatch-s.prediction-s.other)<1e-9);
 assert.equal(s.matched,1425);
});
test('every filled band area equals the precomputed minute energy',()=>{
 for(const r of rows){
  const b=bands(r);
  for(const k of ['dispatch','prediction','other']){
   const area=b.filter(x=>x.kind===k).reduce((s,x)=>s+(x.top-x.bottom)/60,0);
   assert.ok(Math.abs(area-(r[k]??0))<1e-9,`${r.time}: ${k}`);
  }
  assert.ok(b.every(x=>x.top>=x.bottom));
 }
});
test('missing interval has no attributed area',()=>{
 assert.deepEqual(bands(rows[0]),[]);
});
test('half open range filters exactly, without duplicating endpoint',()=>{
 const scoped=filterRows(rows,[510,840]);assert.equal(scoped.length,330);
 assert.equal(scoped[0].time,'08:30');assert.equal(scoped.at(-1).time,'13:59');
 const first=totals(filterRows(rows,[0,15]));assert.equal(first.matched,0);assert.equal(first.excluded,15);
});
test('missing line segments do not bridge null forecasts',()=>{
 const path=stepPath([{minute:0,f:null},{minute:1,f:3},{minute:2,f:null},{minute:3,f:4}],'f',x=>x,y=>y);
 assert.equal((path.match(/M/g)||[]).length,2);assert.equal(clock(1440),'24:00');
});
