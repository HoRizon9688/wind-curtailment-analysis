import assert from 'node:assert/strict';
import {join,resolve} from 'node:path';
import {launchProbe} from './probe-browser.mjs';
const candidate=resolve(process.argv[2]);
const p=await launchProbe(null,'sites-standalone',{siteRoot:join(candidate,'site'),prefix:'',localHostname:'wind-local-probe.chatgpt.site',spaFallback:true,ready:'Boolean(document.querySelector(".wind-upload,.dashboard-shell-loading-error"))'});
try{
  const state=await p.evaluate('({hostname:location.hostname,error:document.querySelector(".dashboard-shell-loading-error")?.textContent,upload:!!document.querySelector(".wind-upload"),title:document.title,topbar:!!document.querySelector(".dashboard-topbar")})');
  console.log(JSON.stringify(state));
  assert.equal(state.upload,true,'A standalone browser-calculation release must render on a Sites hostname');
  assert.equal(state.error,undefined);
  assert.equal(state.topbar,false);
  assert.equal(state.title,'限电量分解');
  assert.equal(p.networkRequests.some(r=>new URL(r.url).pathname.startsWith('/api/')),false,'Standalone Sites must not request Data hosting APIs');
  await p.evaluate('document.querySelector(".wind-theme-toggle").click()');
  assert.equal(await p.evaluate('document.documentElement.dataset.colorScheme'),'dark');
  assert.deepEqual(p.browserErrors,[]);
  console.log('Sites standalone hostname: 7 checks passed');
}finally{await p.close();}
