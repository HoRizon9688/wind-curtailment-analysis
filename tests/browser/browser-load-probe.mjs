import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {launchProbe,ROOT} from './probe-browser.mjs';
// Run after performance-worker has built the public inline-Worker graph.
const probe=await launchProbe(null,'T4');
try {
  const read=async()=>{await probe.evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');return probe.evaluate('({navigation:performance.getEntriesByType("navigation")[0].toJSON(),resources:performance.getEntriesByType("resource").map(e=>({name:new URL(e.name).pathname,duration:e.duration,transferSize:e.transferSize,encodedBodySize:e.encodedBodySize}))})');};
  const cold=await read();await probe.evaluate('window.probeReady=false');await probe.call('Page.reload',{},probe.sessionId);
  for(let i=0;i<100;i++){let ready=false;try{ready=await probe.evaluate('window.probeReady===true');}catch{}if(ready)break;if(i===99)throw new Error('reload timeout');await new Promise(r=>setTimeout(r,50));}
  const warm=await read(),report={browser:probe.version,cold,warm};writeFileSync(join(ROOT,'reports/browser-review/T4/browser-load.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({coldLoadMs:cold.navigation.loadEventEnd,warmLoadMs:warm.navigation.loadEventEnd,coldResources:cold.resources,warmResources:warm.resources}));
}finally{await probe.close();}
