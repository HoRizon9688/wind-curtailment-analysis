"""Reproducible one-day trial using source CSV + original CDQ forecasts.

Run with bundled Python (openpyxl is used only to read the comparison export).
Source files are never modified. Both time mappings are retained explicitly.
"""
import argparse
import csv
from datetime import datetime, timedelta
from decimal import Decimal
import hashlib
import io
import json
import math
from pathlib import Path
import re
import sys
import warnings

from curtailment import LOCAL_TZ, calculate_interval, write_csv


POWER_MAP = {'可用功率':'available_mw','理论功率':'theoretical_mw',
             '全站总有功_集电线有功之和':'actual_mw','AGC有功设定值':'agc_mw'}


def load_power_day(path, day):
    output=[]
    seen=set()
    with path.open(encoding='utf-8-sig',newline='') as stream:
        reader=csv.DictReader(stream)
        if not set(['时间',*POWER_MAP]).issubset(reader.fieldnames or []):
            raise ValueError('功率文件缺少约定列')
        for index,raw in enumerate(reader,2):
            t=datetime.strptime(raw['时间'],'%Y/%m/%d %H:%M').replace(tzinfo=LOCAL_TZ)
            if t.date().isoformat()!=day:
                continue
            if t in seen:
                raise ValueError(f'重复分钟：{t}')
            seen.add(t)
            row={'time':t,'source_row':index}
            for source,key in POWER_MAP.items():
                value=float(raw[source])
                if not math.isfinite(value) or value<0:
                    raise ValueError(f'第{index}条记录的{source}非法')
                row[key]=value
            output.append(row)
    if not output:
        raise ValueError(f'无{day}功率数据')
    return sorted(output,key=lambda row:row['time'])


def parse_forecast(text, source):
    match=re.search(r"type=CDQ\s+time='([^']+)'",text)
    if not match:
        raise ValueError(f'{source} 缺少CDQ时间头')
    file_at=datetime.strptime(match[1],'%Y-%m-%d_%H:%M:%S').replace(tzinfo=LOCAL_TZ)
    points={}
    labels={}
    capacities={}
    for number,label,value,cap in re.findall(r'^#(\d+)\s+VAL(\d{4})\s+([\d.]+)\s+([\d.]+)',text,re.M):
        number=int(number)
        if number in points:
            raise ValueError(f'{source} 预测点重复')
        points[number]=float(value)
        capacities[number]=float(cap)
        labels[number]=label
    if 2 not in points:
        raise ValueError(f'{source} 缺少第二点')
    target=file_at.replace(hour=int(labels[2][:2]),minute=int(labels[2][2:]))
    if target<file_at:
        target+=timedelta(days=1)
    if target-file_at!=timedelta(minutes=15):
        raise ValueError(f'{source} 第二点不是文件时刻后15分钟，需检查格式')
    comment=re.search(r'^//\s+(\d{4}-\d{2}-\d{2}_\d{2}:\d{2}:\d{2})',text,re.M)
    comment_at=datetime.strptime(comment[1],'%Y-%m-%d_%H:%M:%S').replace(tzinfo=LOCAL_TZ) if comment else None
    return dict(file_at=file_at,target_at=target,comment_at=comment_at,second_mw=points[2],
                points=points,capacities=capacities,source=str(source))


def interpolate_forecast(forecasts, time):
    """Interpolate consecutive second-point targets, never extrapolate gaps."""
    ordered=sorted(forecasts,key=lambda f:f['target_at'])
    if len({f['target_at'] for f in ordered})!=len(ordered):
        raise ValueError('预测目标时刻重复')
    exact=next((f for f in ordered if f['target_at']==time),None)
    if exact:
        return exact | {'left':exact,'right':exact,'weight':0.0}
    left=next((f for f in reversed(ordered) if f['target_at']<time),None)
    right=next((f for f in ordered if f['target_at']>time),None)
    if left is None or right is None or right['target_at']-left['target_at']!=timedelta(minutes=15):
        return None
    weight=(time-left['target_at']).total_seconds()/900
    return left | {'second_mw':left['second_mw']+(right['second_mw']-left['second_mw'])*weight,
                   'left':left,'right':right,'weight':weight}


