"""Wind curtailment allocation for explicitly aligned intervals (MW -> MWh).

Standard library only. No raw forecast/AGC timestamp matching is inferred.
"""
from __future__ import annotations

import argparse
import csv
from datetime import datetime, timedelta, timezone
import json
import math
from pathlib import Path
import sys


LOCAL_TZ = timezone(timedelta(hours=8))
POWER_FIELDS = ('available_mw', 'forecast_mw', 'agc_mw', 'actual_mw')
COMPONENTS = ('total_gap', 'prediction', 'dispatch', 'other',
              'other_above_agc', 'other_below_agc', 'other_control',
              'other_deadband', 'raw_dispatch')
SETTINGS = {'comparison_tolerance_mw': None, 'baseline_tolerance_mw': None,
            'available_basis_confirmed': None}


def timestamp(value):
    if not isinstance(value, str):
        raise ValueError('时间必须为带时区的 ISO 8601 字符串')
    try:
        result = datetime.fromisoformat(value)
    except ValueError as exc:
        raise ValueError(f'无效时间：{value}') from exc
    if result.tzinfo is None or result.utcoffset() is None:
        raise ValueError(f'时间缺少时区：{value}')
    return result.astimezone(LOCAL_TZ)


def nonnegative_number(value):
    # Numeric strings are not accepted: this catches wrong units or dirty imports.
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError('功率及容差必须为数值，缺失值不能补零')
    value = float(value)
    if not math.isfinite(value) or value < 0:
        raise ValueError('功率及容差必须为有限非负数')
    return value


def validate_settings(settings):
    if not isinstance(settings, dict) or set(settings) - set(SETTINGS):
        raise ValueError('不支持的 settings 字段')
    result = SETTINGS | settings
    for key in ('comparison_tolerance_mw', 'baseline_tolerance_mw'):
        if result[key] is not None:
            result[key] = nonnegative_number(result[key])
    if result['available_basis_confirmed'] is not None and not isinstance(
            result['available_basis_confirmed'], bool):
        raise ValueError('available_basis_confirmed 必须为 true、false 或 null')
    return result


def calculate_interval(row, settings=None):
    """Return powers, energy, evidence status and reasons for one [start, end)."""
    config = validate_settings(settings or {})
    start, end = timestamp(row.get('start')), timestamp(row.get('end'))
    hours = (end-start).total_seconds()/3600
    if hours <= 0:
        raise ValueError('时段结束必须晚于开始')
    result = {'start':start.isoformat(), 'end':end.isoformat(), 'hours':hours,
              'status':'invalid', 'reasons':[], 'coarse_estimate':hours >= 0.25}
    result.update({f'{key}_{unit}':None for key in COMPONENTS for unit in ('mw','mwh')})
    for key in POWER_FIELDS:
        result[key] = None
    reasons = result['reasons']
    try:
        a,f,g,p = [nonnegative_number(row.get(key)) for key in POWER_FIELDS]
        result.update(dict(zip(POWER_FIELDS, (a,f,g,p))))
        if config['available_basis_confirmed'] is False:
            raise ValueError('可用功率未反映不受外部限额约束的发电能力')
        agc_state = row.get('agc_state','unknown')
        attribution = row.get('attribution_state','unknown')
        if agc_state not in ('automatic','manual','off','unknown'):
            raise ValueError('agc_state 枚举无效')
        if attribution not in ('applicable','transition','other_limit','unknown'):
            raise ValueError('attribution_state 枚举无效')
        if not isinstance(row.get('alignment_verified',False), bool):
            raise ValueError('alignment_verified 必须为布尔值')
        for key in ('forecast_issued_at','forecast_received_at','agc_effective_at'):
            if row.get(key) is not None and timestamp(row[key]) > start:
                raise ValueError(f'{key} 晚于时段开始，不能采用未来信息')
        if row.get('forecast_target_at') is not None:
            timestamp(row['forecast_target_at'])
        if row.get('forecast_issued_at') and row.get('forecast_received_at'):
            if timestamp(row['forecast_received_at']) < timestamp(row['forecast_issued_at']):
                raise ValueError('预测接收时间早于发布时间')
    except ValueError as exc:
        reasons.append(str(exc))
        return result

    values = dict.fromkeys(COMPONENTS,0.0)
    values['total_gap'] = max(a-p,0.0)
    evidence = ('forecast_version','forecast_issued_at','forecast_received_at',
                'forecast_target_at','agc_effective_at')
    verified = (row.get('alignment_verified') is True
                and all(row.get(key) for key in evidence)
                and agc_state == 'automatic' and attribution == 'applicable'
                and config['available_basis_confirmed'] is True
                and config['comparison_tolerance_mw'] is not None)
    result['status'] = 'rule_verified' if verified else 'estimated'
    if not verified:
        reasons.append('采用关系、可用基准、控制状态或比较容差尚未完整确认；仅为规则估算')
    if config['comparison_tolerance_mw'] is None:
        reasons.append('未设置比较容差；保留原始差值，不据此确认微小调度干预')
    if result['coarse_estimate']:
        reasons.append('时段长度不少于15分钟；粗粒度估算无法还原时段内波动')

    if agc_state in ('manual','off') or attribution in ('transition','other_limit'):
        values['other'] = values['other_control'] = values['total_gap']
        result['status'] = 'pending'
        reasons.append('控制逻辑不适用或处于响应过渡段，全部差额待核实')
    elif g > f:
        values['other_above_agc'] = max(a-max(g,p),0.0)
        values['other_below_agc'] = max(min(a,g)-p,0.0)
        values['other'] = values['other_above_agc'] + values['other_below_agc']
        result['status'] = 'pending'
        reasons.append('AGC高于预测，特殊控制逻辑待核实')
    else:
        values['prediction'] = max(a-max(f,p),0.0)
        values['raw_dispatch'] = max(min(a,f)-max(g,p),0.0)
        values['dispatch'] = values['raw_dispatch']
        values['other_below_agc'] = max(min(a,g)-p,0.0)
        values['other'] = values['other_below_agc']
        tolerance = config['comparison_tolerance_mw']
        if tolerance is not None and 0 < f-g <= tolerance:
            values['other_deadband'] = values['dispatch']
            values['other'] += values['dispatch']
            values['dispatch'] = 0.0
            reasons.append('AGC与预测差值在比较容差内，原始调度差额转入待核实')

    if p > a:
        baseline_tolerance = config['baseline_tolerance_mw']
        if baseline_tolerance is None or p-a > baseline_tolerance:
            result['status'] = 'baseline_anomaly'
            reasons.append('实发高于可用基准；差额记零并标记异常，不抵扣其他时段')
        else:
            reasons.append('实发略高于可用功率，位于已设置的基准容差内')
    if not math.isclose(values['total_gap'],sum(values[k] for k in ('prediction','dispatch','other')),
                        abs_tol=1e-8, rel_tol=1e-10):
        raise ArithmeticError('差额闭合校验失败')
    for key,value in values.items():
        energy = value*hours
        if not math.isfinite(energy):
            raise ValueError('电量超出可表示范围')
        result[f'{key}_mw'] = value
        result[f'{key}_mwh'] = energy
    return result


