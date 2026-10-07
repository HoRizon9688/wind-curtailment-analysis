"""Local table import, minute alignment and curtailment analysis (UTC+08)."""
from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import math
import warnings
import zipfile
from bisect import bisect_left
from collections import Counter
from datetime import datetime, timedelta
from pathlib import Path

import openpyxl
from curtailment import LOCAL_TZ, calculate_interval
from threshold_allocation import ThresholdAllocator

MINUTE = timedelta(minutes=1)
QUARTER = timedelta(minutes=15)
POWER_COLUMNS = {'a': '可用功率', 'p': '全站总有功_集电线有功之和', 'g': 'AGC有功设定值'}
ENERGY_KEYS = ('dispatch', 'prediction', 'other', 'above', 'below', 'gap',
               'noiseAbove','noiseBelow','operationalBelow','unexplainedAbove')


def parse_time(value):
    if isinstance(value, datetime):
        result = value
    else:
        text = str(value).strip()
        try:
            result = datetime.fromisoformat(text)
        except ValueError:
            result = None
            for fmt in ('%Y/%m/%d %H:%M', '%Y/%m/%d %H:%M:%S', '%Y-%m-%d %H:%M:%S', '%Y-%m-%d %H:%M'):
                try:
                    result = datetime.strptime(text, fmt)
                    break
                except ValueError:
                    pass
            if result is None:
                raise ValueError(f'无法识别时间：{text}')
    result = result.replace(tzinfo=LOCAL_TZ) if result.tzinfo is None else result.astimezone(LOCAL_TZ)
    if result.second or result.microsecond:
        raise ValueError(f'时间必须精确对齐分钟，不能自动取整：{value}')
    return result


def number(value):
    if isinstance(value, bool):
        return None
    try:
        value = float(value)
        return value if math.isfinite(value) else None
    except (TypeError, ValueError):
        return None


def table_rows(name, blob):
    if name.lower().endswith('.csv'):
        for encoding in ('utf-8-sig', 'gb18030'):
            try:
                text = blob.decode(encoding)
                return list(csv.reader(io.StringIO(text)))
            except UnicodeDecodeError:
                pass
        raise ValueError(f'{name}：CSV 编码无法识别，请导出 UTF-8 CSV')
    if not name.lower().endswith(('.xlsx', '.xls')):
        raise ValueError(f'{name}：仅支持 CSV、XLSX 和系统导出的 OOXML 格式 XLS')
    if not zipfile.is_zipfile(io.BytesIO(blob)):
        raise ValueError(f'{name}：旧版二进制 XLS 不支持，请另存为 XLSX；现有数据下载表的 XLS 可直接读取')
    with zipfile.ZipFile(io.BytesIO(blob)) as z:
        if sum(i.file_size for i in z.infolist()) > 150_000_000:
            raise ValueError(f'{name}：解压后超过 150 MB，请拆分文件')
    with warnings.catch_warnings():
        warnings.simplefilter('ignore', UserWarning)
        book = openpyxl.load_workbook(io.BytesIO(blob), read_only=True, data_only=True)
    try:
        sheet = book['功率预测'] if '功率预测' in book.sheetnames else book.active
        return list(sheet.values)
    finally:
        book.close()


def dictionaries(name, blob, required):
    rows = table_rows(name, blob)
    if not rows:
        raise ValueError(f'{name}：空文件')
    headers = [str(v).strip() if v is not None else '' for v in rows[0]]
    missing = set(required)-set(headers)
    if missing:
        raise ValueError(f'{name}：缺少列 {"、".join(sorted(missing))}')
    if len([v for v in headers if v]) != len(set(v for v in headers if v)):
        raise ValueError(f'{name}：列名重复')
    for i, row in enumerate(rows[1:], 2):
        if any(v not in (None, '') for v in row):
            yield i, dict(zip(headers, row))


def read_power_tables(files):
    power, duplicates = {}, 0
    for name, blob in files:
        for line, row in dictionaries(name, blob, ['时间', *POWER_COLUMNS.values()]):
            try:
                t = parse_time(row['时间'])
            except ValueError as exc:
                raise ValueError(f'{name} 第 {line} 行：{exc}') from exc
            values = {k: number(row.get(col)) for k, col in POWER_COLUMNS.items()}
            values['theory'] = number(row.get('理论功率'))
            if t in power:
                if any(power[t][k] != v for k, v in values.items()):
                    raise ValueError(f'分钟功率重复冲突：{t.isoformat()}（{name} 第 {line} 行）')
                duplicates += 1
                continue
            power[t] = values | {'powerSource': f'{name} 第 {line} 行'}
    if not power:
        raise ValueError('分钟功率表没有数据')
    return power, duplicates


