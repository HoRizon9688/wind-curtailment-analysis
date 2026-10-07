/** Untouched T6 release HTML, static HTTP only, root and repository paths. */
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,readdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {launchProbe,ROOT} from './probe-browser.mjs';
import {oracle,oracleInput} from './python-oracle.mjs';
import {compareResults} from './compare.mjs';
const candidate=resolve(process.argv[2]??join(ROOT,'reports/static-candidates/T6-2026-10-05'));
const urlIndex=process.argv.indexOf('--url');
const remote=urlIndex<0?null:new URL(process.argv[urlIndex+1]);
if(remote && remote.protocol!=='https:')throw Error('Online acceptance requires HTTPS');
const folder=join(ROOT,remote?`reports/browser-review/online-release-2026-10-05/${remote.hostname}`:'reports/browser-review/T6');mkdirSync(folder,{recursive:true});
const manifest=JSON.parse(readFileSync(join(candidate,'candidate-manifest.json'),'utf8'));
const summary=[],delay=ms=>new Promise(r=>setTimeout(r,ms));
const sha=b=>createHash('sha256').update(b).digest('hex');
for(const prefix of remote?[remote.pathname.replace(/\/$/,'')]:['', '/wind-curtailment-analysis']) {
 const tag=prefix?'subpath':'root',downloads=join(folder,`downloads-${tag}-${Date.now()}`);mkdirSync(downloads,{recursive:true});
 const station=`T6-LOCAL-USER-SYNTHETIC-${tag}`;
 const inputs=format=>{const directory=format==='csv'?join(candidate,'site/samples'):join(ROOT,'reports/browser-review/T6/xlsx-synthetic');const file=name=>{const b=readFileSync(join(directory,name));return {name,bytes:b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength)};};return {power:[file(`minute-power.${format}`)],forecast:[file(`forecast.${format}`)],options:{capacity:56,stationName:station,start:'2026-01-01',end:'2026-01-02'}};};
 const expected={csv:await oracle({mode:'analyze',input:oracleInput(inputs('csv'))}),xlsx:await oracle({mode:'analyze',input:oracleInput(inputs('xlsx'))})};
 const checks=[],record=(name,detail)=>{checks.push({name,passed:true,detail});console.log(`PASS ${tag}: ${name}`);};
 const started=performance.now();const p=await launchProbe(null,`T6-${tag}`,{siteRoot:join(candidate,'site'),prefix,readyTimeoutMs:remote?60000:10000,...(remote?{remoteUrl:`${remote.origin}${prefix}/?t0-harness&view=1&tab=dashboard`}:{}),ready:'Boolean(window.__T0__ && document.querySelector(".wind-upload"))'});
 async function wait(expr){for(let i=0;i<300;i++){if(await p.evaluate(expr))return;await delay(35);}throw Error('UI wait: '+expr+' '+await p.evaluate('document.body.innerText.slice(0,1000)'));}
 async function click(text){await p.evaluate(`(()=>{const e=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()===${JSON.stringify(text)});if(!e)throw Error('missing button');e.click();})()`);await p.evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');}
 async function set(selector,value){await p.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(e.tagName==='SELECT'){e.value=${JSON.stringify(value)};}else{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));}e.dispatchEvent(new Event('change',{bubbles:true}));})()`);await p.evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');}
 async function upload(format){
  await p.evaluate('document.querySelector("details.wind-upload").open=true');const {root}=await p.call('DOM.getDocument',{},p.sessionId);
  for(const [name,label] of [['minute-power','分钟功率表文件'],['forecast','数据下载预测表文件']]){const {nodeId}=await p.call('DOM.querySelector',{nodeId:root.nodeId,selector:`input[aria-label="${label}"]`},p.sessionId);await p.call('DOM.setFileInputFiles',{nodeId,files:[join(format==='csv'?join(candidate,'site/samples'):join(ROOT,'reports/browser-review/T6/xlsx-synthetic'),`${name}.${format}`)]},p.sessionId);}
  await set('input[aria-label="场站名称"]',station);await set('input[aria-label="装机容量"]','56');
  await p.evaluate(`(()=>{const es=document.querySelectorAll('.wind-upload input[type=date]');['2026-01-01','2026-01-02'].forEach((v,i)=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(es[i],v);es[i].dispatchEvent(new Event('input',{bubbles:true}));es[i].dispatchEvent(new Event('change',{bubbles:true}));});const e=document.querySelector('.wind-confirm input');if(!e.checked)e.click();})()`);
  await wait('!document.querySelector(".wind-upload button[type=submit]").disabled');await click('校验并计算');
  await wait(`window.__T0__.state().stationName===${JSON.stringify(station)} && !document.querySelector('.wind-upload button[type=submit]').disabled`);
 }
 try {
  await p.call('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:downloads});
  const served=Buffer.from(await (await fetch(`${p.origin}${prefix}/`)).arrayBuffer());assert.equal(sha(served),manifest.files.find(f=>f.path==='site/index.html').sha256);record('served exact candidate bytes without bootstrap rewriting');
  if(remote) {
   for(const name of ['minute-power.csv','forecast.csv']) {
    const response=await fetch(`${p.origin}${prefix}/samples/${name}`);assert.equal(response.status,200);
    assert.equal(sha(Buffer.from(await response.arrayBuffer())),sha(readFileSync(join(candidate,'site/samples',name))));
   }
   record('online synthetic sample bytes match the reviewed release');
  }
  assert.ok(await p.evaluate('document.body.innerText.includes("网站默认数据仅为演示使用")'));assert.ok(await p.evaluate('Boolean(document.querySelector("[data-testid=power-chart]"))'));assert.equal(await p.evaluate('window.__T0__.state().rowCount'),2880);record('initial synthetic example and chart load',{includingBrowserLaunchMs:performance.now()-started});
  assert.equal((await fetch(`${p.origin}${prefix}/api/health`)).status,404);assert.equal((await fetch(`${p.origin}${prefix}/api/calculate`)).status,404);record('static server has no Python health or calculation endpoint');
  for(const format of ['csv','xlsx']) {
   const currentDownloads=join(downloads,format);mkdirSync(currentDownloads,{recursive:true});await p.call('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:currentDownloads});
   const began=performance.now();await upload(format);assert.deepEqual(await p.evaluate('window.__T0__.state().summary'),expected[format].summary);
   await set('select[aria-label="导出内容"]','json');const before=new Set(readdirSync(currentDownloads));await click('导出所选内容');let name;for(let i=0;i<200;i++){name=readdirSync(currentDownloads).find(f=>!before.has(f)&&!f.endsWith('.crdownload'));if(name)break;await delay(25);}assert.ok(name);const result=JSON.parse(readFileSync(join(currentDownloads,name),'utf8'));const review=compareResults(expected[format],result);assert.ok(review.equal,JSON.stringify(review));record(`${format} native input → actual Worker → full JSON matches Python`,{rows:result.rows.length,elapsedMs:performance.now()-began,maxMinuteError:review.maxMinuteError,maxAggregateEnergyError:review.maxAggregateEnergyError});
   if(format==='csv'){await p.call('Page.reload',{ignoreCache:true},p.sessionId);await wait('window.__T0__?.state().stationName?.includes("合成数据")');}
  }
  assert.ok(await p.evaluate(`document.querySelector('[data-testid="analysis-origin"]').textContent.includes('本地用户分析')`));record('user analysis has explicit local identity');
  await p.evaluate(`document.querySelector('button[aria-label="隐藏预测（线性插值）"]').click()`);assert.equal(await p.evaluate('Boolean(document.querySelector("[data-curve=f]"))'),false);await click('预测限电面积');assert.equal(await p.evaluate('Boolean(document.querySelector("[data-area=prediction]"))'),false);record('curves and classification shading are interactive');
  await p.evaluate(`(()=>{const e=document.querySelector('[data-component-id="wind-power"] select[aria-label="功率曲线与限电面积 actions"]');e.value='0';e.dispatchEvent(new Event('change',{bubbles:true}));})()`);await wait(`document.querySelector('.source-sidebar')?.innerText.includes(${JSON.stringify(station)})`);assert.ok(await p.evaluate('document.querySelector(".source-sidebar").innerText.includes("SHA-256")'));record('source follows current local station and file hashes');await p.evaluate(`document.querySelector('button[aria-label="Close data source"]').click()`);
  const storage=await p.evaluate(`JSON.stringify({local:Object.fromEntries(Object.keys(localStorage).map(k=>[k,localStorage.getItem(k)])),session:Object.fromEntries(Object.keys(sessionStorage).map(k=>[k,sessionStorage.getItem(k)]))})`);assert.ok(!storage.includes(station)&&!storage.includes('dispatchState')&&!storage.includes('minute-power.xlsx'));assert.deepEqual(await p.evaluate('indexedDB.databases()'),[]);record('no user result or files persisted by shell');
  await p.call('Page.reload',{ignoreCache:true},p.sessionId);await wait('window.__T0__?.state().stationName?.includes("合成数据")');assert.ok(await p.evaluate('document.body.innerText.includes("网站默认数据仅为演示使用")'));record('refresh restores example rather than prior user analysis');
  assert.ok(p.networkRequests.every(r=>r.method==='GET'&&r.postData===null&&!r.url.includes(station)&&!r.url.includes('minute-power.xlsx')));assert.ok(!p.networkRequests.some(r=>/^https?:/.test(r.url)&&(!r.url.startsWith(p.origin)||r.url.includes('/api/'))));assert.deepEqual(p.browserErrors,[]);record('application uses only local static GETs; no external/API requests or runtime errors');
  if(remote) {
   await p.call('Page.navigate',{url:`${p.origin}${prefix}/?view=1&tab=dashboard`},p.sessionId);
   await wait('Boolean(document.querySelector(".wind-hour") && document.querySelector(".wind-upload"))');
   assert.ok(await p.evaluate('window.isSecureContext && Boolean(crypto.subtle)'));
   await p.evaluate('document.querySelectorAll(".wind-hour")[4].click()');
   await wait('document.querySelectorAll(".wind-hour").length===1');
   await p.evaluate('document.querySelector(".wind-hour").click()');
   await wait('document.querySelectorAll(".wind-hour").length===24');
   assert.equal(await p.evaluate('Number(document.querySelector(\'input[aria-label="范围起点"]\').value)'),0);
   assert.equal(await p.evaluate('Number(document.querySelector(\'input[aria-label="范围终点"]\').value)'),1440);
   assert.deepEqual(p.browserErrors,[]);
   record('normal visitor URL supports secure browser APIs and same-hour reset without harness flag');
  }
  const shot=await p.call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false},p.sessionId);writeFileSync(join(folder,`${tag}.png`),Buffer.from(shot.data,'base64'));
  summary.push({prefix,checks,browser:p.version,requests:p.requests,applicationRequests:p.networkRequests});
 }finally{await p.close();}
}
writeFileSync(join(folder,'static-candidate.json'),JSON.stringify({passed:true,...(remote?{onlineUrl:remote.href}:{}),candidateHtmlSha256:manifest.files.find(f=>f.path==='site/index.html').sha256,checks:summary},null,2)+'\n');console.log(`${remote?'Online release':'T6 exact static candidate'}: ${summary.reduce((sum,s)=>sum+s.checks.length,0)} checks passed`);
