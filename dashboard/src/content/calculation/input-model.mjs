import {dictionaryRows,numberOrNull} from './table-reader.mjs';
import {parseTime,formatTime,QUARTER_MS,stripText} from './time.mjs';
import {CalculationError} from './errors.mjs';
import {pythonString} from './scalar.mjs';
export const POWER_COLUMNS=Object.freeze({a:'可用功率',p:'全站总有功_集电线有功之和',g:'AGC有功设定值'});
// Scalar strings/truthiness follow Python's table types, not JavaScript coercion.

/** Adapted from reviewed handoff read_tables.mjs; async file I/O stays outside. */
export function normalizeInputs(powerTables,forecastTables) {
  const power=new Map(),forecasts=new Map(),stations=new Map();let powerDuplicates=0,forecastDuplicates=0,blankForecastRows=0;
  for(const table of powerTables) {
    for(const {line,values:row} of dictionaryRows(table,['时间',...Object.values(POWER_COLUMNS)])) {
      let t;try{t=parseTime(row['时间']);}catch(e){throw new CalculationError('TIME',`${table.name} 第 ${line} 行：${e.message}`,{file:table.name,row:line,field:'时间'});}
      const values=Object.fromEntries(Object.entries(POWER_COLUMNS).map(([key,col])=>[key,numberOrNull(row[col])]));values.theory=numberOrNull(row['理论功率']);
      if(power.has(t)) {
        if(Object.entries(values).some(([key,v])=>power.get(t)[key]!==v))throw new CalculationError('DUPLICATE',`分钟功率重复冲突：${formatTime(t)}（${table.name} 第 ${line} 行）`,{file:table.name,row:line});
        powerDuplicates++;continue;
      }
      power.set(t,{...values,powerSource:`${table.name} 第 ${line} 行`});
    }
  }
  if(!power.size)throw new CalculationError('INPUT','分钟功率表没有数据');
  for(const table of forecastTables) {
    for(const {line,values:row} of dictionaryRows(table,['预测id','名称','预测时间','考核点2预测结果'])) {
      const station=stripText(pythonString(row['预测id']||''));
      if(!station)throw new CalculationError('STATION',`${table.name} 第 ${line} 行：场站预测 id 缺失`,{file:table.name,row:line,field:'预测id'});
      stations.set(station,pythonString(row['名称']||station));
      if(stations.size>1)throw new CalculationError('STATION','预测表包含多个场站，请每次仅上传一个场站的数据');
      const value=numberOrNull(row['考核点2预测结果']);if(value===null){blankForecastRows++;continue;}
      let t;
      try {t=parseTime(row['预测时间']);}
      catch(error) {throw new CalculationError('TIME',error.message,{file:table.name,row:line,field:'预测时间'});}
      if(t%QUARTER_MS!==0)throw new CalculationError('TIME',`${table.name} 第 ${line} 行：预测版本须对齐 15 分钟`,{file:table.name,row:line,field:'预测时间'});
      const target=t+QUARTER_MS;
      if(forecasts.has(target)) {
        if(forecasts.get(target).value!==value)throw new CalculationError('DUPLICATE',`预测第二点重复冲突：版本 ${formatTime(t)}，请确认实际采用版本`,{file:table.name,row:line});
        forecastDuplicates++;continue;
      }
      forecasts.set(target,{value,version:formatTime(t),source:`${table.name} 第 ${line} 行`});
    }
  }
  if(!forecasts.size)throw new CalculationError('INPUT','预测表没有有效的“考核点2预测结果”');
  const [stationId,stationName]=stations.entries().next().value;
  return {power,forecasts,metadata:{stationId,stationName,forecastNodes:forecasts.size,forecastDuplicates,blankForecastRows,powerDuplicates,
    files:[...powerTables,...forecastTables].map(({name,bytes,sha256})=>({name,bytes,sha256}))}};
}
