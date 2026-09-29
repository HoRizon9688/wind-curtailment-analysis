"""Generate the two synthetic analyses used by the T0-R shell test.

Both analyses come from the *baseline* pipeline (`upload_pipeline.analyze_uploads`)
so the browser test renders genuine result objects rather than hand-made rows.
Only synthetic values are produced; no measurement, forecast or report file is
read. The projections mirror `upload_pipeline.snapshot_for`.

Run from the repository root:

    python tests/fixtures/browser/generate-analysis-fixtures.py
"""
import csv
import gzip
import io
import json
import math
import pathlib
import sys
from datetime import datetime, timedelta

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from upload_pipeline import analyze_uploads  # noqa: E402 - path set above


def build(start, capacity, station_id, station_name):
    """One synthetic day of minute power plus the 15-minute forecast versions."""
    forecast = lambda t: 0.3 if 2 <= t.hour < 4 else round(17 + 6 * math.sin((t.hour + t.minute / 60) * math.pi / 12), 4)
    power = io.StringIO()
    writer = csv.writer(power)
    writer.writerow(['时间', '可用功率', '理论功率', '全站总有功_集电线有功之和', 'AGC有功设定值'])
    for i in range(1440):
        t = start + timedelta(minutes=i)
        # A five-minute gap so the exclusion list is exercised.
        if t.hour == 18 and t.minute < 5:
            continue
        left = t.replace(minute=t.minute // 15 * 15)
        a = round(0.5 * capacity + 0.16 * capacity * math.sin(i / 190) + 0.05 * capacity * math.sin(i / 43), 4)
        sample = forecast(left) + (forecast(left + timedelta(minutes=15)) - forecast(left)) * (t.minute % 15) / 15
        g = round(max(capacity * 0.02, sample - min(7, capacity * 0.125 if 9 <= t.hour < 13 else 0)), 4)
        p = round(min(a, g) * (0.87 if 15 <= t.hour < 16 else 0.99), 4)
        writer.writerow([t.isoformat(), a, round(a + 0.1, 4), p, g])

    versions = io.StringIO()
    writer = csv.writer(versions)
    writer.writerow(['预测id', '名称', '预测时间', '考核点2预测结果'])
    for i in range(97):
        target = start + timedelta(minutes=15 * i)
        writer.writerow([station_id, station_name, (target - timedelta(minutes=15)).isoformat(), forecast(target)])

    result = analyze_uploads(
        [(f'synthetic-{station_id}-minute-power.csv', power.getvalue().encode('utf-8-sig'))],
        [(f'synthetic-{station_id}-forecast.csv', versions.getvalue().encode('utf-8-sig'))],
        start=start.strftime('%Y-%m-%d'),
        end=start.strftime('%Y-%m-%d'),
        capacity=capacity,
        station_name=station_name,
    )
    # Same projection as snapshot_for: the reviewed rows drop internal audit fields.
    reviewed = [
        {key: value for key, value in row.items() if key not in ('referenceTotal', 'releasedAboveAgc')}
        for row in result['rows']
    ]
    return {
        'meta': result['meta'],
        'summary': result['summary'],
        'daily': result['daily'],
        'gaps': result['gaps'],
        'rows': reviewed,
        'calibrationDropped': True,
    }


def source_for(analysis):
    meta, summary = analysis['meta'], analysis['summary']
    return {
        'type': 'file',
        'name': meta['stationName'],
        'files': [record['name'] for record in meta['files']],
        'period': f"{meta['start']}—{meta['end']} (UTC+08:00)",
        'description': (
            f"T0-R 合成对照分析；装机 {meta['capacity']:g} MW；分钟输入 {summary['expected']} 条，"
            f"参与计算 {summary['included']} 条。来源哈希见 meta.files。"
        ),
        'caveats': ['全部为合成数据，仅用于验证静态内存提交后的来源、图表与导出一致性。'],
    }


if __name__ == '__main__':
    cases = [
        ('analysis-a', datetime(2026, 1, 1), 56.0, 'SYNTHETIC_A', '合成甲场站'),
        ('analysis-b', datetime(2026, 2, 1), 100.0, 'SYNTHETIC_B', '合成乙场站'),
    ]
    for name, start, capacity, station_id, station_name in cases:
        analysis = build(start, capacity, station_id, station_name)
        payload = {**analysis, 'source': source_for(analysis)}
        # Gzipped so the committed fixture stays small while the browser test
        # remains self-contained: reproducing it needs Node only, not Python.
        # `mtime=0` keeps regeneration byte-identical.
        blob = json.dumps(payload, ensure_ascii=False, allow_nan=False).encode('utf-8')
        target = HERE / f'{name}.json.gz'
        with open(target, 'wb') as handle:
            with gzip.GzipFile(filename='', mode='wb', fileobj=handle, mtime=0) as gz:
                gz.write(blob)
        print(
            f'wrote {target.name} ({target.stat().st_size} bytes from {len(blob)} bytes, '
            f'{len(analysis["rows"])} rows, {len(analysis["daily"])} day(s), {len(analysis["gaps"])} gap(s))'
        )
