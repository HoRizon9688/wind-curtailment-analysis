"""Explicit T1 synthetic oracle generation. NEVER invoked by a test run.

Uses the frozen, unchanged Python implementations. No measurement folders or
private reports are scanned. All values, labels and times below are synthetic.
Run: python tests/generate_browser_fixtures.py
"""
from __future__ import annotations

import csv
import gzip
import hashlib
import io
import json
import re
import subprocess
import sys
import zipfile
from datetime import datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import openpyxl
from openpyxl.utils.datetime import CALENDAR_MAC_1904
from threshold_allocation import ThresholdAllocator
from upload_pipeline import analyze_uploads, aligned_forecast, number, parse_time, read_forecast_tables, read_power_tables, table_rows

BASELINE = 'a30816b43e265ac6f23faa549bb26a6ddbcf28b2'
OUT = ROOT / 'tests/fixtures/browser/contract'
PH = ['时间', '可用功率', '全站总有功_集电线有功之和', 'AGC有功设定值', '理论功率']
FH = ['预测id', '名称', '预测时间', '考核点2预测结果']
START = datetime(2026, 8, 1)
cases, artifacts = [], set()


def sha(blob):
    return hashlib.sha256(blob).hexdigest()


def write(path, blob):
    dest = OUT / path
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(blob)
    artifacts.add(path)
    return path


def encode_json(value):
    return json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(',', ':')).encode('utf-8') + b'\n'


def csv_bytes(rows, encoding='utf-8-sig'):
    buf = io.StringIO(newline='')
    writer = csv.writer(buf, lineterminator='\n')
    writer.writerows(rows)
    return buf.getvalue().encode(encoding)


