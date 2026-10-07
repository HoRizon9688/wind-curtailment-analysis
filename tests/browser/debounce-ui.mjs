/** Native file inputs and a real built Worker; twelve hand-calculated minutes. */
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync,readdirSync,readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {launchProbe,ROOT} from './probe-browser.mjs';
const out=join(ROOT,'reports/browser-review/debounce-2026-10-07');mkdirSync(out,{recursive:true});
const data=join(out,'input');mkdirSync(data,{recursive:true});
const downloads=join(out,`downloads-${Date.now()}`);mkdirSync(downloads,{recursive:true});
writeFileSync(join(data,'power.csv'),'时间,可用功率,全站总有功_集电线有功之和,AGC有功设定值\n'+[60,60,60,79.5,79.5,79.5,60,60,60,95,95,95].map((g,i)=>`2026-08-01 00:${String(i).padStart(2,'0')},100,60,${g}`).join('\n'));
writeFileSync(join(data,'forecast.csv'),'预测id,名称,预测时间,考核点2预测结果\nS,防抖手算场站,2026-07-31 23:45,80\nS,防抖手算场站,2026-08-01 00:00,80\n');
const p=await launchProbe(null,'debounce-ui',{siteRoot:join(resolve(process.argv[2]),'site'),prefix:'',ready:'Boolean(window.__T0__ && document.querySelector(".wind-upload"))'});
const wait=async e=>{for(let i=0;i<500;i++){if(await p.evaluate(e))return;await new Promise(r=>setTimeout(r,40));}throw Error('UI wait: '+e);};
const set=async(selector,value)=>{await p.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});const proto=e.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));})()`);};
try{
  await p.call('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:downloads});
  await p.evaluate('document.querySelector("details.wind-upload").open=true');
  const {root}=await p.call('DOM.getDocument',{},p.sessionId);
  for(const [label,name] of [['分钟功率表文件','power.csv'],['数据下载预测表文件','forecast.csv']]){
    const {nodeId}=await p.call('DOM.querySelector',{nodeId:root.nodeId,selector:`input[aria-label="${label}"]`},p.sessionId);
    await p.call('DOM.setFileInputFiles',{nodeId,files:[join(data,name)]},p.sessionId);
  }
  await set('input[aria-label="装机容量"]','100');
  await p.evaluate('document.querySelector(".wind-confirm input").click()');
  await wait('!document.querySelector(".wind-upload button[type=submit]").disabled');
  await p.evaluate('document.querySelector(".wind-upload button[type=submit]").click()');
  await wait('window.__T0__.state().stationName === "防抖手算场站"');
  await set('select[aria-label="导出内容"]','json');
  await p.evaluate('[...document.querySelectorAll("button")].find(e=>e.textContent.trim()==="导出所选内容").click()');
  await wait('true');
  let name;
  for(let i=0;i<200;i++){name=readdirSync(downloads).find(n=>n.endsWith('.json'));if(name)break;await new Promise(r=>setTimeout(r,40));}
  assert.ok(name);const r=JSON.parse(readFileSync(join(downloads,name),'utf8'));
  assert.deepEqual(r.rows.slice(0,6).map(x=>x.dispatchState),[false,false,true,true,true,false]);
  assert.equal(r.meta.thresholds.dispatchEnterPct,1);assert.equal(r.meta.thresholds.dispatchExitPct,.5);
  assert.equal(r.meta.thresholds.dispatchEnterMinutes,3);assert.equal(r.meta.thresholds.dispatchExitMinutes,3);
  for(const x of r.rows.slice(0,2)){assert.equal(x.prediction,0);assert.equal(x.dispatch,0);assert.equal(x.unexplainedAbove*60,40);assert.match(x.note,/进入待确认/);}
  assert.equal(r.rows[2].dispatch*60,20);assert.equal(r.rows[2].prediction*60,20);
  assert.deepEqual(r.rows.slice(6,12).map(x=>x.dispatchState),[false,false,true,true,true,false]);
  for(const x of r.rows.slice(9,11)){assert.equal(x.prediction,0);assert.equal(x.dispatch,0);assert.equal(x.unexplainedAbove*60,5);assert.match(x.note,/原因待核实/);}
  assert.equal(r.summary.included,12);assert.ok(Math.abs(r.summary.dispatch-41/60)<1e-10);
  assert.ok(await p.evaluate('document.querySelector(".wind-method").textContent.includes("连续3个有效分钟")'));
  assert.equal(p.browserErrors.length,0);
  writeFileSync(join(out,'checks.json'),JSON.stringify({passed:true,nativeUpload:true,realWorker:true,causalStates:r.rows.slice(0,12).map(x=>x.dispatchState),highAgcExitProtection:true,handDispatchMWh:41/60,thresholds:r.meta.thresholds},null,2));
  console.log('PASS built-page native upload → real Worker → 12 independent hand minutes including high-AGC exit → JSON export and updated method copy');
}finally{await p.close();}
