import React,{useEffect,useMemo,useState} from 'react';
import {DataComponent} from '../../data-app-public.jsx';
import {csvText} from './wind-model.mjs';

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
 const [power,setPower]=useState([]),[forecast,setForecast]=useState([]),[station,setStation]=useState('');
 const [capacity,setCapacity]=useState('56'),[start,setStart]=useState(''),[end,setEnd]=useState('');
 const [busy,setBusy]=useState(false),[message,setMessage]=useState(''),[error,setError]=useState(''),[local,setLocal]=useState(null);
 useEffect(()=>{let current=true;fetch('/api/health').then(r=>r.json()).then(r=>{if(current)setLocal(r.local===true);}).catch(()=>{if(current)setLocal(false);});return()=>{current=false;};},[]);
 const totalBytes=[...power,...forecast].reduce((s,f)=>s+f.size,0);
 const valid=power.length>0&&forecast.length>0&&Number(capacity)>0&&(!start||!end||start<=end)&&totalBytes<=60_000_000;
 async function submit(e){
  e.preventDefault();if(!valid||busy)return;
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
 return <details className="wind-upload" open={!hasResults||busy}>
  <summary><span className="wind-upload-title">导入新的场站数据</span><span>两类文件 · 自动校验 · 本机计算</span></summary>
  <form onSubmit={submit}>
   <p className="wind-upload-intro">每次上传一个场站的连续日期数据。文件仅在本机处理；成功后替换当前分析，原始文件保持不变。</p>
   <fieldset disabled={busy}><div className="wind-upload-files">
    <label className="wind-file-box"><b>01 / 分钟功率表</b><span>时间、可用功率、集电线实发、AGC 指令；理论功率可选</span><input aria-label="分钟功率表文件" type="file" accept=".csv,.xls,.xlsx" multiple onChange={e=>{setPower([...e.target.files]);setError('');}}/>{fileList(power)}</label>
    <label className="wind-file-box"><b>02 / 数据下载预测表</b><span>保留原始列名，可一次选择多份 XLS / XLSX / CSV 表</span><input aria-label="数据下载预测表文件" type="file" accept=".xls,.xlsx,.csv" multiple onChange={e=>{setForecast([...e.target.files]);setError('');}}/>{fileList(forecast)}</label>
   </div><div className="wind-upload-fields">
    <label>场站名称（可选）<input value={station} onChange={e=>setStation(e.target.value)} placeholder="留空则读取预测表中的名称" maxLength={100}/></label>
    <label>装机容量 / MW<input type="number" min="0.001" step="any" required value={capacity} onChange={e=>setCapacity(e.target.value)}/></label>
    <label>起始日期（可选）<input type="date" value={start} onChange={e=>setStart(e.target.value)}/></label>
    <label>结束日期（含当日）<input type="date" value={end} onChange={e=>setEnd(e.target.value)}/></label>
   </div></fieldset>
   <p className="wind-help">日期留空时按分钟表推定，末尾次日 00:00 仅作边界。请核对装机容量，所有功率须为 MW、同一 AGC 测点口径、UTC+08。要计算首日零点，须含前一日 23:45 版本；要计算末日最后 14 分钟，须含末日 23:45 版本。</p>
   {start&&end&&start>end&&<p role="alert" className="wind-error">结束日期不能早于起始日期。</p>}
   {totalBytes>60_000_000&&<p role="alert" className="wind-error">文件总大小超过 60 MB，请按较短连续日期拆分计算。</p>}
   {local===false&&<p role="alert" className="wind-error">未连接本机计算服务。请双击项目中的“启动网页.cmd”，并使用打开的本机地址；静态 HTML / 在线预览不能单独解析文件。</p>}
   {error&&<p role="alert" className="wind-error">{error} 当前已显示的分析结果未被替换。</p>}
   <div className="wind-upload-actions"><button className="wind-primary" type="submit" disabled={!valid||busy||local!==true}>{busy?'正在处理…':'校验并计算'}</button><span role="status" aria-live="polite">{message||'重复且一致的记录自动去重；重复冲突或多个场站混传会提示修正。'}</span></div>
  </form>
 </details>;
}

