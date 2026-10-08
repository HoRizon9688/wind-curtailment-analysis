// Explicit production acceptance; only the user-approved Cloudflare Worker.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {readCloudflareSecrets} from '../../deployment/access/local-secrets.mjs';
import {dailyCode} from '../../deployment/access/core.mjs';
const origin='https://wind-curtailment-analysis.wind-curtailment-static-deployment.workers.dev';
const manifest=JSON.parse(readFileSync('docs/site-release.json','utf8')),checks=[];
for(const path of ['/','/index.html','/samples/forecast.csv','/%69ndex.html','/site-release.json']){
 const r=await fetch(origin+path,{redirect:'manual'});
 assert.equal(r.status,303);assert.match(r.headers.get('location'),/^\/auth\/login/);
 assert.match(r.headers.get('cache-control'),/no-store/);
}
checks.push('direct and encoded files protected without login');
const r=await fetch(origin+'/auth/login',{redirect:'manual',method:'POST',headers:{Origin:origin,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({code:await dailyCode(readCloudflareSecrets().DAILY_ACCESS_SECRET)})});
assert.equal(r.status,303);const value=r.headers.get('set-cookie');
assert.match(value,/HttpOnly/);assert.match(value,/Secure/);assert.match(value,/SameSite=Lax/);
const cookie=value.split(';')[0];checks.push('production secret authenticates with secure host cookie');
for(const f of manifest.files){
 const a=await fetch(origin+(f.path==='index.html'?'/':'/'+f.path),{headers:{cookie}});
 assert.equal(a.status,200);assert.equal(createHash('sha256').update(Buffer.from(await a.arrayBuffer())).digest('hex'),f.sha256);assert.match(a.headers.get('cache-control'),/no-store/);
}
checks.push('all three approved synthetic application files unchanged after login');
const bad=await fetch(origin+'/',{redirect:'manual',headers:{cookie:cookie+'x'}});assert.equal(bad.status,303);checks.push('tampered session refused');
const cross=await fetch(origin+'/auth/logout',{redirect:'manual',method:'POST',headers:{cookie,Origin:'https://other.invalid'}});assert.equal(cross.status,403);checks.push('cross-origin logout refused');
const exit=await fetch(origin+'/auth/logout',{redirect:'manual',method:'POST',headers:{cookie,Origin:origin}});assert.equal(exit.status,303);assert.match(exit.headers.get('set-cookie'),/Max-Age=0/);checks.push('same-origin logout clears cookie');
const publicPage=await fetch('https://horizon9688.github.io/wind-curtailment-analysis/?view=1&tab=dashboard');assert.equal(publicPage.status,200);assert.equal(createHash('sha256').update(Buffer.from(await publicPage.arrayBuffer())).digest('hex'),manifest.files.find(f=>f.path==='index.html').sha256);checks.push('public GitHub Pages remains unchanged and accessible');
mkdirSync('reports/browser-review/daily-access/cloudflare-production',{recursive:true});
writeFileSync('reports/browser-review/daily-access/cloudflare-production/http-result.json',JSON.stringify({passed:true,origin,checks},null,2)+'\n');
console.log(`Production HTTP: ${checks.length} checks passed; no credentials recorded.`);
