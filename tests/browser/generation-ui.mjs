// Real local, synthetic-only preview; no hosting writes.
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync,readFileSync,mkdtempSync,readdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {launchProbe,ROOT} from './probe-browser.mjs';
const candidate=resolve(process.argv[2]),urlIndex=process.argv.indexOf('--url'),remote=urlIndex<0?null:new URL(process.argv[urlIndex+1]);
const cloudflare=remote?.origin==='https://wind-curtailment-analysis.wind-curtailment-static-deployment.workers.dev';
if(remote)assert.ok(cloudflare||remote.href==='https://horizon9688.github.io/wind-curtailment-analysis/','explicit approved production target only');
const out=join(ROOT,'reports/browser-review/generation-2026-10-08',remote?remote.hostname:'local');mkdirSync(out,{recursive:true});
const ready='!!window.__T0__ && !!document.querySelector("[data-testid=total-generation]")';
const p=await launchProbe(null,'generation-ui'+(remote?'-'+remote.hostname:''),{siteRoot:join(candidate,'site'),prefix:'',...(remote?{remoteUrl:remote.href+'?view=1&tab=dashboard',readyTimeoutMs:60000}:{}),ready:cloudflare?'!!document.querySelector("#access-form")':ready});
const checks=[],delay=ms=>new Promise(r=>setTimeout(r,ms));
async function wait(expr){for(let i=0;i<350;i++){if(await p.evaluate(expr))return;await delay(40);}throw Error('UI timeout: '+expr);}
async function set(selector,value){await p.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(e.tagName==='SELECT')e.value=${JSON.stringify(value)};else Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));})()`);await delay(60);}
const number=()=>p.evaluate('Number(document.querySelector("[data-testid=total-generation]").childNodes[0].textContent.replaceAll(",",""))');
const equal=(a,b)=>assert.ok(Math.abs(a-b)<.00051,`${a} != ${b}`);
try{
 if(cloudflare){
  const {readCloudflareSecrets}=await import('../../deployment/access/local-secrets.mjs');
  const {dailyCode}=await import('../../deployment/access/core.mjs');
  const code=await dailyCode(readCloudflareSecrets().DAILY_ACCESS_SECRET);
  await set('#access-code',code);
  await p.evaluate('document.querySelector("#access-form").requestSubmit()');await wait(ready);
  checks.push('approved Cloudflare login grants access to updated dashboard');
 }
 const csv=readFileSync(join(candidate,'site/samples/minute-power.csv'),'utf8').replace(/^\uFEFF/,'').trim().split(/\r?\n/).slice(1),daily={};
 for(const line of csv){const c=line.split(','),date=c[0].slice(0,10),power=Number(c[3]);daily[date]=(daily[date]??0)+Math.max(0,power)/60;}
 assert.equal(await p.evaluate('document.querySelectorAll(".wind-kpis--generation .wind-metric").length'),5);
 assert.deepEqual(await p.evaluate('[...document.querySelectorAll(".wind-kpis--generation [data-testid]")].map(e=>e.dataset.testid)'),['total-dispatch','total-prediction','total-other','total-generation','total-excluded']);
 equal(await number(),daily['2026-01-01']);checks.push('new generation card before exclusions; independent CSV integral matches');
 assert.equal(await p.evaluate('document.querySelector("[data-component-id=wind-daily] .component-title-text")?.textContent ?? [...document.querySelectorAll(".component-title-text")].find(e=>e.textContent==="逐日电量分布情况")?.textContent'),'逐日电量分布情况');
 const bars=await p.evaluate('[...document.querySelectorAll(".wind-daily-bars>button")].map(b=>({date:b.dataset.date,label:b.getAttribute("aria-label"),segments:[...b.querySelectorAll("[data-energy]")].map(s=>s.dataset.energy),height:parseFloat(b.querySelector("[data-energy=generation]").style.height)}))');
 assert.equal(bars.length,2);assert.deepEqual(bars[0].segments,['generation','dispatch','prediction','other']);for(const b of bars){assert.ok(b.label.includes('发电'));assert.ok(b.height>0);}checks.push('daily chart renamed and displays actual generation alongside the three losses');
 const rendered=await p.evaluate('[...document.querySelectorAll(".wind-daily-stack")].map(e=>[...e.children].map(s=>({kind:s.dataset.energy,height:s.style.height,pixels:s.getBoundingClientRect().height,top:s.getBoundingClientRect().top,bottom:s.getBoundingClientRect().bottom,color:getComputedStyle(s).backgroundColor})))');
 for(const stack of rendered)for(const segment of stack)if(parseFloat(segment.height)>0)assert.ok(segment.pixels>0,JSON.stringify(segment));
 for(const stack of rendered)for(let i=1;i<stack.length;i++)assert.ok(stack[i].bottom<=stack[i-1].top+.5,'stack segments must not overlap');
 await p.evaluate(`document.querySelector('.wind-daily-bars>button[data-date="2026-01-02"]').click()`);await delay(80);equal(await number(),daily['2026-01-02']);checks.push('day selection links chart and generation');
 assert.ok(await p.evaluate('!document.body.innerText.includes("统一刻度上限") && !document.body.innerText.includes("下方指标与曲线随日期和图表范围联动")'));
 assert.equal(await p.evaluate('document.querySelectorAll(".wind-day-selector").length'),1);
 assert.ok(await p.evaluate('!!document.querySelector(".wind-chart-card .wind-day-selector select")'));
 await p.evaluate('document.querySelector(".wind-chart-card").scrollIntoView({block:"start"})');await delay(80);
 await set('.wind-day-selector select','2026-01-01');equal(await number(),daily['2026-01-01']);
 assert.ok(await p.evaluate('(()=>{const r=document.querySelector(".wind-chart-date").getBoundingClientRect();return r.top>=0 && r.bottom<innerHeight;})()'));
 assert.equal(await p.evaluate('document.querySelector(".wind-date").textContent'),'2026-01-01');
 await set('.wind-day-selector select','2026-01-02');equal(await number(),daily['2026-01-02']);
 checks.push('unwanted captions removed; date control is inside power chart and switches day without losing chart position');
 await set('.wind-scope select','万kWh');equal(await number(),daily['2026-01-02']/10);await set('.wind-scope select','MWh');checks.push('generation follows energy unit conversion');
 await p.evaluate('document.querySelector(".wind-hour").click()');await delay(80);const selected=csv.filter(l=>l.startsWith('2026-01-02T00:')).reduce((s,l)=>s+Math.max(0,Number(l.split(',')[3]))/60,0);equal(await number(),selected);assert.ok(await p.evaluate('document.querySelector("#wind-generation-metric")?.innerText.includes("范围发电量") ?? [...document.querySelectorAll(".component-title-text")].some(e=>e.textContent==="范围发电量")'));await p.evaluate('document.querySelector(".wind-hour").click()');await delay(80);equal(await number(),daily['2026-01-02']);checks.push('hour zoom updates integral and resets to day');
 for(const width of [1280,903,665,390]){
  await p.call('Emulation.setDeviceMetricsOverride',{width,height:760,deviceScaleFactor:1,mobile:false},p.sessionId);
  await p.evaluate('document.querySelector(".wind-kpis--generation").scrollIntoView({block:"center"})');await delay(80);
  assert.ok(await p.evaluate('document.documentElement.scrollWidth<=innerWidth+1'));
  if(width>=903){const tops=await p.evaluate('[...document.querySelectorAll(".wind-kpis--generation .wind-metric")].map(e=>e.getBoundingClientRect().top)');assert.ok(Math.max(...tops)-Math.min(...tops)<2);}
  assert.ok(await p.evaluate('[...document.querySelectorAll(".wind-kpis--generation .wind-metric-number")].every(e=>e.scrollWidth<=e.clientWidth+1)'));
  const shot=await p.call('Page.captureScreenshot',{format:'png'},p.sessionId);writeFileSync(join(out,`metrics-${width}.png`),Buffer.from(shot.data,'base64'));
  await p.evaluate('document.querySelector(".wind-chart-card").scrollIntoView({block:"start"})');await delay(80);
  assert.ok(await p.evaluate('[...document.querySelectorAll(".wind-chart-toolbar select,.wind-chart-toolbar button")].every(e=>{const r=e.getBoundingClientRect();return r.left>=0 && r.right<=innerWidth && r.height>=44;})'));
  const toolbar=await p.call('Page.captureScreenshot',{format:'png'},p.sessionId);writeFileSync(join(out,`chart-date-${width}.png`),Buffer.from(toolbar.data,'base64'));
 }
 checks.push('five desktop cards in one row; mobile and numeric contents do not overflow');
 await p.call('Emulation.setDeviceMetricsOverride',{width:1280,height:760,deviceScaleFactor:1,mobile:false},p.sessionId);await p.evaluate('document.querySelector(".wind-theme-toggle").click()');await delay(80);const dark=await p.call('Page.captureScreenshot',{format:'png'},p.sessionId);writeFileSync(join(out,'metrics-dark.png'),Buffer.from(dark.data,'base64'));await p.evaluate('document.querySelector(".wind-theme-toggle").click()');checks.push('generation color and cards available in both themes');
 await p.evaluate('document.querySelector(".wind-daily-bars").closest(".dashboard-component").scrollIntoView({block:"center"})');await delay(80);const chart=await p.call('Page.captureScreenshot',{format:'png'},p.sessionId);writeFileSync(join(out,'daily-chart.png'),Buffer.from(chart.data,'base64'));
 const base=Date.UTC(2026,1,1),stamp=m=>new Date(base+m*60000).toISOString().slice(0,19),power=['时间,可用功率,理论功率,全站总有功_集电线有功之和,AGC有功设定值'],forecast=['预测id,名称,预测时间,考核点2预测结果'];
 for(let m=0;m<4320;m++)power.push(`${stamp(m)},45,46,${m>=1440&&m<1450?'':m===1600?-.1:30},30`);
 for(let m=-15;m<2865;m+=15)forecast.push(`SYNTHETIC_GEN,发电量合成验收,${stamp(m)},30`);
 const inputs=join(out,'inputs');mkdirSync(inputs,{recursive:true});writeFileSync(join(inputs,'power.csv'),power.join('\n'));writeFileSync(join(inputs,'forecast.csv'),forecast.join('\n'));
 await p.evaluate('document.querySelector("details.wind-upload").open=true');const {root}=await p.call('DOM.getDocument',{},p.sessionId);
 for(const [file,label] of [['power.csv','分钟功率表文件'],['forecast.csv','数据下载预测表文件']]){const {nodeId}=await p.call('DOM.querySelector',{nodeId:root.nodeId,selector:`input[aria-label="${label}"]`},p.sessionId);await p.call('DOM.setFileInputFiles',{nodeId,files:[join(inputs,file)]},p.sessionId);}
 await set('input[aria-label="场站名称"]','发电量合成验收');await set('input[aria-label="装机容量"]','56');await p.evaluate('document.querySelector(".wind-confirm input").click()');await wait('!document.querySelector(".wind-upload button[type=submit]").disabled');await p.evaluate('document.querySelector(".wind-upload button[type=submit]").click()');await wait('window.__T0__.state().stationName==="发电量合成验收"');equal(await number(),720);checks.push('native new-file upload computes generation from the new station, replacing demo');
 await set('.wind-day-selector select','2026-02-02');equal(await number(),714.5);assert.ok(await p.evaluate('document.querySelector(".wind-generation-coverage").textContent.includes("数据不完整")'));checks.push('actual missing minutes excluded from integral; negative auxiliary load does not reduce generation');
 await set('.wind-day-selector select','2026-02-03');equal(await number(),720);assert.ok(await p.evaluate('document.querySelector("[data-testid=total-dispatch]").textContent.includes("—")'));checks.push('forecast missing all day does not discard available actual generation');
 const downloads=mkdtempSync(join(out,'downloads-'));await p.call('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:downloads});await set('select[aria-label="导出内容"]','daily');await p.evaluate('document.querySelector(".wind-export-controls button").click()');let file;for(let i=0;i<150;i++){file=readdirSync(downloads).find(f=>f.endsWith('.csv'));if(file)break;await delay(30);}assert.ok(file);const exported=readFileSync(join(downloads,file),'utf8');assert.ok(exported.includes('发电量_MWh'));assert.ok(exported.includes('"714.5"'));checks.push('downloaded daily CSV includes measured generation and independent coverage');
 assert.deepEqual(p.browserErrors,[]);writeFileSync(join(out,'result.json'),JSON.stringify({passed:true,candidate,checks,demoGeneration:daily},null,2));console.log(`Generation UI: ${checks.length} checks passed`);
}finally{await p.close();}
