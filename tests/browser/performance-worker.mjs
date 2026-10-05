import assert from 'node:assert/strict';
import {writeFileSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {cpus,totalmem} from 'node:os';
import {launchProbe,ROOT} from './probe-browser.mjs';
const selected=process.argv.includes('--days')?process.argv[process.argv.indexOf('--days')+1].split(',').map(Number):[15,31,366];
const probe=await launchProbe('tests/browser/performance-worker-page.mjs');
const workerHeaps=[],mainHeaps=[];let sampling=false;
const poll=setInterval(async()=>{
  if(sampling)return;sampling=true;
  try {
    const main=await probe.call('Runtime.getHeapUsage',{},probe.sessionId);mainHeaps.push(main.usedSize);
    for(const session of probe.workerSessions)try{const heap=await probe.call('Runtime.getHeapUsage',{},session);workerHeaps.push({session,...heap});}catch{}
  }catch{}finally{sampling=false;}
},100);
try {
  const report={browser:probe.version,cpu:cpus()[0]?.model,logicalCores:cpus().length,totalMemoryBytes:totalmem(),samples:[],checks:{}};
  for(const days of selected)for(const cache of ['cold','warm']) {
    await probe.call('HeapProfiler.collectGarbage',{},probe.sessionId);
    const workerFrom=workerHeaps.length,mainFrom=mainHeaps.length;
    const sample=await probe.evaluate(`window.runProbe(${JSON.stringify({days})})`);
    assert.equal(sample.rows,days*1440);assert.equal(sample.dailyCount,days);assert.equal(sample.summary.included,days*1440);assert.equal(sample.transferred,true);
    assert.ok(sample.maxLongTaskMs<1000&&sample.maxRafGapMs<1000,'UI stalls for more than one second');
    assert.ok(Math.abs(sample.calibration.closureError)<1e-6);
    const heaps=workerHeaps.slice(workerFrom);sample.workerHeapSampleMax=heaps.length?Math.max(...heaps.map(h=>h.usedSize)):null;sample.workerBackingStorageSampleMax=heaps.length?Math.max(...heaps.map(h=>h.backingStorageSize??0)):null;sample.mainCdpHeapSampleMax=Math.max(0,...mainHeaps.slice(mainFrom));sample.cache=cache;
    report.samples.push(sample);console.log(JSON.stringify(sample));
  }
  report.checks.fixtures=await probe.evaluate(`window.runFixtures(${JSON.stringify({prefix:probe.prefix})})`);
  report.checks.cancel=[];
  for(const phase of ['reading','calculating','delivery']){const result=await probe.evaluate(`window.runCancel(${JSON.stringify({phase})})`);assert.equal(result.callbacks,0);assert.equal(result.progressAfterCancel,0);assert.ok(result.confirmationMs<1000&&result.uiFrameMs<1000);report.checks.cancel.push({...result,cancelAt:phase});}
  report.checks.replacement=await probe.evaluate('window.runReplacement()');assert.equal(report.checks.replacement.id,report.checks.replacement.bid);assert.equal(report.checks.replacement.rows,15*1440);assert.equal(report.checks.replacement.delivered.length,1);
  report.checks.privacy=await probe.evaluate('window.probePrivacy()');assert.deepEqual(report.checks.privacy.localStorageKeys,[]);assert.deepEqual(report.checks.privacy.sessionStorageKeys,[]);assert.deepEqual(report.checks.privacy.indexedDatabases,[]);assert.equal(report.checks.privacy.serviceWorkers,0);assert.ok(probe.requests.every(r=>r.method==='GET'&&r.bytes===0));
  report.requests=probe.requests;report.passed=true;
  const folder=join(ROOT,'reports/browser-review/T4');mkdirSync(folder,{recursive:true});writeFileSync(join(folder,'worker-performance.json'),JSON.stringify(report,null,2)+'\n');
  console.log('T4 browser checks passed:',JSON.stringify({fixtures:report.checks.fixtures.cases.length,cancel:report.checks.cancel,replacement:report.checks.replacement,requests:report.requests.length}));
}finally{clearInterval(poll);await probe.close();}
