/** Conditional event inference, kept separate from the verified allocator.
 * J=G is a user-confirmed premise. O=G is NEVER an unconditional input.
 * Energy is a conservative subdivision of existing dispatch, not a new loss.
 */
import {parseTime,formatTime,MINUTE_MS as M,QUARTER_MS as Q} from '../calculation/time.mjs';
export const OPTIMIZATION_SCENARIOS=Object.freeze([
 {id:1,h:.10,alpha:3,beta:1,gamma:2},{id:2,h:.10,alpha:3,beta:1.2,gamma:2},
 {id:3,h:.10,alpha:4,beta:1,gamma:2},{id:4,h:.10,alpha:4,beta:1.3,gamma:1},
 {id:5,h:.10,alpha:4,beta:1.5,gamma:2},{id:6,h:.15,alpha:4,beta:1.5,gamma:2},
 {id:7,h:.15,alpha:5,beta:1.5,gamma:2},
]);
export const OPTIMIZATION_DEFAULTS=Object.freeze({enabled:false,cycle:'mean',delayMinutes:30,nodeLagMinutes:1,
 fitTolerance:.02,recoveryToleranceRatio:.01,start:'2026-10-10',end:'2026-12-10'});
const finite=x=>typeof x==='number'&&Number.isFinite(x);
const median=xs=>{const a=[...xs].sort((a,b)=>a-b);return (a[Math.floor((a.length-1)/2)]+a[Math.ceil((a.length-1)/2)])/2;};
const mean=xs=>xs.reduce((a,b)=>a+b,0)/xs.length;
const positive=x=>Math.max(0,x);
const stamp=t=>formatTime(t);
const zeroRow=r=>({...r,optimization:0,optimizationUpper:0,dispatchRemaining:r.dispatch??0,
 optimizationEvent:null,optimizationStatus:null,optimizationScenarios:'',oEstimate:null,
 optimizationBands:r.included!==false&&r.dispatch>0?[{kind:'dispatchRemaining',bottom:Math.max(r.g,r.p),top:Math.min(r.a,r.f)}]:[]});
function settings(options,capacity){
 const s={...OPTIMIZATION_DEFAULTS,...options};
 if(!(finite(capacity)&&capacity>0)||!['mean','point'].includes(s.cycle)||![15,30,45].includes(s.delayMinutes)||![0,1,2].includes(s.nodeLagMinutes)||
  !(s.fitTolerance>=.005&&s.fitTolerance<=.05)||!(s.recoveryToleranceRatio>=0&&s.recoveryToleranceRatio<=.05)||
  !/^\d{4}-\d{2}-\d{2}$/.test(s.start)||!/^\d{4}-\d{2}-\d{2}$/.test(s.end)||s.start>s.end)throw new RangeError('优化识别参数、日期或生效间隔无效');
 return s;
}
function frozenRuns(rows,times){
 const frozen=new Set(),intervals=[];let i=0;
 while(i<rows.length){let j=i+1;const keys=['a','theory','p','g'];
  while(j<rows.length&&times[j]===times[j-1]+M&&keys.every(k=>finite(rows[i][k])&&rows[j][k]===rows[i][k]))j++;
  if(j-i>=30){for(let k=i;k<j;k++)frozen.add(times[k]);intervals.push({start:stamp(times[i]),end:stamp(times[j-1]+M),minutes:j-i});}i=j;
 }return {frozen,intervals};
}
function modelFactors(alpha,gamma,r){return [...Array(alpha).fill(r),...(gamma===2?[r/2,0]:[0])];}
function summarize(rows,events){
 const s={originalDispatch:0,optimization:0,optimizationUpper:0,dispatchRemaining:0,matchedEvents:0,unresolvedEvents:0};
 for(const r of rows){s.originalDispatch+=r.dispatch??0;s.optimization+=r.optimization;s.optimizationUpper+=r.optimizationUpper;s.dispatchRemaining+=r.dispatchRemaining;}
 for(const e of events)s[e.status==='matched'?'matchedEvents':'unresolvedEvents']++;
 return s;
}
export function optimizationTotals(rows){return summarize(rows,[]);}

