import React,{useEffect,useMemo,useState} from 'react';
import {DataComponent,useDataApp} from '../../data-app-public.jsx';
import {useBrowserAnalysis} from './analysis-session.jsx';
import {draftProblem} from './analysis-session-model.mjs';
import {completeAnalysis,exportAnalysis} from './analysis-exports.mjs';

const fmt=(n,d=3)=>n==null?'—':n.toLocaleString('zh-CN',{maximumFractionDigits:d,minimumFractionDigits:d});
function save(text,name,type='text/csv;charset=utf-8'){
 const url=URL.createObjectURL(new Blob([text],{type}));
 const link=document.createElement('a');link.href=url;link.download=name;link.click();
 setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function filePayload(file){return new Promise((resolve,reject)=>{
 const reader=new FileReader();reader.onload=()=>resolve({name:file.name,data:String(reader.result).split(',')[1]});
 reader.onerror=()=>reject(new Error(`无法读取 ${file.name}`));reader.readAsDataURL(file);
});}

export function UploadPanel({hasResults}){
 const {snapshot,hosted}=useDataApp(),demo=snapshot.pagesDemo===true;
 const browser=snapshot.calculationMode!=='python';
 const analysis=useBrowserAnalysis();
 const [power,setPower]=useState([]),[forecast,setForecast]=useState([]),[station,setStation]=useState('');
 const [capacity,setCapacity]=useState(''),[confirmed,setConfirmed]=useState(false),[start,setStart]=useState(''),[end,setEnd]=useState('');
 const [pythonBusy,setBusy]=useState(false),[message,setMessage]=useState(''),[error,setError]=useState(''),[local,setLocal]=useState(null);
 const busy=browser?['preparing','running'].includes(analysis.state.status):pythonBusy;
 useEffect(()=>{if(browser||demo)return;let current=true;fetch('/api/health').then(r=>r.json()).then(r=>{if(current)setLocal(r.local===true);}).catch(()=>{if(current)setLocal(false);});return()=>{current=false;};},[browser,demo]);
 const totalBytes=[...power,...forecast].reduce((s,f)=>s+f.size,0);
 const problem=draftProblem({power,forecast,capacity,confirmed,start,end});
 const valid=!problem;
 async function submit(e){
  e.preventDefault();if(!valid||busy)return;
  if(browser){
   await analysis.start({power,forecast,options:{capacity:Number(capacity),stationName:station.trim(),start:start||null,end:end||null}});
   return;
  }
  setBusy(true);setError('');setMessage('正在读取文件…');
  try{
   const [p,f]=await Promise.all([Promise.all(power.map(filePayload)),Promise.all(forecast.map(filePayload))]);
   setMessage('正在核验、计算并生成图表，请保持页面打开（通常 10—30 秒）…');
   const response=await fetch('/api/calculate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({power:p,forecast:f,station,capacity:Number(capacity),start,end})});
   const result=await response.json();if(!response.ok)throw new Error(result.error||'计算失败');
   setMessage('计算完成，正在加载新场站结果…');window.location.reload();
  }catch(ex){setError(ex.message||'上传未完成，请确认本机计算服务仍在运行。');setBusy(false);setMessage('');}
 }
 function fileList(files){return files.length?<span className="wind-file-count">已选 {files.length} 个 · {(files.reduce((n,f)=>n+f.size,0)/1024/1024).toFixed(2)} MB<span title={files.map(f=>f.name).join('\n')}>{files.slice(0,2).map(f=>f.name).join('、')}{files.length>2?' …':''}</span></span>:<span className="wind-file-count">尚未选择文件</span>;}
 const phaseNames={preparing:'读取本地文件',reading:'解析表格与核对哈希',validating:'校验时间与字段',calculating:'逐分钟分解',aggregating:'汇总与整理结果'};
 const progress=analysis.state.progress;
 const browserMessage=busy?(progress?`${phaseNames[progress.phase]} · ${progress.completed.toLocaleString()} / ${progress.total.toLocaleString()}`:'等待完整结果传回…'):analysis.state.status==='cancelled'?'已取消，本次草稿保留，当前分析未替换。':analysis.state.status==='success'?'计算成功，当前分析与来源已更新。':'';
 const current=snapshot.wind;
 const shownError=browser?analysis.state.error?.message:error;
 return <details className="wind-upload" open={!hasResults||busy||Boolean(shownError)||analysis.state.status==='cancelled'}>
  <summary><span className="wind-upload-title">导入新的场站数据</span></summary>
  <form onSubmit={submit}>
   <p className="wind-upload-intro">每次选择一个场站的连续日期数据。{browser?'文件在当前浏览器内计算，不上传服务器。刷新或关闭后需重新选择文件。':'文件由本机 Python 服务计算。'}完整成功后才替换当前分析。</p>
   {current&&<p className="wind-current-analysis" data-testid="computed-parameters">当前显示：{current.meta.stationName} · {current.meta.capacity} MW · {current.meta.start} — {current.meta.end}。下方参数为待计算草稿。</p>}
   {demo&&current?.origin!=='browser'&&<p className="wind-sample-label">当前结果为合成示例，不含真实场站数据。选择自己的文件计算后，将显示本地用户分析。</p>}
   {hosted&&browser&&<p role="alert" className="wind-error">此托管发布由平台管理数据，不能替换分析。请使用项目的静态浏览器版本。</p>}
   <fieldset disabled={busy}><div className="wind-upload-files">
    <label className="wind-file-box"><b>01 / 分钟功率表</b><span>时间、可用功率、全站总有功_集电线有功之和、AGC有功设定值；理论功率可选</span><input aria-label="分钟功率表文件" type="file" accept=".csv,.xls,.xlsx" multiple onChange={e=>{setPower([...e.target.files]);setError('');setConfirmed(false);}}/>{fileList(power)}</label>
    <label className="wind-file-box"><b>02 / 数据下载预测表</b><span>预测id、名称、预测时间、考核点2预测结果；保留原始列名</span><input aria-label="数据下载预测表文件" type="file" accept=".xls,.xlsx,.csv" multiple onChange={e=>{setForecast([...e.target.files]);setError('');setConfirmed(false);}}/>{fileList(forecast)}</label>
   </div><div className="wind-upload-fields">
    <label>场站名称（可选）<input aria-label="场站名称" value={station} onChange={e=>setStation(e.target.value)} placeholder="留空则读取预测表中的名称" maxLength={100}/></label>
    <label>装机容量 / MW<input aria-label="装机容量" type="number" min="0.001" step="any" required value={capacity} onChange={e=>{setCapacity(e.target.value);setConfirmed(false);}} placeholder="填写本场站实际容量"/></label>
    <label>起始日期（可选）<input type="date" value={start} onChange={e=>setStart(e.target.value)}/></label>
    <label>结束日期（含当日）<input type="date" value={end} onChange={e=>setEnd(e.target.value)}/></label>
   </div><label className="wind-confirm"><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/>已确认装机容量，分钟功率与预测文件均属于同一场站、同一测点口径。</label></fieldset>
   <p className="wind-help">日期留空时按分钟表推定，末尾次日 00:00 仅作边界。请核对装机容量，所有功率须为 MW、同一 AGC 测点口径、UTC+08。要计算首日零点，须含前一日 23:45 版本；要计算末日最后 14 分钟，须含末日 23:45 版本。</p>
   {start&&end&&start>end&&<p role="alert" className="wind-error">结束日期不能早于起始日期。</p>}
   {totalBytes>60_000_000&&<p role="alert" className="wind-error">文件总大小超过 60 MB，请按较短连续日期拆分计算。</p>}
   <p className="wind-help">最多连续 366 天、每类 400 个文件、总计 60 MB、单工作簿解压后 150 MB。优先 XLSX 或 UTF-8 CSV；旧二进制 XLS 须另存为 XLSX，不能只改扩展名。表头必须在第一行。</p>
   {!browser&&local===false&&<p role="alert" className="wind-error">未连接本机 Python 服务，请运行 python serve_app.py --open。</p>}
   {shownError&&<p role="alert" className="wind-error">{shownError} {analysis.state.error?.file&&<span>文件：{analysis.state.error.file}{analysis.state.error.row?`，第 ${analysis.state.error.row} 行`:''}。</span>}当前分析未替换，可修正后重试。</p>}
   {busy&&browser&&progress&&<progress className="wind-progress" aria-label={phaseNames[progress.phase]} value={progress.completed} max={Math.max(1,progress.total)}/>}
   <div className="wind-upload-actions"><button className="wind-primary" type="submit" disabled={!valid||busy||(browser?hosted:local!==true)}>{busy?'正在处理…':'校验并计算'}</button>{browser&&busy&&<button type="button" onClick={analysis.cancel}>取消计算</button>}<span role="status" aria-live="polite">{browser?(browserMessage||problem||'重复一致记录自动去重，重复冲突会提示修正。'):(message||problem)}</span></div>
  </form>
 </details>;
}

export function PeriodOverview({report,rows,date,onDate}){
 const {meta,summary:s,daily}=report,max=Math.max(1,...daily.map(d=>d.gap));
 const [exportKind,setExportKind]=useState('minutes');
 const months=useMemo(()=>[...new Set(daily.map(d=>d.date.slice(0,7)))].sort(),[daily]);
 const [month,setMonth]=useState(date?.slice(0,7));
 const paged=daily.length>31;
 const activeMonth=months.includes(month)?month:months[0];
 const visibleDaily=paged?daily.filter(d=>d.date.startsWith(activeMonth)):daily;
 useEffect(()=>setMonth(date?.slice(0,7)),[date,report]);
 useEffect(()=>setExportKind('minutes'),[report]);
 function selectMonth(value){setMonth(value);if(!date?.startsWith(value))onDate(daily.find(d=>d.date.startsWith(value)).date);}
 function download(){const output=exportAnalysis(completeAnalysis(report,rows),exportKind);save(output.text,output.name,output.type);}
 return <section className="wind-period" data-reviewed-rows>
  <div className="wind-period-heading"><div><span className="wind-eyebrow">{report.origin==='browser'?'本地用户分析':'整期计算结果'} / {meta.stationName}</span><h2>{meta.start} — {meta.end}</h2></div><div className="wind-export-controls"><label>导出内容 <select aria-label="导出内容" value={exportKind} onChange={e=>setExportKind(e.target.value)}><option value="minutes">整期分钟明细</option><option value="daily">逐日汇总</option><option value="gaps">排除区间</option><option value="json">完整 JSON</option></select></label><button onClick={download}>导出所选内容</button></div></div>
  {!s.included&&<p role="status" className="wind-error">本次分析没有有效计算分钟，不能据此判断两类限电量为零。请检查缺失区间及数据口径。</p>}
  <div className="wind-period-values">
   <div><span>调度限电</span><b style={{color:'var(--wind-dispatch)'}}>{fmt(s.included?s.dispatch:null)} <small>MWh</small></b></div>
   <div><span>功率预测限电</span><b style={{color:'var(--wind-prediction)'}}>{fmt(s.included?s.prediction:null)} <small>MWh</small></b></div>
   <div><span>其他差额</span><b style={{color:'var(--wind-other)'}}>{fmt(s.included?s.other:null)} <small>MWh</small></b></div>
   <div><span>有效计算覆盖率</span><b>{fmt(s.coverage*100,2)}<small>%</small></b></div>
  </div>
  <p className="wind-period-note">参与计算 {s.included.toLocaleString()} / {s.expected.toLocaleString()} 分钟 · 排除 {s.excluded.toLocaleString()} 分钟（已去重） · 两类已归因限电中，调度占比 {s.dispatchShare==null?'—':fmt(s.dispatchShare*100,2)+'%'}。结果为内部规则估算。</p>
  <DataComponent id="wind-daily" title="逐日限电量分布" queryId="wind_minutes" kind="custom" sourceRows={rows} displayRows={visibleDaily} variant="card">
   <div className="wind-daily-scroll"><div className="wind-daily-bars" style={{minWidth:Math.max(260,visibleDaily.length*(paged?18:26))}}>{visibleDaily.map(d=><button key={d.date} className={date===d.date?'selected':''} onClick={()=>onDate(d.date)} aria-label={`${d.date}：调度 ${fmt(d.included?d.dispatch:null)}，预测 ${fmt(d.included?d.prediction:null)}，待核实 ${fmt(d.included?d.other:null)} MWh；排除 ${d.excluded} 分钟。查看当日曲线`} title={`${d.date}\n调度 ${fmt(d.included?d.dispatch:null)} MWh\n预测 ${fmt(d.included?d.prediction:null)} MWh\n待核实 ${fmt(d.included?d.other:null)} MWh\n排除 ${d.excluded} 分钟`}><div className="wind-daily-stack">{['dispatch','prediction','other'].map(k=><span key={k} style={{height:`${d[k]/max*100}%`,background:`var(--wind-${k})`}}/>)}</div><span>{d.date.slice(paged?8:5)}</span>{d.excluded>0&&<i aria-hidden="true"/>}</button>)}</div></div>
   {paged&&<div className="wind-month-navigation"><div className="wind-month-switcher" role="group" aria-label="查看月份">{months.map(value=><button type="button" key={value} data-month={value} aria-pressed={value===activeMonth} onClick={()=>selectMonth(value)}>{value.slice(0,4)}年{Number(value.slice(5))}月</button>)}</div><p role="status" aria-live="polite">当前显示 {activeMonth.slice(0,4)}年{Number(activeMonth.slice(5))}月 · {visibleDaily.length} 天。整期汇总与导出保持完整。</p></div>}
   <p className="wind-help">柱形从下到上：调度、预测、其他差额（MWh）；最高刻度 {fmt(max)} MWh。柱下标点表示含排除时段。点击任一天查看分钟曲线。</p>
   <details className="wind-daily-table"><summary>逐日数值与覆盖率{paged?'（当前月份）':''}</summary><div className="wind-table-scroll"><table><thead><tr>{['日期','调度 MWh','预测 MWh','其他 MWh','参与分钟','排除分钟','覆盖率'].map(v=><th key={v}>{v}</th>)}</tr></thead><tbody>{visibleDaily.map(d=><tr key={d.date}><td>{d.date}</td><td>{fmt(d.included?d.dispatch:null)}</td><td>{fmt(d.included?d.prediction:null)}</td><td>{fmt(d.included?d.other:null)}</td><td>{d.included}</td><td>{d.excluded}</td><td>{fmt(d.coverage*100,2)}%</td></tr>)}</tbody></table></div></details>
  </DataComponent>
 </section>;
}

export function Exclusions({gaps,excluded,onDate,report,rows}){
 const [reason,setReason]=useState('all'),[page,setPage]=useState(0);
 useEffect(()=>{setReason('all');setPage(0);},[gaps]);
 const reasons=useMemo(()=>[...new Set(gaps.map(g=>g.reason))],[gaps]);
 const filtered=useMemo(()=>reason==='all'?gaps:gaps.filter(g=>g.reason===reason),[gaps,reason]);
 function exportGaps(){const output=exportAnalysis(completeAnalysis(report,rows),'gaps');save(output.text,output.name,output.type);}
 return <section className="wind-exclusions" data-reviewed-rows><div className="wind-period-heading"><div><span className="wind-eyebrow">数据质量</span><h2>排除区间 · {excluded.toLocaleString()} 分钟</h2></div><button onClick={exportGaps} disabled={!gaps.length}>导出排除区间</button></div>
  <p>区间包含起点、不含终点；同一分钟可能有多个排除原因，整期排除分钟数已去重。实发负值为低风厂用电，整分钟不参与分类计算。</p>
  <label>筛选原因 <select value={reason} onChange={e=>{setReason(e.target.value);setPage(0);}}><option value="all">全部原因</option>{reasons.map(r=><option key={r}>{r}</option>)}</select></label>
  <div className="wind-table-scroll"><table><thead><tr><th>起点（含）</th><th>终点（不含）</th><th>分钟</th><th>排除原因</th><th>定位</th></tr></thead><tbody>{filtered.slice(page*10,page*10+10).map((g,i)=><tr key={g.start+g.reason}><td>{g.start.slice(0,16).replace('T',' ')}</td><td>{g.end.slice(0,16).replace('T',' ')}</td><td>{g.minutes}</td><td>{g.reason}</td><td><button onClick={()=>onDate(g.start.slice(0,10))}>查看当天</button></td></tr>)}</tbody></table></div>
  {!filtered.length&&<p>当前筛选下没有排除区间。</p>}
  <div className="wind-pagination"><button disabled={page===0} onClick={()=>setPage(p=>p-1)}>上一页</button><span>{page+1} / {Math.max(1,Math.ceil(filtered.length/10))} 页 · {filtered.length} 个区间</span><button disabled={(page+1)*10>=filtered.length} onClick={()=>setPage(p=>p+1)}>下一页</button></div>
 </section>;
}
