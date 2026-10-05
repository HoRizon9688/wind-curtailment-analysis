import {ERROR_CODES} from './contracts.mjs';
/** Strip Error internals; keep only the frozen, serializable error contract. */
export function calculationError(error,code) {
  const out={code:code??(ERROR_CODES.includes(error?.code)?error.code:'INTERNAL'),message:String(error?.message??error??'计算任务失败')};
  for(const key of ['file','field'])if(typeof error?.[key]==='string')out[key]=error[key];
  if(Number.isSafeInteger(error?.row)&&error.row>=2)out.row=error.row;
  return out;
}
