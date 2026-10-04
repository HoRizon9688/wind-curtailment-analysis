import {ENERGY_KEYS} from './contracts.mjs';
import {parseTime,formatTime,MINUTE_MS} from './time.mjs';

/** Reuses the verified aggregation loop from handoff time.mjs. */
export function aggregate(rows) {
  const result=Object.fromEntries(ENERGY_KEYS.map(k=>[k,0]));
  Object.assign(result,{expected:rows.length,included:0,excluded:0,negativeActual:0,missingForecast:0,missingPower:0,baselineAnomalies:0,special:0});
  for(const r of rows) {
    result.negativeActual+=Number(r.reasons.includes('实发负值（低风厂用电）'));
    result.missingForecast+=Number(r.reasons.includes('预测缺失（不外推、不跨缺点）'));
    result.missingPower+=Number(r.reasons.some(s=>s.includes('分钟功率')));
    result.baselineAnomalies+=Number(r.p!==null&&r.a!==null&&r.p>r.a);
    if(r.included) {result.included++;result.special+=Number(!r.following&&!r.dispatchState);for(const k of ENERGY_KEYS)result[k]+=r[k];}
    else result.excluded++;
  }
  result.coverage=rows.length?result.included/rows.length:0;
  result.dispatchShare=result.dispatch+result.prediction?result.dispatch/(result.dispatch+result.prediction):null;
  return result;
}

/** Actual Python baseline appends only NEW intervals (handoff reconstruction was wrong). */
export function gapIntervals(rows) {
  const intervals=[];const reasons=[...new Set(rows.flatMap(r=>r.reasons))].sort();
  for(const reason of reasons) {
    let current=null;
    for(const r of rows) {
      if(!r.reasons.includes(reason)){current=null;continue;}
      if(current&&current.end===r.timestamp){current.end=formatTime(parseTime(r.timestamp)+MINUTE_MS);current.minutes++;}
      else {current={start:r.timestamp,end:formatTime(parseTime(r.timestamp)+MINUTE_MS),minutes:1,reason};intervals.push(current);}
    }
  }
  return intervals.sort((a,b)=>a.start<b.start?-1:a.start>b.start?1:a.reason<b.reason?-1:a.reason>b.reason?1:0);
}
