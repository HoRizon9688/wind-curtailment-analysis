"""Explicit v2 oracle generation; never rewrite the frozen T1 contract directory.

Reuses byte-identical synthetic T1 inputs. Reviewed hand tests in
test_dispatch_debounce.py and browser/debounce.test.mjs are independent of this
generator. Run explicitly after a user-authorized algorithm change, not in tests.
"""
import gzip
import hashlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from threshold_allocation import ThresholdAllocator
from upload_pipeline import analyze_uploads

OLD = ROOT/'tests/fixtures/browser/contract'
OUT = ROOT/'tests/fixtures/browser/dispatch-confirmation-v2'


def write(path, value):
    dest = OUT/path
    dest.parent.mkdir(parents=True, exist_ok=True)
    blob = (json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(',', ':'))+'\n').encode()
    dest.write_bytes(gzip.compress(blob, mtime=0) if path.endswith('.gz') else blob)


def main():
    manifest = json.loads((OLD/'manifest.json').read_text(encoding='utf-8'))
    manifest['algorithmRevision'] = 'dispatch-confirmation-v2'
    manifest['note'] = 'User-authorized 3-minute causal dispatch entry/exit confirmation; all percentage thresholds unchanged. T1 baseline retained separately.'
    for case in manifest['cases']:
        if 'expected' not in case: continue
        files = lambda paths: [(Path(p).name, (OLD/p).read_bytes()) for p in paths]
        o = case['options']
        result = analyze_uploads(files(case['power']), files(case['forecast']),
            capacity=o['capacity'], station_name=o['stationName'], start=o['start'], end=o['end'])
        if case['kind']=='range-boundary': result = {k:v for k,v in result.items() if k!='rows'}
        write(case['expected'], result)

    allocator = json.loads((OLD/'allocator.json').read_text(encoding='utf-8'))
    for case in allocator:
        if case['id'] in ['manual-both', 'actual-exceeds-commands', 'actual-exceeds-available']:
            # The final minute keeps the reviewed arithmetic; earlier minutes
            # demonstrate causal confirmation with zero dispatch/prediction.
            case['inputs'] *= 3
            case['hand'] = [{'dispatch':0, 'prediction':0}, {'dispatch':0, 'prediction':0}, *case['hand']]
        elif case['id']=='dispatch-hysteresis':
            gaps = [.8, 1.1, 1.1, 1.1, .8, .5, .5, .5, .8]
            case['inputs'] = [dict(a=100, f=80, g=80-d, p=70) for d in gaps]
            case['hand'] = [{'dispatchState':s} for s in [False,False,False,True,True,True,True,False,False]]
        elif case['id']=='dispatch-equality-and-neighbours':
            case['hand'] = [{'dispatchState':False} for _ in case['inputs']]
        model = ThresholdAllocator(case['capacity'])
        case['expected'] = [model.calculate(**row) for row in case['inputs']]
        for row, hand in zip(case['expected'], case['hand']):
            for key, expected in hand.items():
                assert abs(row[key]-expected)<1e-9 if type(expected) in (int,float) else row[key]==expected, (case['id'],key)
    write('allocator.json', allocator)
    for entry in manifest['sources']:
        entry['sha256'] = hashlib.sha256((ROOT/entry['path']).read_bytes().replace(b'\r\n', b'\n')).hexdigest()
    for entry in manifest['files']:
        path = OUT/entry['path']
        blob = path.read_bytes() if path.exists() else (OLD/entry['path']).read_bytes()
        entry.update(bytes=len(blob), sha256=hashlib.sha256(blob).hexdigest())
    write('manifest.json', manifest)
    print('Versioned v2 oracles written; T1 fixtures untouched.')


if __name__=='__main__': main()
