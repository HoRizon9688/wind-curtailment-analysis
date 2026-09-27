import unittest
from datetime import datetime, timedelta
from analyze_day import interpolate_forecast, run_scenario
from curtailment import LOCAL_TZ

class InterpolationTests(unittest.TestCase):
    def setUp(self):
        self.t=datetime(2026,8,1,23,45,tzinfo=LOCAL_TZ)
        self.points=[dict(target_at=self.t+timedelta(minutes=i),file_at=self.t+timedelta(minutes=i-15),second_mw=v,source=str(i)) for i,v in [(0,20),(15,35),(45,50)]]
    def test_minute_values_and_midnight_endpoint(self):
        for minute in range(16):
            f=interpolate_forecast(self.points,self.t+timedelta(minutes=minute))
            self.assertEqual(f['second_mw'],20+minute)
        self.assertEqual(interpolate_forecast(self.points,self.t+timedelta(minutes=7))['right']['source'],'15')
    def test_no_extrapolation_or_bridging_missing_upload(self):
        for minute in [-1,16,30,46]:
            self.assertIsNone(interpolate_forecast(self.points,self.t+timedelta(minutes=minute)))
    def test_duplicate_target_rejected(self):
        with self.assertRaises(ValueError):
            interpolate_forecast(self.points+[self.points[0]],self.t)
    def test_interpolated_value_drives_classification(self):
        row=dict(time=self.t+timedelta(minutes=5),available_mw=40,theoretical_mw=40,actual_mw=10,agc_mw=15,source_row=2)
        result,detail=run_scenario([row],self.points,'linear_target_time','2026-08-01')
        self.assertEqual(detail[0]['预测第二点_MW'],25)
        self.assertAlmostEqual(result['prediction_mwh'],15/60)
        self.assertAlmostEqual(result['dispatch_mwh'],10/60)
        self.assertAlmostEqual(result['other_mwh'],5/60)
        self.assertAlmostEqual(result['closure_error_mwh'],0)
