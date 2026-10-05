import {writeFileSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {cpus,totalmem} from 'node:os';
import {launchProbe,ROOT} from './probe-browser.mjs';
const probe=await launchProbe('tests/browser/performance-baseline-page.mjs','T4-baseline');
try {
  const report={browser:probe.version,cpu:cpus()[0]?.model,logicalCores:cpus().length,totalMemoryBytes:totalmem(),samples:[]};
  for(const days of [15,31]){const sample=await probe.evaluate(`window.runProbe(${JSON.stringify({days})})`);report.samples.push(sample);console.log(JSON.stringify(sample));}
  const folder=join(ROOT,'reports/browser-review/T4');mkdirSync(folder,{recursive:true});writeFileSync(join(folder,'baseline.json'),JSON.stringify(report,null,2)+'\n');
}finally{await probe.close();}
