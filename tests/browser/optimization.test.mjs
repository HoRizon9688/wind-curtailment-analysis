import test from 'node:test';
import assert from 'node:assert/strict';
import {ThresholdAllocator} from '../../dashboard/src/content/calculation/threshold-allocator.mjs';
import {parseTime,formatTime,MINUTE_MS} from '../../dashboard/src/content/calculation/time.mjs';

const subject=await import('../../dashboard/src/content/dashboard/optimization-model.mjs').catch(()=>({}));
const base=parseTime('2026-10-13T00:00:00+08:00');
const opts={enabled:true,cycle:'point',delayMinutes:30,nodeLagMinutes:0};
function sample({events=[{start:120,alpha:4,beta:1.5,e:.2,gamma:2}],minutes=720,dateShift=0}={}){
 const F=q=>25+q*.007;
 function node(q){let r=0;for(const e of events){const i=(q-e.start)/15;if(i>=0&&i<e.alpha)r=e.beta*e.e;else if(i===e.alpha&&e.gamma===2)r=e.beta*e.e/2;}return F(q)*(1-r);}
 const allocator=new ThresholdAllocator(100),rows=[];
 for(let m=0;m<minutes;m++){
  const q=Math.floor(m/15)*15,w=(m-q)/15,f=F(q)*(1-w)+F(q+15)*w,g=node(q)*(1-w)+node(q+15)*w;
  let p=g-.1;for(const e of events)if([e.start-45,e.start-30].includes(m))p=g*(1-e.e);
  const timestamp=formatTime(base+(m+dateShift)*MINUTE_MS),a=90+m*.00001;
  rows.push({timestamp,date:timestamp.slice(0,10),time:timestamp.slice(11,16),minute:m%1440,a,theory:a+.1,f,g,p,included:true,...allocator.calculate(a,f,g,p)});
 }return rows;
}
const sum=(rows,key)=>rows.reduce((n,r)=>n+(r[key]??0),0);
test('exports a non-mutating event-based analyzer',()=>assert.equal(typeof subject.analyzeOptimization,'function'));
test('one event can match scenes 5/6 without counting its energy twice',()=>{
 const rows=sample(),before=JSON.stringify(rows),r=subject.analyzeOptimization(rows,100,opts);
 assert.equal(JSON.stringify(rows),before);
 const e=r.events.find(e=>e.status==='matched');assert.ok(e);assert.deepEqual(e.scenarios,[5,6]);
 assert.ok(r.summary.optimization>0);assert.ok(r.summary.optimization<=r.summary.originalDispatch);
 for(const z of r.rows){assert.ok(z.optimization>=0);assert.ok(Math.abs(z.optimization+z.dispatchRemaining-(z.dispatch??0))<1e-9);}
 assert.ok(Math.abs(sum(r.rows,'optimization')-r.summary.optimization)<1e-9);
 assert.ok(r.rows.find(z=>z.minute===110).optimization>0,'include the interpolated entry ramp');
});
test('different modes can occur in the same day',()=>{
 const rows=sample({events:[{start:120,alpha:3,beta:1,e:.2,gamma:2},{start:420,alpha:4,beta:1.3,e:.2,gamma:1}]});
 const r=subject.analyzeOptimization(rows,100,opts),events=r.events.filter(e=>e.status==='matched');
 assert.equal(events.length,2);assert.deepEqual(events.map(e=>e.scenarios),[[1],[4]]);
});
test('a proportional plateau without preceding trigger remains unresolved',()=>{
 const rows=sample();for(const m of [75,90])rows[m].p=rows[m].g-.1;
 const r=subject.analyzeOptimization(rows,100,opts);
 assert.ok(r.events.some(e=>e.status==='unresolved'));assert.equal(r.summary.optimization,0);
});
test('lower actual power cannot be charged again as optimization loss',()=>{
 const rows=sample();for(const z of rows)if(z.minute>=120&&z.minute<165)z.p=0;
 // Recovery has a valid two-cycle pair only after low-output segment; this
 // invalidates recovery timing in the event and must not force a scene.
 const r=subject.analyzeOptimization(rows,100,opts);
 assert.equal(r.summary.optimization,0);assert.ok(r.events.some(e=>e.reasons.some(x=>x.includes('恢复'))));
});
test('missing minute inside a candidate breaks the event, never bridges it',()=>{
 const rows=sample();rows[142]={...rows[142],included:false,p:null,g:null,a:null};
 const r=subject.analyzeOptimization(rows,100,opts);assert.equal(r.summary.optimization,0);
});
test('four-channel frozen runs are screened only for inference',()=>{
 const rows=sample();for(let m=120;m<180;m++)Object.assign(rows[m],{a:40,theory:41,p:12,g:13});
 const r=subject.analyzeOptimization(rows,100,opts);assert.equal(r.summary.optimization,0);assert.ok(r.diagnostics.frozenMinutes>=60);
 assert.equal(r.summary.originalDispatch,sum(rows,'dispatch'));
});
test('no inference outside trial period, while original classification survives',()=>{
 const rows=sample({dateShift:-70*1440}),r=subject.analyzeOptimization(rows,100,opts);
 assert.equal(r.events.length,0);assert.equal(r.summary.optimization,0);assert.equal(r.summary.originalDispatch,sum(rows,'dispatch'));
});
test('disabled inference keeps the source classification and emits no candidate',()=>{
 const rows=sample(),r=subject.analyzeOptimization(rows,100,{...opts,enabled:false});
 assert.equal(r.events.length,0);assert.equal(r.summary.optimization,0);assert.equal(r.summary.dispatchRemaining,sum(rows,'dispatch'));
});
test('AGC floor alone is not evidence of optimization',()=>{
 const rows=sample();for(const z of rows)Object.assign(z,{f:1,g:2,p:1.9});
 assert.equal(subject.analyzeOptimization(rows,100,opts).events.length,0);
});
test('cross-midnight event is matched once using prior day trigger',()=>{
 const rows=sample({events:[{start:1440,alpha:4,beta:1.5,e:.2,gamma:2}],minutes:1680});
 const r=subject.analyzeOptimization(rows,100,opts);assert.equal(r.events.filter(e=>e.status==='matched').length,1);
 assert.ok(r.rows.filter(z=>z.date==='2026-10-13').some(z=>z.optimization>0));
 assert.ok(r.rows.filter(z=>z.date==='2026-10-14').some(z=>z.optimization>0));
});
test('invalid settings are rejected instead of silently changing the fit',()=>{
 assert.throws(()=>subject.analyzeOptimization(sample(),100,{...opts,delayMinutes:-1}),/参数|间隔/);
});
test('model entry begins at raw forecast, not an already-existing dispatch cap',()=>{
 const rows=sample();for(const m of [103,104,105]){rows[m].g*=.8;rows[m].p=rows[m].g-.1;}
 const allocator=new ThresholdAllocator(100);for(const z of rows)Object.assign(z,allocator.calculate(z.a,z.f,z.g,z.p));
 const r=subject.analyzeOptimization(rows,100,opts),entry=r.rows[105];
 assert.ok(entry.dispatch>0);assert.equal(entry.optimization,0);
});
test('already delivered power and unavailable headroom do not inflate the new category',()=>{
 const rows=sample();for(const z of rows)if(z.minute>=120&&z.minute<165){z.p=z.f+.1;z.a=z.g;}
 const allocator=new ThresholdAllocator(100);for(const z of rows)Object.assign(z,allocator.calculate(z.a,z.f,z.g,z.p));
 const r=subject.analyzeOptimization(rows,100,opts);
 assert.ok(r.rows.filter(z=>z.minute>=120&&z.minute<165).every(z=>z.optimization===0));
});
test('all seven rule sets are tested per event, including the 15% trigger distinction',()=>{
 for(const s of subject.OPTIMIZATION_SCENARIOS){
  const rows=sample({events:[{start:120,alpha:s.alpha,beta:s.beta,e:s.id===5?.12:.2,gamma:s.gamma}]});
  const r=subject.analyzeOptimization(rows,100,opts);
  assert.ok(r.events.some(e=>e.status==='matched'&&e.scenarios.includes(s.id)),`scene ${s.id}`);
  if(s.id===5)assert.ok(!r.events.some(e=>e.scenarios.includes(6)),'10% eligible does not imply 15% eligible');
 }
});
test('multiple plausible coefficients expose a model interval and allocate its lower bound',()=>{
 const r=subject.analyzeOptimization(sample({events:[{start:120,alpha:3,beta:1.1,e:.11,gamma:2}]}),100,opts);
 const e=r.events.find(e=>e.status==='matched');assert.ok(e);assert.deepEqual(e.scenarios,[1,2]);
 assert.ok(r.summary.optimization>0);assert.ok(r.summary.optimizationUpper>r.summary.optimization);
 assert.ok(r.rows.every(z=>z.optimization<=z.optimizationUpper&&z.optimizationUpper<=(z.dispatch??0)+1e-10));
});
test('ambiguous recovery lengths retain every compatible model before taking the lower bound',()=>{
 const rows=sample(),allocator=new ThresholdAllocator(100);
 const node=q=>q>=120&&q<180?27:q===180?28.53:30;
 for(const z of rows){const m=z.minute,q=Math.floor(m/15)*15,w=(m-q)/15;z.f=30;z.g=node(q)*(1-w)+node(q+15)*w;z.p=[75,90].includes(m)?26.7:z.g-.1;Object.assign(z,allocator.calculate(z.a,z.f,z.g,z.p));}
 const r=subject.analyzeOptimization(rows,100,{...opts,fitTolerance:.05});
 assert.ok(r.events.some(e=>e.scenarios.includes(3)&&e.scenarios.includes(4)));
 const z=r.rows[180];assert.ok(z.optimizationUpper>0);assert.equal(z.optimization,0,'a compatible gamma=1 model has already fully recovered');
 assert.equal(z.dispatchRemaining,z.dispatch);
});
