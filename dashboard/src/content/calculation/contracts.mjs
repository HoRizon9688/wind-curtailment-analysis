/**
 * Frozen T1 boundary, before algorithm migration. No allocation formula lives here.
 * Source of truth: unchanged upload_pipeline.py / threshold_allocation.py.
 * See docs/browser-calculation-contract.md for conditional fields and units.
 *
 * @typedef {{name:string, bytes:ArrayBuffer}} InputFile Original, unmodified bytes.
 * @typedef {{capacity:number, stationName:string, start:string|null, end:string|null}} Options
 * @typedef {{power:InputFile[], forecast:InputFile[], options:Options}} Input
 * @typedef {{meta:object, summary:object, daily:object[], gaps:object[], rows:object[], calibration:object}} Result
 * @typedef {{code:string,message:string,file?:string,row?:number,field?:string}} CalculationError
 * @typedef {{requestId:string,phase:string,completed:number,total:number}} Progress
 */
export const LIMITS = Object.freeze({totalBytes:60_000_000,filesPerClass:400,expandedWorkbookBytes:150_000_000,days:366});
export const UNITS = Object.freeze({power:'MW',energy:'MWh',duration:'minute',timezone:'UTC+08:00'});
export const ENERGY_KEYS = Object.freeze(['dispatch','prediction','other','above','below','gap','noiseAbove','noiseBelow','operationalBelow','unexplainedAbove']);
export const AUDIT_ENERGY_KEYS = Object.freeze(['referenceTotal','releasedAboveAgc']);
export const COUNT_KEYS = Object.freeze(['expected','included','excluded','negativeActual','missingForecast','missingPower','baselineAnomalies','special']);
export const STATE_KEYS = Object.freeze(['dispatchState','predictionState','following','floorFollowing']);
export const FORECAST_KEYS = Object.freeze(['version','rightVersion','target','rightTarget','leftF','rightF','weight','forecastSource','rightForecastSource']);
export const PHASES = Object.freeze(['reading','validating','calculating','aggregating']);
export const ERROR_CODES = Object.freeze(['INPUT','TABLE','TIME','DUPLICATE','STATION','RANGE','RESOURCE','INTERNAL']);
export const THRESHOLDS = Object.freeze({agcFloorPct:2,dispatchEnterPct:1,dispatchExitPct:.5,followingPct:1,predictionEnterPct:2,predictionExitPct:1,operationalPct:.5});

