/** Synthetic 366-day actual static shell; no real data, no production test hooks. */
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {syntheticInput} from './performance-input.mjs';
import {launchProbe,ROOT} from './probe-browser.mjs';
import {oracle,oracleInput} from './python-oracle.mjs';
import {compareResults} from './compare.mjs';
const candidate=resolve(process.argv[2]),folder=join(ROOT,'reports/browser-review/RG3-annual');mkdirSync(folder,{recursive:true});
const input=syntheticInput(366);input.options.stationName='RG3-SYNTHETIC-366-DAYS';
const files=Object.fromEntries(['power','forecast'].map(kind=>[kind,input[kind].map(f=>{const path=join(folder,f.name);writeFileSync(path,new Uint8Array(f.bytes));return path;})]));
const expected=await oracle({mode:'analyze',input:oracleInput(input),projection:['summary']});
const p=await launchProbe(null,'RG3-annual',{siteRoot:join(candidate,'site'),prefix:'',ready:'Boolean(window.__T0__)'});
const delay=ms=>new Promise(r=>setTimeout(r,ms)),checks=[];
async function set(selector,value){await p.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));})()`);}
try{
 await p.evaluate('document.querySelector("details.wind-upload").open=true');const {root}=await p.call('DOM.getDocument',{},p.sessionId);
 for(const [kind,label] of [['power','分钟功率表文件'],['forecast','数据下载预测表文件']]){const {nodeId}=await p.call('DOM.querySelector',{nodeId:root.nodeId,selector:`input[aria-label="${label}"]`},p.sessionId);await p.call('DOM.setFileInputFiles',{nodeId,files:files[kind]},p.sessionId);}
 await set('input[aria-label="场站名称"]',input.options.stationName);await set('input[aria-label="装机容量"]','56');
 await p.evaluate(`(()=>{const es=document.querySelectorAll('.wind-upload input[type=date]');${JSON.stringify([input.options.start,input.options.end])}.forEach((v,i)=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(es[i],v);es[i].dispatchEvent(new Event('input',{bubbles:true}));es[i].dispatchEvent(new Event('change',{bubbles:true}));});document.querySelector('.wind-confirm input').click();})()`);
 await p.evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
 assert.equal(await p.evaluate('document.querySelector(".wind-upload button[type=submit]").disabled'),false);
 await p.evaluate(`window.annualTasks=[];window.annualObserver=new PerformanceObserver(xs=>window.annualTasks.push(...xs.getEntries().map(e=>({start:e.startTime,duration:e.duration}))));window.annualObserver.observe({type:'longtask',buffered:false});`);
 if(process.argv.includes('--profile')){await p.call('Profiler.enable',{},p.sessionId);await p.call('Profiler.start',{},p.sessionId);}
 const began=performance.now();await p.evaluate('document.querySelector(".wind-upload button[type=submit]").click()');
 let ready=false;for(let i=0;i<2400;i++){if(await p.evaluate(`window.__T0__.state().stationName===${JSON.stringify(input.options.stationName)}`)){ready=true;break;}await delay(50);}assert.ok(ready,'Annual real-shell calculation timed out');
 await p.evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
 const elapsedMs=performance.now()-began,state=await p.evaluate('window.__T0__.state()');assert.equal(state.rowCount,527040);assert.equal(state.dailyDates.length,366);
 if(process.argv.includes('--profile')){const {profile}=await p.call('Profiler.stop',{},p.sessionId);writeFileSync(join(folder,'annual-cpu-profile.json'),JSON.stringify(profile));}
 const comparison=compareResults(expected,{summary:state.summary});assert.ok(comparison.equal);checks.push('366-day actual Worker and full shell summary match fresh Python');
 const dayStart=performance.now();await p.evaluate(`(()=>{const e=document.querySelector('.wind-day-selector select');e.value=${JSON.stringify(input.options.end)};e.dispatchEvent(new Event('change',{bubbles:true}));})()`);await p.evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
 const lastDayMs=performance.now()-dayStart;assert.equal(await p.evaluate('document.querySelector(".wind-date").textContent'),input.options.end);assert.equal(await p.evaluate('document.querySelectorAll(".wind-hour").length'),24);checks.push('last day and 24-hour chart render');
 const tasks=await p.evaluate('window.annualTasks'),heap=await p.evaluate('performance.memory?{used:performance.memory.usedJSHeapSize,total:performance.memory.totalJSHeapSize,limit:performance.memory.jsHeapSizeLimit}:null');
 assert.deepEqual(p.browserErrors,[]);assert.ok(p.networkRequests.every(r=>r.method==='GET'&&r.postData===null&&(!/^https?:/.test(r.url)||r.url.startsWith(p.origin))));
 const responsive=Math.max(0,...tasks.map(t=>t.duration))<=1000;
 const report={passed:responsive,calculationAndDisplayPassed:true,responsivenessPassed:responsive,browser:p.version,checks,rows:527040,inputBytes:input.power[0].bytes.byteLength+input.forecast[0].bytes.byteLength,elapsedMs,lastDayMs,longTasks:tasks,maxLongTaskMs:Math.max(0,...tasks.map(t=>t.duration)),heap,comparison};
 writeFileSync(join(folder,'annual-ui.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({annualUiPassed:responsive,calculationAndDisplayPassed:true,rows:527040,elapsedMs,lastDayMs,maxLongTaskMs:report.maxLongTaskMs,heap}));
 assert.equal(report.responsivenessPassed,true,'Actual annual shell has a main-thread task longer than 1 second; see annual-ui.json');
}catch(error){writeFileSync(join(folder,'annual-ui-failure.json'),JSON.stringify({error:String(error),checks},null,2));throw error;}finally{await p.close();}
