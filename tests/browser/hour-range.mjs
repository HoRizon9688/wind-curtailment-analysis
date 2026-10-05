/** Real chart clicks catch the missing same-hour reset without replacing components. */
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {launchProbe,ROOT} from './probe-browser.mjs';
const candidate=resolve(process.argv[2]);
const out=join(ROOT,'reports/browser-review/hour-range');mkdirSync(out,{recursive:true});
const p=await launchProbe(null,'hour-range',{siteRoot:join(candidate,'site'),prefix:'',ready:'Boolean(document.querySelector(".wind-hour"))'});
const checks=[];
const settle=()=>p.evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
async function clickHour(index){
 const box=await p.evaluate(`(()=>{const e=document.querySelectorAll('.wind-hour')[${index}];e.scrollIntoView({block:'center'});const b=e.getBoundingClientRect();return {x:b.x+b.width/2,y:b.y+b.height/2};})()`);
 for(const type of ['mousePressed','mouseReleased'])await p.call('Input.dispatchMouseEvent',{type,...box,button:'left',clickCount:1},p.sessionId);
 await settle();
}
async function state(){return p.evaluate(`({start:Number(document.querySelector('input[aria-label="范围起点"]').value),end:Number(document.querySelector('input[aria-label="范围终点"]').value),bars:document.querySelectorAll('.wind-hour').length,scope:document.querySelector('.wind-scope').textContent,pressed:document.querySelector('.wind-hour')?.getAttribute('aria-pressed')})`);}
try{
 assert.equal((await state()).bars,24);
 await clickHour(4);let s=await state();assert.equal(s.start,240);assert.equal(s.end,300);assert.equal(s.bars,1);assert.ok(/60\s*分钟/.test(s.scope),JSON.stringify(s));
 checks.push('mouse click narrows the full day to 04:00–05:00');
 await clickHour(0);s=await state();assert.equal(s.start,0,'second click must restore the full day');assert.equal(s.end,1440);assert.equal(s.bars,24);assert.ok(/1440\s*分钟/.test(s.scope));
 checks.push('second mouse click restores 24 bars and 1440 minutes');
 await clickHour(23);s=await state();assert.equal(s.start,1380);assert.equal(s.end,1440);assert.equal(s.pressed,'true');
 await p.evaluate('document.querySelector(".wind-hour").focus()');
 await p.call('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',text:'\r',windowsVirtualKeyCode:13,nativeVirtualKeyCode:13},p.sessionId);
 await p.call('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13},p.sessionId);await settle();
 s=await state();assert.equal(s.start,0);assert.equal(s.end,1440);assert.equal(s.bars,24);
 checks.push('last-hour boundary and native Enter activation restore the full day');
 await p.evaluate(`[...document.querySelectorAll('button')].find(e=>e.textContent==='凌晨').click()`);await settle();
 await clickHour(2);s=await state();assert.equal(s.start,120);assert.equal(s.end,180);await clickHour(0);s=await state();assert.equal(s.start,0);assert.equal(s.end,1440);assert.equal(s.bars,24);
 checks.push('a preset zoom followed by two hour clicks returns to the full day');
 assert.deepEqual(p.browserErrors,[]);
 writeFileSync(join(out,'result.json'),JSON.stringify({passed:true,candidate,browser:p.version,checks},null,2)+'\n');
 console.log(`Hour range: ${checks.length} checks passed`);
}finally{await p.close();}
