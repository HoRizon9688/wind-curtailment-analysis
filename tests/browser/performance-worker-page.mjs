import {createCalculationClient} from '../../dashboard/src/content/calculation/calculation-browser.mjs';
import {syntheticInput,MARKER} from './performance-input.mjs';
import {renderResult} from './performance-display.mjs';
import {compareResults} from './compare.mjs';
window.probeReady=true;
window.runProbe=async({days,files,prefix})=>{
  const input=files?{power:[{name:'synthetic-power.xlsx',bytes:await(await fetch(prefix+files.power)).arrayBuffer()}],forecast:[{name:'synthetic-forecast.xlsx',bytes:await(await fetch(prefix+files.forecast)).arrayBuffer()}],options:syntheticInput(1).options}:syntheticInput(days);
  if(files)input.options.end='2026-08-31';
  const bytes=[...input.power,...input.forecast].reduce((s,f)=>s+f.bytes.byteLength,0);
  const longTasks=[],progress=[],heapSamples=[],rafGaps=[];let running=true,lastFrame=performance.now();
  const frame=t=>{rafGaps.push(t-lastFrame);lastFrame=t;if(running)requestAnimationFrame(frame);};requestAnimationFrame(frame);
  const observer=new PerformanceObserver(list=>longTasks.push(...list.getEntries().map(e=>e.duration)));observer.observe({type:'longtask'});
  const memoryTimer=setInterval(()=>{if(performance.memory)heapSamples.push(performance.memory.usedJSHeapSize);},25);
  const started=performance.now();
  let client;
  try {
    const result=await new Promise((resolve,reject)=>{
      client=createCalculationClient({onProgress:p=>progress.push({...p,atMs:performance.now()-started}),onResult:({result})=>resolve(result),onError:({error})=>reject(new Error(JSON.stringify(error)))});
      client.start(input);
    });
    const receivedMs=performance.now()-started;
    const transferred=[...input.power,...input.forecast].every(f=>f.bytes.byteLength===0);
    const renderMs=await renderResult(result);await new Promise(r=>setTimeout(r,50));
    const phases=Object.fromEntries(['reading','validating','calculating','aggregating'].map(phase=>{const p=progress.filter(p=>p.phase===phase);return [phase,{observedMs:p.at(-1).atMs-p[0].atMs,completed:p.at(-1).completed,total:p.at(-1).total}];}));
    return {days,format:files?'xlsx-date-cells':'csv',bytes,rows:result.rows.length,summary:result.summary,calibration:result.calibration,dailyCount:result.daily.length,lastTimestamp:result.rows.at(-1).timestamp,transferred,startupMs:progress[0].atMs,receivedMs,resultDeliveryMs:receivedMs-progress.at(-1).atMs,renderMs,phases,maxLongTaskMs:Math.max(0,...longTasks),longTasks,maxRafGapMs:Math.max(0,...rafGaps),mainHeapUsedSampleMax:Math.max(0,...heapSamples),mainHeapUsedAfter:performance.memory?.usedJSHeapSize??null};
  }finally{running=false;clearInterval(memoryTimer);observer.disconnect();client?.dispose();}
};
window.runFixtures=async({prefix})=>{
  const root=prefix+'/tests/fixtures/browser/contract/';
  const manifest=await(await fetch(root+'manifest.json')).json();
  const read=async path=>({name:path.split('/').at(-1),bytes:await(await fetch(root+path)).arrayBuffer()});
  const cases=[];
  for(const c of manifest.cases.filter(c=>c.kind!=='range-boundary')) {
    const input={power:await Promise.all(c.power.map(read)),forecast:await Promise.all(c.forecast.map(read)),options:c.options};
    let client;
    const message=await new Promise(resolve=>{client=createCalculationClient({onResult:resolve,onError:resolve});client.start(input);});client.dispose();
    if(c.error) {if(message.error?.code!==c.error.code||message.error?.message!==c.error.message)throw new Error('Worker error mismatch: '+c.id);cases.push({id:c.id,errorMatched:true});}
    else {
      const compressed=await fetch(root+c.expected);
      const expected=JSON.parse(await new Response(compressed.body.pipeThrough(new DecompressionStream('gzip'))).text());
      const comparison=compareResults(expected,message.result);if(!comparison.equal)throw new Error(JSON.stringify({id:c.id,first:comparison.first}));
      cases.push({id:c.id,rows:message.result.rows.length,equal:true,maxMinuteError:comparison.maxMinuteError,maxAggregateEnergyError:comparison.maxAggregateEnergyError});
    }
  }
  return {cases};
};
window.runCancel=async({phase='calculating'})=>{
  const input=syntheticInput(31);let client,resolveDone,clickAt,confirmedAt,progressCount=0,callbacks=0,lastProgress;
  const done=new Promise(r=>resolveDone=r);
  const button=document.getElementById('cancel');
  button.onclick=()=>{clickAt=performance.now();client.cancel();document.getElementById('result').textContent='cancelled';confirmedAt=performance.now();requestAnimationFrame(()=>resolveDone({uiFrameMs:performance.now()-clickAt}));};
  client=createCalculationClient({onProgress:p=>{progressCount++;lastProgress=p;if((p.phase===phase&&p.completed===0)||(phase==='delivery'&&p.phase==='aggregating'&&p.completed===p.total))setTimeout(()=>button.click(),0);},onResult:()=>{callbacks++;resolveDone({unexpectedResult:true});},onError:()=>{callbacks++;resolveDone({unexpectedError:true});}});
  client.start(input);const outcome=await done;const atCancel=progressCount;await new Promise(r=>setTimeout(r,250));client.dispose();button.onclick=null;
  return {...outcome,phase:lastProgress.phase,confirmationMs:confirmedAt-clickAt,progressAfterCancel:progressCount-atCancel,callbacks};
};
window.runReplacement=async()=>{
  const a=syntheticInput(31),b=syntheticInput(15);let client,replaced=false,aid,bid;const delivered=[];
  const outcome=await new Promise((resolve,reject)=>{
    client=createCalculationClient({onProgress:p=>{if(p.requestId===aid&&p.phase==='calculating'&&!replaced){replaced=true;bid=client.start(b);}},onResult:r=>{delivered.push(r.requestId);resolve({id:r.requestId,rows:r.result.rows.length});},onError:r=>reject(new Error(JSON.stringify(r.error)))});
    aid=client.start(a);
  });await new Promise(r=>setTimeout(r,200));client.dispose();return {replaced,aid,bid,...outcome,delivered};
};
window.probePrivacy=async()=>({marker:MARKER,localStorageKeys:Object.keys(localStorage),sessionStorageKeys:Object.keys(sessionStorage),indexedDatabases:await indexedDB.databases(),serviceWorkers:(await navigator.serviceWorker.getRegistrations()).length});
