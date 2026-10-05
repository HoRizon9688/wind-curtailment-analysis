import assert from 'node:assert/strict';
import {writeFileSync,mkdirSync,copyFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {launchProbe,ROOT} from './probe-browser.mjs';
const folder=join(ROOT,'reports/browser-review/T4-source');
mkdirSync(join(folder,'probe-build'),{recursive:true});copyFileSync(join(folder,'dashboard/dist/index.html'),join(folder,'probe-build/index.html'));
const probe=await launchProbe(null,'T4-source');
try {
  const result=await probe.evaluate('window.runProbe()');assert.equal(result.rows,1440);assert.equal(result.included,1);assert.equal(result.first.prediction,20/60);assert.ok(result.files.every(f=>/^[a-f0-9]{64}$/.test(f.sha256)));
  assert.ok(probe.requests.every(r=>r.method==='GET'));
  const html=readFileSync(join(folder,'probe-build/index.html'),'utf8');assert.ok(!/<meta\b[^>]*\bname=["']data-app-local-thread["']/i.test(html));
  const report={passed:true,browser:probe.version,result,requests:probe.requests};writeFileSync(join(ROOT,'reports/browser-review/T4/source-worker-probe.json'),JSON.stringify(report,null,2)+'\n');
  console.log('Data source build inline Worker PASS: 1440 rows, 1 included, original hashes complete.');
}finally{await probe.close();}
