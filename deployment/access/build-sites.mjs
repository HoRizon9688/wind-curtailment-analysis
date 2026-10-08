// Local build only. Never creates a Site, sets hosted secrets, or deploys.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {build} from '../cloudflare/node_modules/esbuild/lib/main.js';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const out=resolve(root,'reports/access-sites-preview');
const manifest=JSON.parse(readFileSync(resolve(root,'docs/site-release.json'),'utf8'));
if(manifest.synthetic!==true||manifest.standaloneSite!==true)throw Error('Only the reviewed synthetic standalone release may be packaged');
const files={};
for(const f of manifest.files){
 if(!['index.html','samples/forecast.csv','samples/minute-power.csv'].includes(f.path))throw Error('Unexpected public asset');
 const b=readFileSync(resolve(root,'docs',f.path));if(createHash('sha256').update(b).digest('hex')!==f.sha256)throw Error('Asset digest mismatch');
 files['/'+f.path]={body:b.toString('utf8'),type:f.path.endsWith('.html')?'text/html; charset=utf-8':'text/csv; charset=utf-8'};
}
const entry=`import {createAccessWorker} from ${JSON.stringify(resolve(root,'deployment/access/worker.mjs'))};
const files=${JSON.stringify(files)};
export default createAccessWorker({fetchAsset(request){const path=new URL(request.url).pathname;const file=files[path==='/'?'/index.html':path];return file?new Response(request.method==='HEAD'?null:file.body,{headers:{'content-type':file.type}}):new Response('Not found',{status:404});}});`;
mkdirSync(resolve(out,'dist/server'),{recursive:true});mkdirSync(resolve(out,'.openai'),{recursive:true});mkdirSync(resolve(out,'dist/.openai'),{recursive:true});
await build({stdin:{contents:entry,resolveDir:root,sourcefile:'sites-access-entry.mjs',loader:'js'},bundle:true,platform:'neutral',format:'esm',target:'es2022',outfile:resolve(out,'dist/server/index.js'),logLevel:'warning'});
// DB is a logical binding; Sites provisions it only during an approved deployment.
const hosted=JSON.parse(readFileSync(resolve(root,'reports/sites/wind-curtailment-analysis/.openai/hosting.json'),'utf8'));
if(typeof hosted.project_id!=='string')throw Error('Existing Sites project identity required');
const hosting={...hosted,d1:'ACCESS_RATE_DB',r2:hosted.r2??null};delete hosting.static;
for(const rel of ['.openai/hosting.json','dist/.openai/hosting.json'])writeFileSync(resolve(out,rel),JSON.stringify(hosting,null,2)+'\n');
mkdirSync(resolve(out,'drizzle/meta'),{recursive:true});
writeFileSync(resolve(out,'drizzle/0000_access_login_attempts.sql'),readFileSync(resolve(root,'deployment/access/migrations/0001_access_login_attempts.sql')));
writeFileSync(resolve(out,'drizzle/meta/_journal.json'),JSON.stringify({version:'7',dialect:'sqlite',entries:[{idx:0,version:'6',when:1791417600000,tag:'0000_access_login_attempts',breakpoints:true}]},null,2)+'\n');
writeFileSync(resolve(out,'asset-manifest.json'),JSON.stringify({sourceRevision:manifest.sourceRevision,synthetic:true,files:manifest.files},null,2)+'\n');
console.log('Built local Sites Worker preview; production source, access policy and secrets untouched.');
