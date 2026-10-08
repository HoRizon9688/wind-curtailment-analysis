import React,{useState,useMemo,useRef,useEffect} from 'react';
import {DataComponent,SortableRegion,SortableItem,useDataApp} from '../../data-app-public.jsx';
import {clock,filterRows,totals,bands,stepPath,hourly} from './wind-model.mjs';
import {generationTotals} from './generation-model.mjs';
import {panRange,zoomRange} from './chart-viewport.mjs';
import './wind.css';
import {UploadPanel,PeriodOverview,Exclusions} from './UploadPanel.jsx';
import {exportAnalysis} from './analysis-exports.mjs';
import {T0AnalysisHarness} from './analysis-session.jsx';

const C={a:'var(--wind-available)',p:'var(--wind-actual)',g:'var(--wind-agc)',f:'var(--wind-forecast)',theory:'var(--wind-theory)',dispatch:'var(--wind-dispatch)',prediction:'var(--wind-prediction)',other:'var(--wind-other)',generation:'var(--wind-generation)',missing:'var(--wind-missing)'};
const L={a:'可用功率',p:'实发功率',g:'AGC 指令',f:'预测（线性插值）',theory:'理论功率',dispatch:'调度限电',prediction:'预测限电',other:'其他差额',missing:'已排除时段'};
const fmt=(v,d=3)=>v==null?'—':v.toLocaleString('zh-CN',{minimumFractionDigits:d,maximumFractionDigits:d});
function Icon({name,size=18}){const p={wind:'M3 8h12a3 3 0 1 0-3-3M3 12h16a3 3 0 1 1-3 3M3 16h6',download:'M12 3v12m-4-4 4 4 4-4M4 16v5h16v-5',play:'m8 4 12 8-12 8Z',pause:'M8 5v14M16 5v14',reset:'M4 10a8 8 0 1 1 0 5M4 3v7h7',info:'M12 10v7M12 7h.01'};return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={p[name]||p.info}/></svg>;}
function useWidth(){const ref=useRef(null),[width,setWidth]=useState(900);useEffect(()=>{const obs=new ResizeObserver(([e])=>setWidth(Math.max(200,e.contentRect.width)));if(ref.current)obs.observe(ref.current);return()=>obs.disconnect();},[]);return[ref,width];}

