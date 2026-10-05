import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {launchProbe,ROOT} from './probe-browser.mjs';
const probe=await launchProbe('tests/browser/performance-worker-page.mjs','T4-xlsx');
const workerHeaps=[];let sampling=false;
const timer=setInterval(async()=>{if(sampling)return;sampling=true;try{for(const session of probe.workerSessions)try{workerHeaps.push(await probe.call('Runtime.getHeapUsage',{},session));}catch{}}finally{sampling=false;}},100);
try {
  const report={browser:probe.version,samples:[]};
  for(const cache of ['cold','warm']) {
    const from=workerHeaps.length;
    const sample=await probe.evaluate(`window.runProbe(${JSON.stringify({days:31,prefix:probe.prefix,files:{power:'/reports/browser-review/T4/xlsx-synthetic/synthetic-power.xlsx',forecast:'/reports/browser-review/T4/xlsx-synthetic/synthetic-forecast.xlsx'}})})`);
    assert.equal(sample.rows,44640);assert.equal(sample.summary.included,44640);assert.equal(sample.transferred,true);assert.ok(sample.maxLongTaskMs<1000&&sample.maxRafGapMs<1000);
    const heaps=workerHeaps.slice(from);sample.workerHeapSampleMax=heaps.length?Math.max(...heaps.map(h=>h.usedSize)):null;sample.cache=cache;report.samples.push(sample);console.log(JSON.stringify(sample));
  }
  assert.ok(probe.requests.every(r=>r.method==='GET'));report.passed=true;writeFileSync(join(ROOT,'reports/browser-review/T4/xlsx-performance.json'),JSON.stringify(report,null,2)+'\n');
}finally{clearInterval(timer);await probe.close();}