def read_forecast_tables(files):
    forecasts, stations, duplicates, blanks = {}, {}, 0, 0
    for name, blob in files:
        for line, row in dictionaries(name, blob, ['预测id', '名称', '预测时间', '考核点2预测结果']):
            station = str(row.get('预测id') or '').strip()
            if not station:
                raise ValueError(f'{name} 第 {line} 行：场站预测 id 缺失')
            stations[station] = str(row.get('名称') or station)
            if len(stations) > 1:
                raise ValueError('预测表包含多个场站，请每次仅上传一个场站的数据')
            value = number(row.get('考核点2预测结果'))
            if value is None:
                blanks += 1
                continue
            t = parse_time(row['预测时间'])
            if t.minute % 15:
                raise ValueError(f'{name} 第 {line} 行：预测版本须对齐 15 分钟')
            target = t + QUARTER
            if target in forecasts:
                if forecasts[target]['value'] != value:
                    raise ValueError(f'预测第二点重复冲突：版本 {t.isoformat()}，请确认实际采用版本')
                duplicates += 1
                continue
            forecasts[target] = {'value': value, 'version': t.isoformat(), 'source': f'{name} 第 {line} 行'}
    if not forecasts:
        raise ValueError('预测表没有有效的“考核点2预测结果”')
    return forecasts, {'stationId': next(iter(stations)), 'stationName': next(iter(stations.values())),
                       'forecastNodes': len(forecasts), 'forecastDuplicates': duplicates, 'blankForecastRows': blanks}


def aligned_forecast(t, forecasts, targets):
    i = bisect_left(targets, t)
    if i < len(targets) and targets[i] == t:
        left = right = t
    elif i == 0 or i == len(targets) or targets[i]-targets[i-1] != QUARTER:
        return {'f': None}
    else:
        left, right = targets[i-1], targets[i]
    a, b = forecasts[left], forecasts[right]
    weight = (t-left).total_seconds()/900 if right != left else 0
    return {'f': a['value']+(b['value']-a['value'])*weight,
            'version': a['version'], 'rightVersion': b['version'],
            'target': left.isoformat(), 'rightTarget': right.isoformat(),
            'leftF': a['value'], 'rightF': b['value'], 'weight': weight,
            'forecastSource': a['source'], 'rightForecastSource': b['source']}


def aggregate(rows):
    result = dict.fromkeys(ENERGY_KEYS, 0.0)
    result.update(expected=len(rows), included=0, excluded=0, negativeActual=0, missingForecast=0,
                  missingPower=0, baselineAnomalies=0, special=0)
    for r in rows:
        result['negativeActual'] += '实发负值（低风厂用电）' in r['reasons']
        result['missingForecast'] += '预测缺失（不外推、不跨缺点）' in r['reasons']
        result['missingPower'] += any('分钟功率' in s for s in r['reasons'])
        result['baselineAnomalies'] += r['p'] is not None and r['a'] is not None and r['p'] > r['a']
        if r['included']:
            result['included'] += 1
            result['special'] += not r.get('following',False) and not r.get('dispatchState',False)
            for key in ENERGY_KEYS:
                result[key] += r[key]
        else:
            result['excluded'] += 1
    result['coverage'] = result['included']/len(rows) if rows else 0
    result['dispatchShare'] = result['dispatch']/(result['dispatch']+result['prediction']) if result['dispatch']+result['prediction'] else None
    return result


def gap_intervals(rows):
    """Per-reason half-open intervals; overlaps must not be added as unique time."""
    intervals = []
    reasons = sorted({reason for row in rows for reason in row['reasons']})
    for reason in reasons:
        current = None
        for row in rows:
            t = parse_time(row['timestamp'])
            if reason not in row['reasons']:
                current = None
                continue
            if current and current['end'] == t.isoformat():
                current['end'] = (t+MINUTE).isoformat()
                current['minutes'] += 1
            else:
                current = {'start': t.isoformat(), 'end': (t+MINUTE).isoformat(), 'minutes': 1, 'reason': reason}
                intervals.append(current)
    return sorted(intervals, key=lambda g: (g['start'], g['reason']))


