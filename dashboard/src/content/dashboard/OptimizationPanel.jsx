import React,{useMemo,useState,useRef,useEffect} from 'react';
import {DataComponent} from '../../data-app-public.jsx';
import {parseTime,MINUTE_MS} from '../calculation/time.mjs';
import {csvTable,clock} from './wind-model.mjs';
import {optimizationTotals,OPTIMIZATION_SCENARIOS,OPTIMIZATION_RESIDUAL_LIMITS} from './optimization-model.mjs';
import './optimization.css';

const format=(v,d=3)=>v==null?'—':v.toLocaleString('zh-CN',{minimumFractionDigits:d,maximumFractionDigits:d});
const title=e=>e.status==='matched'?`场景 ${e.scenarios.join(' / ')} 候选`:'压减特征待核实';
function save(text,name){const url=URL.createObjectURL(new Blob([text],{type:'text/csv;charset=utf-8'})),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
const METRICS={original:'AGC压低对应的调度限电量',optimization:'发电能力优化影响估算电量',remaining:'尚未归入能力优化的调度限电量'};
function EventEvidence({event,config,capacity}){
 const checks=event.modelChecks??[],closest=[...checks].sort((a,b)=>a.maxError-b.maxError)[0],applicable=OPTIMIZATION_SCENARIOS.filter(s=>s.alpha===event.alpha&&s.gamma===event.gamma),h=applicable.length?Math.min(...applicable.map(c=>c.h)):.10;
 const pair=event.triggerCycles,pct=n=>format(n*100,2),parts=[];
 const missing=pair.some(p=>!p),belowTrigger=!missing&&pair.some(p=>p.deficit<=h),lowAGC=!missing&&pair.some(p=>p.g<=capacity*.1);
 if(missing)parts.push('前两个触发周期数据不足，无法确认连续触发');
 else if(belowTrigger)parts.push(<>前两个触发周期的执行偏差分别为 <strong>{pair.map(p=>`${pct(p.deficit)}%`).join('、')}</strong>，没有连续两个周期都超过{h*100}%</>);
 if(lowAGC)parts.push(`前两个周期AGC未连续超过装机容量的10%（${format(capacity*.1)} MW）`);
 if(!event.recoveryPairs.length)parts.push('恢复前未找到连续两周期执行到位');
 if(!missing&&!belowTrigger&&!lowAGC&&closest&&closest.maxError>config.fitTolerance)parts.push(<>实际压减约 <strong>{pct(event.reduction)}%</strong>，场景预计 <strong>{pct(closest.reduction)}%</strong>，节点偏差超过{config.fitTolerance*100}个百分点容差</>);
 if(event.alpha>5)parts.push(`压减持续${event.alpha}个周期，可能连续触发，无法唯一匹配场景`);
 if(!parts.length)parts.push('压减曲线未能完整匹配现有场景');
 return <span className="optimization-evidence" aria-label="待核实原因">{parts.map((part,i)=><React.Fragment key={i}>{i===0?'':i===1&&parts.length===2?'；同时，':'；'}{part}</React.Fragment>)}。</span>;
}

export function OptimizationPanel({model,rows,scoped,range,selected,onSelect,onRange,Chart,config,onConfig,meta,date,dates,onDate,unit}){
 const [filter,setFilter]=useState('all'),[shades,setShades]=useState({optimization:true,dispatchRemaining:true,optimizationPending:true,missing:true});
 const focusRef=useRef(null),[focusedId,setFocusedId]=useState(null);
 useEffect(()=>{focusRef.current=null;setFocusedId(null);},[date,model]);
 const [curves,setCurves]=useState({a:true,p:true,g:true,f:true,oEstimate:true});
 const dayStart=parseTime(date),dayEnd=dayStart+1440*MINUTE_MS;
 const events=model.events.filter(e=>parseTime(e.start)<dayEnd&&parseTime(e.end)>dayStart);
 const filtered=events.filter(e=>filter==='all'||filter==='matched'&&e.status==='matched'||filter==='unresolved'&&e.status==='unresolved'||e.scenarios.includes(Number(filter)));
 const shownIds=new Set(filtered.map(e=>e.id));
 const chartRows=useMemo(()=>scoped.map(r=>({...r,oEstimate:shownIds.has(r.optimizationEvent)?r.oEstimate:null,optimizationBands:r.optimizationBands.filter(b=>b.kind==='dispatchRemaining'||shownIds.has(r.optimizationEvent))})),[scoped,model,filter]);
 const sums=optimizationTotals(scoped),hasOriginal=scoped.some(r=>r.included!==false&&typeof r.dispatch==='number'),energy=v=>hasOriginal?format(unit==='MWh'?v:v/10):'—',enabled=config.enabled;
 const eventEnergy=e=>{const value=rows.filter(r=>r.optimizationEvent===e.id).reduce((v,r)=>v+(e.status==='matched'?r.optimization:r.dispatch??0),0);return format(unit==='MWh'?value:value/10);};
 const active=rows.find(r=>r.minute===selected)||scoped[0],event=model.events.find(e=>e.id===active?.optimizationEvent);
 const inTrial=Boolean(date>=config.start&&date<=config.end);
 function change(key,value){onConfig({...config,[key]:value});}
 function isFocused(e){const f=focusRef.current;return focusedId===e.id&&f?.date===date&&f.start===range[0]&&f.end===range[1];}
 function focusEvent(e){
  if(isFocused(e)){const previous=focusRef.current;focusRef.current=null;setFocusedId(null);onRange(previous.range);onSelect(Math.max(previous.range[0],Math.min(previous.range[1]-1,previous.selected)));return;}
  const left=Math.max(0,(parseTime(e.start)-dayStart)/MINUTE_MS),right=Math.min(1440,(parseTime(e.end)-dayStart)/MINUTE_MS);
  const previous=focusRef.current,alreadyFocused=previous?.date===date&&previous.start===range[0]&&previous.end===range[1];
  focusRef.current={date,start:left,end:right,range:alreadyFocused?previous.range:[...range],selected:alreadyFocused?previous.selected:selected};setFocusedId(e.id);onRange([left,right]);onSelect(Math.floor(left));
 }
 function download(){
  const headers=['场站','容量_MW','时间','参与原分类','原分类说明',`${METRICS.original}_MWh`,`${METRICS.optimization}_MWh`,'模型重建基础电量_MWh','模型重建候选上限_MWh','小额余量归并电量_MWh',`${METRICS.remaining}_MWh`,'优化后预测估算_MW','事件编号','匹配状态','候选场景','周期取值','生效间隔_分钟','节点取样延后_分钟','拟合容差_比例','恢复容差_MW','余量归并电量占比上限','余量归并分钟功率占容量上限','估算已启用'];
  save(csvTable(headers,scoped.map(r=>[meta.stationName,meta.capacity,r.timestamp,r.included,r.note,r.dispatch,r.optimization,r.optimizationModel,r.optimizationModelUpper,r.optimizationToleranceAllocation,r.dispatchRemaining,r.oEstimate,r.optimizationEvent,r.included===false?'原分类排除':!enabled?'未启用':r.optimizationStatus==='matched'?'候选匹配':r.optimizationStatus==='unresolved'?'特征待核实':'未识别',r.optimizationScenarios,config.cycle==='mean'?'前15分钟均值':'目标时刻值',config.delayMinutes,config.nodeLagMinutes,config.fitTolerance,config.recoveryToleranceRatio*meta.capacity,OPTIMIZATION_RESIDUAL_LIMITS.energyRatio,OPTIMIZATION_RESIDUAL_LIMITS.powerRatio,enabled])),`优化影响分析-${date}-${clock(range[0]).replace(':','')}-${clock(range[1]).replace(':','')}.csv`);
 }
 return <DataComponent id="wind-optimization" title="发电能力优化场景分析" queryId="wind_minutes" kind="custom" sourceRows={rows} displayRows={scoped} variant="card" className="wind-optimization"
  description="基于原始上报预测、AGC与实发的事件级条件反推。能力优化影响估算从AGC压低对应的调度限电量中拆出，不增加总差额；不是调度确认结果。">
  <div className="optimization-intro"><p>按实时事件匹配，单日可出现多种场景。<strong>能力优化影响估算从AGC压低对应的调度限电量中拆出，不重复累计。</strong></p><button onClick={download}>导出优化分析</button></div>
  <label className="optimization-enable"><input type="checkbox" aria-label="启用发电能力优化估算" checked={enabled} onChange={e=>change('enabled',e.target.checked)}/>启用估算：确认出清计划与 AGC 一致，预测为场站原始上报值</label>
  {!enabled&&<p className="optimization-empty" role="status">尚未启用。请确认上方数据前提；其他场站或新一批上传需重新确认。</p>}
  {!hasOriginal&&<p className="optimization-empty" role="status">当前范围没有有效的原分类分钟，不能据此判断优化影响为零。</p>}
  {enabled&&!inTrial&&<p className="optimization-empty" role="status">当前日期不在设定识别区间 {config.start} — {config.end}，未划入优化影响估算。可在下方参数中调整适用日期。</p>}
  <div className="optimization-metrics" data-reviewed-rows>
   <div><span>{METRICS.original}</span><b data-testid="optimization-original">{energy(sums.originalDispatch)}<small>{unit}</small></b></div>
   <span className="optimization-equals" aria-hidden="true">＝</span>
   <div className="optimization-estimate"><span>{METRICS.optimization}</span><b data-testid="optimization-estimate">{energy(sums.optimization)}<small>{unit}</small></b>{sums.optimizationUpper-sums.optimization>1e-8&&<small>模型候选区间 {energy(sums.optimization)} — {energy(sums.optimizationUpper)} {unit}，采用下限</small>}{sums.optimizationToleranceAllocation>1e-10&&<small>其中小额余量归并 {energy(sums.optimizationToleranceAllocation)} {unit}</small>}</div>
   <span className="optimization-equals" aria-hidden="true">＋</span>
   <div><span>{METRICS.remaining}</span><b data-testid="optimization-remaining">{energy(sums.dispatchRemaining)}<small>{unit}</small></b></div>
  </div>
  <div className="optimization-toolbar"><label>查看日期<select aria-label="优化分析查看日期" value={date} onChange={e=>onDate(e.target.value)}>{dates.map(d=><option key={d}>{d}</option>)}</select></label><label>显示事件<select aria-label="优化场景筛选" value={filter} onChange={e=>setFilter(e.target.value)}><option value="all">全部事件</option><option value="matched">仅候选匹配</option><option value="unresolved">仅特征待核实</option>{OPTIMIZATION_SCENARIOS.map(s=><option key={s.id} value={s.id}>场景 {s.id} 候选</option>)}</select></label><button onClick={()=>onRange([0,1440])}>恢复全天</button><span>{clock(range[0])} — {clock(range[1])}</span></div>
  <div className="optimization-legend" role="group" aria-label="优化图曲线显示">{[['a','可用'],['p','实发'],['g','AGC'],['f','原始预测'],['oEstimate','优化后预测估算']].map(([k,label])=><button key={k} aria-pressed={curves[k]} className={curves[k]?'':'off'} onClick={()=>setCurves(v=>({...v,[k]:!v[k]}))}><i className={`optimization-line ${k}`} />{label}</button>)}</div>
  <div className="optimization-chart-grid"><div><Chart rows={chartRows} range={range} selected={selected} onSelect={onSelect} onRange={onRange} visible={curves} shades={shades} capacity={0} analysisMode/>
   <div className="optimization-legend" role="group" aria-label="优化图阴影显示">{[['optimization',METRICS.optimization],['dispatchRemaining',METRICS.remaining],['optimizationPending','压减特征待核实（不另计电量）']].map(([k,label])=><button key={k} aria-pressed={shades[k]} className={shades[k]?'':'off'} onClick={()=>setShades(v=>({...v,[k]:!v[k]}))}><i className={`optimization-swatch ${k}`}/>{label}</button>)}</div>
  </div><aside className="optimization-inspector" data-reviewed-rows><span>分钟识别 · {active?.time??'—'}</span><strong>{event?title(event):'未识别到优化事件'}</strong><dl>{[['AGC压低对应的调度限电功率',active?.dispatch],['发电能力优化影响估算功率',active?.optimization],['尚未归入能力优化的调度限电功率',active?.dispatchRemaining]].map(([label,v])=><div key={label}><dt>{label}</dt><dd>{v==null?'—':format(v*60)} <small>MW</small></dd></div>)}</dl><p>{event?.status==='matched'?`α=${event.alpha}，γ=${event.gamma}；平台压减约 ${format(event.reduction*100,2)}%。`:event?.reasons.join('；')??'图中仅展示可用、原始预测、AGC与实发；未识别不等于调度未实施优化。'}</p><small>虚线为模型重建；阴影按正式计算时刻裁切，并扣除已实际发出的功率。{event?.toleranceMerged?'此事件满足小额余量归并条件，紫色阴影包含归并部分，虚线仍保留重建值。':''}</small></aside></div>
  <div className="optimization-events-heading"><strong>当日事件 · {filtered.length}</strong><span>点击方框放大查看，再次点击恢复放大前范围；卡片电量按当日统计。</span></div>
  {!filtered.length?<p className="optimization-empty">{enabled?'当日没有符合筛选条件的完整事件。缺少触发前序或恢复后序、仅有 AGC 低于预测的片段，不会被强行归类。':'启用估算后显示事件。'}</p>:<div className="optimization-events" data-testid="optimization-events">{filtered.map(e=><button key={e.id} data-event-id={e.id} aria-pressed={isFocused(e)} className={`optimization-event ${e.status}${isFocused(e)?' is-focused':''}`} onClick={()=>focusEvent(e)}><span>{e.start.slice(5,16).replace('T',' ')} — {e.end.slice(5,16).replace('T',' ')}</span><strong>{title(e)}</strong><span>α {e.alpha} · γ {e.gamma} · 压减 {format(e.reduction*100,1)}%</span><b><small>{e.status==='matched'?'影响估算电量':'涉及调度限电量'}</small>{eventEnergy(e)} {unit}</b>{e.status==='matched'?<small>首次压减目标 {e.firstTarget.slice(11,16)}；模型相容，未获调度确认。{e.toleranceMerged?`完整事件另归并小额余量 ${format(unit==='MWh'?e.toleranceAllocation:e.toleranceAllocation/10,5)} ${unit}（原占比 ${format(e.residualRatioBeforeMerge*100,2)}%，最大分钟余量 ${format(e.maxResidualMW)} MW）。`:''}</small>:<EventEvidence event={e} config={config} capacity={meta.capacity}/>}<span className="optimization-event-action">{isFocused(e)?'正在查看 · 再次点击恢复放大前范围':'点击查看特征曲线'}</span></button>)}</div>}
  <p className="optimization-footnote">整期：候选匹配 {model.summary.matchedEvents} 组，特征待核实 {model.summary.unresolvedEvents} 组，发电能力优化影响估算电量 {energy(model.summary.optimization)} {unit}（含小额余量归并 {energy(model.summary.optimizationToleranceAllocation)} {unit}）。{model.diagnostics.frozenMinutes>0?`疑似四通道冻结 ${model.diagnostics.frozenMinutes} 分钟仅从优化识别排除，原分类保留。`:''}</p>
  <details className="optimization-settings"><summary>识别参数与场景说明</summary><div className="optimization-setting-fields">
   <label>周期功率取值<select aria-label="优化周期取值" value={config.cycle} onChange={e=>change('cycle',e.target.value)}><option value="mean">前15分钟平均值</option><option value="point">目标时刻值</option></select></label>
   <label>触发至首次目标间隔<select aria-label="优化生效间隔" value={config.delayMinutes} onChange={e=>change('delayMinutes',Number(e.target.value))}>{[15,30,45].map(n=><option key={n} value={n}>{n} 分钟</option>)}</select></label>
   <label>节点响应取样延后<select aria-label="优化节点取样延后" value={config.nodeLagMinutes} onChange={e=>change('nodeLagMinutes',Number(e.target.value))}>{[0,1,2].map(n=><option key={n} value={n}>{n} 分钟</option>)}</select></label>
   <label>拟合容差 / 百分点<select aria-label="优化拟合容差" value={config.fitTolerance} onChange={e=>change('fitTolerance',Number(e.target.value))}>{[.005,.01,.015,.02,.025,.03,.05].map(n=><option key={n} value={n}>{format(n*100,1)}</option>)}</select></label>
   <label>恢复到位容差 / 容量比例<select aria-label="优化恢复容差" value={config.recoveryToleranceRatio} onChange={e=>change('recoveryToleranceRatio',Number(e.target.value))}>{[0,.005,.01,.02].map(n=><option key={n} value={n}>{format(n*100,1)}%</option>)}</select></label>
   <label>识别起始日期<input aria-label="优化起始日期" type="date" value={config.start} max={config.end} onChange={e=>{if(e.target.value&&e.target.value<=config.end)change('start',e.target.value);}}/></label><label>识别结束日期<input aria-label="优化结束日期" type="date" value={config.end} min={config.start} onChange={e=>{if(e.target.value&&e.target.value>=config.start)change('end',e.target.value);}}/></label>
  </div><p>这些是优化识别假设，不改变原限电阈值。拟合容差针对原始预测的比例误差；恢复容差为模型假设。节点取样延后仅用于匹配，不平移正式电量。连续触发、参数动态调整和其他约束叠加可能无法唯一识别。</p><p>小额余量归并按完整事件判断：触发、幅度及恢复均匹配，且只有一种压减轨迹（场景5/6仅触发门槛不同，可视为相同轨迹）；未归因余量占事件调度限电量 ≤ {OPTIMIZATION_RESIDUAL_LIMITS.energyRatio*100}%，任一分钟余量功率 ≤ 装机容量的 {OPTIMIZATION_RESIDUAL_LIMITS.powerRatio*100}%（本站 {format(meta.capacity*OPTIMIZATION_RESIDUAL_LIMITS.powerRatio)} MW），才全部归入能力优化影响估算。页面和导出保留归并电量；缩放不重新判定。</p><div className="wind-table-scroll"><table><thead><tr><th>场景</th><th>触发偏差 h</th><th>周期 α</th><th>修正 β</th><th>恢复 γ</th></tr></thead><tbody>{OPTIMIZATION_SCENARIOS.map(s=><tr key={s.id}><td>{s.id}</td><td>{s.h*100}%</td><td>{s.alpha}</td><td>{s.beta}</td><td>{s.gamma}</td></tr>)}</tbody></table></div><p>缺少调度优化后预测，采用场景前向重建。多模型匹配时取可分配电量下限；未匹配部分保留为尚未归入能力优化的调度限电量，其中也可能包含未识别的优化影响。以上仍为估算，不是调度确认结果。</p></details>
 </DataComponent>;
}
