import {LIMITS,dateSpan} from '../calculation/contracts.mjs';

export function draftProblem({power,forecast,capacity,confirmed,start,end}) {
 if(!power.length||!forecast.length)return '请选择分钟功率表和数据下载预测表。';
 if(!Number.isFinite(Number(capacity))||Number(capacity)<=0)return '请填写大于 0 的装机容量（MW）。';
 if(!confirmed)return '请确认装机容量及两个文件组属于同一场站。';
 if(power.length>LIMITS.filesPerClass||forecast.length>LIMITS.filesPerClass)return '每类最多 400 个文件。';
 if([...power,...forecast].some(f=>!/^.+\.(csv|xlsx|xls)$/iu.test(f.name)))return '仅支持 CSV、XLSX 和 OOXML XLS。';
 if([...power,...forecast].reduce((sum,f)=>sum+f.size,0)>LIMITS.totalBytes)return '文件总大小超过 60,000,000 字节，请拆分日期。';
 if(start&&end){try{dateSpan(start,end);}catch{return '起止日期须为连续 1—366 天，结束日期不能早于起始日期。';}}
 return '';
}

/** One active task, no file/result persistence. The successful analysis belongs
 * to the shell; pending drafts and errors never modify it. */
export function createAnalysisSession({createClient,commit,onState}) {
 let active=null,disposed=false,sequence=0;
 const emit=s=>{if(!disposed)onState(s);};
 function release(task){if(active===task)active=null;task?.client?.dispose();if(task)task.client=null;}
 function cancel(){if(active){release(active);emit({status:'cancelled',progress:null,error:null});}}
 async function start({power,forecast,options}) {
  if(disposed)throw new Error('Analysis session is disposed');
  if(active)release(active);
  const task={id:++sequence,client:null,options:{...options}};active=task;
  let completed=0;const total=power.length+forecast.length;
  emit({status:'preparing',progress:{phase:'preparing',completed,total},error:null});
  const fail=error=>{if(active!==task)return;release(task);emit({status:'error',progress:null,error:{code:error.code??'INTERNAL',message:error.message||'计算失败',...(error.file?{file:error.file}:{}),...(error.row?{row:error.row}:{}),...(error.field?{field:error.field}:{})}});};
  try {
   const read=async file=>{
    let bytes;try{bytes=await file.arrayBuffer();}catch{throw Object.assign(new Error(`无法读取 ${file.name}，请重新选择后重试`),{code:'INPUT',file:file.name});}
    if(active!==task)return null;
    emit({status:'preparing',progress:{phase:'preparing',completed:++completed,total},error:null});
    return {name:file.name,bytes};
   };
   const [p,f]=await Promise.all([Promise.all(power.map(read)),Promise.all(forecast.map(read))]);
   if(active!==task)return;
   task.client=createClient({
    onProgress:progress=>{if(active===task)emit({status:'running',progress,error:null});},
    onError:({error})=>fail(error),
    onResult:({result,requestId})=>{
     if(active!==task)return;
     try{commit(result,requestId??String(task.id));}catch(error){fail(error);return;}
     release(task);emit({status:'success',progress:null,error:null});
    },
   });
   emit({status:'running',progress:null,error:null});
   task.client.start({power:p,forecast:f,options:task.options});
  }catch(error){fail(error);}
 }
 return {start,cancel,dispose(){if(active)release(active);disposed=true;}};
}

/** Shallow assembly is intentional: the validated Worker Result retains all
 * minute rows without a second year-long schema walk or cloned row objects. */
export function analysisCommitPayload(result,revision) {
 const {meta,summary,daily,gaps,rows,calibration}=result??{};
 if(!meta||!summary||!Array.isArray(daily)||!Array.isArray(gaps)||!Array.isArray(rows)||!rows.length)throw new Error('分析缺少完整的 meta / summary / daily / gaps / rows，保留原分析。');
 const source={type:'file',label:`${meta.stationName} · ${meta.capacity} MW · ${meta.start}—${meta.end}`,name:meta.stationName,files:meta.files.map(f=>f.name),period:`${meta.start}—${meta.end} (UTC+08:00)`,
  description:`用户在浏览器本地计算；装机 ${meta.capacity} MW；${summary.expected} 分钟，参与 ${summary.included} 分钟。\n`+meta.files.map(f=>`${f.name} · ${f.bytes} 字节 · SHA-256 ${f.sha256}`).join('\n'),
  caveats:[`当前分析：${meta.stationName}；装机 ${meta.capacity} MW；${meta.start}—${meta.end}（UTC+08:00）；预期 ${summary.expected} 分钟，参与 ${summary.included} 分钟。`,...meta.files.map(f=>`输入文件：${f.name} · ${f.bytes} 字节 · SHA-256 ${f.sha256}`),'本地用户分析；文件和结果不自动上传或持久保存，刷新后需重新导入。','全部功率为 MW，同一 AGC 测点口径，UTC+08:00。','第二点目标为预测版本+15分钟；只在连续15分钟节点间线性插值，不外推或跨缺点。','缺失、异常及厂用电负实发整分钟排除，不补零；跨日状态延续，排除分钟重置。','调度进入1%/退出0.5%，预测空间进入2%/退出1%，AGC下限2%，跟随容差1%；均按装机容量换算。结果为内部规则估算。'],
  metricDefinitions:[{label:'调度限电',definition:'调度状态有效时 max(min(A,F)−max(G,P),0)/60 MWh。'},{label:'预测限电',definition:'跟随且预测低估状态有效时 max(A−max(G,P),0)/60；调度且低估状态有效时 max(A−max(F,G,P),0)/60 MWh。'},{label:'其他差额',definition:'指令以下未发、阈值内小偏差和指令以上原因未明差额，不计入两类限电。'}]};
 const methods=[{language:'text',code:'浏览器本地 Web Worker：analyzeFiles → input-model / interpolation → ThresholdAllocator → aggregate；连续15分钟节点线性插值，按时间顺序施加容量比例滞回，逐分钟功率差除以60得到 MWh。跨日延续状态，排除分钟重置；保留实发修正。'}];
 return {queryId:'wind_minutes',namespace:'wind',rows,source,methods,analysis:{meta,summary,daily,gaps,...(calibration?{calibration}:{}),origin:'browser',revision}};
}
