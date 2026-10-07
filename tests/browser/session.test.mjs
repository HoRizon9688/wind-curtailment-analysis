import test from 'node:test';
import assert from 'node:assert/strict';
import {gunzipSync} from 'node:zlib';
import {readFileSync} from 'node:fs';
const session=await import('../../dashboard/src/content/dashboard/analysis-session-model.mjs').catch(()=>({}));
const exports=await import('../../dashboard/src/content/dashboard/analysis-exports.mjs').catch(()=>({}));
const result=JSON.parse(gunzipSync(readFileSync(new URL('../fixtures/browser/dispatch-confirmation-v2/expected/normal.json.gz',import.meta.url))));
const flush=()=>new Promise(r=>setImmediate(r));
function setup(){
 assert.equal(typeof session.createAnalysisSession,'function','T5 session controller must exist');
 const jobs=[],states=[],commits=[];
 const model=session.createAnalysisSession({createClient:callbacks=>{
  const job={...callbacks,input:null,cancelled:0,disposed:0};jobs.push(job);
  return {start(input){job.input=input;return `job${jobs.length}`;},cancel(){job.cancelled++;},dispose(){job.disposed++;}};
 },commit:r=>commits.push(r),onState:s=>states.push(s)});
 const files=()=>({power:[{name:'power.csv',size:1,arrayBuffer:async()=>new ArrayBuffer(1)}],forecast:[{name:'forecast.csv',size:1,arrayBuffer:async()=>new ArrayBuffer(1)}],options:{capacity:56,stationName:'',start:null,end:null}});
 return {model,jobs,states,commits,files};
}
test('A success stays committed throughout B failure or cancellation; B success commits once',async()=>{
 const {model,jobs,states,commits,files}=setup();
 await model.start(files());jobs[0].onResult({requestId:'job1',result});assert.deepEqual(commits,[result]);
 await model.start(files());assert.equal(states.at(-1).status,'running');assert.equal(commits.length,1);
 jobs[1].onError({requestId:'job2',error:{code:'TABLE',message:'坏文件',file:'forecast.csv',row:2}});
 assert.equal(states.at(-1).status,'error');assert.equal(states.at(-1).error.file,'forecast.csv');assert.equal(commits.length,1);
 await model.start(files());model.cancel();jobs[2].onResult({requestId:'job3',result:{...result,meta:{...result.meta,stationName:'迟到B'}}});assert.equal(commits.length,1);assert.equal(states.at(-1).status,'cancelled');
 await model.start(files());jobs[3].onResult({requestId:'job4',result});jobs[3].onResult({requestId:'job4',result});assert.equal(commits.length,2);assert.equal(states.at(-1).status,'success');
});
test('cancel during file preparation never starts Worker; retry rereads files and tabs are independent',async()=>{
 const one=setup(),two=setup();let release,reads=0;const f=one.files();f.power[0].arrayBuffer=()=>{reads++;return new Promise(r=>release=r);};
 const pending=one.model.start(f);await flush();one.model.cancel();release(new ArrayBuffer(1));await pending;assert.equal(one.jobs.length,0);
 f.power[0].arrayBuffer=async()=>{reads++;return new ArrayBuffer(1);};await one.model.start(f);assert.equal(reads,2);assert.equal(one.jobs.length,1);
 await two.model.start(two.files());one.model.dispose();assert.equal(one.jobs[0].disposed,1);assert.equal(two.jobs[0].disposed,0);two.jobs[0].onResult({requestId:'job1',result});assert.equal(two.commits.length,1);
});
test('A preparation/error/progress cannot overwrite B and commit rejection retains last success',async()=>{
 const {model,jobs,states,commits,files}=setup();let release;const a=files();a.power[0].arrayBuffer=()=>new Promise(r=>release=r);
 const pending=model.start(a);await flush();await model.start(files());release(new ArrayBuffer(1));await pending;assert.equal(jobs.length,1);
 jobs[0].onProgress({requestId:'job1',phase:'calculating',completed:1440,total:1440});assert.equal(states.at(-1).progress.completed,1440);
 model.cancel();jobs[0].onError({error:{message:'late'}});assert.equal(states.at(-1).status,'cancelled');assert.equal(commits.length,0);
 const rejected=[];const failing=session.createAnalysisSession({createClient:c=>({start(){queueMicrotask(()=>c.onResult({result}));},dispose(){}}),commit(){throw new Error('commit refused');},onState:s=>rejected.push(s)});
 await failing.start(files());await flush();assert.equal(rejected.at(-1).status,'error');assert.match(rejected.at(-1).error.message,/commit refused/);
});
test('complete commit synchronizes source and exact six-field Result without copying annual rows',()=>{
 assert.equal(typeof session.analysisCommitPayload,'function','T5 complete commit adapter must exist');
 const p=session.analysisCommitPayload(result,'test-job');assert.equal(p.rows,result.rows);assert.equal(p.namespace,'wind');assert.equal(p.queryId,'wind_minutes');
 assert.ok(p.source.label.includes(result.meta.stationName));assert.ok(p.source.caveats.some(c=>c.includes(result.meta.stationName)&&c.includes(result.meta.start)));
 assert.equal(p.source.name,result.meta.stationName);assert.deepEqual(p.source.files,result.meta.files.map(f=>f.name));
 for(const f of result.meta.files)assert.ok(p.source.caveats.some(c=>c.includes(f.name)&&c.includes(f.sha256)));
 assert.ok(p.methods.some(m=>m.code.includes('Web Worker')));
 assert.equal(p.analysis.calibration,result.calibration);assert.equal(p.analysis.origin,'browser');assert.equal(p.analysis.revision,'test-job');
 assert.throws(()=>session.analysisCommitPayload({...result,rows:[]},'bad'),/完整|缺少/);
 const zero={...result,summary:{...result.summary,included:0}};assert.equal(session.analysisCommitPayload(zero,'zero').analysis.summary.included,0);
});
test('draft validation does not assume 56MW, requires capacity confirmation, keeps data size/range limits',()=>{
 assert.equal(typeof session.draftProblem,'function','T5 draft validation must exist');
 const files={power:[{name:'p.csv',size:1}],forecast:[{name:'f.xlsx',size:1}],capacity:'60',confirmed:true,start:'',end:''};
 assert.equal(session.draftProblem(files),'');assert.match(session.draftProblem({...files,confirmed:false}),/容量/);
 assert.match(session.draftProblem({...files,capacity:'Infinity'}),/容量/);assert.match(session.draftProblem({...files,capacity:'0'}),/容量/);
 assert.match(session.draftProblem({...files,power:[{name:'p.csv',size:60_000_000}]}),/60/);
 assert.match(session.draftProblem({...files,start:'2026-01-01',end:'2027-01-02'}),/366/);
});
test('exports preserve full JSON, truthful station and period, daily coverage, exclusions and CSV formula safety',()=>{
 assert.equal(typeof exports.exportAnalysis,'function','T5 export descriptors must exist');
 const r={...result,meta:{...result.meta,stationName:'=恶意,"站\n名',files:[{name:'=file.xlsx',bytes:1,sha256:'a'.repeat(64)}]}};
 const json=exports.exportAnalysis(r,'json');assert.deepEqual(JSON.parse(json.text),r);assert.ok(json.name.endsWith('.json'));assert.ok(!/[\r\n"<>:/\\|?*]/.test(json.name));
 for(const kind of ['minutes','daily','gaps']){const out=exports.exportAnalysis(r,kind);assert.ok(out.text.startsWith('\uFEFF'));assert.ok(out.name.includes(r.meta.start));assert.ok(out.text.includes("'=恶意"));}
 assert.match(exports.exportAnalysis(r,'daily').text,/覆盖率/);assert.match(exports.exportAnalysis(r,'gaps').text,/终点（不含）/);
});
