"""Build only independently generated synthetic data for public GitHub Pages."""
import csv
import hashlib
import io
import json
import math
import shutil
import subprocess
import tempfile
from datetime import datetime, timedelta
from pathlib import Path

from serve_app import build_dashboard
from upload_pipeline import analyze_uploads, snapshot_for

ROOT=Path(__file__).resolve().parent


def create_demo_inputs():
    """No reads of measurements, reports or local snapshots occur here."""
    start=datetime(2026,1,1)
    def forecast(t):
        if 2 <= t.hour < 4:
            return .3
        return round(17+6*math.sin((t.hour+t.minute/60)*math.pi/12),4)
    power=io.StringIO();pw=csv.writer(power)
    pw.writerow(['时间','可用功率','理论功率','全站总有功_集电线有功之和','AGC有功设定值'])
    for i in range(2880):
        t=start+timedelta(minutes=i)
        if t.day==1 and t.hour==18 and t.minute<5:
            continue
        left=t.replace(minute=t.minute//15*15)
        f=forecast(left)+(forecast(left+timedelta(minutes=15))-forecast(left))*(t.minute%15)/15
        a=round(29+9*math.sin(i/190)+3*math.sin(i/43),4)
        g=round(max(1.12,f-(7 if 9<=t.hour<13 else 0)),4)
        p=round(min(a,g)*(.87 if 15<=t.hour<16 else .99),4)
        if t.day==2 and t.hour==2 and 20<=t.minute<25:
            p=-.1
        pw.writerow([t.isoformat(),a,a+.1,p,g])
    text=io.StringIO();fw=csv.writer(text)
    fw.writerow(['预测id','名称','预测时间','考核点2预测结果'])
    for i in range(193):
        target=start+timedelta(minutes=15*i)
        if target.day==1 and target.hour==10 and target.minute in (30,45):
            continue
        fw.writerow(['SYNTHETIC_DEMO','示例风电场（合成数据）',(target-timedelta(minutes=15)).isoformat(),forecast(target)])
    return {'power':[('synthetic-minute-power.csv',power.getvalue().encode('utf-8-sig'))],
            'forecast':[('synthetic-forecast.csv',text.getvalue().encode('utf-8-sig'))],
            'options':{'start':'2026-01-01','end':'2026-01-02','capacity':56}}


def create_demo():
    files=create_demo_inputs()
    return analyze_uploads(files['power'],files['forecast'],**files['options'])



def main():
    result=create_demo()
    snapshot=snapshot_for(result,ROOT/'templates/dashboard-snapshot.json')
    snapshot['pagesDemo']=True
    snapshot['title']='风电限电量分析 · 合成数据演示'
    snapshot['queries']['wind_minutes']['source']['description']='完全由公式生成的合成演示数据，不包含任何实际场站测量、预测文件或八月结果。'
    snapshot['queries']['wind_minutes']['source']['caveats'].insert(0,'全部数值仅演示交互与分类逻辑，不可用于实际场站分析。')
    snapshot['generatedAt']='2026-01-03T00:00:00+08:00'
    tracked=subprocess.run(['git','-c',f'safe.directory={ROOT.as_posix()}','ls-files','-z','dashboard'],
                           cwd=ROOT,capture_output=True,check=True).stdout.decode('utf-8').split('\0')
    scratch=ROOT/'reports';scratch.mkdir(exist_ok=True)
    # Independent copy prevents either the running local server or publication
    # from reading/writing the other build's private snapshot.
    with tempfile.TemporaryDirectory(prefix='pages-build-',dir=scratch) as temp:
        project=Path(temp)/'dashboard'
        assert Path(temp).resolve().parent==scratch.resolve()
        for name in filter(None,tracked):
            relative=Path(name).relative_to('dashboard')
            if relative==Path('src/data.json') or relative.parts[0] in ('dist','.openai','.git'):
                continue
            target=project/relative
            target.parent.mkdir(parents=True,exist_ok=True)
            shutil.copyfile(ROOT/name,target)
        (project/'src/data.json').write_text(json.dumps(snapshot,ensure_ascii=False,allow_nan=False),encoding='utf-8')
        build_dashboard(project,local_context=False)
        manifest=json.loads((project/'dist/data-app-build.json').read_text(encoding='utf-8'))
        docs=ROOT/'docs';docs.mkdir(exist_ok=True)
        for record in (manifest['html'],manifest['snapshot']):
            filename=record['path']
            if Path(filename).name!=filename:
                raise ValueError('Build artifact must be a plain file name')
            data=(project/'dist'/filename).read_bytes()
            if hashlib.sha256(data).hexdigest()!=record['sha256']:
                raise ValueError('Build artifact hash mismatch')
            if b'CN_37_N0002_W0001_PRED001' in data or '莱西'.encode() in data:
                raise ValueError('Private station reference detected in public artifact')
            if b'<meta name="data-app-local-thread"' in data:
                raise ValueError('Local thread metadata must not enter the public build')
            (docs/filename).write_bytes(data)
        shutil.copyfile(project/'dist/data-app-build.json',docs/'data-app-build.json')
        (docs/'.nojekyll').write_text('',encoding='utf-8')
        # Old snapshots are public generated artifacts in this exact docs folder.
        # Check every target before removing only superseded snapshot files.
        for old in docs.glob('snapshot.*.json'):
            if old.name!=manifest['snapshot']['path']:
                assert old.resolve().parent==docs.resolve()
                old.unlink()
    print(json.dumps({'output':str(ROOT/'docs'),'syntheticRows':len(result['rows']),
                      'data':manifest['snapshot']['path'],'privateDataPublished':False}))


if __name__=='__main__':main()
