import {validateInput,validateProgress,validateError,LIMITS} from './contracts.mjs';
import {calculationError} from './worker-errors.mjs';
import {RESULT_PART_ROWS} from './result-transfer.mjs';
const RESULT_KEYS=['calibration','daily','gaps','meta','rows','summary'];
/** Transport lifecycle only. Browser entry binds the supported inline factory.
 * Tests inject a Worker factory; there is no formula or main-thread fallback.
 * Full field correctness is tested in the core; do not walk every received row
 * again on the UI thread just to validate a trusted internal Worker envelope.
 */
export function createCalculationClient({onProgress=()=>{},onResult=()=>{},onError=()=>{},workerFactory}) {
  let active=null,disposed=false,sequence=0;
  const prefix=globalThis.crypto.randomUUID();
  function release(task) {
    if(!task)return;
    if(active===task)active=null;
    const worker=task.worker;
    if(worker){for(const [type,fn] of Object.entries(task.handlers??{}))worker.removeEventListener(type,fn);worker.terminate();}
    task.worker=null;task.handlers=null;task.rows=null;task.totalRows=null;
  }
  function cancel(){release(active);}
  function start(input) {
    if(disposed)throw new Error('Calculation client is disposed');
    cancel();const requestId=`${prefix}:${++sequence}`;let task,startError;
    try {
      // Keep range error precedence identical to analyzeFiles.
      try{validateInput(input);}catch(e){if(e.field!=='range')throw e;}
      if(typeof workerFactory!=='function')throw new Error('Worker factory is required; import calculation-browser.mjs in browser code');
      task={requestId,worker:workerFactory(),handlers:{},rows:[],totalRows:null};active=task;
      const fail=error=>{if(active!==task)return;release(task);onError({requestId,error});};
      task.handlers.message=({data})=>{
        if(active!==task||data?.requestId!==requestId)return;
        try {
          if(data.type==='progress') {const {type,...progress}=data;validateProgress(progress);onProgress(progress);}
          else if(data.type==='error') {validateError(data.error);fail(data.error);}
          else if(data.type==='result-part') {
            if(!Array.isArray(data.rows)||data.rows.length<1||data.rows.length>RESULT_PART_ROWS||!Number.isSafeInteger(data.totalRows)||data.totalRows<1||data.totalRows>LIMITS.days*1440||data.offset!==task.rows.length||(task.totalRows!==null&&task.totalRows!==data.totalRows)||data.offset+data.rows.length>data.totalRows)throw new Error('Worker result part is missing, out of order or oversized');
            task.totalRows=data.totalRows;task.rows.push(...data.rows);
          }
          else if(data.type==='result') {
            const r=data.result;
            if(!r||Object.keys(r).sort().join(',')!==RESULT_KEYS.join(',')||!Array.isArray(r.rows)||!Array.isArray(r.daily)||!Array.isArray(r.gaps)||!r.meta||!r.summary||!r.calibration)throw new Error('Worker result envelope is invalid');
            if(data.rowCount!==undefined) {
              if(data.rowCount!==task.totalRows||data.rowCount!==task.rows.length||r.rows.length!==0)throw new Error('Worker result parts are incomplete');
              r.rows=task.rows;
            } else if(task.totalRows!==null)throw new Error('Worker mixed full and partial results');
            release(task);onResult({requestId,result:r});
          }else throw new Error('Unknown Worker message');
        }catch(e){fail(calculationError(e,'INTERNAL'));}
      };
      task.handlers.error=e=>{e.preventDefault?.();fail(calculationError({message:e.message||'Worker 无法加载或运行失败'},'INTERNAL'));};
      task.handlers.messageerror=()=>fail(calculationError({message:'Worker 结果无法传回，请重新读取文件后重试'},'INTERNAL'));
      for(const [type,fn] of Object.entries(task.handlers))task.worker.addEventListener(type,fn);
      const transfer=[...new Set([...input.power,...input.forecast].map(f=>f.bytes))];
      task.worker.postMessage({type:'calculate',requestId,input},transfer);
    }catch(e){release(task);startError=calculationError(e);}
    if(startError)onError({requestId,error:startError});
    return requestId;
  }
  return {start,cancel,dispose(){cancel();disposed=true;}};
}
