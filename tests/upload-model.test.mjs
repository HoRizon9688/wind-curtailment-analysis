import test from 'node:test';
import assert from 'node:assert/strict';
import {totals,bands,csvText} from '../dashboard/src/content/dashboard/wind-model.mjs';

test('excluded minutes have neither energy totals nor loss shading',()=>{
  const row={included:false,a:10,p:-.2,g:8,f:8,gap:null,dispatch:null,prediction:null,other:null};
  assert.equal(totals([row]).matched,0);
  assert.equal(totals([row]).excluded,1);
  assert.equal(totals([row]).gap,0);
  assert.deepEqual(bands(row),[]);
});
test('CSV includes exclusion reason and source location',()=>{
  const csv=csvText([{timestamp:'2026-08-01',included:false,note:'分钟功率缺行',powerSource:'power.csv 第2行'}]);
  assert.ok(csv.includes('分钟功率缺行'));
  assert.ok(csv.includes('power.csv 第2行'));
});

test('threshold classification bands override the legacy G greater than F rule',()=>{
 const row={included:true,a:100,p:80,g:80,f:79.5,allocationBands:[{kind:'prediction',bottom:80,top:100}]};
 assert.deepEqual(bands(row),[{kind:'prediction',bottom:80,top:100}]);
});
