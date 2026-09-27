"""Rebuild Aug 1 dashboard from raw files using minute linear interpolation."""
from pathlib import Path
from datetime import datetime, timezone
import json
from analyze_day import load_power_day, parse_forecast, run_scenario, check_workbook
from curtailment import write_csv

ROOT=Path(__file__).resolve().parent

def main():
    day='2026-08-01'
    power=load_power_day(ROOT/'可用-理论-实发-AGC指令.csv',day)
    forecasts=[parse_forecast(p.read_text(encoding='gb18030'),str(p.relative_to(ROOT)))
               for p in sorted((ROOT/'功率预测数据').rglob('*_CDQ.RB_1'))]
    if len({f['file_at'] for f in forecasts})!=len(forecasts):
        raise ValueError('预测版本重复')
    check=check_workbook(next((ROOT/'功率预测数据').glob('*.xls')),forecasts,day)
    if check['mismatched_times']:
        raise ValueError('原始预测与导出表不一致')
    summary,detail=run_scenario(power,forecasts,'linear_target_time',day)
    held,_=run_scenario(power,forecasts,'target_time',day)
    out=ROOT/'reports/2026-08-01-linear'
    out.mkdir(exist_ok=True)
    write_csv(out/'线性插值-分钟明细.csv',detail)
    write_csv(out/'线性插值-小时汇总.csv',summary['hourly'])
    report={'method':'相邻15分钟第二点目标值之间线性插值；精确端点直接使用；不外推、不跨缺失版本插值',
            'formula':'F(t)=F0+(F1-F0)*(t-t0)/(t1-t0)',
            'linear':summary,'previous_hold':held,'workbook_check':check}
    (out/'试算结果.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    path=ROOT/'dashboard/src/data.json'
    snapshot=json.loads(path.read_text(encoding='utf-8'))
    query=snapshot['queries']['wind_minutes']
    mapping={'a':'可用_MW','p':'实发_MW','g':'AGC_MW','f':'预测第二点_MW','theory':'理论_MW',
             'prediction':'预测限电_MWh','dispatch':'调度限电_MWh','other':'其他待核实_MWh',
             'above':'其他_指令以上_MWh','below':'其他_指令以下_MWh','gap':'可用减实发正差额_MWh'}
    query['rows']=[dict(minute=i,time=d['时间'][11:16],timestamp=d['时间'],version=d['预测版本'],target=d['第二点目标时刻'],
                         rightVersion=d['插值右端版本'],rightTarget=d['插值右端目标时刻'],leftF=d['左端原始预测_MW'],rightF=d['右端原始预测_MW'],weight=d['插值权重'],
                         status=d['状态'],note=d['说明'],**{k:d[v] for k,v in mapping.items()}) for i,d in enumerate(detail)]
    source=query['source']
    source['caveats']=[
        f"前15分钟缺少前一日23:45版本，{summary['unmatched_gap_mwh']:.9f} MWh未分配。",
        '按相邻文件第二点的目标时刻线性插值到每分钟，非15分钟保持；不外推、不跨缺失版本插值。',
        '插值预测是离线分析基准，不代表调度实际逐分钟下发的指令；保留原始AGC。',
        '每分钟先分类再乘1/60小时积分；原始分钟值为平均或瞬时抽样尚待确认。',
        '未设置人为死区或响应滞后；AGC>插值预测时归待核实；实发高于可用不负向抵扣。']
    source['evidenceFlow'][1]['detail']='96份CDQ与导出表16点一致；提取各文件第二点，以目标时刻为节点，对连续15分钟区间线性插值。'
    query['methods']=[{'language':'text','code':'运行 refresh_linear_dashboard.py；F(t)=F0+(F1-F0)×(t-t0)/15分钟。分钟明细保留两端预测值、目标时间、版本和权重。按分钟矩形积分，阴影面积与分类电量一致。'}]
    snapshot['generatedAt']=datetime.now(timezone.utc).isoformat()
    path.write_text(json.dumps(snapshot,ensure_ascii=False,indent=2),encoding='utf-8')
    (out/'说明.md').write_text(f"# 8月1日线性插值重算\n\n{report['method']}。\n\nF(t)=F0+(F1-F0)×(t-t0)/(t1-t0)。\n\n调度 {summary['dispatch_mwh']:.9f} MWh，预测 {summary['prediction_mwh']:.9f} MWh，待核实 {summary['other_mwh']:.9f} MWh，缺失未分配 {summary['unmatched_gap_mwh']:.9f} MWh。\n\n匹配 {summary['matched_minutes']} 分钟，AGC高于插值预测 {summary['agc_above_forecast_minutes']} 分钟。插值是分析假设，不等同于实际调度生成逻辑；每个分钟值按该分钟的代表值积分，非梯形积分。旧版保持法结果单独保留。\n",encoding='utf-8')
    print(json.dumps({k:v for k,v in summary.items() if k!='hourly'},ensure_ascii=False,indent=2))

if __name__=='__main__':
    main()
