import {analyzeFiles} from '../../dashboard/src/content/calculation/analyze.mjs';
import {syntheticInput} from './performance-input.mjs';
import {renderResult} from './performance-display.mjs';
window.probeReady=true;
window.runProbe=async({days})=>{
  const input=syntheticInput(days),bytes=[...input.power,...input.forecast].reduce((s,f)=>s+f.bytes.byteLength,0);
  const longTasks=[],observer=new PerformanceObserver(list=>longTasks.push(...list.getEntries().map(e=>e.duration)));
  observer.observe({type:'longtask'});await new Promise(r=>requestAnimationFrame(r));
  const started=performance.now(),result=await analyzeFiles(input),computeMs=performance.now()-started;
  const renderMs=await renderResult(result);await new Promise(r=>setTimeout(r,50));observer.disconnect();
  return {days,bytes,rows:result.rows.length,computeMs,renderMs,maxLongTaskMs:Math.max(0,...longTasks),longTasks,heapUsed:performance.memory?.usedJSHeapSize??null};
};