export class ContractError extends Error {
  constructor(path, detail) { super(`${path}: ${detail}`); this.name='ContractError'; this.code='INPUT'; this.field=path; }
}
const fail=(path,detail)=>{throw new ContractError(path,detail);};
const object=(x,path)=>{if(x===null || typeof x!=='object' || Array.isArray(x)) fail(path,'expected object');};
const array=(x,path)=>{if(!Array.isArray(x)) fail(path,'expected array');};
const string=(x,path)=>{if(typeof x!=='string') fail(path,'expected string');};
const finite=(x,path)=>{if(typeof x!=='number' || !Number.isFinite(x)) fail(path,'expected finite number');};
const nullable=(x,path)=>{if(x!==null) finite(x,path);};
const count=(x,path)=>{if(!Number.isSafeInteger(x) || x<0) fail(path,'expected nonnegative integer');};
function keys(x,required,optional,path) {
  object(x,path);
  for(const key of required) if(!Object.hasOwn(x,key)) fail(`${path}.${key}`,'missing field (not null)');
  for(const key of Object.keys(x)) if(!required.includes(key) && !optional.includes(key)) fail(`${path}.${key}`,'unexpected field');
}
function date(value,path) {
  if(typeof value!=='string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail(path,'expected YYYY-MM-DD');
  const ms=Date.parse(`${value}T00:00:00Z`);
  if(!Number.isFinite(ms) || new Date(ms).toISOString().slice(0,10)!==value || value<'0001-01-01') fail(path,'invalid calendar date');
  return ms;
}
/** Inclusive reporting dates, not timestamps. Inferred dates are checked by T3 after normalization. */
export function dateSpan(start,end) {
  const days=(date(end,'end')-date(start,'start'))/86_400_000+1;
  if(days<1 || days>LIMITS.days) fail('range','计算日期范围须为连续 1—366 天');
  return days;
}
function timestamp(x,path) {
  if(typeof x!=='string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\+08:00$/.test(x)) fail(path,'expected minute ISO timestamp +08:00');
  date(x.slice(0,10),path);
  if(Number(x.slice(11,13))>23 || Number(x.slice(14,16))>59) fail(path,'invalid clock time');
}

export function validateInput(input) {
  keys(input,['power','forecast','options'],[],'input');
  let total=0;
  for(const kind of ['power','forecast']) {
    array(input[kind],kind);
    if(input[kind].length<1 || input[kind].length>LIMITS.filesPerClass) fail(kind,'每类须上传 1—400 个文件');
    input[kind].forEach((file,i)=>{
      const path=`${kind}[${i}]`; keys(file,['name','bytes'],[],path); string(file.name,`${path}.name`);
      if(!/\.(csv|xlsx|xls)$/i.test(file.name)) fail(`${path}.name`,'仅支持 CSV、XLSX 和 OOXML XLS');
      if(!(file.bytes instanceof ArrayBuffer) || file.bytes.byteLength===0) fail(`${path}.bytes`,'expected nonempty ArrayBuffer');
      total+=file.bytes.byteLength;
    });
  }
  if(total>LIMITS.totalBytes) fail('input','文件总大小超过 60,000,000 字节');
  const o=input.options; keys(o,['capacity','stationName','start','end'],[],'options');
  finite(o.capacity,'capacity'); if(o.capacity<=0) fail('capacity','装机容量须为大于 0 的 MW 数值');
  string(o.stationName,'stationName');
  for(const k of ['start','end']) if(o[k]!==null) date(o[k],k);
  if(o.start!==null && o.end!==null) dateSpan(o.start,o.end);
  return input;
}

function stats(x,path,daily=false) {
  keys(x,[...ENERGY_KEYS,...COUNT_KEYS,'coverage','dispatchShare',...(daily?['date']:[])],[],path);
  for(const k of ENERGY_KEYS) {finite(x[k],`${path}.${k}`); if(x[k]<0) fail(`${path}.${k}`,'negative energy');}
  for(const k of COUNT_KEYS) count(x[k],`${path}.${k}`);
  finite(x.coverage,`${path}.coverage`); nullable(x.dispatchShare,`${path}.dispatchShare`);
  if(x.included+x.excluded!==x.expected) fail(path,'included + excluded != expected');
  if(x.coverage<0 || x.coverage>1 || (x.dispatchShare!==null && (x.dispatchShare<0 || x.dispatchShare>1))) fail(path,'ratio outside [0,1]');
  if(daily) date(x.date,`${path}.date`);
}

/** Schema validation is deliberately independent of allocation equations. */
export function validateResult(result) {
  keys(result,['meta','summary','daily','gaps','rows','calibration'],[],'result');
  const m=result.meta;
  const strings=['stationId','stationName','start','end','timezone','negativePolicy'];
  const counts=['forecastNodes','forecastDuplicates','blankForecastRows','powerRows','powerDuplicates','powerOutsidePeriod'];
  keys(m,[...strings,...counts,'capacity','thresholds','files'],[],'meta');
  for(const k of strings) string(m[k],`meta.${k}`);
  for(const k of counts) count(m[k],`meta.${k}`);
  finite(m.capacity,'meta.capacity'); if(m.capacity<=0) fail('meta.capacity','nonpositive capacity');
  const days=dateSpan(m.start,m.end);
  if(m.timezone!==UNITS.timezone) fail('meta.timezone','expected UTC+08:00');
  keys(m.thresholds,Object.keys(THRESHOLDS),[],'meta.thresholds');
  for(const [k,v] of Object.entries(THRESHOLDS)) if(m.thresholds[k]!==v) fail(`meta.thresholds.${k}`,'frozen threshold changed');
  array(m.files,'meta.files');
  m.files.forEach((f,i)=>{const path=`meta.files[${i}]`;keys(f,['name','bytes','sha256'],[],path);string(f.name,path);count(f.bytes,path);if(typeof f.sha256!=='string'||!/^[a-f0-9]{64}$/.test(f.sha256))fail(path,'invalid SHA-256');});
  stats(result.summary,'summary');
  for(const k of ['daily','gaps','rows']) array(result[k],k);
  result.daily.forEach((x,i)=>stats(x,`daily[${i}]`,true));
  if(result.rows.length!==days*1440 || result.summary.expected!==result.rows.length || result.daily.length!==days) fail('rows','report grid must contain every reporting minute');
  const begin=Date.parse(`${m.start}T00:00:00+08:00`);
  result.rows.forEach((r,i)=>{
    const path=`rows[${i}]`;
    const base=['timestamp','date','time','minute','a','f','g','p','theory','included','reasons','status','note',...ENERGY_KEYS];
    const valid=[...AUDIT_ENERGY_KEYS,...STATE_KEYS,'trackingReference','allocationBands'];
    const forecast=r.f===null?[]:FORECAST_KEYS;
    keys(r,[...base,...forecast,...(r.included===true?valid:[])],['powerSource'],path);
    timestamp(r.timestamp,`${path}.timestamp`);
    if(Date.parse(r.timestamp)!==begin+i*60_000 || r.date!==r.timestamp.slice(0,10) || r.time!==r.timestamp.slice(11,16) || r.minute!==i%1440) fail(path,'incorrect chronological minute grid');
    for(const k of ['a','f','g','p','theory']) nullable(r[k],`${path}.${k}`);
    if(typeof r.included!=='boolean') fail(path,'included must be boolean');
    array(r.reasons,`${path}.reasons`);r.reasons.forEach(x=>string(x,`${path}.reasons`));string(r.note,`${path}.note`);
    if(r.status!==(r.included?'estimated':'excluded') || r.included!==(r.reasons.length===0)) fail(path,'status/reasons inconsistent');
    if(Object.hasOwn(r,'powerSource')) string(r.powerSource,`${path}.powerSource`);
    if(r.f!==null) {
      for(const k of ['version','rightVersion','target','rightTarget']) timestamp(r[k],`${path}.${k}`);
      for(const k of ['leftF','rightF','weight']) finite(r[k],`${path}.${k}`);
      for(const k of ['forecastSource','rightForecastSource']) string(r[k],`${path}.${k}`);
      if(r.weight<0 || r.weight>1) fail(`${path}.weight`,'interpolation weight outside [0,1]');
    }
    for(const k of ENERGY_KEYS) {
      if(r.included) {finite(r[k],`${path}.${k}`);if(r[k]<0)fail(path,'negative energy');}
      else if(r[k]!==null) fail(`${path}.${k}`,'excluded energy must be null');
    }
    if(r.included) {
      for(const k of ['a','f','g','p','trackingReference',...AUDIT_ENERGY_KEYS]) finite(r[k],`${path}.${k}`);
      for(const k of ['a','f','g','p','leftF','rightF']) if(r[k]<0 || r[k]>m.capacity) fail(`${path}.${k}`,'included power outside [0,capacity]');
      for(const k of AUDIT_ENERGY_KEYS) if(r[k]<0) fail(`${path}.${k}`,'negative audit energy');
      for(const k of STATE_KEYS) if(typeof r[k]!=='boolean') fail(`${path}.${k}`,'expected boolean');
      array(r.allocationBands,`${path}.allocationBands`);
      r.allocationBands.forEach((b,j)=>{const bp=`${path}.allocationBands[${j}]`;keys(b,['kind','bottom','top'],[],bp);if(!['other','dispatch','prediction'].includes(b.kind))fail(bp,'unknown band');finite(b.bottom,bp);finite(b.top,bp);if(b.top<=b.bottom)fail(bp,'empty/reversed band');});
    }
  });
  result.gaps.forEach((g,i)=>{const path=`gaps[${i}]`;keys(g,['start','end','minutes','reason'],[],path);timestamp(g.start,path);timestamp(g.end,path);count(g.minutes,path);string(g.reason,path);if(g.minutes===0 || Date.parse(g.end)-Date.parse(g.start)!==g.minutes*60_000)fail(path,'gap is half-open [start,end)');});
  const c=result.calibration;
  keys(c,['referenceTotal','assigned','difference','relativeDifference','releasedAboveAgc','noiseAbove','unexplainedAbove','closureError'],[],'calibration');
  for(const k of Object.keys(c)) if(k==='relativeDifference')nullable(c[k],`calibration.${k}`);else finite(c[k],`calibration.${k}`);
  return result;
}

export function validateError(error) {
  keys(error,['code','message'],['file','row','field'],'error');string(error.message,'message');
  if(!ERROR_CODES.includes(error.code))fail('code','unknown error code');
  for(const k of ['file','field'])if(Object.hasOwn(error,k))string(error[k],k);
  if(Object.hasOwn(error,'row')){count(error.row,'row');if(error.row<2)fail('row','physical data row must be >= 2');}
  return error;
}
export function validateProgress(progress) {
  keys(progress,['requestId','phase','completed','total'],[],'progress');string(progress.requestId,'requestId');
  if(!progress.requestId || !PHASES.includes(progress.phase))fail('progress','unknown phase or empty request id');
  count(progress.completed,'completed');count(progress.total,'total');
  if(progress.completed>progress.total)fail('progress','completed exceeds total');
  return progress;
}
