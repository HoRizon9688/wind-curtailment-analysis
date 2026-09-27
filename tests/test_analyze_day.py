import csv
from datetime import datetime, timedelta
from pathlib import Path
import tempfile
import unittest

from analyze_day import load_power_day, parse_forecast, match_forecast, run_scenario


FORECAST = """// 2026-08-01_23:30:00
<! Entity=NSRL1 type=CDQ time='2026-08-01_23:45:00' !>
@@NUM NAME VALUE CAP
#1 VAL2345 20 56
#2 VAL0000 18 56
"""


class DayAdapterTests(unittest.TestCase):
    def test_second_point_rolls_over_at_midnight(self):
        f = parse_forecast(FORECAST, 'example')
        self.assertEqual(f['second_mw'],18)
        self.assertEqual(f['target_at'].isoformat(),'2026-08-02T00:00:00+08:00')

    def test_no_guessing_or_future_match_for_missing_previous_version(self):
        f = parse_forecast(FORECAST, 'example')
        self.assertIsNone(match_forecast([f],f['file_at'],'target_time'))
        self.assertEqual(match_forecast([f],f['file_at'],'file_time')['second_mw'],18)

    def test_no_stale_forecast_after_fifteen_minutes(self):
        f = parse_forecast(FORECAST, 'example')
        self.assertIsNone(match_forecast([f],f['target_at']+timedelta(minutes=15),'target_time'))

    def test_forecast_requires_second_point(self):
        with self.assertRaises(ValueError):
            parse_forecast(FORECAST.replace('#2 VAL0000 18 56',''), 'example')

    def test_wrong_day_and_duplicate_power_data(self):
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp)/'power.csv'
            text='时间,可用功率,理论功率,全站总有功_集电线有功之和,AGC有功设定值\n'
            path.write_text(text+'2026/8/1 0:00,100,100,50,60\n2026/8/2 0:00,5,5,5,5\n',encoding='utf-8-sig')
            rows=load_power_day(path,'2026-08-01')
            self.assertEqual(len(rows),1)
            self.assertEqual(rows[0]['actual_mw'],50)
            with path.open('a',encoding='utf-8') as out:
                out.write('2026/8/1 0:00,100,100,50,60\n')
            with self.assertRaises(ValueError):
                load_power_day(path,'2026-08-01')

    def test_missing_forecast_keeps_observed_gap_separate(self):
        f=parse_forecast(FORECAST,'example')
        rows=[dict(time=f['file_at'],available_mw=100,theoretical_mw=100,actual_mw=50,
                   agc_mw=60,source_row=2)]
        result,detail=run_scenario(rows,[f],'target_time','2026-08-01')
        self.assertEqual(result['matched_minutes'],0)
        self.assertAlmostEqual(result['unmatched_gap_mwh'],50/60)
        self.assertIsNone(detail[0]['调度限电_MWh'])

    def test_known_case_and_independent_decimal_check(self):
        text=FORECAST.replace('#2 VAL0000 18 56','#2 VAL0000 80 56')
        f=parse_forecast(text,'example')
        rows=[dict(time=f['file_at'],available_mw=100,theoretical_mw=100,actual_mw=50,
                   agc_mw=60,source_row=2)]
        result,detail=run_scenario(rows,[f],'file_time','2026-08-01')
        self.assertAlmostEqual(result['prediction_mwh'],20/60)
        self.assertAlmostEqual(result['dispatch_mwh'],20/60)
        self.assertAlmostEqual(result['other_mwh'],10/60)
        self.assertLess(result['independent_check_max_error_mwh'],1e-10)


if __name__=='__main__':
    unittest.main()
