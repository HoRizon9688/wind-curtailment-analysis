/** Explicit private full-shell regression; the HTTP server serves only synthetic site/.
 * Select real local files through the native input, export actual Worker results, and
 * compare every field with the freshly regenerated immutable Python baseline.
 */
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,readdirSync} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {launchProbe,ROOT} from './probe-browser.mjs';
import {compareResults,TOLERANCES} from './compare.mjs';
import {validateResult,ENERGY_KEYS} from '../../dashboard/src/content/calculation/contracts.mjs';
import {parseDelimited} from '../../dashboard/src/content/calculation/table-reader.mjs';

const inputPath=resolve(process.argv[2]),candidate=resolve(process.argv[3]);
assert.ok(inputPath.startsWith(join(ROOT,'reports/browser-review')+'/')||inputPath.startsWith(join(ROOT,'reports/browser-review')+'\\'));
const input=JSON.parse(readFileSync(inputPath,'utf8')),folder=dirname(inputPath);
assert.equal(input.private,true);
const expected=validateResult(JSON.parse(readFileSync(input.expected,'utf8')));
const sha=b=>createHash('sha256').update(b).digest('hex');
for(const path of [...input.power,...input.forecast]){
 const f=expected.meta.files.find(f=>f.name===path.split(/[\\/]/).at(-1));assert.ok(f);assert.equal(sha(readFileSync(path)),f.sha256);
}
const downloads=join(folder,`downloads-${Date.now()}`);mkdirSync(downloads);
const p=await launchProbe(null,'RG3-private',{siteRoot:join(candidate,'site'),prefix:'',ready:'Boolean(window.__T0__ && document.querySelector(".wind-upload"))'});
const checks=[],delay=ms=>new Promise(r=>setTimeout(r,ms));
const record=(name,detail)=>{checks.push({name,passed:true,detail});console.log('PASS '+name);};
const settle=()=>p.evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
async function wait(expr){for(let i=0;i<1800;i++){if(await p.evaluate(expr))return;await delay(50);}throw Error('Private UI timeout');}
async function set(selector,value){await p.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(e.tagName==='SELECT')e.value=${JSON.stringify(value)};else{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));}e.dispatchEvent(new Event('change',{bubbles:true}));})()`);await settle();}
async function click(text){await p.evaluate(`(()=>{const e=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()===${JSON.stringify(text)});if(!e)throw Error('Button missing');e.click();})()`);await settle();}
async function download(kind){
 const dir=join(downloads,kind);mkdirSync(dir);await p.call('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:dir});
 await set('select[aria-label="导出内容"]',kind);await click('导出所选内容');
 for(let i=0;i<1200;i++){const name=readdirSync(dir).find(n=>!n.endsWith('.crdownload'));if(name)return {path:join(dir,name),text:readFileSync(join(dir,name),'utf8')};await delay(50);}throw Error('Download timeout');
}
const close=(a,b,tolerance=TOLERANCES.minute)=>assert.ok(Math.abs(a-b)<=tolerance,`Numerical audit error ${Math.abs(a-b)}`);
try{
 const siteManifest=JSON.parse(readFileSync(join(candidate,'candidate-manifest.json'),'utf8'));
 assert.equal(sha(Buffer.from(await (await fetch(p.origin+'/')).arrayBuffer())),siteManifest.files.find(f=>f.path==='site/index.html').sha256);
 record('exact synthetic candidate served; private inputs are not HTTP assets');
 await p.evaluate('document.querySelector("details.wind-upload").open=true');
 const {root}=await p.call('DOM.getDocument',{},p.sessionId);
 for(const [kind,label] of [['power','分钟功率表文件'],['forecast','数据下载预测表文件']]){
  const {nodeId}=await p.call('DOM.querySelector',{nodeId:root.nodeId,selector:`input[aria-label="${label}"]`},p.sessionId);
  await p.call('DOM.setFileInputFiles',{nodeId,files:input[kind]},p.sessionId);
 }
 await set('input[aria-label="场站名称"]',input.options.stationName);await set('input[aria-label="装机容量"]',String(input.options.capacity));
 await p.evaluate(`(()=>{const es=document.querySelectorAll('.wind-upload input[type=date]');${JSON.stringify([input.options.start,input.options.end])}.forEach((v,i)=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(es[i],v);es[i].dispatchEvent(new Event('input',{bubbles:true}));es[i].dispatchEvent(new Event('change',{bubbles:true}));});const c=document.querySelector('.wind-confirm input');if(!c.checked)c.click();})()`);
 await wait('!document.querySelector(".wind-upload button[type=submit]").disabled');
 const began=performance.now();await click('校验并计算');
 await wait(`window.__T0__.state().stationName===${JSON.stringify(expected.meta.stationName)}&&!document.querySelector('.wind-upload button[type=submit]').disabled`);
 const state=await p.evaluate('window.__T0__.state()');assert.equal(state.rowCount,44640);assert.equal(state.sourceName,expected.meta.stationName);
 record('native local inputs → actual inline Worker → 31-day full-shell result',{elapsedMs:performance.now()-began,rows:state.rowCount});
 const exported=await download('json'),actual=validateResult(JSON.parse(exported.text));
 const comparison=compareResults(expected,actual);
 writeFileSync(join(folder,'full-difference.json'),JSON.stringify(comparison,null,2));
 assert.ok(comparison.equal,'See private full-difference.json');assert.deepEqual(state.summary,actual.summary);
 record('all six Result fields match fresh immutable Python baseline',{differentFields:comparison.differences.length,maxMinuteError:comparison.maxMinuteError,maxAggregateEnergyError:comparison.maxAggregateEnergyError,jsonBytes:Buffer.byteLength(exported.text)});

 // Independently audit equations, state recurrence, reset and band integrals.
 let dispatch=false,prediction=false,negative=0,excluded=0,midnights=0,carryMatters=0,maxClosure=0,maxCommandClosure=0,maxBandError=0;
 const reasonMinutes={};
 for(const r of actual.rows){
  for(const reason of r.reasons)reasonMinutes[reason]=(reasonMinutes[reason]??0)+1;
  if(r.p!==null&&r.p<0){negative++;assert.equal(r.included,false);}
  if(!r.included){excluded++;for(const k of ENERGY_KEYS)assert.equal(r[k],null);assert.equal(r.allocationBands,undefined);dispatch=false;prediction=false;continue;}
  const diff=r.f-r.g;
  dispatch=diff>(dispatch?.28:.56);
  const following=!dispatch&&Math.abs(r.g-Math.max(r.f,1.12))<=.56;
  const headroom=r.a-Math.max(r.f,r.g);
  prediction=headroom>(prediction?.56:1.12);
  if(!(following||dispatch))prediction=false;
  assert.equal(r.dispatchState,dispatch);assert.equal(r.predictionState,prediction);assert.equal(r.following,following);
  assert.equal(r.floorFollowing,following&&r.f<1.12);
  if(r.time==='00:00'&&r.date!==actual.meta.start){midnights++;const freshDispatch=diff>.56;const freshFollowing=!freshDispatch&&Math.abs(r.g-Math.max(r.f,1.12))<=.56;const freshPred=headroom>1.12&&(freshFollowing||freshDispatch);if(freshDispatch!==dispatch||freshPred!==prediction)carryMatters++;}
  const bottom=Math.max(r.g,r.p),d=dispatch?Math.max(Math.min(r.a,r.f)-bottom,0):0;
  const pred=prediction?(dispatch?Math.max(r.a-Math.max(r.f,r.g,r.p),0):Math.max(r.a-bottom,0)):0;
  close(r.dispatch,d/60);close(r.prediction,pred/60);
  const closure=Math.abs(r.gap-r.dispatch-r.prediction-r.other);maxClosure=Math.max(maxClosure,closure);close(closure,0);
  const command=Math.abs(r.referenceTotal-r.dispatch-r.prediction-r.above-r.releasedAboveAgc);maxCommandClosure=Math.max(maxCommandClosure,command);close(command,0);
  for(const kind of ['dispatch','prediction','other']){const area=r.allocationBands.filter(b=>b.kind===kind).reduce((s,b)=>s+(b.top-b.bottom)/60,0);const error=Math.abs(area-r[kind]);maxBandError=Math.max(maxBandError,error);close(error,0);}
 }
 const first=actual.rows[0];assert.equal(first.included,true);assert.notEqual(first.f,null);
 assert.equal(excluded,actual.summary.excluded);
 const focus=actual.rows.filter(r=>r.date===actual.meta.start&&r.time>='04:40'&&r.time<='04:52');assert.equal(focus.length,13);
 const aug5=actual.gaps.filter(g=>g.reason.includes('缺')&&g.start.startsWith(actual.meta.start.slice(0,8)+'05'));
 assert.deepEqual(aug5,expected.gaps.filter(g=>g.reason.includes('缺')&&g.start.startsWith(expected.meta.start.slice(0,8)+'05')));
 assert.ok(aug5.length>0);assert.ok(negative>0);
 writeFileSync(join(folder,'special-audit.json'),JSON.stringify({focus0446:focus,august5MissingGaps:aug5,negative,excluded,reasonMinutes,midnights,carryMatters,maxClosure,maxCommandClosure,maxBandError,calibration:actual.calibration},null,2));
 record('all-minute closure, band area, state recurrence, excluded reset and midnight carry audited',{negative,excluded,midnights,carryMatters,maxClosure,maxCommandClosure,maxBandError});
 record('first midnight forecast, 04:46 window and August 5 gaps match baseline');

 const csv=await download('minutes'),table=parseDelimited(csv.text.replace(/^\uFEFF/,''));
 const keys=['timestamp','a','theory','p','g','f','dispatch','prediction','other','above','below','gap','status','version','rightVersion','target','rightTarget','leftF','rightF','weight','included','note','powerSource','forecastSource','rightForecastSource','operationalBelow','unexplainedAbove','noiseAbove','noiseBelow','dispatchState','predictionState','following','floorFollowing','trackingReference','stationName','stationCapacity'];
 assert.equal(table.length,44641);assert.equal(table[0].length,36);
 const numeric=new Set(['a','theory','p','g','f','dispatch','prediction','other','above','below','gap','leftF','rightF','weight','operationalBelow','unexplainedAbove','noiseAbove','noiseBelow','trackingReference','stationCapacity']);
 for(let i=1;i<table.length;i++)for(let j=0;j<keys.length;j++){
  const key=keys[j],value=key==='stationName'?actual.meta.stationName:key==='stationCapacity'?actual.meta.capacity:actual.rows[i-1][key],cell=table[i][j];
  if(value===null||value===undefined)assert.equal(cell,'');
  else if(numeric.has(key))close(Number(cell),value);
  else{const text=String(value);assert.equal(cell,typeof value==='string'&&/^\s*[=+@-]/.test(text)?"'"+text:text);}
 }
 record('downloaded minute CSV has all 44,640 rows, 36 columns and current values');
 await set('.wind-day-selector select',actual.meta.start);await click('凌晨');await click('全天');
 await p.evaluate(`(()=>{const e=document.querySelector('[data-component-id="wind-power"] select[aria-label="功率曲线与限电面积 actions"]');e.value='0';e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
 await wait('Boolean(document.querySelector(".source-sidebar"))');
 const source=await p.evaluate('document.querySelector(".source-sidebar").innerText');assert.ok(source.includes(actual.meta.stationName));for(const f of actual.meta.files)assert.ok(source.includes(f.sha256));
 await p.evaluate(`document.querySelector('button[aria-label="Close data source"]').click()`);
 record('source inspector carries every original input hash');
 await set('.wind-day-selector select',actual.meta.start.slice(0,8)+'05');assert.ok(await p.evaluate('document.querySelector(".wind-notice").textContent.includes("已排除")'));assert.ok(await p.evaluate(`Boolean(document.querySelector('.wind-power-svg rect[fill="url(#wind-hatch-missing)"]'))`));
 record('missing August 5 minutes are marked in the actual daily chart');
 const storage=await p.evaluate('JSON.stringify({local:Object.fromEntries(Object.keys(localStorage).map(k=>[k,localStorage.getItem(k)])),session:Object.fromEntries(Object.keys(sessionStorage).map(k=>[k,sessionStorage.getItem(k)]))})');
 for(const value of [actual.meta.stationName,...actual.meta.files.flatMap(f=>[f.name,f.sha256]),'dispatchState'])assert.ok(!storage.includes(value));
 assert.deepEqual(await p.evaluate('indexedDB.databases()'),[]);assert.equal(await p.evaluate('navigator.serviceWorker.getRegistrations().then(x=>x.length)'),0);
 assert.ok(p.networkRequests.every(r=>r.method==='GET'&&r.postData===null&&!r.url.includes('/api/')&&(!/^https?:/.test(r.url)||r.url.startsWith(p.origin))));
 assert.ok(p.requests.every(r=>r.method==='GET'&&r.bytes===0));assert.deepEqual(p.browserErrors,[]);
 record('no private input/result persistence or external/calculation API requests');
 await p.call('Page.reload',{ignoreCache:true},p.sessionId);await wait('window.__T0__?.state().stationName?.includes("合成数据")');record('refresh discards real analysis and restores synthetic example');
 writeFileSync(join(folder,'browser-private-review.json'),JSON.stringify({passed:true,candidateHtmlSHA256:siteManifest.files.find(f=>f.path==='site/index.html').sha256,baseline:input.baseline,browser:p.version,checks,comparison:{equal:comparison.equal,differences:comparison.differences.length,maxMinuteError:comparison.maxMinuteError,maxAggregateEnergyError:comparison.maxAggregateEnergyError},requests:p.networkRequests},null,2));
 console.log(`Private R/G3: ${checks.length} checks passed`);
}catch(error){writeFileSync(join(folder,'browser-private-failure.json'),JSON.stringify({error:String(error),checks},null,2));throw error;}finally{await p.close();}
