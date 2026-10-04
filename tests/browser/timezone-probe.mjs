/** Actual Chrome, public module graph, four emulated browser timezones.
 * No UI/Worker integration is claimed here; that remains T4/T5.
 */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {existsSync,mkdirSync,writeFileSync,createReadStream,statSync} from 'node:fs';
import {dirname,join,resolve,relative,sep,extname,basename} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {tmpdir} from 'node:os';
import {loadJson,loadExpected} from './fixture-tools.mjs';
import {compareResults} from './compare.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const out=join(root,'reports/browser-review/T2-T3/timezone-build');
const {build}=await import(pathToFileURL(join(root,'dashboard/node_modules/vite/dist/node/index.js')));
await build({root:join(root,'dashboard'),configFile:false,logLevel:'warn',build:{outDir:out,emptyOutDir:true,target:'es2022',lib:{entry:join(root,'tests/browser/timezone-probe-page.mjs'),formats:['es'],fileName:()=> 'probe.js'}}});
writeFileSync(join(out,'index.html'),'<!doctype html><title>T2/T3 synthetic timezones</title><script type="module" src="./probe.js"></script>');
const requests=[];
const prefix='/'+encodeURIComponent(basename(root));
const server=createServer((req,res)=>{
  requests.push({method:req.method,path:req.url});
  const path=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
  const target=resolve(dirname(root),'.'+path),rel=relative(root,target);
  if(rel.startsWith('..')||rel.startsWith(sep)||!existsSync(target)||!statSync(target).isFile()){res.writeHead(404).end();return;}
  res.setHeader('content-type',extname(target)==='.html'?'text/html; charset=utf-8':extname(target)==='.js'?'text/javascript; charset=utf-8':'application/octet-stream');
  createReadStream(target).pipe(res);
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const origin=`http://127.0.0.1:${server.address().port}`;
const chrome=['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
if(!chrome)throw new Error('Chrome/Edge not installed');
const profile=join(tmpdir(),`wind-t23-timezone-${process.pid}`);mkdirSync(profile,{recursive:true});
const child=spawn(chrome,['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--disable-extensions','--disable-background-networking','--disable-component-update','--disable-sync','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],{windowsHide:true,stdio:['ignore','ignore','pipe']});
let ws,timer;
try {
  const endpoint=await new Promise((resolveEndpoint,reject)=>{
    timer=setTimeout(()=>reject(new Error('Chrome startup timeout')),15000);
    let stderr='';child.stderr.on('data',chunk=>{stderr+=chunk;const found=/DevTools listening on (ws:\/\/[^\s]+)/.exec(stderr);if(found){clearTimeout(timer);resolveEndpoint(found[1]);}});
    child.on('error',reject);
  });
  ws=new WebSocket(endpoint);await new Promise((r,j)=>{ws.addEventListener('open',r,{once:true});ws.addEventListener('error',j,{once:true});});
  let id=0;const pending=new Map();
  ws.addEventListener('message',e=>{const m=JSON.parse(e.data);const p=pending.get(m.id);if(!p)return;pending.delete(m.id);clearTimeout(p.timer);if(m.error)p.reject(new Error(JSON.stringify(m.error)));else p.resolve(m.result);});
  const call=(method,params={},sessionId)=>new Promise((resolveCall,reject)=>{const n=++id;const timer=setTimeout(()=>{pending.delete(n);reject(new Error(`CDP timeout: ${method}`));},30000);pending.set(n,{resolve:resolveCall,reject,timer});ws.send(JSON.stringify({id:n,method,params,...(sessionId?{sessionId}:{})}));});
  const {targetId}=await call('Target.createTarget',{url:'about:blank'});
  const {sessionId}=await call('Target.attachToTarget',{targetId,flatten:true});
  const evaluate=async expression=>{const r=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true},sessionId);if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
  await call('Page.navigate',{url:`${origin}${prefix}/reports/browser-review/T2-T3/timezone-build/index.html`},sessionId);
  for(let i=0;i<60;i++){if(await evaluate('typeof window.t23Run === "function"'))break;if(i===59)throw new Error('Browser module graph did not load');await new Promise(r=>setTimeout(r,100));}
  const manifest=loadJson('manifest.json');
  const ids=['continuous-day-56mw','dates-1900','dates-1904'];
  // Select by source files as ids may carry descriptive suffixes.
  const cases=[manifest.cases.find(c=>c.id===ids[0]),...['1900','1904'].map(x=>manifest.cases.find(c=>c.power.some(p=>p.includes(`dates-${x}`))))];
  assert.ok(cases.every(Boolean));
  const report={cases:cases.map(c=>c.id),zones:[],passed:false};
  for(const timezone of ['Asia/Shanghai','UTC','America/Los_Angeles','Pacific/Auckland']) {
    await call('Emulation.setTimezoneOverride',{timezoneId:timezone},sessionId);
    const actual=await evaluate(`window.t23Run(${JSON.stringify({prefix,cases})})`);
    assert.equal(actual.timezone,timezone);
    assert.deepEqual(actual.times,['2026-08-01T00:00:00+08:00',...Array(3).fill('2026-08-01T00:15:00+08:00')]);
    const comparisons=actual.results.map(r=>{const c=cases.find(c=>c.id===r.id);const result=compareResults(loadExpected(c.expected),r.result);assert.equal(result.equal,true,JSON.stringify({timezone,id:r.id,first:result.first}));return {id:r.id,rows:r.result.rows.length,equal:result.equal,maxMinuteError:result.maxMinuteError,maxAggregateEnergyError:result.maxAggregateEnergyError};});
    report.zones.push({timezone,comparisons});
  }
  assert.ok(requests.every(r=>r.method==='GET'));report.passed=true;report.requests=requests;
  writeFileSync(join(root,'reports/browser-review/T2-T3/timezone-probe.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({...report,requests:requests.length},null,2));
} finally {clearTimeout(timer);ws?.close();child.kill();await new Promise(r=>server.close(r));}
