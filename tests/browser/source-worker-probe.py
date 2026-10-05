"""Independent Data app copy; no private snapshot or publication directory read."""
import json,shutil,subprocess,sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT))
from build_pages_demo import create_demo
from upload_pipeline import snapshot_for

folder=ROOT/'reports/browser-review/T4-source'
project=folder/'dashboard'
if '--copy-dependencies' in sys.argv and not (project/'node_modules').exists():
    project.mkdir(parents=True,exist_ok=True)
    shutil.copytree(ROOT/'dashboard/node_modules',project/'node_modules')
tracked=subprocess.run(['git','-c',f'safe.directory={ROOT.as_posix()}','ls-files','-z','dashboard'],cwd=ROOT,capture_output=True,check=True).stdout.decode().split('\0')
for name in filter(None,tracked):
    relative=Path(name).relative_to('dashboard')
    if relative==Path('src/data.json') or relative.parts[0] in ('dist','node_modules','.git'):continue
    target=project/relative;target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(ROOT/name,target)
for source in (ROOT/'dashboard/src/content/calculation').glob('*.mjs'):
    target=project/'src/content/calculation'/source.name;target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(source,target)
snapshot=snapshot_for(create_demo(),ROOT/'templates/dashboard-snapshot.json')
snapshot.update(id='t4-source-worker-probe',title='T4 source Worker · 纯合成技术测试',generatedAt='2026-10-05T00:00:00+08:00')
(project/'src/data.json').write_text(json.dumps(snapshot,ensure_ascii=False),encoding='utf-8')
content='''import React,{useEffect,useState} from 'react';
import {createCalculationClient} from '../calculation/calculation-browser.mjs';
export function DashboardContent(){
 const [status,setStatus]=useState('ready');
 useEffect(()=>{let client;
  window.runProbe=()=>new Promise((resolve,reject)=>{
   const file=(name,text)=>({name,bytes:new TextEncoder().encode(text).buffer});
   const input={power:[file('power.csv','时间,可用功率,全站总有功_集电线有功之和,AGC有功设定值\\n2026-08-01T00:00:00,40,19,20\\n')],forecast:[file('forecast.csv','预测id,名称,预测时间,考核点2预测结果\\nT4_SOURCE_SYNTHETIC,纯合成测试,2026-07-31T23:45:00,20\\n')],options:{capacity:56,stationName:'',start:null,end:null}};
   client=createCalculationClient({onResult:({result})=>{setStatus('success');resolve({rows:result.rows.length,included:result.summary.included,first:result.rows[0],files:result.meta.files});},onError:({error})=>{setStatus('error');reject(new Error(error.message));}});client.start(input);
  });window.probeReady=true;
  return()=>{client?.dispose();delete window.runProbe;delete window.probeReady;};
 },[]);return <section><h1>T4 inline Worker 源构建验证</h1><p id="t4-status">{status}</p></section>;
}
'''
(project/'src/content/dashboard/DashboardContent.jsx').write_text(content,encoding='utf-8')
print(json.dumps({'project':str(project),'synthetic':True}))
