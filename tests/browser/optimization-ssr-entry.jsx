/** DOM-free component smoke check. NOT browser layout/interaction acceptance. */
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import assert from 'node:assert/strict';
import {analyzeOptimization} from '../../dashboard/src/content/dashboard/optimization-model.mjs';
import {OptimizationPanel} from '../../dashboard/src/content/dashboard/OptimizationPanel.jsx';
import {PowerChart} from '../../dashboard/src/content/dashboard/DashboardContent.jsx';
import {ThresholdAllocator} from '../../dashboard/src/content/calculation/threshold-allocator.mjs';
import {parseTime,formatTime,MINUTE_MS} from '../../dashboard/src/content/calculation/time.mjs';

const start=parseTime('2026-10-13'),rows=[],alloc=new ThresholdAllocator(100);
const f=q=>25+q*.007,r=q=>q>=120&&q<180?.3:q===180?.15:0,g=q=>f(q)*(1-r(q));
for(let m=0;m<300;m++){
 const q=Math.floor(m/15)*15,w=(m-q)/15,F=f(q)*(1-w)+f(q+15)*w,G=g(q)*(1-w)+g(q+15)*w;
 const P=[75,90].includes(m)?G*.8:G-.1,timestamp=formatTime(start+m*MINUTE_MS),a=90+m*.0001;
 rows.push({timestamp,date:timestamp.slice(0,10),time:timestamp.slice(11,16),minute:m,a,theory:a+.1,f:F,g:G,p:P,included:true,...alloc.calculate(a,F,G,P)});
}
const model=analyzeOptimization(rows,100,{enabled:true,cycle:'point',nodeLagMinutes:0});
const props={model,rows:model.rows,scoped:model.rows,range:[0,300],selected:130,onSelect:()=>{},onRange:()=>{},Chart:PowerChart,config:model.config,onConfig:()=>{},meta:{capacity:100,stationName:'合成组件核验'},date:'2026-10-13',dates:['2026-10-13'],onDate:()=>{},unit:'MWh'};
const markup=renderToStaticMarkup(<OptimizationPanel {...props}/>);
assert.ok(markup.includes('发电能力优化场景分析'));
assert.ok(markup.includes('场景 5 / 6 候选'));
assert.ok(markup.includes('data-testid="optimization-estimate"'));
assert.ok(markup.includes('data-testid="optimization-chart"'));
assert.ok(/data-area="optimization"><path d="M[^\"]+"/.test(markup));
assert.ok(/data-curve="oEstimate" d="M[^\"]+"/.test(markup));
assert.ok(!markup.includes('NaN')&&!markup.includes('Infinity'));
const pathIds=[...markup.matchAll(/<clipPath id="([^\"]+)"/g)].map(m=>m[1]);assert.equal(pathIds.length,1);
const original=renderToStaticMarkup(<PowerChart rows={rows} range={[0,300]} selected={130} onSelect={()=>{}} onRange={()=>{}} visible={{a:true,p:true,g:true,f:true}} shades={{dispatch:true,prediction:true,other:true}} capacity={0}/>);
assert.ok(original.includes('data-area="dispatch"'));assert.ok(!original.includes('data-area="optimization"'));
const both=renderToStaticMarkup(<><PowerChart rows={rows} range={[0,300]} selected={130} onSelect={()=>{}} onRange={()=>{}} visible={{a:true}} shades={{dispatch:true}} capacity={0}/><OptimizationPanel {...props}/></>);
const bothIds=[...both.matchAll(/<clipPath id="([^\"]+)"/g)].map(m=>m[1]);assert.equal(new Set(bothIds).size,2);
const missing=renderToStaticMarkup(<OptimizationPanel {...props} scoped={model.rows.map(r=>({...r,included:false,dispatch:null}))}/>);
assert.ok(missing.includes('当前范围没有有效的原分类分钟'));
assert.ok(/data-testid="optimization-estimate">—/.test(missing));
console.log(JSON.stringify({passed:true,method:'React server rendering; no browser or URL access; not visual acceptance',candidateEvents:model.summary.matchedEvents,optimizationMWh:model.summary.optimization}));