def empty_totals():
    return {f'{key}_mwh':0.0 for key in COMPONENTS}


def calculate_dataset(data):
    """Calculate nonoverlapping aligned intervals, with calendar + coverage totals.

    Report boundaries default to earliest start / latest end. Gaps inside this
    window count against coverage, but do not get filled with zero power.
    """
    if not isinstance(data,dict):
        raise ValueError('输入顶层必须为对象')
    station = data.get('station',{})
    if not isinstance(station,dict) or station.get('power_unit','MW') != 'MW':
        raise ValueError('station 必须为对象，输入功率单位必须为 MW；请先完成单位换算')
    config = validate_settings(data.get('settings',{}))
    rows = data.get('intervals')
    if not isinstance(rows,list) or not rows or not all(isinstance(r,dict) for r in rows):
        raise ValueError('intervals 必须为非空对象数组')
    ordered = sorted(enumerate(rows,1),key=lambda item:timestamp(item[1].get('start')))
    results = []
    previous_end = None
    for source_row,row in ordered:
        result = calculate_interval(row,config)
        start, end = timestamp(result['start']), timestamp(result['end'])
        if previous_end is not None and start < previous_end:
            raise ValueError(f'第{source_row}条时段与其他时段重叠或重复，禁止重复累计')
        previous_end = end
        result['source_row'] = source_row
        result['source_metadata'] = {key:value for key,value in row.items() if key not in POWER_FIELDS}
        results.append(result)
    window_start = timestamp(data.get('report_start',results[0]['start']))
    window_end = timestamp(data.get('report_end',results[-1]['end']))
    if window_start > timestamp(results[0]['start']) or window_end < timestamp(results[-1]['end']):
        raise ValueError('报告边界必须覆盖所有输入时段')
    total_hours = (window_end-window_start).total_seconds()/3600
    summary = empty_totals() | {'window_hours':total_hours,'supplied_hours':0.0,
                               'valid_hours':0.0,'invalid_hours':0.0,
                               'baseline_anomaly_hours':0.0,'rule_verified_hours':0.0,
                               'estimated_hours':0.0,'pending_hours':0.0,
                               'row_count':len(results)}
    daily = {}
    by_status = {}
    # Seed every calendar day, including completely missing days.
    cursor = window_start
    while cursor < window_end:
        boundary = min(cursor.replace(hour=0,minute=0,second=0,microsecond=0)+timedelta(days=1),window_end)
        day = cursor.date().isoformat()
        daily[day] = empty_totals() | {'period':day, 'window_hours':(boundary-cursor).total_seconds()/3600,
                                      'supplied_hours':0.0,'valid_hours':0.0}
        cursor = boundary
    for result in results:
        hours = result['hours']
        summary['supplied_hours'] += hours
        status = result['status']
        summary[f'{status}_hours'] += hours
        status_totals = by_status.setdefault(status,empty_totals() | {'hours':0.0,'row_count':0})
        status_totals['hours'] += hours
        status_totals['row_count'] += 1
        valid = status not in ('invalid','baseline_anomaly')
        if valid:
            summary['valid_hours'] += hours
        for key in COMPONENTS:
            summary[f'{key}_mwh'] += result[f'{key}_mwh'] or 0.0
            status_totals[f'{key}_mwh'] += result[f'{key}_mwh'] or 0.0
        cursor, end = timestamp(result['start']),timestamp(result['end'])
        while cursor < end:
            boundary = min(cursor.replace(hour=0,minute=0,second=0,microsecond=0)+timedelta(days=1),end)
            part_hours = (boundary-cursor).total_seconds()/3600
            bucket = daily[cursor.date().isoformat()]
            bucket['supplied_hours'] += part_hours
            if valid:
                bucket['valid_hours'] += part_hours
            for key in COMPONENTS:
                bucket[f'{key}_mwh'] += (result[f'{key}_mw'] or 0.0)*part_hours
            cursor = boundary
    summary['gap_hours'] = max(total_hours-summary['supplied_hours'],0.0)
    summary['coverage_ratio'] = summary['valid_hours']/total_hours
    assigned = summary['prediction_mwh']+summary['dispatch_mwh']
    summary['prediction_share_of_assigned'] = summary['prediction_mwh']/assigned if assigned else None
    summary['dispatch_share_of_assigned'] = summary['dispatch_mwh']/assigned if assigned else None
    summary['energy_is_partial'] = summary['coverage_ratio'] < 1.0
    monthly = {}
    for day,bucket in daily.items():
        month = day[:7]
        dest = monthly.setdefault(month, {key:0.0 for key in bucket if key != 'period'} | {'period':month})
        for key,value in bucket.items():
            if key != 'period':
                dest[key] += value
    for bucket in [*daily.values(),*monthly.values()]:
        bucket['coverage_ratio'] = bucket['valid_hours']/bucket['window_hours']
        bucket['gap_hours'] = max(bucket['window_hours']-bucket['supplied_hours'],0.0)
    return {'model_version':'1.0.0','timezone':'UTC+08:00','power_unit':'MW','energy_unit':'MWh',
            'notice':'内部分析口径；估算不等于因果认定或监管结算；缺失时段不补零。',
            'report_start':window_start.isoformat(),'report_end':window_end.isoformat(),
            'settings':config,'station':station,
            'summary':summary,'by_status':by_status,'intervals':results,'daily':list(daily.values()),
            'monthly':list(monthly.values())}