def analyze_uploads(power_files, forecast_files, *, start=None, end=None, capacity=56, station_name=''):
    capacity = number(capacity)
    if capacity is None or capacity <= 0:
        raise ValueError('装机容量须为大于 0 的 MW 数值')
    power, duplicates = read_power_tables(power_files)
    forecasts, metadata = read_forecast_tables(forecast_files)
    first, last = min(power), max(power)
    # A next-day 00:00 endpoint is not an extra complete reporting day.
    inferred_last = last-MINUTE if last > first and last.hour == last.minute == 0 else last
    begin = parse_time(start or first.date().isoformat()).replace(hour=0, minute=0)
    finish = parse_time(end or inferred_last.date().isoformat()).replace(hour=0, minute=0)+timedelta(days=1)
    if not 0 < (finish-begin).days <= 366:
        raise ValueError('计算日期范围须为连续 1—366 天')
    if not any(begin <= t < finish for t in power):
        raise ValueError('所选日期范围没有分钟功率数据')
    targets, rows, t = sorted(forecasts), [], begin
    allocator = ThresholdAllocator(capacity)
    while t < finish:
        values = power.get(t)
        r = {'timestamp': t.isoformat(), 'date': str(t.date()), 'time': t.strftime('%H:%M'),
             'minute': t.hour*60+t.minute, 'a': None, 'p': None, 'g': None, 'theory': None,
             **(values or {}), **aligned_forecast(t, forecasts, targets)}
        reasons = []
        if values is None:
            reasons.append('分钟功率缺行')
        elif any(r[k] is None for k in ('a', 'p', 'g')):
            reasons.append('分钟功率缺值或非数值')
        if r['p'] is not None and r['p'] < 0:
            reasons.append('实发负值（低风厂用电）')
        if r['f'] is None:
            reasons.append('预测缺失（不外推、不跨缺点）')
        elif any(not 0 <= r[k] <= capacity for k in ('leftF','rightF')):
            reasons.append('预测节点超出有效功率范围')
        if any(r[k] is not None and r[k] < 0 for k in ('a', 'g', 'f')):
            reasons.append('可用、AGC 或预测为负值')
        if any(r[k] is not None and r[k] > capacity for k in ('a', 'p', 'g', 'f')):
            reasons.append('功率超过装机容量（请核对场站及单位）')
        r.update(included=not reasons, reasons=reasons, status='excluded' if reasons else 'estimated',
                 note='；'.join(reasons), **dict.fromkeys(ENERGY_KEYS))
        if not reasons:
            r.update(allocator.calculate(r['a'],r['f'],r['g'],r['p']))
            r['status'] = 'estimated'
            if r['p'] > r['a']:
                r['note'] += '；实发高于可用，正差额计零'
        else:
            allocator.reset()
        rows.append(r)
        t += MINUTE
    dates = sorted({r['date'] for r in rows})
    daily = []
    for i, date in enumerate(dates):
        daily.append({'date': date, **aggregate(rows[i*1440:(i+1)*1440])})
    metadata.update(stationName=station_name.strip() or metadata['stationName'], capacity=capacity,
                    start=begin.date().isoformat(), end=(finish-MINUTE).date().isoformat(), timezone='UTC+08:00',
                    powerRows=len(power), powerDuplicates=duplicates,
                    powerOutsidePeriod=sum(not begin <= t < finish for t in power),
                    negativePolicy='实发负值属于低风厂用电，整分钟排除，不按零替换',
                    thresholds={'agcFloorPct':2,'dispatchEnterPct':1,'dispatchExitPct':.5,'followingPct':1,
                                'predictionEnterPct':2,'predictionExitPct':1,'operationalPct':.5,
                                'dispatchEnterMinutes':3,'dispatchExitMinutes':3},
                    files=[{'name':name,'bytes':len(blob),'sha256':hashlib.sha256(blob).hexdigest()}
                           for name,blob in power_files+forecast_files])
    summary=aggregate(rows)
    reference=sum(r.get('referenceTotal',0) for r in rows)
    released=sum(r.get('releasedAboveAgc',0) for r in rows)
    assigned=summary['dispatch']+summary['prediction']
    calibration={'referenceTotal':reference,'assigned':assigned,'difference':reference-assigned,
                 'relativeDifference':(reference-assigned)/reference if reference else None,
                 'releasedAboveAgc':released,'noiseAbove':summary['noiseAbove'],
                 'unexplainedAbove':summary['unexplainedAbove'],
                 'closureError':reference-assigned-released-summary['noiseAbove']-summary['unexplainedAbove']}
    return {'meta':metadata, 'summary':summary, 'daily':daily, 'gaps':gap_intervals(rows), 'rows':rows,'calibration':calibration}


