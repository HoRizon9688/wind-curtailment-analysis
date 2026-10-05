"""Explicit local-only August review. Outputs must stay in ignored reports.
Reads user-selected inputs and the immutable Git baseline; never writes a snapshot.
"""
import argparse
import hashlib
import importlib
import json
import subprocess
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BASELINE = '26fd0e7ff436f92327063140f5352cd9b6466327'


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--power', type=Path, required=True)
    parser.add_argument('--forecast-dir', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    out = args.output.resolve()
    private_root = (ROOT / 'reports/browser-review').resolve()
    if not out.is_relative_to(private_root) or out == private_root or out.exists():
        raise ValueError('Use a new directory under reports/browser-review')
    modules = {}
    for name in ('curtailment.py', 'threshold_allocation.py', 'upload_pipeline.py'):
        blob = subprocess.check_output(['git', '-c', f'safe.directory={ROOT.as_posix()}',
                                       'show', f'{BASELINE}:{name}'], cwd=ROOT)
        if (ROOT/name).read_bytes().replace(b'\r\n', b'\n') != blob:
            raise ValueError(f'Python baseline changed: {name}')
        modules[name] = blob
    power_path = args.power.resolve()
    forecast_paths = sorted(p.resolve() for p in args.forecast_dir.iterdir()
                            if p.suffix.lower() in ('.xls', '.xlsx', '.csv') and p.is_file())
    power_files = [(power_path.name, power_path.read_bytes())]
    forecast_files = [(p.name, p.read_bytes()) for p in forecast_paths]
    out.mkdir(parents=True)
    source = out/'baseline-python'; source.mkdir()
    for name, blob in modules.items():
        (source/name).write_bytes(blob)
    sys.path.insert(0, str(source))
    pipeline = importlib.import_module('upload_pipeline')
    assert Path(pipeline.__file__).resolve() == (source/'upload_pipeline.py').resolve()
    power, _ = pipeline.read_power_tables(power_files)
    months = {(t.year, t.month) for t in power if t.month == 8}
    if len(months) != 1:
        raise ValueError('Expected a single August in the selected power table')
    year, month = next(iter(months))
    options = {'capacity': 56, 'stationName': '', 'start': f'{year}-08-01', 'end': f'{year}-08-31'}
    result = pipeline.analyze_uploads(power_files, forecast_files, capacity=56,
                                      station_name='', start=options['start'], end=options['end'])
    expected = out/'python-result.json'
    expected.write_text(json.dumps(result, ensure_ascii=False, allow_nan=False), encoding='utf-8')
    manifest = {'private': True, 'baseline': BASELINE,
        'baselineModules': {n: hashlib.sha256(b).hexdigest() for n, b in modules.items()},
        'power': [str(power_path)], 'forecast': [str(p) for p in forecast_paths],
        'options': options, 'expected': str(expected), 'files': result['meta']['files']}
    (out/'inputs.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
    reasons = Counter(reason for r in result['rows'] for reason in r['reasons'])
    focus = [r for r in result['rows'] if r['date'] == options['start'] and '04:40' <= r['time'] <= '04:52']
    missing = [g for g in result['gaps'] if g['start'].startswith(f'{year}-08-05')
               and '缺' in g['reason']]
    audit = {'summary': result['summary'], 'calibration': result['calibration'],
             'reasonMinutes': dict(reasons), 'focus0446': focus, 'august5MissingGaps': missing,
             'inputFiles': len(result['meta']['files']), 'pythonResultSHA256': hashlib.sha256(expected.read_bytes()).hexdigest()}
    (out/'python-audit.json').write_text(json.dumps(audit, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({'privateBaselinePrepared': True, 'period': [options['start'], options['end']],
                      'rows': len(result['rows']), 'inputs': len(result['meta']['files'])}))


if __name__ == '__main__':
    main()
