/** Test-only Vite + local static server + Chrome CDP, never publication. */
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {existsSync,mkdirSync,writeFileSync,createReadStream,statSync} from 'node:fs';
import {dirname,join,resolve,relative,sep,extname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {tmpdir} from 'node:os';
export const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
export async function launchProbe(entry,stage='T4') {
  const out=join(ROOT,`reports/browser-review/${stage}/probe-build`);
  if(entry) {
    const {build}=await import(pathToFileURL(join(ROOT,'dashboard/node_modules/vite/dist/node/index.js')));
    await build({root:join(ROOT,'dashboard'),configFile:false,logLevel:'warn',build:{outDir:out,emptyOutDir:true,target:'es2022',lib:{entry:join(ROOT,entry),formats:['es'],fileName:()=> 'probe.js'}}});
    writeFileSync(join(out,'index.html'),'<!doctype html><title>Synthetic browser probe</title><div id="result"></div><div id="chart"></div><button id="cancel">Cancel</button><script type="module" src="./probe.js"></script>');
  }
  const requests=[];
  const prefix='/wind-curtailment-analysis';
  const server=createServer((req,res)=>{
    requests.push({method:req.method,path:req.url,bytes:Number(req.headers['content-length']??0)});
    const path=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
    if(!path.startsWith(prefix+'/')){res.writeHead(404).end();return;}
    const target=resolve(ROOT,'.'+path.slice(prefix.length)),rel=relative(ROOT,target);
    if(rel.startsWith('..')||rel.startsWith(sep)||!existsSync(target)||!statSync(target).isFile()){res.writeHead(404).end();return;}
    res.setHeader('content-type',extname(target)==='.html'?'text/html; charset=utf-8':extname(target)==='.js'?'text/javascript; charset=utf-8':'application/octet-stream');
    // Cache only program modules; synthetic data and result pages are no-store.
    res.setHeader('cache-control',extname(target)==='.js'?'public, max-age=3600':'no-store');createReadStream(target).pipe(res);
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const origin=`http://127.0.0.1:${server.address().port}`;
  const chrome=process.env.BROWSER_PROBE_CHROME??['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Microsoft/Edge/Application/msedge.exe','/usr/bin/google-chrome','/usr/bin/chromium'].find(existsSync);
  if(!chrome){server.close();throw new Error('Chrome/Edge not installed');}
  const profile=join(tmpdir(),`wind-${stage}-${process.pid}`);mkdirSync(profile,{recursive:true});
  const child=spawn(chrome,['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--disable-extensions','--disable-background-networking','--disable-component-update','--disable-sync','--enable-precise-memory-info','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],{windowsHide:true,stdio:['ignore','ignore','pipe']});
  let ws,startTimer;
  try {
    const endpoint=await new Promise((r,j)=>{startTimer=setTimeout(()=>j(new Error('Chrome startup timeout')),15000);let output='';child.stderr.on('data',chunk=>{output+=chunk;const m=/DevTools listening on (ws:\/\/[^\s]+)/.exec(output);if(m){clearTimeout(startTimer);r(m[1]);}});child.on('error',j);});
    ws=new WebSocket(endpoint);await new Promise((r,j)=>{ws.addEventListener('open',r,{once:true});ws.addEventListener('error',j,{once:true});});
    let id=0;const pending=new Map(),workerSessions=new Set();
    ws.addEventListener('message',e=>{const m=JSON.parse(e.data);
      if(m.method==='Target.attachedToTarget'&&m.params.targetInfo.type==='worker')workerSessions.add(m.params.sessionId);
      if(m.method==='Target.detachedFromTarget')workerSessions.delete(m.params.sessionId);
      const p=pending.get(m.id);if(!p)return;pending.delete(m.id);clearTimeout(p.timer);if(m.error)p.reject(new Error(JSON.stringify(m.error)));else p.resolve(m.result);
    });
    const call=(method,params={},sessionId)=>new Promise((r,j)=>{const n=++id,timer=setTimeout(()=>{pending.delete(n);j(new Error(`CDP timeout: ${method}`));},120000);pending.set(n,{resolve:r,reject:j,timer});ws.send(JSON.stringify({id:n,method,params,...(sessionId?{sessionId}:{})}));});
    const {targetId}=await call('Target.createTarget',{url:'about:blank'}),{sessionId}=await call('Target.attachToTarget',{targetId,flatten:true});
    await call('Target.setAutoAttach',{autoAttach:true,waitForDebuggerOnStart:false,flatten:true},sessionId);
    const evaluate=async expression=>{const r=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true},sessionId);if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
    await call('Page.navigate',{url:`${origin}${prefix}/reports/browser-review/${stage}/probe-build/index.html`},sessionId);
    for(let i=0;i<100;i++){if(await evaluate('window.probeReady === true'))break;if(i===99)throw new Error('Probe module graph not ready');await new Promise(r=>setTimeout(r,100));}
    return {evaluate,call,sessionId,workerSessions,requests,prefix,version:await call('Browser.getVersion'),close:async()=>{clearTimeout(startTimer);for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error('Probe closed'));}ws.close();child.kill();await new Promise(r=>server.close(r));}};
  } catch(e){clearTimeout(startTimer);ws?.close();child.kill();server.close();throw e;}
}