function PowerChart({rows,range,selected,onSelect,onRange,visible,shades,capacity}){
 const [ref,w]=useWidth();const h=354,left=42,right=12,top=22,bottom=30;
 const max=capacity?capacity:Math.max(10,Math.ceil(Math.max(...rows.map(r=>Math.max(r.a,r.p,r.g,r.f??0,r.theory)))/5)*5);
 const min=Math.min(0,...rows.map(r=>r.p??0));
 const x=m=>left+(m-range[0])/(range[1]-range[0])*(w-left-right),y=v=>h-bottom-(v-min)/(max-min)*(h-top-bottom);
 const drag=useRef(null),svgRef=useRef(null),viewport=useRef(null),[dragEnd,setDragEnd]=useState(null),[panning,setPanning]=useState(false);
 viewport.current={range,onRange,width:w};
 const geo=useMemo(()=>{const fill={dispatch:'',prediction:'',other:'',missing:''};for(const r of rows)for(const b of bands(r))fill[b.kind]+=`M${x(r.minute)},${y(b.top)}H${x(r.minute+1)}V${y(b.bottom)}H${x(r.minute)}Z`;return{fill,lines:Object.fromEntries(['a','p','g','f','theory'].map(k=>[k,stepPath(rows,k,x,y)]))};},[rows,range,w,max,min]);
 const position=(clientX,svg,width)=>{const rect=svg.getBoundingClientRect();return Math.max(0,Math.min(1,((clientX-rect.left)/rect.width*width-left)/(width-left-right)));};
 const locate=e=>Math.max(range[0],Math.min(range[1]-1,Math.floor(range[0]+position(e.clientX,e.currentTarget,w)*(range[1]-range[0]))));
 useEffect(()=>{
  const svg=svgRef.current;
  function wheel(event){
   // Keep browser zoom shortcuts available. A native non-passive listener is
   // required so wheel navigation inside the plot cannot also scroll the page.
   if(event.ctrlKey||event.metaKey||!event.deltaY)return;
   event.preventDefault();
   const current=viewport.current,next=zoomRange(current.range,position(event.clientX,svg,current.width),event.deltaY,event.deltaMode);
   current.range=next;drag.current=null;setDragEnd(null);setPanning(false);current.onRange(next);
  }
  svg.addEventListener('wheel',wheel,{passive:false});
  return()=>svg.removeEventListener('wheel',wheel);
 },[]);
 function finishGesture(event){
  drag.current=null;setDragEnd(null);setPanning(false);
  if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);
 }
 const tickCount=w<500?4:7;
 return <div ref={ref} className="wind-plot"><svg ref={svgRef} className={`wind-power-svg${panning?' is-panning':''}`} data-testid="power-chart" viewBox={`0 0 ${w} ${h}`} tabIndex={0} role="application" aria-label="功率曲线。按住鼠标拖动平移，滚轮围绕鼠标位置缩放；Shift加拖动可框选。左右方向键逐分钟查看，Shift加方向键移动15分钟。"
 onKeyDown={e=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(e.key)){e.preventDefault();const n=e.key==='Home'?range[0]:e.key==='End'?range[1]-1:selected+(e.key==='ArrowLeft'?-1:1)*(e.shiftKey?15:1);onSelect(Math.max(range[0],Math.min(range[1]-1,n)));}}}
 onPointerDown={e=>{if(e.button!==0||e.isPrimary===false)return;const rect=e.currentTarget.getBoundingClientRect(),minute=locate(e);drag.current={minute,range:[...range],clientX:e.clientX,clientY:e.clientY,width:rect.width*(w-left-right)/w,mode:e.shiftKey?'select':'pan',pointerId:e.pointerId,moved:false};setPanning(!e.shiftKey);if(e.shiftKey)setDragEnd(minute);if(e.pointerType==='mouse')e.currentTarget.focus({preventScroll:true});e.currentTarget.setPointerCapture(e.pointerId);onSelect(minute);}}
 onPointerMove={e=>{
  const gesture=drag.current;
  if(!gesture){onSelect(locate(e));return;}
  if(gesture.pointerId!==e.pointerId)return;
  const dx=e.clientX-gesture.clientX,dy=e.clientY-gesture.clientY;
  if(!gesture.moved){if(Math.abs(dx)<4||e.pointerType==='touch'&&Math.abs(dy)>Math.abs(dx))return;gesture.moved=true;}
  if(gesture.mode==='select')setDragEnd(locate(e));
  else onRange(panRange(gesture.range,dx,gesture.width));
 }}
 onPointerUp={e=>{const gesture=drag.current;if(gesture&&gesture.pointerId===e.pointerId&&gesture.mode==='select'){const m=locate(e);if(gesture.moved&&Math.abs(m-gesture.minute)>=15)onRange([Math.min(m,gesture.minute),Math.min(1440,Math.max(m,gesture.minute)+1)]);}finishGesture(e);}}
 onPointerCancel={finishGesture}
 onLostPointerCapture={()=>{drag.current=null;setDragEnd(null);setPanning(false);}}>
 <defs><pattern id="wind-hatch-missing" width="7" height="7" patternUnits="userSpaceOnUse"><path d="M-1 1L1-1M0 7L7 0M6 8L8 6" stroke="var(--wind-missing)" opacity=".65"/></pattern><pattern id="wind-hatch-other" width="6" height="6" patternUnits="userSpaceOnUse"><path d="M0 6L6 0" stroke="var(--wind-other)" opacity=".22"/></pattern><clipPath id="wind-clip"><rect x={left} y={top-1} width={w-left-right} height={h-top-bottom+1}/></clipPath></defs>
 <text x="2" y="12" className="wind-tick">MW</text>
 {Array.from({length:6},(_,i)=>min+(max-min)*i/5).map(v=><g key={v}><line x1={left} x2={w-right} y1={y(v)} y2={y(v)} className="wind-grid"/><text x={left-9} y={y(v)+4} textAnchor="end" className="wind-tick">{fmt(v,min<0?1:0)}</text></g>)}
 {Array.from({length:tickCount},(_,i)=>Math.round(range[0]+(range[1]-range[0])*i/(tickCount-1))).map(m=><g key={m}><line x1={x(m)} x2={x(m)} y1={top} y2={h-bottom} className="wind-grid vertical"/><text x={x(m)} y={h-7} textAnchor={m===range[0]?'start':m===range[1]?'end':'middle'} className="wind-tick">{clock(m)}</text></g>)}
 <g clipPath="url(#wind-clip)">
 {rows.filter(r=>r.included===false||r.f===null).map(r=><rect key={r.minute} x={x(r.minute)} y={top} width={x(r.minute+1)-x(r.minute)} height={h-top-bottom} fill="url(#wind-hatch-missing)" opacity=".4"/>)}
 {['other','prediction','dispatch','missing'].map(k=>shades[k]&&<g key={k} data-area={k}><path d={geo.fill[k]} fill={k==='missing'?'url(#wind-hatch-missing)':C[k]} fillOpacity={k==='missing'?1:k==='other'?.16:.33}/>{k==='other'&&<path d={geo.fill[k]} fill="url(#wind-hatch-other)"/>}</g>)}
 {['theory','a','f','g','p'].map(k=>visible[k]&&<path key={k} data-curve={k} d={geo.lines[k]} fill="none" stroke={C[k]} strokeWidth={k==='p'?1.8:1.4} strokeDasharray={k==='g'?'5 3':k==='f'?'8 4':k==='theory'?'2 4':undefined} vectorEffect="non-scaling-stroke"/>)}
 {selected>=range[0]&&selected<range[1]&&<line x1={x(selected+.5)} x2={x(selected+.5)} y1={top} y2={h-bottom} className="wind-crosshair"/>}
 {dragEnd!==null&&drag.current?.mode==='select'&&<rect x={x(Math.min(dragEnd,drag.current.minute))} y={top} width={Math.abs(x(dragEnd)-x(drag.current.minute))} height={h-top-bottom} fill="var(--accent)" opacity=".15"/>}
 </g></svg></div>;
}

