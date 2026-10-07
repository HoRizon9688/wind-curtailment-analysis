/** Product defaults and native appearance switching, without changing the theme family. */
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {launchProbe,ROOT} from './probe-browser.mjs';
const candidate=resolve(process.argv[2]),themeOnly=process.argv.includes('--theme-only');
const out=join(ROOT,'reports/browser-review/site-presentation-2026-10-07');mkdirSync(out,{recursive:true});
const p=await launchProbe(null,'site-presentation',{siteRoot:join(candidate,'site'),prefix:'',ready:'Boolean(document.querySelector(".wind-theme-toggle"))'});
async function wait(expr){for(let i=0;i<100;i++){if(await p.evaluate(expr))return;await new Promise(r=>setTimeout(r,40));}throw Error('UI wait: '+expr);}
const checks=[];
try{
 if(!themeOnly){
  assert.equal(await p.evaluate('document.title'),'限电量分解');
  assert.equal(await p.evaluate('document.querySelector("[data-testid=analysis-origin]").textContent'),'网站默认数据仅为演示使用，选择自己的文件后计算场站结果');
  assert.equal(await p.evaluate('document.querySelector(".wind-upload>summary").textContent'),'导入新的场站数据');
  assert.equal(await p.evaluate('document.querySelectorAll(".wind-upload>summary>span").length'),1);
  checks.push('website title and demonstration notice match requested wording; upload subtitle removed');
 }
 assert.equal(await p.evaluate('document.documentElement.dataset.appTheme'),'scientific-blue','Scientific blue is the default theme');
 checks.push('fresh browser opens with the Scientific blue preset');
 for(const [scheme,color] of [['dark','rgb(16, 23, 34)'],['light','rgb(247, 250, 255)']]){
  if(await p.evaluate(`document.documentElement.dataset.colorScheme!==${JSON.stringify(scheme)}`))await p.evaluate('document.querySelector(".wind-theme-toggle").click()');
  await wait(`document.documentElement.dataset.colorScheme===${JSON.stringify(scheme)}`);
  assert.equal(await p.evaluate('document.documentElement.dataset.appTheme'),'scientific-blue');
  assert.equal(await p.evaluate('getComputedStyle(document.body).backgroundColor'),color);
  for(const width of [1280,665]){
   await p.call('Emulation.setDeviceMetricsOverride',{width,height:605,deviceScaleFactor:1,mobile:false},p.sessionId);
   assert.ok(await p.evaluate('document.documentElement.scrollWidth<=innerWidth+1'));
   const shot=await p.call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false},p.sessionId);writeFileSync(join(out,`${scheme}-${width}.png`),Buffer.from(shot.data,'base64'));
  }
  checks.push(`floating button switches to ${scheme} with the native Scientific blue palette`);
 }
 await p.evaluate('document.querySelector(".wind-theme-toggle").click()');await wait('document.documentElement.dataset.colorScheme==="dark"');
 await p.call('Page.reload',{ignoreCache:true},p.sessionId);await wait('Boolean(document.querySelector(".wind-theme-toggle")) && document.documentElement.dataset.colorScheme==="dark"');
 assert.equal(await p.evaluate('document.documentElement.dataset.appTheme'),'scientific-blue');
 checks.push('reload retains explicit dark preference and Scientific blue theme');
 assert.deepEqual(p.browserErrors,[]);
 writeFileSync(join(out,'result.json'),JSON.stringify({passed:true,candidate,checks},null,2)+'\n');
 console.log(`Site presentation: ${checks.length} checks passed`);
}finally{await p.close();}