def match_forecast(forecasts, time, mode):
    if mode=='linear_target_time':
        return interpolate_forecast(forecasts,time)
    if mode not in ('file_time','target_time'):
        raise ValueError('未知预测时间映射')
    key='file_at' if mode=='file_time' else 'target_at'
    candidates=[f for f in forecasts if f[key]<=time<f[key]+timedelta(minutes=15)]
    if len(candidates)>1:
        raise ValueError('预测匹配不唯一')
    return candidates[0] if candidates else None


def run_scenario(rows, forecasts, mode, day):
    totals={key:0.0 for key in ['prediction_mwh','dispatch_mwh','other_mwh','matched_gap_mwh',
                               'unmatched_gap_mwh','other_above_agc_mwh','other_below_agc_mwh']}
    decimal_totals=[Decimal(0)]*3
    detail=[]
    hourly={}
    count=0
    special=0
    baseline_count=0
    for row in rows:
        t=row['time']
        f=match_forecast(forecasts,t,mode)
        aligned={key:row[key] for key in ('available_mw','agc_mw','actual_mw')}
        aligned.update(start=t.isoformat(),end=(t+timedelta(minutes=1)).isoformat(),
                       forecast_mw=f['second_mw'] if f else None,
                       agc_state='unknown',attribution_state='unknown',alignment_verified=False)
        result=calculate_interval(aligned)
        gap=max(row['available_mw']-row['actual_mw'],0)/60
        if row['actual_mw']>row['available_mw']:
            baseline_count+=1
        hour=t.strftime('%H:00')
        bucket=hourly.setdefault(hour,{'小时':hour,'已匹配分钟':0,'预测限电_MWh':0.,
                                      '调度限电_MWh':0.,'其他待核实_MWh':0.,'缺预测差额_MWh':0.})
        if f:
            count+=1
            special+=row['agc_mw']>f['second_mw']
            totals['matched_gap_mwh']+=gap
            bucket['已匹配分钟']+=1
            for field,label in [('prediction_mwh','预测限电_MWh'),('dispatch_mwh','调度限电_MWh'),
                                ('other_mwh','其他待核实_MWh')]:
                totals[field]+=result[field]
                bucket[label]+=result[field]
            for field in ('other_above_agc_mwh','other_below_agc_mwh'):
                totals[field]+=result[field]
            # Independent decimal arithmetic using geometric interval lengths.
            a,p,g,v=[Decimal(str(x)) for x in [row['available_mw'],row['actual_mw'],row['agc_mw'],f['second_mw']]]
            zero=Decimal(0)
            if g>v:
                values=[zero,zero,max(a-p,zero)]
            else:
                boundaries=[(max(v,p),a),(max(g,p),min(a,v)),(p,min(a,g))]
                values=[max(upper-lower,zero) for lower,upper in boundaries]
            decimal_totals=[x+y/Decimal(60) for x,y in zip(decimal_totals,values)]
        else:
            totals['unmatched_gap_mwh']+=gap
            bucket['缺预测差额_MWh']+=gap
        detail.append({'时间':t.isoformat(),'功率记录序号':row['source_row'],
                       '可用_MW':row['available_mw'],'理论_MW':row['theoretical_mw'],
                       '实发_MW':row['actual_mw'],'AGC_MW':row['agc_mw'],
                       '预测第二点_MW':f['second_mw'] if f else None,
                       '预测版本':Path(f['source']).name if f else None,
                       '文件时刻':f['file_at'].isoformat() if f else None,
                       '第二点目标时刻':f['target_at'].isoformat() if f else None,
                       '预测限电_MWh':result['prediction_mwh'],'调度限电_MWh':result['dispatch_mwh'],
                       '其他待核实_MWh':result['other_mwh'],
                       '其他_指令以上_MWh':result['other_above_agc_mwh'],
                       '其他_指令以下_MWh':result['other_below_agc_mwh'],
                       '可用减实发正差额_MWh':gap,'状态':result['status'],
                       '说明':'; '.join(result['reasons']) if f else '无对应预测版本；已知差额保留未分配'})
        if mode=='linear_target_time':
            detail[-1].update({'插值右端版本':Path(f['right']['source']).name if f else None,
                              '插值右端目标时刻':f['right']['target_at'].isoformat() if f else None,
                              '左端原始预测_MW':f['left']['second_mw'] if f else None,
                              '右端原始预测_MW':f['right']['second_mw'] if f else None,
                              '插值权重':f['weight'] if f else None})
    error=max(abs(totals[key]-float(value)) for key,value in
              zip(('prediction_mwh','dispatch_mwh','other_mwh'),decimal_totals))
    if error>1e-8:
        raise ArithmeticError('独立Decimal复核未通过')
    total_gap=sum(max(row['available_mw']-row['actual_mw'],0)/60 for row in rows)
    closure=total_gap-sum(totals[key] for key in ('prediction_mwh','dispatch_mwh','other_mwh','unmatched_gap_mwh'))
    if abs(closure)>1e-8:
        raise ArithmeticError('全日闭合复核未通过')
    return totals | {'mode':mode,'date':day,'observed_minutes':len(rows),'matched_minutes':count,
                     'forecast_coverage_ratio':count/1440,'agc_above_forecast_minutes':special,
                     'baseline_anomaly_minutes':baseline_count,'total_gap_mwh':total_gap,
                     'independent_check_max_error_mwh':error,'closure_error_mwh':closure,
                     'hourly':list(hourly.values())},detail


