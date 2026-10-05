import {parseTime,formatTime} from '../../dashboard/src/content/calculation/time.mjs';
export const MARKER='T4-SYNTHETIC-PRIVATE-MARKER-a14e83';
export function syntheticInput(days) {
  const begin=parseTime('2026-08-01'),minutes=days*1440;
  const power=['时间,可用功率,全站总有功_集电线有功之和,AGC有功设定值,理论功率'];
  const forecast=['预测id,名称,预测时间,考核点2预测结果'];
  const node=n=>n%96<4?.2:18+(n%64)*.3;
  for(let i=0;i<minutes;i++) {
    const left=Math.floor(i/15),f=node(left)+(node(left+1)-node(left))*(i%15)/15;
    const a=Math.min(56,f+7+(i%17)/10),g=Math.max(1.12,f-(i%1440>=720?3:0)),p=Math.max(0,g-.3);
    power.push([formatTime(begin+i*60000).slice(0,19),a.toFixed(2),p.toFixed(2),g.toFixed(2),a.toFixed(2)].join(','));
  }
  for(let n=0;n<=minutes/15;n++)forecast.push([MARKER,'纯合成性能风场',formatTime(begin+(n-1)*900000).slice(0,19),node(n).toFixed(2)].join(','));
  const file=(name,lines)=>({name,bytes:new TextEncoder().encode(lines.join('\n')+'\n').buffer});
  return {power:[file('synthetic-power.csv',power)],forecast:[file('synthetic-forecast.csv',forecast)],options:{capacity:56,stationName:'',start:'2026-08-01',end:formatTime(begin+(days-1)*86400000).slice(0,10)}};
}