function Minute({row,onPrevious,onNext,range}){return <aside className="wind-minute" data-reviewed-rows><div className="wind-minute-head"><span>分钟剖面</span><div><button aria-label="上一分钟" disabled={row.minute<=range[0]} onClick={onPrevious}>‹</button><strong data-testid="minute-time">{row.time}</strong><button aria-label="下一分钟" disabled={row.minute>=range[1]-1} onClick={onNext}>›</button></div></div><div className="wind-minute-values">{['a','p','g','f'].map(k=><div key={k}><span><i style={{background:C[k]}}/>{L[k]}</span><b>{fmt(row[k])}<small> MW</small></b></div>)}</div><div className="wind-minute-losses">{['dispatch','prediction','other'].map(k=><div key={k}><span style={{color:C[k]}}>{L[k]}</span><b>{fmt(row[k]===null?null:row[k]*60)}<small> MW</small></b></div>)}</div><p className="wind-state">{row.note}</p><div className="wind-version">{row.f===null?<span>缺少连续预测节点，不外推或跨缺点插值</span>:<><span>插值目标区间 / 权重</span><b>{row.target.slice(11,16)} → {row.rightTarget.slice(11,16)} / {fmt(row.weight*100,1)}%</b><span>{fmt(row.leftF)} → {fmt(row.rightF)} MW</span><span title={`${row.version} → ${row.rightVersion}`}>来源版本 {row.version?.slice(5,16)} → {row.rightVersion?.slice(5,16)}</span></>}</div></aside>;}

