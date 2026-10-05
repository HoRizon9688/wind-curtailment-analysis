/** Real standalone release: absent authoring header, retained appearance and layout. */
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {launchProbe,ROOT} from './probe-browser.mjs';
const candidate=resolve(process.argv[2]);
const urlIndex=process.argv.indexOf('--url');
const remote=urlIndex<0?null:new URL(process.argv[urlIndex+1]);
const out=join(ROOT,'reports/browser-review/standalone-chrome-2026-10-05',remote?.hostname??'local');mkdirSync(out,{recursive:true});
const p=await launchProbe(null,'standalone-chrome',{siteRoot:join(candidate,'site'),prefix:'',...(remote?{remoteUrl:remote.href}:{}),ready:'Boolean(document.querySelector(".wind-upload"))'});
const checks=[],wait=async expression=>{
 for(let i=0;i<100;i++){if(await p.evaluate(expression))return;await new Promise(r=>setTimeout(r,40));}
 throw Error('UI wait: '+expression);
};
try {
 assert.equal(await p.evaluate('document.querySelectorAll(".dashboard-topbar").length'),0,'Standalone release must not mount the authoring top bar');
 assert.equal(await p.evaluate('document.querySelectorAll(".dashboard-ask-button,.dashboard-publish-button").length'),0);
 assert.equal(await p.evaluate('document.querySelectorAll("main").length'),1);
 checks.push('authoring header, Ask and Publish absent; single main landmark retained');
 await p.evaluate('document.querySelector(\'button[aria-label="打开外观设置"]\').click()');
 await wait('Boolean(document.querySelector(\'select[aria-label="Appearance"]\'))');
 await p.evaluate(`(()=>{const e=document.querySelector('select[aria-label="Appearance"]');e.value='dark';e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
 await wait('document.documentElement.dataset.colorScheme === "dark"');
 await p.evaluate('document.querySelector(\'button[aria-label="Close theme picker"]\').click()');
 checks.push('native appearance drawer remains usable without the authoring header');
 for(const [width,height] of [[1280,900],[665,605],[390,844]]) {
  await p.call('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:width<700},p.sessionId);
  await p.evaluate('window.scrollTo(0,0)');await new Promise(r=>setTimeout(r,100));
  const geometry=await p.evaluate(`(()=>{const b=document.querySelector('button[aria-label="打开外观设置"]').getBoundingClientRect();return {overflow:document.documentElement.scrollWidth-window.innerWidth,top:document.querySelector('main').getBoundingClientRect().top,width:b.width,height:b.height};})()`);
  assert.ok(geometry.overflow<=1,JSON.stringify(geometry));assert.ok(geometry.top<60,JSON.stringify(geometry));
  assert.ok(geometry.width>=44&&geometry.height>=44,JSON.stringify(geometry));
  const shot=await p.call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false},p.sessionId);
  writeFileSync(join(out,`${width}.png`),Buffer.from(shot.data,'base64'));
  checks.push(`${width}px layout has no topbar gap or horizontal overflow; appearance target is usable`);
 }
 assert.deepEqual(p.browserErrors,[]);
 writeFileSync(join(out,'result.json'),JSON.stringify({passed:true,candidate,browser:p.version,checks},null,2)+'\n');
 console.log(`Standalone chrome: ${checks.length} checks passed`);
}finally{await p.close();}
