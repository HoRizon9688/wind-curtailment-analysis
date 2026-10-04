// Test-only page: synthetic fixtures loaded from the local harness server.
import {analyzeFiles} from '../../dashboard/src/content/calculation/analyze.mjs';
import {parseTime,formatTime} from '../../dashboard/src/content/calculation/time.mjs';
import {validateResult} from '../../dashboard/src/content/calculation/contracts.mjs';
window.t23Run=async({prefix,cases})=>{
  const root=`${prefix}/tests/fixtures/browser/contract/`;
  const file=async path=>({name:path.split('/').at(-1),bytes:await (await fetch(root+path)).arrayBuffer()});
  const results=[];
  for(const c of cases) {
    const input={power:await Promise.all(c.power.map(file)),forecast:await Promise.all(c.forecast.map(file)),options:c.options};
    const result=await analyzeFiles(input);validateResult(result);results.push({id:c.id,result});
  }
  const times=['2026-08-01','2026/8/1 0:15','2026-07-31T16:15:00Z','2026-08-01T00:15:00+08:00'].map(x=>formatTime(parseTime(x)));
  return {timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,times,results};
};