def check_workbook(path, forecasts, day):
    import openpyxl
    # The supplied .xls is actually OOXML; BytesIO avoids extension rejection.
    with warnings.catch_warnings():
        warnings.filterwarnings('ignore',message='Workbook contains no default style.*')
        book=openpyxl.load_workbook(io.BytesIO(path.read_bytes()),data_only=True,read_only=True)
    sheet=book['功率预测']
    data=iter(sheet.values)
    headers=next(data)
    if headers[2]!='预测时间' or headers[5]!='考核点2预测结果':
        raise ValueError('预测表列定义变化')
    lookup={f['file_at']:f for f in forecasts}
    matches=0
    mismatches=[]
    seen=set()
    for row in data:
        if not str(row[2]).startswith(day):
            continue
        t=datetime.fromisoformat(row[2]).replace(tzinfo=LOCAL_TZ)
        if t in seen:
            raise ValueError('预测表存在重复时刻')
        seen.add(t)
        if t not in lookup or any(row[3+i] is None or float(row[3+i])!=lookup[t]['points'].get(i)
                                  for i in range(1,17)):
            mismatches.append(t.isoformat())
        else:
            matches+=1
    book.close()
    return {'matched_versions_all_16_points':matches,'mismatched_times':mismatches,'rows_on_day':len(seen)}


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--date',default='2026-08-01')
    parser.add_argument('--root',type=Path,default=Path(__file__).resolve().parent)
    parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args()
    day=args.date
    datetime.strptime(day,'%Y-%m-%d')
    source=args.root/'可用-理论-实发-AGC指令.csv'
    power=load_power_day(source,day)
    paths=sorted((args.root/'功率预测数据').rglob('*_CDQ.RB_1'))
    # All supplied days are eligible, including preceding day boundary versions.
    forecasts=[parse_forecast(p.read_text(encoding='gb18030'),str(p.relative_to(args.root))) for p in paths]
    if len({f['file_at'] for f in forecasts})!=len(forecasts):
        raise ValueError('CDQ版本时刻重复，请先解决冲突')
    for f in forecasts:
        if set(f['points'])!=set(range(1,17)) or any(v!=56 for v in f['capacities'].values()):
            raise ValueError('CDQ点数或56MW容量校验失败')
    workbooks=list((args.root/'功率预测数据').glob('*.xls'))
    if len(workbooks)!=1:
        raise ValueError('需唯一的预测表用于交叉核对')
    workbook_check=check_workbook(workbooks[0],forecasts,day)
    if workbook_check['mismatched_times']:
        raise ValueError('预测表与原始CDQ文件存在不一致')
    start=datetime.fromisoformat(day).replace(tzinfo=LOCAL_TZ)
    expected={start+timedelta(minutes=i) for i in range(1440)}
    profile={'date':day,'station_capacity_mw':56,'grid_voltage_kv':110,
             'measurement_basis':'用户确认均为AGC装置所用数据；实发列为集电线有功之和',
             'observed_minutes':len(power),'source_coverage_ratio':len(power)/1440,
             'missing_minutes':[t.isoformat() for t in sorted(expected-{r['time'] for r in power})],
             'actual_above_available_minutes':sum(r['actual_mw']>r['available_mw'] for r in power),
             'actual_above_available_excess_mwh':sum(max(r['actual_mw']-r['available_mw'],0)/60 for r in power),
             'actual_above_available_max_mw':max(r['actual_mw']-r['available_mw'] for r in power),
             'available_above_theoretical_minutes':sum(r['available_mw']>r['theoretical_mw'] for r in power),
             'available_above_theoretical_max_mw':max(r['available_mw']-r['theoretical_mw'] for r in power),
             'available_energy_mwh':sum(r['available_mw']/60 for r in power),
             'actual_energy_mwh':sum(r['actual_mw']/60 for r in power),
             'positive_gap_mwh':sum(max(r['available_mw']-r['actual_mw'],0)/60 for r in power),
             'exceeds_capacity_counts':{k:sum(r[k]>56 for r in power) for k in POWER_MAP.values()},
             'forecast_workbook_check':workbook_check,
             'minute_assumption':'每个分钟值代表[t,t+1分钟)；原始文件未注明瞬时值或区间平均值',
             'control_assumption':'未提供AGC投退/手动状态、响应时长、死区；按原始公式估算，不能认定责任',
             'alignment_status':'用户已确认按第二点标注的目标时刻下达AGC；目标时刻间采用15分钟保持作本次积分假设',
             'hashes_sha256':{str(p.relative_to(args.root)):hashlib.sha256(p.read_bytes()).hexdigest()
                              for p in [source,workbooks[0],*paths]}}
    scenarios={}
    details={}
    for mode in ('file_time','target_time'):
        scenarios[mode],details[mode]=run_scenario(power,forecasts,mode,day)
    common=[r for r in power if all(match_forecast(forecasts,r['time'],m) for m in scenarios)]
    comparisons={m:run_scenario(common,forecasts,m,day)[0] for m in scenarios} if common else {}
    report={'primary_mode':'target_time','profile':profile,'scenarios':scenarios,'same_covered_minutes_comparison':comparisons}
    args.output.mkdir(parents=True,exist_ok=False)
    (args.output/'试算结果.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    names={'file_time':'按文件时刻','target_time':'按第二点目标时刻'}
    comparison_rows=[]
    for mode,result in scenarios.items():
        write_csv(args.output/f'{names[mode]}-分钟明细.csv',details[mode])
        write_csv(args.output/f'{names[mode]}-小时汇总.csv',result['hourly'])
        comparison_rows.append({'方案':names[mode],'覆盖分钟':result['matched_minutes'],
                                '预测限电_MWh':result['prediction_mwh'],'调度限电_MWh':result['dispatch_mwh'],
                                '其他待核实_MWh':result['other_mwh'],'缺预测未分配_MWh':result['unmatched_gap_mwh']})
    write_csv(args.output/'两种时间对应方式对比.csv',comparison_rows)
    a,b=scenarios['file_time'],scenarios['target_time']
    description=f'''# {day} 风电场限电量试算

56 MW，110 kV，功率单位 MW。实发采用“全站总有功_集电线有功之和”；用户确认全部测点为 AGC 装置所用数据。

## 主结果：按第二点目标时刻匹配（用户已确认）

- 调度限电：**{b['dispatch_mwh']:.6f} MWh**。
- 功率预测限电：**{b['prediction_mwh']:.6f} MWh**。
- 两类合计：**{b['dispatch_mwh']+b['prediction_mwh']:.6f} MWh**。
- 其他/待核实差额：{b['other_mwh']:.6f} MWh。
- 已匹配 {b['matched_minutes']} / 1440 分钟（{b['forecast_coverage_ratio']:.2%}），本次有效匹配时段为00:15至24:00。
- 00:00至00:15缺少前一版本预测，已知正差额 {b['unmatched_gap_mwh']:.6f} MWh 尚未分配。因此上述两类数值是当天已匹配时段的试算值，不是完整24小时最终数值。

上述分类为规则估算：目标时刻之间暂按15分钟保持，未提供 AGC 投退、控制死区、接收延迟或响应过渡时段。时间对应规则虽已确认，仍不能凭四条曲线认定责任或结算金额。

## 时间错配对比（仅用于核验，不作为第二份主结果）

| 对应方式 | 覆盖分钟 | 调度限电 MWh | 预测限电 MWh | 其他待核实 MWh | 缺预测未分配 MWh |
|---|---:|---:|---:|---:|---:|
| 文件时刻起保持15分钟 | {a['matched_minutes']} | {a['dispatch_mwh']:.6f} | {a['prediction_mwh']:.6f} | {a['other_mwh']:.6f} | {a['unmatched_gap_mwh']:.6f} |
| 第二点目标时刻起保持15分钟 | {b['matched_minutes']} | {b['dispatch_mwh']:.6f} | {b['prediction_mwh']:.6f} | {b['other_mwh']:.6f} | {b['unmatched_gap_mwh']:.6f} |

第一行仅保留为错配敏感性对比；采用用户确认的第二行作为主结果。两行不能相加。均保留原始差值计算，没有额外设置人为死区，尚未核实 AGC 投退状态、控制死区和动态响应时间。

例如 00:00 文件的第二点为 VAL0015，按用户确认的规则用于00:15目标时刻，本次将它保持至00:30前。注释时间比文件头早15分钟；本次不将该注释伪装成接收时间，也不按注释时间提前使用后续版本。

第二种方式缺少覆盖 00:00—00:15 的前一版本：通常需要 7月31日23:45 文件（第二点目标为8月1日00:00）。已知这15分钟的可用减实发正差额为 {b['unmatched_gap_mwh']:.6f} MWh，保留未分配；不从其他版本拼接，也不假填零。

## 数据校验

- 分钟记录：{len(power)} / 1440，源数据覆盖率 {profile['source_coverage_ratio']:.2%}。仅筛选 {day}，未累计其他日期。
- 预测表与原始文件：当天 {workbook_check['rows_on_day']} 个版本，全部16个预测点一致的版本为 {workbook_check['matched_versions_all_16_points']}，不一致数为 {len(workbook_check['mismatched_times'])}。
- 可用功率积分 {profile['available_energy_mwh']:.6f} MWh；实发功率积分 {profile['actual_energy_mwh']:.6f} MWh。
- 逐分钟可用减实发正差额合计 {profile['positive_gap_mwh']:.6f} MWh。该总差额包含待核实部分，不能全部称为调度与预测限电。
- 实发高于可用：{profile['actual_above_available_minutes']} 分钟，反向差额累计 {profile['actual_above_available_excess_mwh']:.6f} MWh，最大 {profile['actual_above_available_max_mw']:.4f} MW。这些分钟按零正差额保留异常，不抵扣其他时段。
- 可用高于理论：{profile['available_above_theoretical_minutes']} 分钟，最大 {profile['available_above_theoretical_max_mw']:.4f} MW。仅作质量标记，本次仍按可用功率列计算。
- 每个分钟值按该分钟开始至下一分钟的代表值积分，时长1/60小时；尚需确认源数据是分钟平均还是分钟瞬时抽样。未对曲线平滑、插值或夹限。
- 独立 Decimal 算术与现有计算核心交叉校验，最大电量误差不超过 {max(a['independent_check_max_error_mwh'],b['independent_check_max_error_mwh']):.3g} MWh；两种方式均满足“预测+调度+其他+缺预测未分配=全日正差额”。

## 计算规则

当 G≤F：预测=max(A-max(F,P),0)，调度=max(min(A,F)-max(G,P),0)，其他=max(min(A,G)-P,0)。

当 G>F：预测、调度均为0，差额归待核实，保留指令以上和指令以下子项。所有功率先按分钟划分，再除以60累计为 MWh。没有使用理论功率替代可用功率。

目标时刻方案中 AGC>预测有 {b['agc_above_forecast_minutes']} 分钟，均按约定保留待核实。目标点之间如何插值、分钟数据是均值还是抽样、控制死区及响应参数，仍需进一步核实。

## 可复核文件

- 两种时间对应方式对比.csv：核心结果。
- 按文件时刻-分钟明细.csv、按第二点目标时刻-分钟明细.csv：每分钟四条输入、所用预测文件、来源记录序号、分项电量和质量说明。
- 两份小时汇总.csv：小时级结果，直接汇总分钟电量。
- 试算结果.json：完整质量检查、同覆盖分钟的敏感性对比、源文件 SHA-256。

源数据：可用-理论-实发-AGC指令.csv；功率预测数据目录中的预测导出表及 *_CDQ.RB_1 原始文件。原始文件保持不变。源 CSV 有空行，明细中的记录序号指忽略空行后的逻辑记录序号。
'''
    (args.output/'试算说明.md').write_text(description,encoding='utf-8')
    print(json.dumps({'output':str(args.output.resolve()),'comparison':comparison_rows,
                      'checks':{k:v for k,v in profile.items() if k!='hashes_sha256'}},ensure_ascii=False,indent=2))


if __name__=='__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    main()
