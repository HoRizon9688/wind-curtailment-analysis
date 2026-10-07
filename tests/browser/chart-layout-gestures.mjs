import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {launchProbe,ROOT} from './probe-browser.mjs';
const candidate=resolve(process.argv[2]),out=join(ROOT,'reports/browser-review/chart-layout-2026-10-07');mkdirSync(out,{recursive:true});
const p=await launchProbe(null,'chart-layout-gestures',{siteRoot:join(candidate,'site'),prefix:'',ready:'Boolean(document.querySelector(".wind-power-svg"))'});
const checks=[],delay=ms=>new Promise(r=>setTimeout(r,ms));
const range=()=>p.evaluate('[...document.querySelectorAll(".wind-range-controls input")].map(e=>Number(e.value))');
async function chartBox(){await p.evaluate('document.querySelector(".wind-power-svg").scrollIntoView({block:"center"})');await delay(100);return p.evaluate('(()=>{const s=document.querySelector(".wind-power-svg"),r=s.getBoundingClientRect(),w=s.viewBox.baseVal.width;return {x:r.x+42/w*r.width,y:r.y+r.height*.5,width:(w-54)/w*r.width};})()');}
async function wheel(deltaY,pos=.5,modifiers=0){const r=await chartBox();await p.call('Input.dispatchMouseEvent',{type:'mouseWheel',x:r.x+r.width*pos,y:r.y,deltaX:0,deltaY,modifiers},p.sessionId);await delay(120);}
async function drag(dx,modifiers=0){const r=await chartBox(),x=r.x+r.width*.5,y=r.y;await p.call('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',buttons:1,clickCount:1,modifiers},p.sessionId);await p.call('Input.dispatchMouseEvent',{type:'mouseMoved',x:x+dx,y,button:'left',buttons:1,modifiers},p.sessionId);await p.call('Input.dispatchMouseEvent',{type:'mouseReleased',x:x+dx,y,button:'left',clickCount:1,modifiers},p.sessionId);await delay(120);}
async function reset(){await p.evaluate('document.querySelector("button[aria-label=恢复全天范围]").click()');await delay(100);}
try{
 assert.equal(await p.evaluate('!!document.querySelector(".wind-badge")'),false,'obsolete interpolation badge is removed');
 assert.equal(await p.evaluate('!!document.querySelector(".wind-method")'),false,'method explanation is removed');
 const meta=await p.evaluate('(()=>{const d=document.querySelector(".wind-date"),b=d.nextElementSibling;return {date:d.textContent,next:b.textContent};})()');assert.equal(meta.date,'2026-01-01');assert.match(meta.next,/导出当前范围/);checks.push('date remains immediately beside export; badge and method section removed');
 assert.equal(await p.evaluate('document.querySelector("details.wind-exclusions").open'),false);
 assert.equal(await p.evaluate('document.querySelector(".wind-exclusions table").checkVisibility()'),false);
 await p.evaluate('document.querySelector(".wind-exclusions summary").click()');assert.equal(await p.evaluate('document.querySelector(".wind-exclusions table").checkVisibility()'),true);
 await p.evaluate('document.querySelector(".wind-exclusions summary").click()');checks.push('exclusion disclosure defaults closed and opens/closes with its header');
 await wheel(-120,.7);let r=await range();assert.ok(r[1]-r[0]<1440);const anchor=1008;assert.ok(Math.abs(r[0]+.7*(r[1]-r[0])-anchor)<=2);checks.push('native wheel zooms at the cursor');
 const scroll=await p.evaluate('scrollY');await wheel(-120,.5);assert.equal(await p.evaluate('scrollY'),scroll);checks.push('wheel inside the plot does not scroll the page');
 const before=await range();await drag(-90);r=await range();assert.ok(r[0]>before[0]);assert.equal(r[1]-r[0],before[1]-before[0]);checks.push('native drag pans without changing duration');
 const atRight=await range();await drag(90);r=await range();assert.ok(r[0]<atRight[0]);checks.push('opposite drag returns toward earlier times');
 const zoomed=await range();await wheel(120);r=await range();assert.ok(r[1]-r[0]>zoomed[1]-zoomed[0]);checks.push('positive wheel zooms out');
 await reset();assert.deepEqual(await range(),[0,1440]);await drag(80);assert.deepEqual(await range(),[0,1440]);checks.push('reset restores a day; dragging a full day cannot leave its bounds');
 const box=await chartBox();await p.call('Input.dispatchMouseEvent',{type:'mousePressed',x:box.x+box.width*.2,y:box.y,button:'left',buttons:1,modifiers:8},p.sessionId);await p.call('Input.dispatchMouseEvent',{type:'mouseMoved',x:box.x+box.width*.5,y:box.y,button:'left',buttons:1,modifiers:8},p.sessionId);await p.call('Input.dispatchMouseEvent',{type:'mouseReleased',x:box.x+box.width*.5,y:box.y,button:'left',modifiers:8},p.sessionId);assert.ok((await range())[1]-(await range())[0]<1440);checks.push('Shift-drag retains rectangular range selection');
 await reset();await p.evaluate('document.querySelector(".wind-power-svg").focus()');const selected=await p.evaluate('document.querySelector("[data-testid=minute-time]").textContent');await p.call('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowRight',code:'ArrowRight'},p.sessionId);await p.call('Input.dispatchKeyEvent',{type:'keyUp',key:'ArrowRight',code:'ArrowRight'},p.sessionId);assert.notEqual(await p.evaluate('document.querySelector("[data-testid=minute-time]").textContent'),selected);checks.push('keyboard minute inspection remains available');
 await p.evaluate('window.scrollTo(0,0)');await delay(100);await p.call('Input.dispatchMouseEvent',{type:'mouseWheel',x:30,y:80,deltaX:0,deltaY:200},p.sessionId);await delay(150);assert.ok(await p.evaluate('scrollY>0'));checks.push('wheel outside the chart still scrolls the page');
 for(const width of [1280,903,665,390]){await p.call('Emulation.setDeviceMetricsOverride',{width,height:605,deviceScaleFactor:1,mobile:false},p.sessionId);await p.evaluate('window.scrollTo(0,0)');await delay(120);assert.ok(await p.evaluate('document.documentElement.scrollWidth<=innerWidth+1'));const shot=await p.call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false},p.sessionId);writeFileSync(join(out,`${width}.png`),Buffer.from(shot.data,'base64'));}checks.push('desktop and narrow layouts have no horizontal overflow');
 assert.deepEqual(p.browserErrors,[]);writeFileSync(join(out,'result.json'),JSON.stringify({passed:true,candidate,checks},null,2));console.log(`Chart layout and gestures: ${checks.length} checks passed`);
}finally{await p.close();}
