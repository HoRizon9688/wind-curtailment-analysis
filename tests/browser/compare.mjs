import { ENERGY_KEYS, AUDIT_ENERGY_KEYS } from '../../dashboard/src/content/calculation/contracts.mjs';

const minuteNumbers=new Set(['a','f','g','p','theory','leftF','rightF','weight','trackingReference',...ENERGY_KEYS,...AUDIT_ENERGY_KEYS]);
const aggregateEnergy=new Set([...ENERGY_KEYS,...AUDIT_ENERGY_KEYS,'assigned','difference','closureError']);
export const TOLERANCES=Object.freeze({minute:1e-9,aggregateEnergy:1e-6,ratio:1e-9});
function tolerance(path) {
  if(/^\$\.rows\[\d+\]\.[^.[]+$/.test(path) && minuteNumbers.has(path.split('.').at(-1)))return TOLERANCES.minute;
  if(/^\$\.rows\[\d+\]\.allocationBands\[\d+\]\.(bottom|top)$/.test(path))return TOLERANCES.minute;
  if(/^\$\.(summary|daily\[\d+\]|calibration)\.[^.[]+$/.test(path)) {
    const key=path.split('.').at(-1);
    if(aggregateEnergy.has(key))return TOLERANCES.aggregateEnergy;
    if(['coverage','dispatchShare','relativeDifference'].includes(key))return TOLERANCES.ratio;
  }
  return 0;
}

/** Compare unrounded full results. Exact keys, nulls, booleans, array order and counters.
 * No arbitrary ignore list and no early-exit cap: first AND all differences are returned.
 * Caller validates the Result schema separately (so two identical malformed objects are not accepted).
 */
export function compareResults(expected,actual) {
  const differences=[];let maxMinuteError=0,maxAggregateEnergyError=0;
  function record(path,kind,e,a,context,extra={}) {
    const rowMatch=/^\$\.rows\[(\d+)\]/.exec(path);
    const row=rowMatch && expected?.rows?.[Number(rowMatch[1])];
    if(row)context={timestamp:row.timestamp,input:{a:row.a,f:row.f,g:row.g,p:row.p}};
    differences.push({path,kind,expected:e,actual:a,expectedPresent:kind!=='extra',actualPresent:kind!=='missing',...context,...extra});
  }
  function walk(e,a,path,context={}) {
    const rowMatch=/^\$\.rows\[(\d+)\]$/.exec(path);
    if(rowMatch && e && typeof e==='object')context={timestamp:e.timestamp,input:{a:e.a,f:e.f,g:e.g,p:e.p}};
    if(typeof e==='number' && typeof a==='number') {
      const error=Math.abs(e-a),limit=tolerance(path);
      if(!Number.isFinite(e)||!Number.isFinite(a)){record(path,'nonfinite',e,a,context);return;}
      if(limit===TOLERANCES.aggregateEnergy)maxAggregateEnergyError=Math.max(maxAggregateEnergyError,error);
      else if(limit===TOLERANCES.minute)maxMinuteError=Math.max(maxMinuteError,error);
      if(error>limit)record(path,'number',e,a,context,{absoluteError:error,tolerance:limit});
      return;
    }
    if(e===null || a===null || typeof e!=='object' || typeof a!=='object') {
      if(!Object.is(e,a))record(path,'value',e,a,context);
      return;
    }
    if(Array.isArray(e)!==Array.isArray(a)){record(path,'type',e,a,context);return;}
    if(Array.isArray(e)) {
      for(let i=0;i<Math.max(e.length,a.length);i++) {
        const p=`${path}[${i}]`;
        if(i>=e.length)record(p,'extra',undefined,a[i],context);
        else if(i>=a.length)record(p,'missing',e[i],undefined,context);
        else walk(e[i],a[i],p,context);
      }
      return;
    }
    for(const key of new Set([...Object.keys(e),...Object.keys(a)])) {
      const p=`${path}.${key}`;
      if(!Object.hasOwn(e,key))record(p,'extra',undefined,a[key],context);
      else if(!Object.hasOwn(a,key))record(p,'missing',e[key],undefined,context);
      else walk(e[key],a[key],p,context);
    }
  }
  walk(expected,actual,'$');
  return {equal:differences.length===0,first:differences[0]??null,differences,maxMinuteError,maxAggregateEnergyError};
}
