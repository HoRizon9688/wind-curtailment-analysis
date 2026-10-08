import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {readLocalSecrets} from '../../deployment/access/local-secrets.mjs';
import {dailyCode} from '../../deployment/access/core.mjs';
const secrets=readLocalSecrets(),manifest=JSON.parse(readFileSync('docs/site-release.json','utf8'));
for(const port of [4191,4192]){
 test(`real local Worker ${port}: login, direct asset protection, exact reviewed app, and logout`,async()=>{
  const origin=`http://127.0.0.1:${port}`,headers={'CF-Connecting-IP':`192.0.2.${port===4191?21:22}`};
  const opts={redirect:'manual',headers};
  for(const path of ['/','/index.html','/samples/forecast.csv','/%69ndex.html']){const r=await fetch(origin+path,opts);assert.equal(r.status,303);assert.match(r.headers.get('location'),/^\/auth\/login/);}
  const code=await dailyCode(secrets.DAILY_ACCESS_SECRET);
  const r=await fetch(origin+'/auth/login',{...opts,method:'POST',headers:{...headers,Origin:origin,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({code})});assert.equal(r.status,303);const cookie=r.headers.get('set-cookie').split(';')[0];
  for(const f of manifest.files){const a=await fetch(origin+(f.path==='index.html'?'/':'/'+f.path),{headers:{...headers,cookie}});assert.equal(a.status,200);const bytes=Buffer.from(await a.arrayBuffer());assert.equal(createHash('sha256').update(bytes).digest('hex'),f.sha256);assert.match(a.headers.get('cache-control'),/no-store/);}
  const changed=await fetch(origin+'/',{redirect:'manual',headers:{...headers,cookie:cookie+'x'}});assert.equal(changed.status,303);
  const cross=await fetch(origin+'/auth/logout',{redirect:'manual',method:'POST',headers:{...headers,Origin:'https://other.invalid',cookie}});assert.equal(cross.status,403);
  const exit=await fetch(origin+'/auth/logout',{redirect:'manual',method:'POST',headers:{...headers,Origin:origin,cookie}});assert.equal(exit.status,303);assert.match(exit.headers.get('set-cookie'),/Max-Age=0/);
 });
 test(`real local Worker ${port}: failed attempts activate rate limits`,async()=>{
  const origin=`http://127.0.0.1:${port}`,headers={'CF-Connecting-IP':`192.0.2.${port===4191?31:32}`,Origin:origin,'content-type':'application/x-www-form-urlencoded'};
  const outcomes=[];
  for(let i=0;i<8;i++){const r=await fetch(origin+'/auth/login',{redirect:'manual',method:'POST',headers,body:'code=bad'});outcomes.push(r.status);if(r.status===429)assert.equal(r.headers.get('retry-after'),'60');}
  assert.ok(outcomes.includes(401));assert.ok(outcomes.includes(429));assert.ok(outcomes.every(n=>n===401||n===429));
 });
}
