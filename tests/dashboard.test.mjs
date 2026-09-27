import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { totals, bands, filterRows, clock, stepPath } from '../dashboard/src/content/dashboard/wind-model.mjs';
const rows = JSON.parse(fs.readFileSync(new URL('../dashboard/src/data.json',import.meta.url),'utf8')).queries.wind_minutes.rows;
test('reviewed full-day totals are preserved, missing forecast remains separate',()=>{
 const s=totals(rows);
 assert.ok(Math.abs(s.dispatch-70.330955)<1e-9);
 assert.ok(Math.abs(s.prediction-19.157055)<1e-9);
 assert.ok(Math.abs(s.other-28.323701666666697)<1e-9);
 assert.ok(Math.abs(s.missing-1.431761666666667)<1e-9);
 assert.equal(s.matched,1425);
});
test('every interpolated minute matches its recorded source endpoints',()=>{
 for(const r of rows.filter(r=>r.f!==null)){
  const t=Date.parse(r.timestamp),a=Date.parse(r.target),b=Date.parse(r.rightTarget);
  assert.ok(t>=a&&t<=b);
  assert.ok(a===b||b-a===900000);
  assert.ok(Math.abs(r.f-(r.leftF+(r.rightF-r.leftF)*r.weight))<1e-10);
 }
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
test('missing interval is hatched rather than attributed',()=>{
 const b=bands(rows[0]);assert.equal(b.length,1);assert.equal(b[0].kind,'missing');
});
test('half open range filters exactly, without duplicating endpoint',()=>{
 const scoped=filterRows(rows,[510,840]);assert.equal(scoped.length,330);
 assert.equal(scoped[0].time,'08:30');assert.equal(scoped.at(-1).time,'13:59');
 const first=totals(filterRows(rows,[0,15]));assert.equal(first.matched,0);assert.ok(first.missing>0);
});
test('missing line segments do not bridge null forecasts',()=>{
 const path=stepPath([{minute:0,f:null},{minute:1,f:3},{minute:2,f:null},{minute:3,f:4}],'f',x=>x,y=>y);
 assert.equal((path.match(/M/g)||[]).length,2);assert.equal(clock(1440),'24:00');
});