export function analyzeOptimization(input,capacity,options={}){
 const config=settings(options,capacity),rows=input.map(zeroRow),times=input.map(r=>parseTime(r.timestamp));
 for(let i=1;i<times.length;i++)if(times[i]<=times[i-1])throw new RangeError('优化识别需要按时间递增且不重复的分钟数据');
 const empty={rows,events:[],summary:summarize(rows,[]),config,diagnostics:{frozenMinutes:0,frozenIntervals:[],screenedMinutes:0}};
 if(!config.enabled||!rows.length)return empty;
 const {frozen,intervals}=frozenRuns(rows,times),lookup=new Map(times.map((t,i)=>[t,rows[i]]));
 const inWindow=r=>r.date>=config.start&&r.date<=config.end;
 const usable=(r,t)=>Boolean(r&&inWindow(r)&&r.included!==false&&!frozen.has(t)&&['a','f','g','p'].every(k=>finite(r[k])&&r[k]>=0&&r[k]<=capacity));
 function cycle(t){
  const ts=config.cycle==='point'?[t]:Array.from({length:15},(_,i)=>t-(15-i)*M);
  const zs=ts.map(t=>lookup.get(t));if(zs.some((r,i)=>!usable(r,ts[i])))return null;
  const g=mean(zs.map(r=>r.g)),p=mean(zs.map(r=>r.p));
  return {time:stamp(t),g,p,deficit:g>0?(g-p)/g:null};
 }
 const nodes=new Map();
 for(let i=0;i<rows.length;i++){
  const t=times[i],r=rows[i];if(r.minute%15||!usable(r,t)||r.f<=capacity*.02)continue;
  const z=lookup.get(t+config.nodeLagMinutes*M);
  if(!usable(z,t+config.nodeLagMinutes*M)||z.g<=capacity*.02)continue;
  nodes.set(t,{t,f:r.f,g:z.g,reduction:1-z.g/r.f});
 }
 const candidates=[];
 for(const [t] of nodes){
  for(const alpha of [3,4,5,6,7,8,9,10,11,12])for(const gamma of [1,2]){
   const n=alpha+gamma,ns=Array.from({length:n},(_,i)=>nodes.get(t+i*Q));if(ns.some(z=>!z))continue;
   const r=median(ns.slice(0,alpha).map(z=>z.reduction));if(r<.05)continue;
   const prev=nodes.get(t-Q);if(prev&&Math.abs(prev.reduction-r)<=config.fitTolerance)continue;
   const expected=modelFactors(alpha,gamma,r),shapeError=Math.max(...ns.map((z,i)=>Math.abs(z.reduction-expected[i])));
   if(shapeError>config.fitTolerance)continue;
   const start=t-Q,end=t+(n-1)*Q;
   // Check every source minute, not just quarter nodes. Holes and freezing
   // must not be bridged by a visually smooth model.
   let continuous=true;for(let m=start;m<end;m+=M)if(!usable(lookup.get(m),m)){continuous=false;break;}
   if(!continuous)continue;
   const pair=[cycle(t-(config.delayMinutes+15)*M),cycle(t-config.delayMinutes*M)],fits=[],reasons=[];
   if(pair.some(p=>!p))reasons.push('前两个触发周期数据不足');
   else if(pair.some(p=>p.g<=capacity*.10||p.deficit<=.10))reasons.push('前两个周期未同时满足10%触发筛选');
   const recovery=[];
   for(let i=0;i<alpha-1;i++){
    const last=t+(i+1)*Q;
    if(last>t+alpha*Q-config.delayMinutes*M)continue;
    const p=cycle(last-Q),q=cycle(last);
    if(p&&q&&[p,q].every(z=>Math.abs(z.g-z.p)<=capacity*config.recoveryToleranceRatio))recovery.push([p.time,q.time]);
   }
   if(!recovery.length)reasons.push('恢复前未找到连续两周期执行到位（当前容差）');
   for(const s of OPTIMIZATION_SCENARIOS.filter(s=>s.alpha===alpha&&s.gamma===gamma)){
    if(pair.some(p=>!p||p.g<=capacity*.10||p.deficit<=s.h)||!recovery.length)continue;
    const reduction=s.beta*mean(pair.map(p=>p.deficit));if(!(reduction>=0&&reduction<=1))continue;
    const factors=modelFactors(alpha,gamma,reduction);
    const residuals=ns.map((z,i)=>Math.max(capacity*.02,z.f*(1-factors[i]))-z.g);
    const maxError=Math.max(...residuals.map((e,i)=>Math.abs(e)/ns[i].f));
    if(maxError<=config.fitTolerance)fits.push({...s,reduction,maxError,rmseMW:Math.sqrt(mean(residuals.map(e=>e*e)))});
   }
   if(alpha>5)reasons.push('长平台可能连续触发，无法唯一确定α');
   if(!fits.length&&!reasons.length)reasons.push('压减幅度与七组参数不吻合');
   candidates.push({target:t,start,end,alpha,gamma,reduction:r,shapeError,nodes:ns,pair,fits,recovery,reasons});
  }
 }
 // Group competing shapes before allocation, retaining ALL compatible alpha /
 // gamma models. Choosing only the best-looking shape would inflate the lower
 // bound when another allowed recovery model has already returned to raw F.
 candidates.sort((a,b)=>a.start-b.start||a.shapeError-b.shapeError);
 const groups=[];
 for(const c of candidates){
  const previous=groups.at(-1);
  if(previous&&c.start<previous.end){previous.members.push(c);previous.end=Math.max(previous.end,c.end);}
  else groups.push({start:c.start,end:c.end,members:[c]});
 }
 const alternatives=(values)=>{const unique=[...new Set(values)].sort((a,b)=>a-b);return unique.length===1?unique[0]:unique.join('/');};
 const events=groups.map((group,i)=>{
  group.hypotheses=group.members.flatMap(c=>c.fits.map(fit=>({candidate:c,fit})));
  const ranked=[...group.members].sort((a,b)=>Number(Boolean(b.fits.length))-Number(Boolean(a.fits.length))||a.shapeError-b.shapeError);
  const c=ranked[0],matched=Boolean(group.hypotheses.length),models=group.hypotheses.map(({candidate,fit})=>({...fit,firstTarget:stamp(candidate.target),end:stamp(candidate.end)}));
  return {id:`optimization-${i+1}`,start:stamp(group.start),end:stamp(group.end),firstTarget:stamp(c.target),
   alpha:matched?alternatives(models.map(m=>m.alpha)):c.alpha,gamma:matched?alternatives(models.map(m=>m.gamma)):c.gamma,
   reduction:c.reduction,shapeError:c.shapeError,status:matched?'matched':'unresolved',
   scenarios:[...new Set(models.map(s=>s.id))].sort((a,b)=>a-b),models,
   triggerCycles:c.pair,recoveryPairs:c.recovery,reasons:matched?[]:[...new Set(group.members.flatMap(m=>m.reasons))],
   optimization:0,optimizationUpper:0,originalDispatch:0,previousReduction:nodes.get(c.target-Q)?.reduction??null};
 });
 function optimizedAt(c,fit,t){
  // Outside this particular hypothesis's active interval it is fully restored.
  // Other hypotheses in the grouped event may have a longer recovery interval.
  if(t<c.start||t>=c.end)return lookup.get(t)?.f??null;
  const qs=[c.target-Q,...c.nodes.map(z=>z.t)];
  const previous=nodes.get(c.target-Q),previousCap=previous?.f??null;
  if(previousCap===null)return null;
  const fs=[previousCap,...c.nodes.map((z,i)=>z.f*(1-modelFactors(c.alpha,c.gamma,fit.reduction)[i]))];
  const j=Math.max(0,Math.min(qs.length-2,Math.floor((t-qs[0])/Q))),w=(t-qs[j])/Q;
  return fs[j]*(1-w)+fs[j+1]*w;
 }
 const byEvent=new Map(events.map((e,i)=>[e.id,groups[i]]));
 let cursor=0;
 for(let i=0;i<rows.length;i++){
  const z=rows[i],t=times[i];while(cursor<events.length&&t>=parseTime(events[cursor].end))cursor++;
  const e=events[cursor];if(!e||t<parseTime(e.start))continue;
  const group=byEvent.get(e.id);z.optimizationEvent=e.id;z.optimizationStatus=e.status;z.optimizationScenarios=e.scenarios.join('/');
  z.optimizationBands=[];
  const top=Math.min(z.a,z.f),bottom=Math.max(z.g,z.p),original=positive(z.dispatch??0);
  if(e.status==='matched'){
   const estimates=group.hypotheses.map(({candidate,fit})=>optimizedAt(candidate,fit,t));
   if(estimates.every(finite)){
    const values=estimates.map(o=>Math.min(original,positive(top-Math.max(o,z.g,z.p))/60));
    z.optimization=Math.min(...values);z.optimizationUpper=Math.max(...values);
    z.oEstimate=Math.max(0,Math.min(z.f,Math.max(...estimates)));
   }
  }
  z.dispatchRemaining=positive(original-z.optimization);
  if(original>0){
   const splitTop=top-z.optimization*60;
   if(z.optimization>0)z.optimizationBands.push({kind:'optimization',bottom:splitTop,top});
   if(z.dispatchRemaining>0)z.optimizationBands.push({kind:'dispatchRemaining',bottom,top:splitTop});
   if(e.status==='unresolved')z.optimizationBands.push({kind:'optimizationPending',bottom,top});
  }
  e.originalDispatch+=original;e.optimization+=z.optimization;e.optimizationUpper+=z.optimizationUpper;
 }
 return {rows,events,summary:summarize(rows,events),config,diagnostics:{frozenMinutes:frozen.size,frozenIntervals:intervals,
  screenedMinutes:rows.reduce((n,r,i)=>n+Number(!usable(r,times[i])),0)}};
}