def write_csv(path, rows):
    with path.open('w',encoding='utf-8-sig',newline='') as stream:
        writer = csv.DictWriter(stream,fieldnames=list(rows[0]))
        writer.writeheader()
        for row in rows:
            formatted = {}
            for key,value in row.items():
                if isinstance(value,(dict,list)):
                    value = json.dumps(value,ensure_ascii=False,allow_nan=False)
                # Avoid treating untrusted identifiers as spreadsheet formulas.
                if isinstance(value,str) and value.lstrip().startswith(('=','+','-','@')):
                    value = "'"+value
                formatted[key] = value
            writer.writerow(formatted)


def main(argv=None):
    parser = argparse.ArgumentParser(description='风电场已对齐时段限电量划分（MW → MWh）')
    parser.add_argument('input',type=Path,help='UTF-8 JSON 数据文件')
    parser.add_argument('--output',type=Path,required=True,help='新建输出目录（不得已存在）')
    args = parser.parse_args(argv)
    try:
        data = json.loads(args.input.read_text(encoding='utf-8-sig'),
                          parse_constant=lambda value: (_ for _ in ()).throw(ValueError(f'非法JSON数值：{value}')))
        report = calculate_dataset(data)
        serialized = json.dumps(report,ensure_ascii=False,indent=2,allow_nan=False)
        args.output.mkdir(parents=True,exist_ok=False)
        (args.output/'report.json').write_text(serialized,encoding='utf-8')
        for name in ('intervals','daily','monthly'):
            write_csv(args.output/f'{name}.csv',report[name])
        s = report['summary']
        print(f"输出：{args.output.resolve()}\n数据覆盖率：{s['coverage_ratio']:.2%}\n"
              f"预测 {s['prediction_mwh']:.6f} MWh；调度 {s['dispatch_mwh']:.6f} MWh；"
              f"其他 {s['other_mwh']:.6f} MWh")
        return 0
    except (OSError,ValueError,ArithmeticError) as exc:
        print(f'计算失败：{exc}',file=sys.stderr)
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