function HourChart({rows,range,onRange}){const bins=hourly(rows),max=Math.max(1,...bins.map(b=>b.gap));const[active,setActive]=useState(null);useEffect(()=>setActive(null),[rows]);return <><div className="wind-hour-chart"><div className="wind-hour-axis"><span>{fmt(max,1)} MWh</span><span>0</span></div><div className="wind-bars">{bins.map(b=><button key={b.hour} className="wind-hour" onMouseEnter={()=>setActive(b)} onFocus={()=>setActive(b)} aria-pressed={range[0]===b.hour*60&&range[1]===(b.hour+1)*60} onClick={()=>onRange(range[0]===b.hour*60&&range[1]===(b.hour+1)*60?[0,1440]:[b.hour*60,(b.hour+1)*60])} aria-label={`${clock(b.hour*60)}，调度${fmt(b.dispatch)}，预测${fmt(b.prediction)}，待核实${fmt(b.other)} MWh，${range[0]===b.hour*60&&range[1]===(b.hour+1)*60?'再次点击恢复全天':'点击查看此小时'}`}><div className="wind-hour-stack">{['dispatch','prediction','other'].map(k=><span key={k} style={{height:`${b[k]/max*100}%`,background:C[k]}}/>)}</div><span className="wind-hour-label">{String(b.hour).padStart(2,'0')}</span></button>)}</div></div><div className="wind-hour-readout" aria-live="polite">{active?`${clock(active.hour*60)}—${clock((active.hour+1)*60)}　调度 ${fmt(active.dispatch)} · 预测 ${fmt(active.prediction)} · 待核实 ${fmt(active.other)} MWh`:'按所选范围内的分钟电量汇总；点击柱形放大到该小时，再次点击恢复全天。'}</div><div className="wind-small-legend">{['dispatch','prediction','other'].map(k=><span key={k}><i style={{background:C[k]}}/>{L[k]}</span>)}</div></>;}

