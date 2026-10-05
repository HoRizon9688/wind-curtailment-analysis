// Test-only representative renderer: uses the existing chart geometry helpers.
// Whole dashboard React/session integration is separately verified in T5.
import {bands,stepPath} from '../../dashboard/src/content/dashboard/wind-model.mjs';
export async function renderResult(result) {
  const start=performance.now(),rows=result.rows.slice(0,1440);
  const x=m=>m/1440*1000,y=p=>350-p/56*350;
  const curves=['a','f','g','p'].map(k=>`<path data-curve="${k}" d="${stepPath(rows,k,x,y)}" fill="none" stroke="black"/>`).join('');
  const fill={dispatch:'',prediction:'',other:''};
  for(const r of rows)for(const b of bands(r))fill[b.kind]+=`M${x(r.minute)},${y(b.top)}H${x(r.minute+1)}V${y(b.bottom)}H${x(r.minute)}Z`;
  document.getElementById('result').textContent=JSON.stringify(result.summary);
  document.getElementById('chart').innerHTML=`<svg viewBox="0 0 1000 350">${Object.entries(fill).map(([kind,d])=>`<path data-area="${kind}" d="${d}" fill="gray" opacity=".3"/>`).join('')}${curves}</svg>`;
  await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
  return performance.now()-start;
}