export function PeriodOverview({report,rows,date,onDate}){
 const {meta,summary:s,daily}=report,max=Math.max(1,...daily.map(d=>d.gap));
 return <section className="wind-period" data-reviewed-rows>
  <div className="wind-period-heading"><div><span className="wind-eyebrow">整期计算结果 / {meta.stationName}</span><h2>{meta.start} — {meta.end}</h2></div><button onClick={()=>save(csvText(rows),`${meta.stationName}-${meta.start}-${meta.end}-分钟分解.csv`)}>导出整期分钟明细</button></div>
  <div className="wind-period-values">
   <div><span>调度限电</span><b style={{color:'var(--wind-dispatch)'}}>{fmt(s.included?s.dispatch:null)} <small>MWh</small></b></div>
   <div><span>功率预测限电</span><b style={{color:'var(--wind-prediction)'}}>{fmt(s.included?s.prediction:null)} <small>MWh</small></b></div>
   <div><span>其他差额</span><b style={{color:'var(--wind-other)'}}>{fmt(s.included?s.other:null)} <small>MWh</small></b></div>
   <div><span>有效计算覆盖率</span><b>{fmt(s.coverage*100,2)}<small>%</small></b></div>
  </div>
  <p className="wind-period-note">参与计算 {s.included.toLocaleString()} / {s.expected.toLocaleString()} 分钟 · 排除 {s.excluded.toLocaleString()} 分钟（已去重） · 两类已归因限电中，调度占比 {s.dispatchShare==null?'—':fmt(s.dispatchShare*100,2)+'%'}。结果为内部规则估算。</p>
  <DataComponent id="wind-daily" title="逐日限电量分布" queryId="wind_minutes" kind="custom" sourceRows={rows} displayRows={daily} variant="card">
   <div className="wind-daily-scroll"><div className="wind-daily-bars" style={{minWidth:Math.max(260,daily.length*26)}}>{daily.map(d=><button key={d.date} className={date===d.date?'selected':''} onClick={()=>onDate(d.date)} aria-label={`${d.date}：调度 ${fmt(d.dispatch)}，预测 ${fmt(d.prediction)}，待核实 ${fmt(d.other)} MWh；排除 ${d.excluded} 分钟。查看当日曲线`} title={`${d.date}\n调度 ${fmt(d.dispatch)} MWh\n预测 ${fmt(d.prediction)} MWh\n待核实 ${fmt(d.other)} MWh\n排除 ${d.excluded} 分钟`}><div className="wind-daily-stack">{['dispatch','prediction','other'].map(k=><span key={k} style={{height:`${d[k]/max*100}%`,background:`var(--wind-${k})`}}/>)}</div><span>{d.date.slice(5)}</span>{d.excluded>0&&<i aria-hidden="true"/>}</button>)}</div></div>
   <p className="wind-help">柱形从下到上：调度、预测、其他差额（MWh）；最高刻度 {fmt(max)} MWh。柱下标点表示含排除时段。点击任一天查看分钟曲线。</p>
   <details className="wind-daily-table"><summary>逐日数值与覆盖率</summary><div className="wind-table-scroll"><table><thead><tr>{['日期','调度 MWh','预测 MWh','其他 MWh','参与分钟','排除分钟','覆盖率'].map(v=><th key={v}>{v}</th>)}</tr></thead><tbody>{daily.map(d=><tr key={d.date}><td>{d.date}</td><td>{fmt(d.dispatch)}</td><td>{fmt(d.prediction)}</td><td>{fmt(d.other)}</td><td>{d.included}</td><td>{d.excluded}</td><td>{fmt(d.coverage*100,2)}%</td></tr>)}</tbody></table></div></details>
  </DataComponent>
 </section>;
}

export function Exclusions({gaps,excluded,onDate}){
 const [reason,setReason]=useState('all'),[page,setPage]=useState(0);
 const reasons=useMemo(()=>[...new Set(gaps.map(g=>g.reason))],[gaps]);
 const filtered=useMemo(()=>reason==='all'?gaps:gaps.filter(g=>g.reason===reason),[gaps,reason]);
 function exportGaps(){const q=v=>'"'+String(v).replaceAll('"','""')+'"';save('\uFEFF'+[['起点（含）','终点（不含）','分钟','排除原因'],...gaps.map(g=>[g.start,g.end,g.minutes,g.reason])].map(r=>r.map(q).join(',')).join('\r\n'),'排除区间.csv');}
 return <section className="wind-exclusions" data-reviewed-rows><div className="wind-period-heading"><div><span className="wind-eyebrow">数据质量</span><h2>排除区间 · {excluded.toLocaleString()} 分钟</h2></div><button onClick={exportGaps} disabled={!gaps.length}>导出排除区间</button></div>
  <p>区间包含起点、不含终点；同一分钟可能有多个排除原因，整期排除分钟数已去重。实发负值为低风厂用电，整分钟不参与分类计算。</p>
  <label>筛选原因 <select value={reason} onChange={e=>{setReason(e.target.value);setPage(0);}}><option value="all">全部原因</option>{reasons.map(r=><option key={r}>{r}</option>)}</select></label>
  <div className="wind-table-scroll"><table><thead><tr><th>起点（含）</th><th>终点（不含）</th><th>分钟</th><th>排除原因</th><th>定位</th></tr></thead><tbody>{filtered.slice(page*10,page*10+10).map((g,i)=><tr key={g.start+g.reason}><td>{g.start.slice(0,16).replace('T',' ')}</td><td>{g.end.slice(0,16).replace('T',' ')}</td><td>{g.minutes}</td><td>{g.reason}</td><td><button onClick={()=>onDate(g.start.slice(0,10))}>查看当天</button></td></tr>)}</tbody></table></div>
  {!filtered.length&&<p>当前筛选下没有排除区间。</p>}
  <div className="wind-pagination"><button disabled={page===0} onClick={()=>setPage(p=>p-1)}>上一页</button><span>{page+1} / {Math.max(1,Math.ceil(filtered.length/10))} 页 · {filtered.length} 个区间</span><button disabled={(page+1)*10>=filtered.length} onClick={()=>setPage(p=>p+1)}>下一页</button></div>
 </section>;
}
