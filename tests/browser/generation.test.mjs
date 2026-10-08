import test from 'node:test';
import assert from 'node:assert/strict';
import {generationTotals,dailyGeneration} from '../../dashboard/src/content/dashboard/generation-model.mjs';
import {exportAnalysis} from '../../dashboard/src/content/dashboard/analysis-exports.mjs';

test('actual positive energy is a minute integral independent of curtailment eligibility',()=>{
 const rows=[{p:60,included:true},{p:30,included:false,f:null},{p:0,included:false,g:null},{p:-.2,included:false},{p:null},{p:Infinity},{p:61}];
 const s=generationTotals(rows,60);
 assert.equal(s.generation,1.5);assert.equal(s.generationObserved,4);assert.equal(s.generationMissing,3);assert.equal(s.generationNegative,1);assert.equal(s.generationCoverage,4/7);
});
test('missing actual is not zero, but known zero or negative actual means zero generation',()=>{
 assert.equal(generationTotals([{p:null},{p:NaN}],56).generation,null);
 assert.equal(generationTotals([{p:0},{p:-.2}],56).generation,0);
 assert.equal(generationTotals([],56).generation,null);
});
test('daily grouping is additive, preserves order and loss fields, and range sums do not carry over',()=>{
 const days=[{date:'2026-01-02',dispatch:7},{date:'2026-01-01',dispatch:3},{date:'2026-01-03',dispatch:0}];
 const rows=[{date:'2026-01-01',p:12},{date:'2026-01-02',p:30},{date:'2026-01-01',p:18},{date:'2026-01-03',p:null}];
 const result=dailyGeneration(days,rows,56);
 assert.deepEqual(result.map(d=>d.generation),[.5,.5,null]);assert.deepEqual(result.map(d=>d.dispatch),[7,3,0]);
 assert.equal(generationTotals(rows,56).generation,1);assert.equal(generationTotals(rows.slice(0,1),56).generation,.2);
 assert.equal(Object.hasOwn(days[0],'generation'),false);
});
test('daily CSV includes the same actual energy and its independent coverage',()=>{
 const result={meta:{stationName:'合成测试',capacity:56,timezone:'UTC+08:00',start:'2026-01-01',end:'2026-01-01'},rows:[{date:'2026-01-01',p:30,included:false}],daily:[{date:'2026-01-01',dispatch:0,prediction:0,other:0,expected:1,included:0,excluded:1,coverage:0,dispatchShare:null}]};
 const csv=exportAnalysis(result,'daily').text;
 assert.ok(csv.includes('发电量_MWh'));assert.ok(csv.includes('实发数据覆盖率'));assert.ok(csv.includes('"0.5"'));
 assert.deepEqual(JSON.parse(exportAnalysis(result,'json').text),result);
});
