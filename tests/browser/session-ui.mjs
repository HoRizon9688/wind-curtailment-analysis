/** Actual T5 full shell: native file selection, real inline Worker, no API. */
import assert from 'node:assert/strict';
import {writeFileSync,mkdirSync,readFileSync,readdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {syntheticInput} from './performance-input.mjs';
import {analyzeFiles} from '../../dashboard/src/content/calculation/analyze.mjs';
import {compareResults} from './compare.mjs';
import {launchProbe,ROOT} from './probe-browser.mjs';
const candidate=process.argv[2]?resolve(process.argv[2]):null;
const stage=candidate?'RG3-ui':'T5-source';
const folder=join(ROOT,`reports/browser-review/${stage}`),data=join(folder,'synthetic-inputs'),downloads=join(folder,`downloads-${Date.now()}`);
mkdirSync(data,{recursive:true});mkdirSync(downloads,{recursive:true});mkdirSync(join(folder,'probe-build'),{recursive:true});
const checks=[],record=(name,detail)=>{checks.push({name,passed:true,detail});console.log(`PASS ${name}`);};
const stationA='T5-PRIVATE-SYNTHETIC-A-a19e',stationB='T5-PRIVATE-SYNTHETIC-B-b28f';
const writeInput=(input,prefix)=>Object.fromEntries(['power','forecast'].map(kind=>[kind,input[kind].map(f=>{f.name=`${prefix}-${f.name}`;const path=join(data,f.name);writeFileSync(path,new Uint8Array(f.bytes));return path;})]));
const a=syntheticInput(2);a.options.stationName=stationA;
const aPaths=writeInput(a,'a'),expectedA=await analyzeFiles(a);
const b=syntheticInput(1);b.options={...b.options,stationName:stationB,capacity:60,start:'2026-09-01',end:'2026-09-01'};
for(const kind of ['power','forecast'])for(const f of b[kind])f.bytes=new TextEncoder().encode(new TextDecoder().decode(f.bytes).replaceAll('2026-08-','2026-09-').replaceAll('2026-07-31','2026-08-31')).buffer;
// Include explicit exclusion cases for the actual gap export.
{const lines=new TextDecoder().decode(b.power[0].bytes).split('\n');lines.splice(7,1);const parts=lines[9].split(',');parts[2]='-0.1';lines[9]=parts.join(',');b.power[0].bytes=new TextEncoder().encode(lines.join('\n')).buffer;}
const bPaths=writeInput(b,'b'),expectedB=await analyzeFiles(b);
const large=syntheticInput(31);large.options.stationName='T5-PRIVATE-SYNTHETIC-C-31days';const largePaths=writeInput(large,'c'),expectedLarge=await analyzeFiles(large);
const zero=syntheticInput(1);zero.options.stationName='T5-PRIVATE-SYNTHETIC-ZERO';{const lines=new TextDecoder().decode(zero.power[0].bytes).trimEnd().split('\n');zero.power[0].bytes=new TextEncoder().encode(lines.map((line,i)=>{if(!i)return line;const cells=line.split(',');cells[2]='-0.1';return cells.join(',');}).join('\n')).buffer;}const zeroPaths=writeInput(zero,'zero');
const badPath=join(data,'invalid-header.csv');writeFileSync(badPath,'时间,可用功率,实发功率,AGC有功设定值\n2026-09-01 00:00:00,20,10,15\n');
if(!candidate){
const html=readFileSync(join(folder,'dashboard/dist/index.html'),'utf8');
assert.ok(!/<meta\b[^>]*\bname=["']data-app-local-thread["']/i.test(html));
const bootstrap=`<script>window.probeReady=true;window.testRequests=[];window.testErrors=[];history.replaceState(null,'',location.pathname+'?t0-harness');const originalFetch=window.fetch;window.fetch=function(input,options){window.testRequests.push({url:String(input),method:options?.method??'GET',body:options?.body??null});return originalFetch.apply(this,arguments);};window.addEventListener('error',e=>window.testErrors.push(e.message));window.addEventListener('unhandledrejection',e=>window.testErrors.push(String(e.reason)));</script>`;
writeFileSync(join(folder,'probe-build/index.html'),html.replace('</head>',bootstrap+'</head>'));
}
const p=await launchProbe(null,stage,candidate?{siteRoot:join(candidate,'site'),prefix:'',ready:'Boolean(window.__T0__ && document.querySelector(".wind-upload"))'}:{});
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function wait(expression,timeout=20000){const start=Date.now();while(Date.now()-start<timeout){if(await p.evaluate(expression))return;await delay(40);}throw new Error(`UI wait failed: ${expression}\n${await p.evaluate('document.body.innerText.slice(0,2500)')}`);}
async function clickText(text){await p.evaluate(`(()=>{const e=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()===${JSON.stringify(text)});if(!e)throw Error('button missing '+${JSON.stringify(text)});e.click();})()`);}
async function setValue(selector,value){
 const option=await p.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('missing input');if(e.tagName==='SELECT'){e.focus();return [...e.options].findIndex(o=>o.value===${JSON.stringify(value)});}Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));return null;})()`);
 if(option!==null){assert.ok(option>=0);await p.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.selectedIndex=${option};e.dispatchEvent(new Event('change',{bubbles:true}));})()`);}
 await p.evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
}
async function chooseFiles(paths){
 await p.evaluate(`document.querySelector('details.wind-upload').open=true`);
 const {root}=await p.call('DOM.getDocument',{},p.sessionId);
 for(const [kind,label] of [['power','分钟功率表文件'],['forecast','数据下载预测表文件']]){
  const {nodeId}=await p.call('DOM.querySelector',{nodeId:root.nodeId,selector:`input[aria-label="${label}"]`},p.sessionId);
  await p.call('DOM.setFileInputFiles',{nodeId,files:paths[kind]},p.sessionId);
 }
}
async function form(paths,options){await chooseFiles(paths);await setValue('input[aria-label="场站名称"]',options.stationName);await setValue('input[aria-label="装机容量"]',String(options.capacity));
 const dates=await p.evaluate('[...document.querySelectorAll(".wind-upload input[type=date]")].length');assert.equal(dates,2);
 await p.evaluate(`(()=>{const es=document.querySelectorAll('.wind-upload input[type=date]');[${JSON.stringify(options.start)},${JSON.stringify(options.end)}].forEach((v,i)=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(es[i],v);es[i].dispatchEvent(new Event('input',{bubbles:true}));es[i].dispatchEvent(new Event('change',{bubbles:true}));});})()`);
 await p.evaluate(`(()=>{const e=document.querySelector('.wind-confirm input');if(!e.checked)e.click();})()`);
 await wait('!document.querySelector(".wind-upload button[type=submit]").disabled');
}
async function state(){return p.evaluate('window.__T0__.state()');}
async function upload(paths,options){await form(paths,options);await clickText('校验并计算');await wait(`window.__T0__.state().stationName===${JSON.stringify(options.stationName)}`);}
async function exportKind(kind){const before=new Set(readdirSync(downloads));await setValue('select[aria-label="导出内容"]',kind);assert.equal(await p.evaluate('document.querySelector("select[aria-label=导出内容]").value'),kind);await clickText('导出所选内容');let file;for(let i=0;i<200;i++){file=readdirSync(downloads).find(f=>!before.has(f)&&!f.endsWith('.crdownload'));if(file)break;await delay(25);}assert.ok(file,`download ${kind}`);return {name:file,text:readFileSync(join(downloads,file),'utf8')};}
try{
 await p.call('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:downloads});
 await wait('Boolean(window.__T0__ && document.querySelector(".wind-upload"))');
 assert.ok(await p.evaluate('document.body.innerText.includes("合成示例")'));assert.ok(!await p.evaluate('document.querySelector("input[aria-label=装机容量]").value'));record('initial example is labeled and capacity is not assumed');
 await upload(aPaths,a.options);const stateA=await state();assert.equal(stateA.rowCount,2880);assert.deepEqual(stateA.summary,expectedA.summary);assert.equal(await p.evaluate('document.querySelectorAll(".wind-period").length'),1);assert.ok(!await p.evaluate('Boolean(document.querySelector(".wind-upload [role=alert]"))'));record('native file upload A → real Worker → atomic full-shell result',stateA);
 for(const invalid of [{code:'bad'},[{language:'text'}]]){await assert.rejects(p.evaluate(`window.__T0__.commitInvalidMethods(${JSON.stringify(invalid)})`),/methods/);assert.deepEqual(await state(),stateA);}record('invalid recorded methods are refused before any snapshot change');
 // Current-result export is a browser download, then independent full compare.
 let exported=await exportKind('json');const comparisonA=compareResults(expectedA,JSON.parse(exported.text));assert.ok(comparisonA.equal,JSON.stringify(comparisonA));record('A full JSON browser download equals entire core Result');
 await p.evaluate('document.querySelector("button[aria-label=隐藏可用功率]").click()');await clickText('预测限电面积');await setValue('select[aria-label="电量单位"]','万千瓦时');
 await setValue('.wind-day-selector select','2026-08-02');await clickText('凌晨');
 await p.evaluate('document.querySelector("details.wind-detail-table").open=true');await clickText('下一页');
 // Hold actual File reads only to inspect pending/cancel states reliably.
 await p.evaluate(`window.originalArrayBuffer=File.prototype.arrayBuffer;window.readGate=true;window.releaseReads=[];File.prototype.arrayBuffer=async function(){if(window.readGate)await new Promise(r=>window.releaseReads.push(r));return window.originalArrayBuffer.call(this);};`);
 await form(bPaths,b.options);await clickText('校验并计算');await wait('Boolean(document.querySelector(".wind-upload button[type=submit]").disabled)');assert.equal((await state()).stationName,stationA);assert.ok(await p.evaluate(`document.querySelector('[data-testid="computed-parameters"]').innerText.includes(${JSON.stringify(stationA)})`));record('B pending shows A computed parameters and retains A values');
 await clickText('取消计算');await p.evaluate('window.readGate=false;window.releaseReads.splice(0).forEach(r=>r())');await delay(180);assert.deepEqual(await state(),stateA);record('cancel during actual File preparation retains A and draft');
 await form({...bPaths,power:[badPath]},b.options);await clickText('校验并计算');await wait('Boolean(document.querySelector(".wind-upload [role=alert]"))');assert.ok(await p.evaluate('document.querySelector("details.wind-upload").open'));assert.deepEqual(await state(),stateA);record('bad B header preserves A and exposes retry error');
 await upload(bPaths,b.options);const stateB=await state();assert.deepEqual(stateB.summary,expectedB.summary);assert.ok(stateB.methods.some(m=>m.code.includes('Web Worker')));assert.ok(!JSON.stringify(stateB.methods).includes('upload_pipeline.py'));assert.equal(stateB.sourceName,stationB);assert.ok(stateB.sourcePeriod.includes('2026-09-01'));record('retry rereads files and B source/rows/summary update together',stateB);
 assert.equal(await p.evaluate('document.querySelector(".wind-day-selector select").value'),'2026-09-01');assert.equal(await p.evaluate('document.querySelector("input[aria-label=范围起点]").value'),'0');assert.equal(await p.evaluate('document.querySelector("input[aria-label=范围终点]").value'),'1440');assert.equal(await p.evaluate('document.querySelector("[data-curve=a]")'),null);assert.equal(await p.evaluate('document.querySelector("[data-area=prediction]")'),null);assert.equal(await p.evaluate('document.querySelector("select[aria-label=电量单位]").value'),'万千瓦时');assert.ok(await p.evaluate('document.querySelector(".wind-detail-table .wind-pagination").textContent.includes("1 / 72")'));record('B resets day/range/page and retains explicit visibility/units');
 for(const [curve,label] of [['a','可用功率'],['p','实发功率'],['g','AGC 指令'],['f','预测（线性插值）']]){
  const before=await p.evaluate(`Boolean(document.querySelector('[data-curve=${curve}]'))`);
  await p.evaluate(`document.querySelector('button[aria-label=${JSON.stringify((before?'隐藏':'显示')+label)}]').click()`);
  assert.notEqual(await p.evaluate(`Boolean(document.querySelector('[data-curve=${curve}]'))`),before);
 }
 await clickText('调度限电面积');assert.equal(await p.evaluate('Boolean(document.querySelector("[data-area=dispatch]"))'),false);assert.deepEqual((await state()).summary,expectedB.summary);record('four primary curve toggles and independent shading leave totals unchanged');
 // Actual keyboard and drag gesture in the full chart.
 await p.evaluate('document.querySelector("[data-testid=power-chart]").focus()');await p.call('Input.dispatchKeyEvent',{type:'keyDown',key:'Home',code:'Home'},p.sessionId);await p.call('Input.dispatchKeyEvent',{type:'keyUp',key:'Home',code:'Home'},p.sessionId);assert.equal(await p.evaluate('document.querySelector("[data-testid=minute-time]").textContent'),'00:00');
 const rect=await p.evaluate('(()=>{const r=document.querySelector("[data-testid=power-chart]").getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height}})()');
 await p.call('Input.dispatchMouseEvent',{type:'mousePressed',x:rect.x+rect.w*.25,y:rect.y+80,button:'left',clickCount:1},p.sessionId);await p.call('Input.dispatchMouseEvent',{type:'mouseMoved',x:rect.x+rect.w*.5,y:rect.y+80,button:'left',buttons:1},p.sessionId);await p.call('Input.dispatchMouseEvent',{type:'mouseReleased',x:rect.x+rect.w*.5,y:rect.y+80,button:'left',clickCount:1},p.sessionId);
 assert.ok(Number(await p.evaluate('document.querySelector("input[aria-label=范围起点]").value'))>0);record('keyboard minute inspection and actual drag selection');await clickText('全天');
 // Native shell source menu opens its real source inspector.
 await p.evaluate(`(()=>{const e=document.querySelector('[data-component-id="wind-power"] select[aria-label="功率曲线与限电面积 actions"]');e.value='0';e.dispatchEvent(new Event('change',{bubbles:true}));})()`);await wait('Boolean(document.querySelector(".source-sidebar"))');
 await wait(`document.querySelector('.source-sidebar')?.innerText.includes(${JSON.stringify(stationB)})`);
 const sourceText=await p.evaluate('document.querySelector(".source-sidebar").innerText');assert.ok(sourceText.includes(stationB));assert.ok(!sourceText.includes(stationA));assert.ok(sourceText.includes('2026-09-01'));for(const f of expectedB.meta.files)assert.ok(sourceText.includes(f.sha256));record('real source menu follows B station and period');
 await p.evaluate(`document.querySelector('button[aria-label="Close data source"]').click()`);await wait('!document.querySelector(".source-sidebar")');
 for(const kind of ['json','minutes','daily','gaps']){
  exported=await exportKind(kind);assert.ok(exported.name.includes(stationB));assert.ok(!exported.name.includes(stationA));
  if(kind==='json'){const comparison=compareResults(expectedB,JSON.parse(exported.text));assert.ok(comparison.equal,JSON.stringify(comparison));}
  else {assert.ok(exported.text.includes(stationB));assert.ok(!exported.text.includes(stationA));if(kind==='daily')assert.ok(exported.text.includes('覆盖率'));if(kind==='gaps')assert.ok(exported.text.includes('实发负值'));}
  record(`B ${kind} actual download has current identity and content`,{file:exported.name,bytes:Buffer.byteLength(exported.text)});
 }
 // Real product replay and theme controls; no direct root/style manipulation.
 await clickText('回放');const minuteBefore=await p.evaluate('document.querySelector("[data-testid=minute-time]").textContent');await delay(220);assert.notEqual(await p.evaluate('document.querySelector("[data-testid=minute-time]").textContent'),minuteBefore);await clickText('暂停');record('real minute replay advances and pauses');
 await setValue('select[aria-label="More"]','theme');await wait('Boolean(document.querySelector("select[aria-label=Appearance]"))');await setValue('select[aria-label="Appearance"]','dark');await p.evaluate(`document.querySelector('button[aria-label="Close theme picker"]').click()`);await wait('!document.querySelector(".theme-drawer.is-open")');assert.equal(await p.evaluate('document.documentElement.dataset.colorScheme'),'dark');const darkShot=await p.call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false},p.sessionId);writeFileSync(join(folder,'dark.png'),Buffer.from(darkShot.data,'base64'));record('native theme menu applies dark appearance');
 await form(largePaths,large.options);await clickText('校验并计算');await wait('document.querySelector(".wind-progress") && document.querySelector(".wind-progress").getAttribute("aria-label")!=="读取本地文件"');assert.equal((await state()).stationName,stationB);const cancelStart=performance.now();await clickText('取消计算');await wait('!document.querySelector(".wind-upload button[type=submit]").disabled');const cancelMs=performance.now()-cancelStart;await delay(160);assert.deepEqual(await state(),stateB);record('cancel while real Worker is active retains B',{buttonRoundTripMs:cancelMs});
 await clickText('回放');const started=performance.now();await upload(largePaths,large.options);assert.deepEqual((await state()).summary,expectedLarge.summary);assert.equal((await state()).rowCount,44640);assert.ok(await p.evaluate('document.querySelector(".wind-play").innerText.includes("回放")'));assert.equal(await p.evaluate('document.documentElement.dataset.colorScheme'),'dark');record('31 days render in actual full shell and reset replay while retaining theme',{elapsedMs:performance.now()-started,minutes:44640});
 await upload(zeroPaths,zero.options);assert.equal((await state()).summary.included,0);assert.ok(await p.evaluate('document.querySelector(".wind-period").innerText.includes("没有有效计算分钟")'));assert.ok(await p.evaluate('document.querySelector(".wind-daily-table tbody").textContent.includes("—")'));for(const kind of ['dispatch','prediction','other'])assert.ok(await p.evaluate(`document.querySelector('[data-testid=total-${kind}]').textContent.includes('—')`));record('zero valid minutes explicitly means no effective result, not zero loss');
 await upload(bPaths,b.options);await setValue('select[aria-label="More"]','theme');await wait('Boolean(document.querySelector("select[aria-label=Appearance]"))');await setValue('select[aria-label="Appearance"]','light');await p.evaluate(`document.querySelector('button[aria-label="Close theme picker"]').click()`);assert.equal(await p.evaluate('document.documentElement.dataset.colorScheme'),'light');record('native theme menu restores light appearance');
 // Persistent storage may contain shell appearance/layout, never user input/result.
 const storage=await p.evaluate(`(()=>{const read=s=>Object.fromEntries(Object.keys(s).map(k=>[k,s.getItem(k)]));return {local:read(localStorage),session:read(sessionStorage)}})()`);const storageText=JSON.stringify(storage);assert.ok(!storageText.includes(stationA)&&!storageText.includes(stationB)&&!storageText.includes('a-synthetic-power.csv')&&!storageText.includes('b-synthetic-power.csv'));assert.ok(!storageText.includes('dispatchState')&&!storageText.includes('T5-PRIVATE-SYNTHETIC'));const databases=await p.evaluate('indexedDB.databases().then(xs=>xs.map(x=>x.name))');assert.deepEqual(databases,[]);assert.equal(await p.evaluate('navigator.serviceWorker.getRegistrations().then(xs=>xs.length)'),0);assert.ok(!JSON.stringify(candidate?p.networkRequests:await p.evaluate('window.testRequests')).includes(stationA));assert.ok(p.requests.every(r=>r.method==='GET'&&r.bytes===0));assert.ok(!p.requests.some(r=>r.path.includes('/api/health')||r.path.includes('/api/calculate')));record('no calculation/health API, user marker or raw/result data in shell storage');
 // Separate real page uses its own memory session, even with shared appearance.
 const {targetId}=await p.call('Target.createTarget',{url:await p.evaluate('location.href')});const {sessionId:second}=await p.call('Target.attachToTarget',{targetId,flatten:true});let secondName;for(let i=0;i<100;i++){const r=await p.call('Runtime.evaluate',{expression:'window.__T0__?.state()?.stationName',returnByValue:true},second);secondName=r.result.value;if(secondName)break;await delay(40);}assert.ok(secondName&&!secondName.includes(stationA)&&!secondName.includes(stationB));await p.call('Target.closeTarget',{targetId});record('second browser tab starts independently with example');
 await p.call('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true},p.sessionId);await delay(120);assert.ok(await p.evaluate('document.documentElement.scrollWidth<=window.innerWidth+1'));const shot=await p.call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false},p.sessionId);writeFileSync(join(folder,'narrow.png'),Buffer.from(shot.data,'base64'));await p.evaluate('document.querySelector(".wind-chart-card").scrollIntoView({block:"start"})');const chartShot=await p.call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false},p.sessionId);writeFileSync(join(folder,'narrow-chart.png'),Buffer.from(chartShot.data,'base64'));record('390px layout stays within viewport');
 await p.call('Emulation.clearDeviceMetricsOverride',{},p.sessionId);
 assert.deepEqual(candidate?p.browserErrors:await p.evaluate('window.testErrors'),[]);
 writeFileSync(join(folder,'session-ui.json'),JSON.stringify({passed:true,browser:p.version,checks,requests:p.requests,storage,sourceText},null,2)+'\n');
 console.log(`T5 full-shell UI: ${checks.length} checks passed`);
}catch(error){writeFileSync(join(folder,'session-ui-failure.json'),JSON.stringify({error:String(error),checks,body:await p.evaluate('document.body.innerText.slice(0,5000)'),requests:p.requests},null,2));throw error;}finally{await p.close();}
