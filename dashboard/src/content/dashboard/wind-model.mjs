export const clock=m=>`${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`;
export const filterRows=(rows,range)=>rows.filter(r=>r.minute>=range[0]&&r.minute<range[1]);
export function totals(rows){
 const s={dispatch:0,prediction:0,other:0,above:0,below:0,gap:0,missing:0,matched:0,anomalies:0,special:0,count:rows.length};
 for(const r of rows){s.gap+=r.gap;if(r.f===null)s.missing+=r.gap;else{s.matched++;for(const k of ['dispatch','prediction','other','above','below'])s[k]+=r[k]??0;if(r.g>r.f)s.special++;}if(r.p>r.a)s.anomalies++;}return s;
}
export function bands(r){
 const out=[];const add=(kind,bottom,top)=>{if(top>bottom)out.push({kind,bottom,top});};
 if(r.f===null){add('missing',r.p,r.a);return out;}
 if(r.g>r.f){add('other',r.p,r.a);return out;}
 add('prediction',Math.max(r.f,r.p),r.a);add('dispatch',Math.max(r.g,r.p),Math.min(r.a,r.f));add('other',r.p,Math.min(r.a,r.g));return out;
}
export function stepPath(rows,key,x,y){let path='',last=null;for(const r of rows){if(r[key]===null){last=null;continue;}path+=(last===r.minute-1?'L':'M')+x(r.minute)+','+y(r[key])+'L'+x(r.minute+1)+','+y(r[key]);last=r.minute;}return path;}
export function hourly(rows){const map=new Map();for(const r of rows){const h=Math.floor(r.minute/60);if(!map.has(h))map.set(h,[]);map.get(h).push(r);}return [...map].map(([hour,r])=>({hour,...totals(r)}));}
export function csvText(rows){
 const cols=[['时间','timestamp'],['可用_MW','a'],['理论_MW','theory'],['实发_MW','p'],['AGC_MW','g'],['预测_线性插值_MW','f'],['调度限电_MWh','dispatch'],['预测限电_MWh','prediction'],['待核实_MWh','other'],['指令以上待核实_MWh','above'],['指令以下待核实_MWh','below'],['正差额_MWh','gap'],['状态','status'],['左端预测版本','version'],['右端预测版本','rightVersion'],['左端目标时间','target'],['右端目标时间','rightTarget'],['左端预测_MW','leftF'],['右端预测_MW','rightF'],['插值权重','weight']];
 const quote=v=>'"'+String(v??'').replaceAll('"','""')+'"';return '\uFEFF'+[cols.map(c=>quote(c[0])).join(','),...rows.map(r=>cols.map(c=>quote(r[c[1]])).join(','))].join('\r\n');
}
