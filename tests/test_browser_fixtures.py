"""Replay committed T1 oracles; do not regenerate or modify expected files."""
import gzip
import hashlib
import json
import unittest
from pathlib import Path

from threshold_allocation import ThresholdAllocator
from upload_pipeline import analyze_uploads, number, parse_time

FIXTURES = Path(__file__).resolve().parent / 'fixtures/browser/contract'


def load(name):
    return json.loads((FIXTURES/name).read_text(encoding='utf-8'))


class BrowserFixturesTest(unittest.TestCase):
    def test_full_results_and_fatal_errors_replay_without_rewriting(self):
        for fixture in load('manifest.json')['cases']:
            if fixture['kind']=='range-boundary':
                continue  # Full 366-day generation is explicit; browser performance is T4.
            with self.subTest(case=fixture['id']):
                power=[(Path(p).name,(FIXTURES/p).read_bytes()) for p in fixture['power']]
                forecast=[(Path(p).name,(FIXTURES/p).read_bytes()) for p in fixture['forecast']]
                o=fixture['options']
                options={'capacity':o['capacity'],'station_name':o['stationName'],'start':o['start'],'end':o['end']}
                if 'error' in fixture:
                    with self.assertRaises(ValueError) as caught:
                        analyze_uploads(power,forecast,**options)
                    self.assertEqual(str(caught.exception),fixture['error']['message'])
                else:
                    actual=analyze_uploads(power,forecast,**options)
                    expected=json.loads(gzip.decompress((FIXTURES/fixture['expected']).read_bytes()))
                    self.assertEqual(actual,expected)

    def test_allocator_sequences_replay(self):
        for fixture in load('allocator.json'):
            model=ThresholdAllocator(fixture['capacity'])
            for inputs,expected in zip(fixture['inputs'],fixture['expected']):
                self.assertEqual(model.calculate(**inputs),expected,fixture['id'])

    def test_manifest_file_hashes(self):
        for entry in load('manifest.json')['files']:
            blob=(FIXTURES/entry['path']).read_bytes()
            self.assertEqual(len(blob),entry['bytes'])
            self.assertEqual(hashlib.sha256(blob).hexdigest(),entry['sha256'],entry['path'])

    def test_time_and_numeric_oracles(self):
        for fixture in load('numbers.json'):
            self.assertEqual(number(fixture['input']),fixture['expected'])
        for fixture in load('times.json'):
            if 'error' in fixture:
                with self.assertRaises(ValueError) as caught:
                    parse_time(fixture['input'])
                self.assertEqual(str(caught.exception),fixture['error'])
            else:
                self.assertEqual(parse_time(fixture['input']).isoformat(),fixture['expected'])


if __name__=='__main__':
    unittest.main()
