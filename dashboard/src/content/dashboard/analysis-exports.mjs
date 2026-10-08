import {csvText,csvTable} from './wind-model.mjs';
import {dailyGeneration} from './generation-model.mjs';
const safeName=value=>String(value).replace(/[\x00-\x1f<>:"/\\|?*]/g,'_').replace(/[. ]+$/g,'').slice(0,90)||'场站';
export function completeAnalysis(report,rows) {
 return {meta:report.meta,summary:report.summary,daily:report.daily,gaps:report.gaps,rows,...(report.calibration?{calibration:report.calibration}:{})};
}
export function exportAnalysis(result,kind) {
 const {meta,rows,daily,gaps}=result;
 const prefix=`${safeName(meta.stationName)}-${meta.start}-${meta.end}`;
 const identity=['场站名称','装机容量_MW','时区'];
 const values=[meta.stationName,meta.capacity,meta.timezone];
 if(kind==='json')return {name:`${prefix}-完整结果.json`,type:'application/json;charset=utf-8',text:JSON.stringify(result,null,2)};
 let text,label;
 if(kind==='minutes'){label='分钟分解';text=csvText(rows,meta);}
 else if(kind==='daily'){label='逐日汇总';text=csvTable([...identity,'日期','调度限电_MWh','功率预测限电_MWh','其他差额_MWh','发电量_MWh','实发有效分钟','实发缺失或异常分钟','厂用电负值分钟','实发数据覆盖率','预期分钟','参与分钟','排除分钟','限电计算覆盖率','调度占比'],dailyGeneration(daily,rows,meta.capacity).map(d=>[...values,d.date,d.dispatch,d.prediction,d.other,d.generation,d.generationObserved,d.generationMissing,d.generationNegative,d.generationCoverage,d.expected,d.included,d.excluded,d.coverage,d.dispatchShare]));}
 else if(kind==='gaps'){label='排除区间';text=csvTable([...identity,'起点（含）','终点（不含）','分钟','排除原因'],gaps.map(g=>[...values,g.start,g.end,g.minutes,g.reason]));
  // Even a gap-free export needs explicit current-analysis identity.
  if(!gaps.length)text=csvTable([...identity,'起点（含）','终点（不含）','分钟','排除原因'],[[...values,'','',0,'无排除区间']]);
 } else throw new Error('未知导出类型');
 return {name:`${prefix}-${label}.csv`,type:'text/csv;charset=utf-8',text};
}
