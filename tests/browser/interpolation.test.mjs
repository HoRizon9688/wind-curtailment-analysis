import test from 'node:test';
import assert from 'node:assert/strict';
import {parseTime} from '../../dashboard/src/content/calculation/time.mjs';
import {alignedForecast} from '../../dashboard/src/content/calculation/interpolation.mjs';
import {compareResults} from './compare.mjs';
import {loadJson} from './fixture-tools.mjs';
test('all frozen exact, bracketed, missing-node and endpoint samples match Python',()=>{
  for(const c of loadJson('normalized.json').filter(x=>!x.error)) {
    const f=new Map(c.forecasts.map(([t,v])=>[parseTime(t),v]));const targets=[...f.keys()].sort((a,b)=>a-b);
    const expected={rows:c.aligned.map(([timestamp,v])=>({timestamp,...v}))};
    const actual={rows:c.aligned.map(([timestamp])=>({timestamp,...alignedForecast(parseTime(timestamp),f,targets)}))};
    const review=compareResults(expected,actual);assert.equal(review.equal,true,JSON.stringify({id:c.id,first:review.first}));
  }
});
test('hand arithmetic: 80 to 95 produces 81 at minute one, cannot bridge missing node',()=>{
  const t=parseTime('2026-08-01T00:00:00+08:00');const f=new Map([[t,{value:80,version:'v0',source:'s0'}],[t+900000,{value:95,version:'v1',source:'s1'}]]);
  assert.equal(alignedForecast(t+60000,f,[...f.keys()]).f,81);
  const missing=new Map([[t,f.get(t)],[t+1800000,f.get(t+900000)]]);
  assert.deepEqual(alignedForecast(t+60000,missing,[...missing.keys()]),{f:null});
});
