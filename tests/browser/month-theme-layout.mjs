/** Native synthetic file uploads exercise month paging and the floating theme control. */
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync,readFileSync,readdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {launchProbe,ROOT} from './probe-browser.mjs';
const candidate=resolve(process.argv[2]);
const monthsOnly=process.argv.includes('--months-only');
const out=join(ROOT,'reports/browser-review/month-theme-2026-10-07');mkdirSync(out,{recursive:true});
const p=await launchProbe(null,'month-theme',{siteRoot:join(candidate,'site'),prefix:'',ready:'Boolean(window.__T0__ && document.querySelector(".wind-upload"))'});
const checks=[],delay=ms=>new Promise(r=>setTimeout(r,ms));
const settle=()=>p.evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
async function wait(expr){for(let i=0;i<500;i++){if(await p.evaluate(expr))return;await delay(40);}throw Error('UI wait: '+expr);}
async function set(selector,value){await p.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(e.tagName==='SELECT')e.value=${JSON.stringify(value)};else{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));}e.dispatchEvent(new Event('change',{bubbles:true}));})()`);await settle();}
async function click(selector){await p.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);await settle();}
function inputs(days){
 const start=Date.UTC(2025,11,1),stamp=m=>new Date(start+m*60000).toISOString().slice(0,19);
 const power=['时间,可用功率,理论功率,全站总有功_集电线有功之和,AGC有功设定值'];
 for(let m=0;m<days*1440;m++)power.push(`${stamp(m)},45,46,36,36`);
 const forecast=['预测id,名称,预测时间,考核点2预测结果'];
 for(let m=-15;m<=days*1440;m+=15)forecast.push(`SYNTHETIC_MONTH,月份测试合成场站,${stamp(m)},36`);
 const directory=join(out,`inputs-${days}`);mkdirSync(directory,{recursive:true});
 writeFileSync(join(directory,'power.csv'),power.join('\n')+'\n');writeFileSync(join(directory,'forecast.csv'),forecast.join('\n')+'\n');
 return directory;
}
async function upload(days){
 const directory=inputs(days);await p.evaluate('document.querySelector("details.wind-upload").open=true');
 const {root}=await p.call('DOM.getDocument',{},p.sessionId);
 for(const [file,label] of [['power','分钟功率表文件'],['forecast','数据下载预测表文件']]){const {nodeId}=await p.call('DOM.querySelector',{nodeId:root.nodeId,selector:`input[aria-label="${label}"]`},p.sessionId);await p.call('DOM.setFileInputFiles',{nodeId,files:[join(directory,`${file}.csv`)]},p.sessionId);}
 await set('input[aria-label="场站名称"]',`合成月份测试-${days}`);await set('input[aria-label="装机容量"]','56');
 await p.evaluate('document.querySelector(".wind-confirm input").click()');await settle();
 await wait('!document.querySelector(".wind-upload button[type=submit]").disabled');await click('.wind-upload button[type=submit]');
 await wait(`window.__T0__.state().stationName==='合成月份测试-${days}'`);
}
const dates=()=>p.evaluate(`[...document.querySelectorAll('.wind-daily-bars>button')].map(b=>b.getAttribute('aria-label').slice(0,10))`);
try{
 if(!monthsOnly){
  assert.equal(await p.evaluate('document.querySelectorAll(".wind-theme-toggle").length'),1,'standalone theme control must float at viewport edge');
  assert.equal(await p.evaluate('document.querySelector(".wind-theme-toggle").textContent.trim()'),'');
  assert.equal(await p.evaluate('getComputedStyle(document.querySelector(".wind-theme-toggle")).position'),'fixed');
  const before=await p.evaluate('document.documentElement.dataset.colorScheme');
  await click('.wind-theme-toggle');await wait(`document.documentElement.dataset.colorScheme!==${JSON.stringify(before)}`);
  assert.ok(await p.evaluate('document.querySelector(".wind-theme-toggle").getAttribute("aria-label").includes("切换")'));
  await p.evaluate('document.querySelector(".wind-theme-toggle").focus()');
  await p.call('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',text:'\r',windowsVirtualKeyCode:13},p.sessionId);
  await p.call('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13},p.sessionId);
  await wait(`document.documentElement.dataset.colorScheme===${JSON.stringify(before)}`);
  checks.push('icon-only floating theme button switches both ways with click and Enter');
  await p.evaluate('document.querySelector(".wind-theme-toggle").blur()');
  await p.call('Input.dispatchMouseEvent',{type:'mouseMoved',x:100,y:200},p.sessionId);await delay(250);
  let rect=await p.evaluate('(()=>{const r=document.querySelector(".wind-theme-toggle").getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height,visible:document.documentElement.clientWidth-r.x}})()');
  assert.ok(rect.visible<rect.w/2 && rect.visible>=16,JSON.stringify(rect));
  await p.call('Input.dispatchMouseEvent',{type:'mouseMoved',x:rect.x+8,y:rect.y+rect.h/2},p.sessionId);await delay(250);
  assert.ok(await p.evaluate('(()=>{const r=document.querySelector(".wind-theme-toggle").getBoundingClientRect();return r.right<=document.documentElement.clientWidth&&r.width>=44&&r.height>=44})()'));
  checks.push('desktop button is mostly tucked away and slides fully in on pointer hover');
  await p.call('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]},p.sessionId);
  assert.equal(await p.evaluate('getComputedStyle(document.querySelector(".wind-theme-toggle")).transitionDuration'),'0s');
  checks.push('theme motion respects reduced-motion preference');
 }
 assert.equal(await p.evaluate('document.querySelectorAll(".wind-month-switcher").length'),0);
 await upload(31);assert.equal((await dates()).length,31);assert.equal(await p.evaluate('document.querySelectorAll(".wind-month-switcher").length'),0);
 checks.push('31-day reports retain their original unpaged daily view');
 await upload(32);assert.equal((await dates()).length,31);assert.equal(await p.evaluate('document.querySelectorAll(".wind-month-switcher button").length'),2);
 await click('.wind-month-switcher button[data-month="2026-01"]');assert.deepEqual(await dates(),['2026-01-01']);
 checks.push('paging begins strictly above 31 days and handles a one-day partial month');
 await upload(62);assert.equal((await dates()).length,31);
 const beforeSwitch=await p.evaluate('window.__T0__.state()');
 await click('.wind-month-switcher button[data-month="2026-01"]');
 assert.ok((await dates()).every(d=>d.startsWith('2026-01')));assert.equal((await dates()).length,31);
 assert.equal(await p.evaluate('document.querySelector(".wind-day-selector select").value'),'2026-01-01');
 assert.equal(await p.evaluate('document.querySelectorAll(".wind-daily-table tbody tr").length'),31);
 assert.equal(await p.evaluate('document.querySelector(\'.wind-month-switcher [aria-pressed="true"]\').dataset.month'),'2026-01');
 assert.deepEqual(await p.evaluate('window.__T0__.state()'),beforeSwitch);
 checks.push('cross-year months filter only chart/table and preserve complete calculation totals');
 await set('.wind-day-selector select','2025-12-30');assert.ok((await dates()).every(d=>d.startsWith('2025-12')));
 await click('.wind-daily-bars>button:last-child');assert.equal(await p.evaluate('document.querySelector(".wind-day-selector select").value'),'2025-12-31');
 checks.push('date selector and daily bar clicks stay synchronized with the month window');
 const downloads=join(out,'downloads-'+Date.now());mkdirSync(downloads,{recursive:true});await p.call('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:downloads});
 await set('select[aria-label="导出内容"]','daily');await click('.wind-export-controls>button');
 let file;for(let i=0;i<200;i++){file=readdirSync(downloads).find(f=>!f.endsWith('.crdownload'));if(file)break;await delay(25);}assert.ok(file);
 const text=readFileSync(join(downloads,file),'utf8');assert.ok(text.includes('2025-12-01')&&text.includes('2026-01-31'));assert.equal(text.trim().split(/\r?\n/).length,63);
 checks.push('daily export retains all 62 days despite chart month selection');
 for(const [width,height] of [[1280,900],[665,605],[390,844]]){
  await p.call('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:width<700},p.sessionId);
  if(width<700)await p.call('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:1},p.sessionId);
  await p.evaluate('document.querySelector("[data-component-id=wind-daily]").scrollIntoView({block:"start"})');await delay(200);
  assert.ok(await p.evaluate('document.documentElement.scrollWidth<=innerWidth+1'));
  const screenshot=await p.call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false},p.sessionId);writeFileSync(join(out,`months-${width}.png`),Buffer.from(screenshot.data,'base64'));
  await p.evaluate('window.scrollTo(0,0)');await delay(200);
  if(!monthsOnly&&width<700){const r=await p.evaluate('(()=>{const r=document.querySelector(".wind-theme-toggle").getBoundingClientRect();return {right:r.right,width:r.width}})()');assert.ok(r.right<=width,JSON.stringify(r));}
  const top=await p.call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false},p.sessionId);writeFileSync(join(out,`top-${width}.png`),Buffer.from(top.data,'base64'));
 }
 checks.push('desktop, 665px and 390px layouts fit the viewport; touch theme control stays visible');
 await upload(2);assert.equal(await p.evaluate('document.querySelectorAll(".wind-month-switcher").length'),0);assert.equal((await dates()).length,2);
 checks.push('replacement by a short report resets month controls without stale dates');
 assert.deepEqual(p.browserErrors,[]);
 writeFileSync(join(out,'result.json'),JSON.stringify({passed:true,candidate,checks},null,2)+'\n');
 console.log(`Month/theme layout: ${checks.length} checks passed`);
}finally{await p.close();}