function DailyDashboard({all,meta,date,dates,onDate,preferences,setPreferences}){
 const[range,setRange]=useState([0,1440]),[selected,setSelected]=useState(720),[playing,setPlaying]=useState(false),[reduced,setReduced]=useState(false),[page,setPage]=useState(0);
 const {unit,visible,shades,capacity}=preferences;
 const setPreference=(key,value)=>setPreferences(p=>({...p,[key]:typeof value==='function'?value(p[key]):value}));
 const setUnit=v=>setPreference('unit',v),setVisible=v=>setPreference('visible',v),setShades=v=>setPreference('shades',v),setCapacity=v=>setPreference('capacity',v);
 const scoped=useMemo(()=>filterRows(all,range),[all,range]),sum=useMemo(()=>totals(scoped),[scoped]),row=all.find(r=>r.minute===selected)||scoped[0];
 const generation=useMemo(()=>generationTotals(scoped,meta.capacity),[scoped,meta.capacity]);
 function updateRange(next){setRange(next);setSelected(m=>Math.max(next[0],Math.min(next[1]-1,m)));setPage(0);setPlaying(false);}
 useEffect(()=>{const media=window.matchMedia('(prefers-reduced-motion: reduce)');const change=()=>{setReduced(media.matches);if(media.matches)setPlaying(false);};change();media.addEventListener('change',change);const hide=()=>{if(document.hidden)setPlaying(false);};document.addEventListener('visibilitychange',hide);return()=>{media.removeEventListener('change',change);document.removeEventListener('visibilitychange',hide);};},[]);
 useEffect(()=>{if(!playing)return;const timer=setInterval(()=>setSelected(m=>Math.min(range[1]-1,m+5)),160);return()=>clearInterval(timer);},[playing,range]);
 useEffect(()=>{if(selected>=range[1]-1)setPlaying(false);},[selected,range]);
 const value=v=>fmt(unit==='MWh'?v:v/10);
 function download(){const exported=exportAnalysis({meta:{...meta,start:date,end:date},rows:scoped},'minutes');const url=URL.createObjectURL(new Blob([exported.text],{type:exported.type}));const a=document.createElement('a');a.href=url;a.download=exported.name.replace('分钟分解',`${clock(range[0]).replace(':','')}-${clock(range[1]).replace(':','')}-分钟分解`);a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
 const preset=(text,next)=><button key={text} className={range[0]===next[0]&&range[1]===next[1]?'active':''} onClick={()=>updateRange(next)}>{text}</button>;
 return <article className="wind-app">
 <div className="wind-context"><div className="wind-station"><span className="wind-station-icon"><Icon name="wind" size={26}/></span><div><strong>{meta.stationName}</strong><span>{meta.capacity} MW 装机容量 · MW · {meta.timezone}</span></div></div><div className="wind-meta"><span className="wind-date">{date}</span><button onClick={download}><Icon name="download"/>导出当前范围</button></div></div>
 <div className="wind-scope"><div><span>当前范围</span><b>{clock(range[0])} — {clock(range[1])}</b><span>{scoped.length} 分钟</span></div><label>电量单位<select aria-label="电量单位" value={unit} onChange={e=>setUnit(e.target.value)}><option>MWh</option><option>万千瓦时</option></select></label></div>
 <SortableRegion id="wind-metrics-region" variant="freeform" label="电量指标" className="wind-kpis wind-kpis--generation" authoredRevision={2}>{[['dispatch','调度限电','AGC 相对预测进一步压低'],['prediction','预测限电','预测偏低约束可用出力'],['other','其他差额','场站未发、原因未明与阈值内小偏差'],['generation',range[0]===0&&range[1]===1440?'当日发电量':'范围发电量','实发正功率逐分钟积分'],['excluded','已排除时段','缺失、厂用电负值及其他异常，不计入分类电量']].map(([k,title,desc])=><SortableItem key={k} id={`wind-${k}-metric`} label={title} kind="metric"><DataComponent id={`wind-${k}-metric`} title={title} queryId="wind_minutes" kind="metric" sourceRows={scoped} displayRows={scoped} variant="card" className="wind-metric"><div className="wind-metric-number" data-testid={`total-${k}`} style={{color:C[k]}}>{k==='excluded'?sum.excluded:k==='generation'?(generation.generation===null?'—':value(generation.generation)):sum.matched===0?'—':value(sum[k])}<small>{k==='excluded'?'分钟':unit}</small></div><p>{desc}{k==='generation'&&<span className="wind-generation-coverage">实发有效 {generation.generationObserved} 分钟{generation.generationMissing>0?' · 数据不完整':''}</span>}</p></DataComponent></SortableItem>)}</SortableRegion>
 <div className="wind-coverage"><span><i/>参与计算 <b>{sum.matched}</b> / {scoped.length} 分钟</span><span>有效时段正差额 <b>{value(sum.gap)} {unit}</b> = 两类限电 + 其他差额</span></div>
 {sum.excluded>0&&<div className="wind-notice"><Icon name="info"/><span>当前范围有 {sum.excluded} 分钟已排除；背景斜纹为不可计算时段，不计任何分类电量。具体原因见下方排除区间。</span></div>}
 <DataComponent id="wind-power" title="功率曲线与限电面积" queryId="wind_minutes" kind="custom" sourceRows={scoped} displayRows={scoped} variant="card" className="wind-chart-card">
 <div className="wind-chart-toolbar"><div className="wind-chart-controls"><div className="wind-day-selector wind-chart-date"><label>查看日期 <select aria-label="查看日期" value={date} onChange={e=>onDate(e.target.value)}>{dates.map(d=><option key={d}>{d}</option>)}</select></label></div><div className="wind-presets">{preset('全天',[0,1440])}{preset('低 AGC 时段',[480,840])}{preset('凌晨',[0,360])}{preset('傍晚',[1020,1440])}</div></div><div className="wind-play"><button aria-label="恢复全天范围" onClick={()=>updateRange([0,1440])}><Icon name="reset"/></button><button disabled={reduced} onClick={()=>{if(selected>=range[1]-1)setSelected(range[0]);setPlaying(!playing);}}><Icon name={playing?'pause':'play'}/>{playing?'暂停':'回放'}</button></div></div>
 <p className="wind-help">点击下方曲线按钮可显示或隐藏；曲线与阴影分别控制，不改变计算结果。</p><div className="wind-legends"><div className="wind-line-legend">{['a','p','g','f','theory'].map(k=><button key={k} aria-pressed={visible[k]} aria-label={`${visible[k]?'隐藏':'显示'}${L[k]}`} title={`点击${visible[k]?'隐藏':'显示'}${L[k]}`} className={visible[k]?'':'off'} onClick={()=>setVisible(v=>({...v,[k]:!v[k]}))}><span className={`wind-line-key ${['g','f','theory'].includes(k)?'dashed':''}`} style={{borderColor:C[k]}}/>{L[k]}<small className="wind-visibility-state">{visible[k]?'已显示':'已隐藏'}</small></button>)}</div><label className="wind-capacity"><input type="checkbox" checked={capacity} onChange={e=>setCapacity(e.target.checked)}/>显示 {meta.capacity} MW 容量</label></div>
 <div className="wind-chart-grid"><div className="wind-chart-main"><PowerChart rows={scoped} range={range} selected={selected} onSelect={m=>{setSelected(m);setPlaying(false);}} onRange={updateRange} visible={visible} shades={shades} capacity={capacity?meta.capacity:0}/><div className="wind-area-legend">{['dispatch','prediction','other'].map(k=><button key={k} aria-pressed={shades[k]} className={shades[k]?'':'off'} onClick={()=>setShades(v=>({...v,[k]:!v[k]}))}><span style={{background:C[k]}}/>{L[k]}面积</button>)}<span>面积 = 功率差 × 时间</span></div></div><Minute row={row} range={range} onPrevious={()=>{setSelected(m=>Math.max(range[0],m-1));setPlaying(false);}} onNext={()=>{setSelected(m=>Math.min(range[1]-1,m+1));setPlaying(false);}}/></div>
 <div className="wind-range-controls"><label>起点 <b>{clock(range[0])}</b><input aria-label="范围起点" type="range" min="0" max="1425" step="1" value={range[0]} onChange={e=>updateRange([Math.min(Number(e.target.value),range[1]-15),range[1]])}/></label><label>终点 <b>{clock(range[1])}</b><input aria-label="范围终点" type="range" min="15" max="1440" step="1" value={range[1]} onChange={e=>updateRange([range[0],Math.max(Number(e.target.value),range[0]+15)])}/></label><span>按住拖动平移 · 滚轮缩放 · Shift 拖动框选</span></div>
 </DataComponent>
 <div className="wind-secondary-grid"><DataComponent id="wind-hours" title="限电量的小时分布" queryId="wind_minutes" kind="custom" sourceRows={scoped} displayRows={hourly(scoped)} variant="card"><HourChart rows={scoped} range={range} onRange={updateRange}/></DataComponent><DataComponent id="wind-pending" title="其他差额细分（不计入两类限电）" queryId="wind_minutes" kind="custom" sourceRows={scoped} displayRows={scoped} variant="card"><div className="wind-pending-total"><b>{sum.matched?value(sum.other):'—'}</b><span>{unit}</span></div>{[
 ['operationalBelow','场站指令以下未发','低于 min(可用,AGC)，差额超过容量的 0.5%。'],
 ['unexplainedAbove','指令以上待核实','含调度进入确认前的差额，以及 AGC 明显高于预测且不符合 2% 下限跟随的差额。'],
 ['noiseAbove','指令以上阈值内差额','预测未发空间未满足进入 / 保持阈值。'],
 ['noiseBelow','指令以下小偏差','未超过容量的 0.5%，保留原始差额供复核。']
 ].map(([k,title,desc])=><div className="wind-split-item" key={k}><span>{title}</span><b>{sum.matched?value(sum[k]):'—'} <small>{unit}</small></b><p>{desc}</p></div>)}</DataComponent></div>

 <details className="wind-detail-table"><summary>逐分钟数据<span>查看当前范围的输入功率与分类电量</span></summary><DataComponent id="wind-records" title="分钟明细" queryId="wind_minutes" kind="table" sourceRows={scoped} displayRows={scoped} variant="plain"><div className="wind-table-scroll"><table><thead><tr>{['时刻','可用 MW','实发 MW','AGC MW','预测 MW','调度 MWh','预测 MWh','待核实 MWh'].map(s=><th key={s}>{s}</th>)}</tr></thead><tbody>{scoped.slice(page*20,page*20+20).map(r=><tr key={r.minute}><td>{r.time}</td>{['a','p','g','f','dispatch','prediction','other'].map(k=><td key={k}>{fmt(r[k],['dispatch','prediction','other'].includes(k)?5:3)}</td>)}</tr>)}</tbody></table></div><div className="wind-pagination"><button disabled={page===0} onClick={()=>setPage(p=>p-1)}>上一页</button><span>{page+1} / {Math.max(1,Math.ceil(scoped.length/20))} 页</span><button disabled={(page+1)*20>=scoped.length} onClick={()=>setPage(p=>p+1)}>下一页</button></div></DataComponent></details>
 </article>;
}


export function DashboardContent(){
 const {snapshot}=useDataApp();
 const all=snapshot.queries.wind_minutes.rows;
 const report=snapshot.wind;
 const revision=report?.revision??report?.meta;
 const [selection,setSelection]=useState({revision:null,date:''});
 const [preferences,setPreferences]=useState({unit:'MWh',visible:{a:true,p:true,g:true,f:true,theory:false},shades:{dispatch:true,prediction:true,other:true,missing:true},capacity:false});
 const selectedDate=selection.revision===revision?selection.date:'';
 const setDate=date=>setSelection({revision,date});
 // The selected day belongs to the analysis, not to the page: a new commit
 // replaces the analysis and must reset the day view instead of keeping a date
 // that no longer exists. Deriving it keeps the day selector working unchanged.
 const dates=useMemo(()=>report?.daily?.map(d=>d.date)??[],[report]);
 const date=dates.includes(selectedDate)?selectedDate:(dates[0]??'');
 const day=useMemo(()=>all.filter(r=>r.date===date),[all,date]);
 const ready=Boolean(report&&all.length);
 return <div className="wind-app">
  <T0AnalysisHarness/>
  {(snapshot.pagesDemo===true||report?.origin==='browser')&&<p className="wind-sample-label" data-testid="analysis-origin">{report?.origin==='browser'?'本地用户分析 · 仅在当前标签页内保留，刷新后需重新导入。':'网站默认数据仅为演示使用，选择自己的文件后计算场站结果'}</p>}
  <UploadPanel hasResults={ready}/>
  {ready?<>
   <PeriodOverview report={report} rows={all} date={date} onDate={setDate}/>
   {day.length>0&&<DailyDashboard key={`${report.revision??report.meta.start}-${date}`} all={day} meta={report.meta} date={date} dates={dates} onDate={setDate} preferences={preferences} setPreferences={setPreferences}/>}
   <Exclusions gaps={report.gaps} excluded={report.summary.excluded} onDate={setDate} report={report} rows={all}/>
  </>:<section className="wind-empty"><h2>上传数据，开始一次场站分析</h2><p>选择一分钟功率表与对应的“数据下载”预测表，即可生成两类限电量、逐日统计与分钟曲线。</p><p>每次分析一个场站。计算沿用第二点目标时刻与线性插值规则，缺失区间会自动排除并列明。</p></section>}
 </div>;
}