def xlsx_bytes(rows, mac=False, active_second=False, preferred=False):
    book = openpyxl.Workbook()
    book.properties.created = book.properties.modified = datetime(2000, 1, 1)
    if mac:
        book.epoch = CALENDAR_MAC_1904
    sheet = book.active
    if active_second or preferred:
        sheet.append(['此页不是计算数据'])
        sheet = book.create_sheet('功率预测' if preferred else '有效数据')
        if active_second:
            book.active = 1
    for row in rows:
        sheet.append(row)
    buf = io.BytesIO()
    book.save(buf)
    book.close()
    # ZIP timestamps and ordering otherwise depend on generation time.
    stable = io.BytesIO()
    with zipfile.ZipFile(io.BytesIO(buf.getvalue())) as source, zipfile.ZipFile(stable, 'w', compression=zipfile.ZIP_DEFLATED) as target:
        for name in sorted(source.namelist()):
            info = zipfile.ZipInfo(name, date_time=(2000, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o600 << 16
            content=source.read(name)
            if name=='docProps/core.xml':
                # save_workbook overwrites properties.modified with current UTC
                # even when we set it before save. Freeze the generated metadata.
                content=re.sub(rb'(<dcterms:modified\b[^>]*>).*?(</dcterms:modified>)',
                               rb'\g<1>2000-01-01T00:00:00Z\g<2>',content)
            target.writestr(info, content)
    return stable.getvalue()


def power_rows(values):
    return [PH] + [[(START + timedelta(minutes=i)).isoformat(), a, p, g, a] for i, a, g, p in values]


def forecast_rows(nodes=((0, 80), (15, 80))):
    return [FH] + [['SYNTHETIC-T1', '合成风电场，非实测', (START + timedelta(minutes=i-15)).isoformat(), f] for i, f in nodes]


def run_case(id, power=None, forecast=None, options=None, pext='csv', fext='csv', encoding='utf-8-sig', workbook=None, kind='analysis', **tags):
    power = power if power is not None else power_rows([(0, 100, 80, 80), (15, 100, 80, 80)])
    forecast = forecast if forecast is not None else forecast_rows()
    pblob = csv_bytes(power, encoding) if pext=='csv' else xlsx_bytes(power, **(workbook or {}))
    fblob = csv_bytes(forecast, encoding) if fext=='csv' else xlsx_bytes(forecast, **(workbook or {}))
    pp, fp = f'inputs/{id}-power.{pext}', f'inputs/{id}-forecast.{fext}'
    write(pp, pblob); write(fp, fblob)
    opts = {'capacity':100, 'station_name':'', 'start':'2026-08-01', 'end':'2026-08-01'}
    if options:
        opts.update(options)
    entry = {'id':id,'kind':kind,'power':[pp],'forecast':[fp], 'options':{'capacity':opts['capacity'],'stationName':opts['station_name'],'start':opts['start'],'end':opts['end']}, **tags}
    try:
        result = analyze_uploads([(Path(pp).name,pblob)], [(Path(fp).name,fblob)], **opts)
    except ValueError as error:
        entry['kind']='error'
        code = {'duplicate-power-conflict':'DUPLICATE','duplicate-forecast-conflict':'DUPLICATE',
                'mixed-stations':'STATION','missing-header':'TABLE','duplicate-header':'TABLE',
                'seconds-not-rounded':'TIME','forecast-not-quarter':'TIME','range-367':'RANGE'}[id]
        entry['error']={'type':'ValueError','code':code,'message':str(error)}
    else:
        if kind=='range-boundary':
            # Python DOES calculate every minute at this boundary. Store the
            # explicit audit projection, not 527,040 repeated missing rows.
            projection = {k:v for k,v in result.items() if k!='rows'}
            entry['projection']=['meta','summary','daily','gaps','calibration']
            entry['expected']=write(f'expected/{id}.json.gz',gzip.compress(encode_json(projection),mtime=0))
            entry['computedRows']=len(result['rows'])
        else:
            entry['expected']=write(f'expected/{id}.json.gz',gzip.compress(encode_json(result),mtime=0))
    cases.append(entry)
    return entry


def allocator_cases():
    definitions = [
        ('manual-both',100,[(100,80,60,50)], [{'dispatch':20/60,'prediction':20/60,'other':10/60,'referenceTotal':40/60}]),
        ('normal-following',100,[(100,80,80,80)],[{'dispatch':0,'prediction':20/60,'other':0,'following':True}]),
        ('floor-56',56,[(5,.1,1.12,.9)],[{'dispatch':0,'prediction':3.88/60,'noiseBelow':.22/60,'floorFollowing':True}]),
        ('clearly-above-forecast',100,[(100,60,80,75)],[{'prediction':0,'dispatch':0,'unexplainedAbove':20/60,'operationalBelow':5/60}]),
        ('actual-exceeds-commands',100,[(100,80,60,90)],[{'dispatch':0,'prediction':10/60,'releasedAboveAgc':30/60}]),
        ('actual-exceeds-available',100,[(70,80,60,90)],[{'dispatch':0,'prediction':0,'gap':0,'referenceTotal':10/60,'releasedAboveAgc':10/60}]),
        ('dispatch-hysteresis',100,[(100,80,g,70) for g in [79.2,78.9,79.2,79.49,79.5,79.2]], [{'dispatchState':v} for v in [False,True,True,True,False,False]]),
        ('prediction-hysteresis',100,[(a,80,80,80) for a in [81.5,82.1,81.5,81,81.5]], [{'predictionState':v} for v in [False,True,True,False,False]]),
        ('dispatch-equality-and-neighbours',100,[(100,80,g,70) for g in [79.000001,79,78.999999,79.499999,79.5,79.500001]], [{'dispatchState':v} for v in [False,False,True,True,False,False]]),
        ('prediction-equality-and-neighbours',100,[(a,80,80,80) for a in [81.999999,82,82.000001,81.000001,81,80.999999]], [{'predictionState':v} for v in [False,False,True,True,False,False]]),
        ('operational-equality-and-neighbours',100,[(100,80,80,p) for p in [79.500001,79.5,79.499999]], [{'operationalBelow':0},{'operationalBelow':0},{'operationalBelow':.500001/60}]),
        ('following-equality-and-neighbours',100,[(100,80,g,80) for g in [80.999999,81,81.000001]], [{'following':True},{'following':True},{'following':False,'predictionState':False}]),
    ]
    results=[]
    for id,capacity,inputs,hand in definitions:
        model=ThresholdAllocator(capacity)
        expected=[model.calculate(*row) for row in inputs]
        for actual, checks in zip(expected,hand):
            for key,value in checks.items():
                assert (abs(actual[key]-value)<=1e-9 if isinstance(value,(float,int)) and not isinstance(value,bool) else actual[key]==value), (id,key,actual[key],value)
        results.append({'id':id,'capacity':capacity,'inputs':[dict(zip(['a','f','g','p'],row)) for row in inputs], 'expected':expected,'hand':hand})
    write('allocator.json',encode_json(results))


def main():
    sources=[]
    for name in ['upload_pipeline.py','threshold_allocation.py','curtailment.py']:
        frozen=subprocess.check_output(['git','-c',f'safe.directory={ROOT.as_posix()}','show',f'{BASELINE}:{name}'],cwd=ROOT).replace(b'\r\n',b'\n')
        current=(ROOT/name).read_bytes().replace(b'\r\n',b'\n')
        if frozen!=current:
            raise RuntimeError(f'{name} no longer matches frozen baseline; do not regenerate silently')
        sources.append({'path':name,'sha256':sha(frozen),'hashConvention':'UTF-8 source bytes with LF'})
    allocator_cases()
    run_case('normal')
    def day_forecast(t):
        return .4 if 2<=t.hour<4 else 20+2*(t.hour%4)
    day_power=[]
    for i in range(1440):
        t=START+timedelta(minutes=i)
        left=t.replace(minute=t.minute//15*15)
        f=day_forecast(left)+(day_forecast(left+timedelta(minutes=15))-day_forecast(left))*(t.minute%15)/15
        g=max(1.12,f-(4 if 9<=t.hour<13 else 0))
        if t.hour==18:g=f+1.2
        p=min(44.8,g)*.99
        if t.hour==6:p=min(44.8,g+2)
        day_power.append((i,44.8,g,p))
    run_case('continuous-day-56mw',power_rows(day_power),
             forecast_rows([(15*i,day_forecast(START+timedelta(minutes=15*i))) for i in range(97)]),options={'capacity':56})
    run_case('both',power_rows([(0,100,60,50),(1,100,60,70),(2,70,80,90)]))
    run_case('floor',power_rows([(0,5,1.12,.9),(1,1,1.12,.5),(2,10,3,1)]),forecast_rows([(0,.1),(15,.1)]),options={'capacity':56})
    run_case('interpolation',power_rows([(i,100,80+i,70) for i in range(16)]),forecast_rows([(0,80),(15,95)]))
    run_case('missing-node',power_rows([(i,100,80,70) for i in range(31)]),forecast_rows([(0,80),(30,80)]))
    run_case('negative-and-reset',power_rows([(0,100,78.9,70),(1,100,78.9,-.1),(2,100,79.2,70)]))
    run_case('missing-and-reset',power_rows([(0,100,78.9,70),(2,100,79.2,70)]))
    run_case('cross-midnight',power_rows([(1438,100,78.9,70),(1439,100,79.2,70),(1440,100,79.2,70),(1441,100,79.5,70)]),forecast_rows([(1425,80),(1440,80),(1455,80)]),options={'end':'2026-08-02'})
    run_case('bad-endpoint',power_rows([(0,100,80,70),(1,100,80,70),(15,100,80,70)]),forecast_rows([(0,80),(15,101)]))
    run_case('invalid-values',power_rows([(0,None,80,70),(1,100,80,-.1),(2,-1,80,0),(3,101,80,70)]))
    run_case('blank-forecast',forecast=forecast_rows()+[['SYNTHETIC-T1','合成风电场，非实测','not-a-time','']])
    run_case('utf8-bom-quotes')
    run_case('gb18030',encoding='gb18030')
    run_case('ooxml-named-xls',pext='xls',fext='xls',workbook={'preferred':True})
    # Real date cells; retain sparse numeric cell nulls and different Excel date systems.
    p=power_rows([(0,100,80,80),(15,None,80,80)]);f=forecast_rows()
    for row in p[1:]:row[0]=datetime.fromisoformat(row[0])
    for row in f[1:]:row[2]=datetime.fromisoformat(row[2])
    run_case('dates-1900-active-sheet',p,f,pext='xlsx',fext='xlsx',workbook={'active_second':True})
    run_case('dates-1904',p,f,pext='xlsx',fext='xlsx',workbook={'mac':True})
    p=power_rows([(0,100,80,80)]);f=forecast_rows()
    run_case('duplicate-identical',p+[p[1]],f+[f[1]])
    run_case('duplicate-power-conflict',p+[[p[1][0],99,80,80,99]],f)
    run_case('duplicate-forecast-conflict',p,f+[[*f[1][:3],79]])
    run_case('mixed-stations',p,f+[['OTHER-SYNTHETIC','另一个合成场站',f[1][2],'']])
    run_case('missing-header',[PH[:-1][:-1]]+[r[:3] for r in p[1:]],f)
    run_case('duplicate-header',[PH+['时间']]+[r+[r[0]] for r in p[1:]],f)
    run_case('seconds-not-rounded',[[*PH],['2026-08-01T00:00:01+08:00',100,80,80,100]],f)
    run_case('forecast-not-quarter',p,[FH,['SYNTHETIC-T1','合成','2026-08-01 00:01',80]])
    run_case('inferred-midnight-endpoint',power_rows([(0,100,80,80),(1440,100,80,80)]),forecast_rows([(0,80),(1440,80)]),options={'start':None,'end':None})
    run_case('range-367',options={'start':'2024-01-01','end':'2025-01-01'})
    # This is a real full Python boundary run; browser performance belongs to T4.
    run_case('range-366',power_rows([(0,100,80,80)]),options={'end':'2027-08-01'},kind='range-boundary')

    # Expected normalization/interpolation is separately reusable by T2, before T3 exists.
    normalized=[]
    for entry in cases:
        power=[(Path(p).name,(OUT/p).read_bytes()) for p in entry['power']]
        forecast=[(Path(p).name,(OUT/p).read_bytes()) for p in entry['forecast']]
        try:
            pm,duplicates=read_power_tables(power)
            fm,metadata=read_forecast_tables(forecast)
        except ValueError as error:
            normalized.append({'id':entry['id'],'error':entry['error']})
            continue
        samples=[START+timedelta(minutes=i) for i in [-1,0,1,14,15,16,29,30,1439,1440]]
        normalized.append({'id':entry['id'],'power':[[t.isoformat(),v] for t,v in sorted(pm.items())], 'powerDuplicates':duplicates,
            'forecasts':[[t.isoformat(),v] for t,v in sorted(fm.items())], 'metadata':metadata,
            'aligned':[[parse_time(t).isoformat(),aligned_forecast(parse_time(t),fm,sorted(fm))] for t in samples]})
    write('normalized.json',encode_json(normalized))

    def cells(value):
        if isinstance(value,datetime):return {'excelWallTime':value.isoformat()}
        return value
    tables=[]
    for path in sorted(artifacts):
        if path.startswith('inputs/'):
            tables.append({'path':path,'rows':[[cells(v) for v in row] for row in table_rows(Path(path).name,(OUT/path).read_bytes())]})
    write('tables.json',encode_json(tables))
    times=[]
    for value in ['2026-08-01 00:00','2026/08/01 00:15','2026-08-01T00:00:00+08:00',
                  '2026-07-31T16:00:00Z','2026-08-01T01:00:00+09:00','2026-08-01',
                  '2026-08-01 00:00:01','2026-08-01T00:00:00.001','2026-02-29','not-a-time']:
        try:times.append({'input':value,'expected':parse_time(value).isoformat()})
        except ValueError as error:times.append({'input':value,'error':str(error)})
    write('times.json',encode_json(times))
    write('numbers.json',encode_json([{'input':v,'expected':number(v)} for v in
        [None,True,False,0,1.5,'','  ','+1.5',' -1 ','1e2','1_000','１２','١٢','NaN','Infinity','abc']]))
    manifest={'syntheticOnly':True,'baselineCommit':BASELINE,'pythonVersion':sys.version.split()[0],'openpyxlVersion':openpyxl.__version__,
        'sources':sources,'cases':cases,'files':[{'path':p,'bytes':len((OUT/p).read_bytes()),'sha256':sha((OUT/p).read_bytes())} for p in sorted(artifacts)]}
    (OUT/'manifest.json').write_bytes(encode_json(manifest))
    print(json.dumps({'cases':len(cases),'files':len(artifacts),'fullResults':sum(c['kind']=='analysis' for c in cases),'boundaryRows':next(c['computedRows'] for c in cases if c['id']=='range-366')},ensure_ascii=False))


if __name__=='__main__':
    main()
