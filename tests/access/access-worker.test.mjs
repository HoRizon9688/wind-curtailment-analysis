import test from 'node:test';
import assert from 'node:assert/strict';
import {createAccessWorker} from '../../deployment/access/worker.mjs';
import {dailyCode,COOKIE_NAME,dayWindow,createSession} from '../../deployment/access/core.mjs';
const now=Date.parse('2026-10-08T04:00:00Z'),origin='https://wind.test';
function harness(overrides={}){
 let assetCalls=0,attempts=0;
 const env={DAILY_ACCESS_SECRET:'test-daily-secret-000000000000000000000000000',ACCESS_SESSION_SECRET:'test-session-secret-000000000000000000000000',ACCESS_LOGIN_LIMITER:{async limit(){return {success:++attempts<=5};}},ASSETS:{async fetch(){assetCalls++;return new Response('reviewed asset',{headers:{'content-type':'text/html'}});}},...overrides};
 const worker=createAccessWorker({now:()=>now});return {env,worker,get assetCalls(){return assetCalls;}};
}
function request(path='/',options={}){return new Request(origin+path,options);}
function login(code,extra={}){return request('/auth/login',{method:'POST',headers:{Origin:origin,'content-type':'application/x-www-form-urlencoded',...extra},body:new URLSearchParams({code,returnTo:'/?view=1&tab=dashboard'})});}
test('all direct assets are gated and uncached; missing setup fails closed',async()=>{
 const h=harness();
 for(const path of ['/','/index.html','/samples/forecast.csv','/samples/minute-power.csv','/foo.js']){const r=await h.worker.fetch(request(path),h.env);assert.equal(r.status,303);assert.match(r.headers.get('location'),/^\/auth\/login/);assert.match(r.headers.get('cache-control'),/no-store/);}
 assert.equal(h.assetCalls,0);
 for(const missing of ['DAILY_ACCESS_SECRET','ACCESS_SESSION_SECRET','ACCESS_LOGIN_LIMITER','ASSETS']){const b=harness({[missing]:undefined});assert.equal((await b.worker.fetch(request('/'),b.env)).status,503);assert.equal(b.assetCalls,0);}
});
test('real login signs a private host cookie and preserves the selected view',async()=>{
 const h=harness();const r=await h.worker.fetch(login(await dailyCode(h.env.DAILY_ACCESS_SECRET,now)),h.env);assert.equal(r.status,303);assert.equal(r.headers.get('location'),'/?view=1&tab=dashboard');
 const cookie=r.headers.get('set-cookie');for(const bit of ['HttpOnly','Secure','SameSite=Lax','Path=/','Max-Age=43200'])assert.ok(cookie.includes(bit));
 const page=await h.worker.fetch(request('/',{headers:{cookie:cookie.split(';')[0]}}),h.env);assert.equal(page.status,200);assert.equal(await page.text(),'reviewed asset');assert.match(page.headers.get('cache-control'),/no-store/);assert.equal(h.assetCalls,1);
});
test('wrong, malformed, old codes never grant access; repeated attempts are throttled',async()=>{
 const h=harness();
 for(const code of ['nope','123','000000',await dailyCode(h.env.DAILY_ACCESS_SECRET,now-86400000),'123456']){const r=await h.worker.fetch(login(code),h.env);assert.equal(r.status,401);assert.equal(r.headers.get('set-cookie'),null);assert.ok(!(await r.text()).includes(`value="${code}"`));}
 const r=await h.worker.fetch(login(await dailyCode(h.env.DAILY_ACCESS_SECRET,now)),h.env);assert.equal(r.status,429);assert.equal(r.headers.get('retry-after'),'60');assert.equal(h.assetCalls,0);
});
test('cross-origin forms, invalid content and oversized bodies are refused',async()=>{
 const h=harness();assert.equal((await h.worker.fetch(login('123456',{Origin:'https://evil.test'}),h.env)).status,403);
 assert.equal((await h.worker.fetch(request('/auth/login',{method:'POST',body:'x'.repeat(3000),headers:{Origin:origin,'content-type':'application/x-www-form-urlencoded'}}),h.env)).status,413);
 assert.equal((await h.worker.fetch(request('/auth/login',{method:'POST',body:'{}',headers:{Origin:origin,'content-type':'application/json'}}),h.env)).status,415);
});
test('tampered, duplicate, expired and cross-day cookies cannot serve assets',async()=>{
 const h=harness();
 for(const token of ['bad',await createSession(h.env.ACCESS_SESSION_SECRET,now-86400000),await createSession(h.env.ACCESS_SESSION_SECRET,now+86400000)]){assert.equal((await h.worker.fetch(request('/',{headers:{cookie:`${COOKIE_NAME}=${token}`}}),h.env)).status,303);}
 const token=await createSession(h.env.ACCESS_SESSION_SECRET,now);assert.equal((await h.worker.fetch(request('/',{headers:{cookie:`${COOKIE_NAME}=${token}; ${COOKIE_NAME}=${token}`}}),h.env)).status,303);
 const expired=createAccessWorker({now:()=>dayWindow(now).expiresAt});assert.equal((await expired.fetch(request('/',{headers:{cookie:`${COOKIE_NAME}=${token}`}}),h.env)).status,303);assert.equal(h.assetCalls,0);
});
test('logout needs a same-origin POST and clears the cookie; backend failure denies login',async()=>{
 const h=harness();assert.equal((await h.worker.fetch(request('/auth/logout'),h.env)).status,200);
 const r=await h.worker.fetch(request('/auth/logout',{method:'POST',headers:{Origin:origin}}),h.env);assert.equal(r.status,303);assert.match(r.headers.get('set-cookie'),/Max-Age=0/);
 const bad=harness({ACCESS_LOGIN_LIMITER:{async limit(){throw Error('broken');}}});assert.equal((await bad.worker.fetch(login('123456'),bad.env)).status,503);
});