def snapshot_for(result, template_path):
    snapshot = json.loads(Path(template_path).read_text(encoding='utf-8'))
    m, s = result['meta'], result['summary']
    snapshot.update(buildStatus='complete', generatedAt=datetime.now(LOCAL_TZ).isoformat(),
                    wind={k:v for k,v in result.items() if k not in ('rows','calibration')})
    reviewed=[{k:v for k,v in row.items() if k not in ('referenceTotal','releasedAboveAgc')} for row in result['rows']]
    snapshot['queries']['wind_minutes'] = {'rows':reviewed, 'source':{
        'type':'file', 'name':m['stationName'], 'files':[f['name'] for f in m['files']],
        'period':f"{m['start']}—{m['end']} (UTC+08:00)",
        'description':f"装机 {m['capacity']:g} MW；分钟输入 {s['expected']} 条，参与计算 {s['included']} 条。来源哈希在本地计算报告中保留。",
        'caveats':['所有缺失及异常分钟从电量统计排除；实发负值属于低风厂用电，整分钟排除。',
                   '数据下载表预测时间为版本时刻，第二点目标为版本+15分钟；仅在连续15分钟节点间线性插值。',
                   '用户确认AGC通常不低于容量2%；跟随比较基准取max(原预测,容量2%)，原预测与AGC曲线均保留。调度压低仍比较原预测，不因下限虚增调度损失。',
                   '内部规则估算；插值预测不代表真实逐分钟指令。调度进入1%/退出0.5%，进入与退出均连续3个有效分钟确认，第3分钟生效不回填；预测空间进入2%/退出1%，按装机容量换算；缺失分钟重置状态。'],
        'metricDefinitions':[
            {'label':'调度限电','definition':'调度状态有效时 max(min(A,F)−max(G,P),0)/60 MWh。'},
            {'label':'预测限电','definition':'跟随且预测低估状态有效时 max(A−max(G,P),0)/60；调度状态中保留预测以上未发空间。'},
            {'label':'其他差额','definition':'场站指令以下未发、阈值内小偏差、AGC明显高于预测及调度进入待确认的原因未明差额，均不混入两类限电。'}]},
        'methods':[{'language':'text','code':'upload_pipeline.py → ThresholdAllocator；按时间顺序施加容量比例滞回及调度连续3分钟进入/退出确认，待进入确认的指令以上差额暂列待核实，不回填；逐分钟分类乘1/60小时。跨日延续状态，缺失/排除分钟重置；保留实发修正。'}]}
    return snapshot


def write_outputs(result, output):
    output = Path(output)
    output.mkdir(parents=True, exist_ok=True)
    (output/'result.json').write_text(json.dumps(result,ensure_ascii=False,allow_nan=False),encoding='utf-8')
    for name, rows in [('daily.csv',result['daily']),('excluded-intervals.csv',result['gaps']),('minutes.csv',result['rows'])]:
        keys = list(dict.fromkeys(k for row in rows for k in row)) or ['start','end','minutes','reason']
        with (output/name).open('w',encoding='utf-8-sig',newline='') as f:
            writer=csv.DictWriter(f,fieldnames=keys)
            writer.writeheader()
            # Keep uploaded labels as text when opened in a spreadsheet.
            writer.writerows({k:("'"+v if isinstance(v,str) and v.lstrip().startswith(('=','+','-','@')) else v)
                              for k,v in row.items()} for row in rows)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--power', type=Path, nargs='+', required=True)
    parser.add_argument('--forecast-dir', type=Path, required=True)
    parser.add_argument('--start')
    parser.add_argument('--end')
    parser.add_argument('--capacity', type=float, required=True)
    parser.add_argument('--station', default='')
    parser.add_argument('--output', type=Path, default=Path('reports/latest'))
    parser.add_argument('--dashboard', action='store_true')
    args = parser.parse_args()
    forecast = sorted(p for p in args.forecast_dir.iterdir() if p.suffix.lower() in ('.xls','.xlsx','.csv'))
    result = analyze_uploads([(p.name,p.read_bytes()) for p in args.power],
                              [(p.name,p.read_bytes()) for p in forecast], start=args.start,end=args.end,
                              capacity=args.capacity,station_name=args.station)
    write_outputs(result,args.output)
    if args.dashboard:
        root = Path(__file__).resolve().parent
        snapshot = snapshot_for(result, root/'templates/dashboard-snapshot.json')
        (root/'dashboard/src/data.json').write_text(json.dumps(snapshot,ensure_ascii=False,allow_nan=False),encoding='utf-8')
    print(json.dumps({'summary':result['summary'],'meta':{k:v for k,v in result['meta'].items() if k!='files'}},ensure_ascii=False,indent=2))


if __name__ == '__main__':
    main()
