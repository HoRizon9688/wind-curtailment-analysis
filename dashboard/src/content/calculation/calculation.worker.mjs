import {analyzeFiles} from './analyze.mjs';
import {calculationError} from './worker-errors.mjs';
import {postCalculationResult} from './result-transfer.mjs';
/** One sequential task per Worker. Cancellation is performed by terminate(). */
export function installCalculationWorker(scope) {
  let busy=false;
  scope.addEventListener('message',async({data})=>{
    const requestId=typeof data?.requestId==='string'?data.requestId:'';
    if(!requestId)return; // No valid identity to reply to.
    const error=e=>scope.postMessage({type:'error',requestId,error:calculationError(e)});
    if(data.type!=='calculate'){error({code:'INPUT',message:'未知计算任务类型'});return;}
    if(busy){error({code:'INTERNAL',message:'Worker 已有计算任务，请新建任务实例'});return;}
    busy=true;
    try {
      const result=await analyzeFiles(data.input,p=>scope.postMessage({type:'progress',requestId,...p}));
      // Includes every row and all original-byte hashes; no lossy summary path.
      postCalculationResult(scope,requestId,result);
    }catch(e){error(e);}finally{busy=false;}
  });
}
if(typeof self!=='undefined'&&typeof document==='undefined')installCalculationWorker(self);
