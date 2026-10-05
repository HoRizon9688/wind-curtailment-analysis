import test from 'node:test';
import assert from 'node:assert/strict';
import {createCalculationClient} from '../../dashboard/src/content/calculation/calculation-client.mjs';
import {fixtureInput,loadJson,loadExpected} from './fixture-tools.mjs';
const c=loadJson('manifest.json').cases.find(c=>c.id==='continuous-day-56mw');
const result=()=>loadExpected(c.expected);
class ControlledWorker {
  listeners={};terminated=false;sent=null;
  addEventListener(type,fn){this.listeners[type]=fn;}
  removeEventListener(type,fn){if(this.listeners[type]===fn)delete this.listeners[type];}
  postMessage(message,transfer){this.sent=structuredClone(message,{transfer});}
  terminate(){this.terminated=true;}
}
function setup(factory){const workers=[],events=[];const client=createCalculationClient({workerFactory:factory??(()=>{const w=new ControlledWorker();workers.push(w);return w;}),onProgress:e=>events.push(['progress',e]),onResult:e=>events.push(['result',e]),onError:e=>events.push(['error',e])});return {workers,events,client};}

test('late A cannot overwrite B; cancelled result/error/progress are all ignored',()=>{
  const {client,workers,events}=setup();const a=client.start(fixtureInput(c));const late=workers[0].listeners.message;
  const b=client.start(fixtureInput(c));assert.notEqual(a,b);assert.equal(workers[0].terminated,true);
  for(const type of ['result','error','progress'])late({data:{type,requestId:a,result:result(),error:{code:'INPUT',message:'late'}}});
  assert.equal(events.length,0);
  const bHandler=workers[1].listeners.message;
  bHandler({data:{type:'result',requestId:b,result:result()}});
  assert.equal(events.length,1);assert.equal(events[0][1].requestId,b);assert.equal(workers[1].terminated,true);
  const d=client.start(fixtureInput(c));const dHandler=workers[2].listeners.message;client.cancel();
  for(const type of ['result','error','progress'])dHandler({data:{type,requestId:d,result:result(),error:{code:'INPUT',message:'late'}}});
  assert.equal(events.length,1);assert.equal(workers[2].terminated,true);
});
test('buffers transfer once; cancelled retry needs freshly read bytes, then dispose removes handlers',()=>{
  const {client,workers,events}=setup();const input=fixtureInput(c);client.start(input);
  assert.equal(input.power[0].bytes.byteLength,0);assert.ok(workers[0].sent.input.power[0].bytes.byteLength>0);
  client.cancel();client.start(input);assert.equal(events.at(-1)[0],'error');assert.equal(workers.length,1);
  client.start(fixtureInput(c));client.dispose();assert.equal(workers.at(-1).terminated,true);assert.deepEqual(workers.at(-1).listeners,{});
  assert.throws(()=>client.start(fixtureInput(c)),/disposed/);
});
test('creation, transfer, execution and message errors release task and allow retry',()=>{
  const broken=setup(()=>{throw new Error('cannot create worker');});const id=broken.client.start(fixtureInput(c));assert.equal(broken.events[0][1].requestId,id);assert.equal(broken.events[0][1].error.code,'INTERNAL');
  const {client,workers,events}=setup();const a=client.start(fixtureInput(c));workers[0].listeners.error({message:'worker crash',preventDefault(){}});
  assert.equal(events[0][1].requestId,a);assert.equal(workers[0].terminated,true);
  const b=client.start(fixtureInput(c));workers[1].listeners.messageerror({});assert.equal(events[1][1].requestId,b);assert.equal(workers[1].terminated,true);
  const d=client.start(fixtureInput(c));workers[2].listeners.message({data:{type:'progress',requestId:d,phase:'calculating',completed:2,total:1}});
  assert.equal(events[2][1].error.code,'INTERNAL');assert.equal(workers[2].terminated,true);
  let count=0;const failingTransfer=setup(()=>{const w=new ControlledWorker();if(count++===0)w.postMessage=()=>{throw new Error('transfer failed');};return w;});
  failingTransfer.client.start(fixtureInput(c));assert.equal(failingTransfer.events.length,1);assert.equal(failingTransfer.events[0][0],'error');
  failingTransfer.client.start(fixtureInput(c));assert.equal(count,2);
});
test('valid progress and errors retain identity/location and success callback can start next task',()=>{
  const {client,workers,events}=setup();const id=client.start(fixtureInput(c));workers[0].listeners.message({data:{type:'progress',requestId:id,phase:'reading',completed:1,total:2}});
  assert.equal(events[0][1].completed,1);
  workers[0].listeners.message({data:{type:'error',requestId:id,error:{code:'TIME',message:'bad time',file:'x.csv',row:2,field:'时间'}}});
  assert.deepEqual(events[1][1].error,{code:'TIME',message:'bad time',file:'x.csv',row:2,field:'时间'});
  const created=[];let reentrant;
  reentrant=createCalculationClient({workerFactory:()=>{const w=new ControlledWorker();created.push(w);return w;},onResult:()=>reentrant.start(fixtureInput(c))});
  const first=reentrant.start(fixtureInput(c));created[0].listeners.message({data:{type:'result',requestId:first,result:result()}});
  assert.equal(created.length,2);assert.equal(created[0].terminated,true);assert.equal(created[1].terminated,false);reentrant.dispose();
});
test('result parts are atomic, ordered, bounded, cancellable and preserve every row',()=>{
  const {client,workers,events}=setup();const id=client.start(fixtureInput(c)),handler=workers[0].listeners.message;
  const expected=result(),rows=expected.rows;
  handler({data:{type:'result-part',requestId:id,offset:0,totalRows:1440,rows:rows.slice(0,1024)}});
  assert.equal(events.length,0);
  handler({data:{type:'result-part',requestId:id,offset:1024,totalRows:1440,rows:rows.slice(1024)}});
  handler({data:{type:'result',requestId:id,rowCount:1440,result:{...expected,rows:[]}}});
  assert.deepEqual(events[0][1].result,expected);
  const b=client.start(fixtureInput(c)),bHandler=workers[1].listeners.message;
  bHandler({data:{type:'result-part',requestId:b,offset:0,totalRows:1440,rows:rows.slice(0,1024)}});client.cancel();
  bHandler({data:{type:'result',requestId:b,rowCount:1440,result:{...expected,rows:[]}}});assert.equal(events.length,1);
  const d=client.start(fixtureInput(c));workers[2].listeners.message({data:{type:'result-part',requestId:d,offset:1,totalRows:1440,rows:rows.slice(0,1)}});
  assert.equal(events.at(-1)[0],'error');assert.equal(events.at(-1)[1].error.code,'INTERNAL');
  for(const scenario of ['incomplete','oversized','duplicate']) {
    const at=workers.length,id=client.start(fixtureInput(c)),handle=workers[at].listeners.message;
    const part={type:'result-part',requestId:id,offset:0,totalRows:1440,rows:rows.slice(0,1024)};
    if(scenario==='oversized')part.rows=rows;
    handle({data:part});
    if(scenario==='duplicate')handle({data:part});
    if(scenario==='incomplete')handle({data:{type:'result',requestId:id,rowCount:1440,result:{...expected,rows:[]}}});
    assert.equal(events.at(-1)[0],'error');assert.equal(workers[at].terminated,true);
  }
});
