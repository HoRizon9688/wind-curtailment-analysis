/** The reviewed handoff orchestration, adapted to normalized input and the FULL
 * frozen Python Result. No second allocator and no API/file-system dependency.
 */
import {readTable} from './table-reader.mjs';
import {normalizeInputs} from './input-model.mjs';
import {parseTime,formatTime,MINUTE_MS,DAY_MS,stripText} from './time.mjs';
import {alignedForecast} from './interpolation.mjs';
import {aggregate,gapIntervals} from './aggregate.mjs';
import {ThresholdAllocator} from './threshold-allocator.mjs';
import {ENERGY_KEYS,THRESHOLDS,validateInput,dateSpan} from './contracts.mjs';
import {CalculationError} from './errors.mjs';

export function analyzeNormalized({power,forecasts,metadata},options,onProgress=()=>{}) {
  const {capacity,stationName,start,end}=options;
  if(!Number.isFinite(capacity)||capacity<=0)throw new CalculationError('INPUT','装机容量须为大于 0 的 MW 数值');
  // Avoid Math.min(...keys), which overflows the call stack on month/year data.
  let first=Infinity,last=-Infinity;for(const t of power.keys()){if(t<first)first=t;if(t>last)last=t;}
  if(!power.size)throw new CalculationError('INPUT','分钟功率表没有数据');
  const inferredLast=last>first&&formatTime(last).slice(11,16)==='00:00'?last-MINUTE_MS:last;
  const beginDate=start??formatTime(first).slice(0,10),endDate=end??formatTime(inferredLast).slice(0,10);
  try{dateSpan(beginDate,endDate);}catch{throw new CalculationError('RANGE','计算日期范围须为连续 1—366 天');}
  const begin=parseTime(beginDate),finish=parseTime(endDate)+DAY_MS;
  let powerOutsidePeriod=0,inPeriod=false;for(const t of power.keys())if(t<begin||t>=finish)powerOutsidePeriod++;else inPeriod=true;
  if(!inPeriod)throw new CalculationError('RANGE','所选日期范围没有分钟功率数据');
  const targets=[...forecasts.keys()].sort((a,b)=>a-b),rows=[];const allocator=new ThresholdAllocator(capacity);
  const totalMinutes=(finish-begin)/MINUTE_MS;
  onProgress({phase:'calculating',completed:0,total:totalMinutes});
  for(let t=begin;t<finish;t+=MINUTE_MS) {
    const values=power.get(t),timestamp=formatTime(t);
    const r={timestamp,date:timestamp.slice(0,10),time:timestamp.slice(11,16),minute:(t-begin)/MINUTE_MS%1440,a:null,p:null,g:null,theory:null,...(values??{}),...alignedForecast(t,forecasts,targets)};
    const reasons=[];
    if(!values)reasons.push('分钟功率缺行');else if(['a','p','g'].some(k=>r[k]===null))reasons.push('分钟功率缺值或非数值');
    if(r.p!==null&&r.p<0)reasons.push('实发负值（低风厂用电）');
    if(r.f===null)reasons.push('预测缺失（不外推、不跨缺点）');else if(['leftF','rightF'].some(k=>!(r[k]>=0&&r[k]<=capacity)))reasons.push('预测节点超出有效功率范围');
    if(['a','g','f'].some(k=>r[k]!==null&&r[k]<0))reasons.push('可用、AGC 或预测为负值');
    if(['a','p','g','f'].some(k=>r[k]!==null&&r[k]>capacity))reasons.push('功率超过装机容量（请核对场站及单位）');
    Object.assign(r,{included:reasons.length===0,reasons,status:reasons.length?'excluded':'estimated',note:reasons.join('；')},Object.fromEntries(ENERGY_KEYS.map(k=>[k,null])));
    if(!reasons.length){Object.assign(r,allocator.calculate(r.a,r.f,r.g,r.p));if(r.p>r.a)r.note+='；实发高于可用，正差额计零';}
    else allocator.reset();
    rows.push(r);
    if(rows.length%1440===0||rows.length===totalMinutes)onProgress({phase:'calculating',completed:rows.length,total:totalMinutes});
  }
  const aggregateSteps=rows.length/1440+3;
  onProgress({phase:'aggregating',completed:0,total:aggregateSteps});
  const daily=[];for(let i=0;i<rows.length;i+=1440){daily.push({date:rows[i].date,...aggregate(rows.slice(i,i+1440))});onProgress({phase:'aggregating',completed:daily.length,total:aggregateSteps});}
  const {powerDuplicates,...originalMeta}=metadata;
  const meta={...originalMeta,stationName:stripText(stationName)||metadata.stationName,capacity,start:beginDate,end:endDate,timezone:'UTC+08:00',powerRows:power.size,powerDuplicates,powerOutsidePeriod,
    negativePolicy:'实发负值属于低风厂用电，整分钟排除，不按零替换',thresholds:{...THRESHOLDS}};
  const summary=aggregate(rows);let reference=0,released=0;
  onProgress({phase:'aggregating',completed:daily.length+1,total:aggregateSteps});
  for(const r of rows){reference+=r.referenceTotal??0;released+=r.releasedAboveAgc??0;}
  const assigned=summary.dispatch+summary.prediction;
  const calibration={referenceTotal:reference,assigned,difference:reference-assigned,relativeDifference:reference?(reference-assigned)/reference:null,releasedAboveAgc:released,
    noiseAbove:summary.noiseAbove,unexplainedAbove:summary.unexplainedAbove,closureError:reference-assigned-released-summary.noiseAbove-summary.unexplainedAbove};
  onProgress({phase:'aggregating',completed:daily.length+2,total:aggregateSteps});
  const gaps=gapIntervals(rows);
  onProgress({phase:'aggregating',completed:aggregateSteps,total:aggregateSteps});
  return {meta,summary,daily,gaps,rows,calibration};
}

/** Shared async entry point for tests and future Worker; never uploads bytes. */
export async function analyzeFiles(input,onProgress=()=>{}) {
  // Range is checked after tables, matching baseline error precedence.
  try { validateInput(input); }
  catch(error) { if(error.field!=='range')throw error; }
  const powerTables=[],forecastTables=[];
  const total=input.power.length+input.forecast.length;let completed=0;
  onProgress({phase:'reading',completed,total});
  for(const file of input.power){powerTables.push(await readTable(file));onProgress({phase:'reading',completed:++completed,total});}
  for(const file of input.forecast){forecastTables.push(await readTable(file));onProgress({phase:'reading',completed:++completed,total});}
  onProgress({phase:'validating',completed:0,total:1});
  const normalized=normalizeInputs(powerTables,forecastTables);
  // The normalized maps retain values and provenance, not parsed cell arrays.
  powerTables.length=0;forecastTables.length=0;
  onProgress({phase:'validating',completed:1,total:1});
  return analyzeNormalized(normalized,input.options,onProgress);
}
