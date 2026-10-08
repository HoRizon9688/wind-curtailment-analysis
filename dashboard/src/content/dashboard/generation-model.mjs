// Display metric from original minute measurements. Curtailment exclusions do
// not discard otherwise usable actual power. Never infer missing actual power.
const empty=()=>({generation:0,generationObserved:0,generationMissing:0,generationNegative:0});
function add(s,row,capacity){
 if(typeof row.p!=='number'||!Number.isFinite(row.p)||row.p>capacity){s.generationMissing++;return;}
 s.generationObserved++;
 if(row.p<0)s.generationNegative++;else s.generation+=row.p/60;
}
function finish(s){
 const expected=s.generationObserved+s.generationMissing;
 return {...s,generation:s.generationObserved?s.generation:null,generationCoverage:expected?s.generationObserved/expected:0};
}
export function generationTotals(rows,capacity=Infinity){
 const s=empty();for(const row of rows)add(s,row,capacity);return finish(s);
}
export function dailyGeneration(daily,rows,capacity=Infinity){
 const map=new Map();
 for(const row of rows){if(!map.has(row.date))map.set(row.date,empty());add(map.get(row.date),row,capacity);}
 return daily.map(day=>({...day,...finish(map.get(day.date)??empty())}));
}
