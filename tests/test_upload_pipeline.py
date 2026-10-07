import io
import unittest
from datetime import datetime, timedelta
from openpyxl import Workbook

from upload_pipeline import analyze_uploads, read_forecast_tables


def forecast_file(points, station='plant-1'):
    book = Workbook()
    sheet = book.active
    sheet.title = '功率预测'
    sheet.append(['预测id', '名称', '预测时间', '平均预测结果'] +
                 [f'考核点{i}预测结果' for i in range(1, 17)])
    for version, value in points:
        sheet.append([station, '测试风场', version, 999] + [999, value] + [None]*14)
    stream = io.BytesIO()
    book.save(stream)
    return ('预测.xls', stream.getvalue())


def power_file(rows):
    text = '时间,可用功率,理论功率,全站总有功_集电线有功之和,AGC有功设定值\n'
    text += '\n'.join(','.join(map(str, r)) for r in rows)
    return ('分钟.csv', text.encode('utf-8-sig'))


class UploadPipelineTests(unittest.TestCase):
    def calculate(self, power, forecasts, **options):
        return analyze_uploads([power_file(power)], [forecast_file(forecasts)],
                               start='2026-08-01', end='2026-08-01', capacity=100, **options)

    def test_second_point_target_and_interpolation_and_closed_energy(self):
        result = self.calculate([['2026/8/1 0:00',100,100,50,60],
                                 ['2026/8/1 0:01',100,100,50,60],
                                 ['2026/8/1 0:02',100,100,50,60]],
                                [('2026-07-31 23:45',80), ('2026-08-01 00:00',95)])
        a,b = result['rows'][:2]
        self.assertEqual([a['f'],b['f']], [80,81])
        self.assertEqual(a['dispatch'],0)
        self.assertEqual(b['prediction'],0)
        self.assertAlmostEqual(a['other'],50/60)
        self.assertAlmostEqual(result['rows'][2]['dispatch'],22/60)
        self.assertAlmostEqual(result['rows'][2]['prediction'],18/60)
        self.assertAlmostEqual(result['summary']['gap'], result['summary']['dispatch']+
                               result['summary']['prediction']+result['summary']['other'])
        self.assertEqual(result['summary']['included'], 3)
        self.assertEqual(result['summary']['expected'], 1440)

    def test_does_not_bridge_missing_node_exact_nodes_remain_usable(self):
        result = self.calculate([['2026/8/1 0:15',100,100,50,60],
                                 ['2026/8/1 0:16',100,100,50,60]],
                                [('2026-08-01 00:00',80), ('2026-08-01 00:30',95)])
        self.assertEqual(result['rows'][15]['f'],80)
        self.assertIsNone(result['rows'][16]['f'])
        self.assertIsNone(result['rows'][16]['gap'])
        self.assertEqual(result['summary']['included'],1)

    def test_negative_actual_excluded_without_filling_zero(self):
        result = self.calculate([['2026/8/1 0:00',10,10,-.2,8]], [('2026-07-31 23:45',8)])
        self.assertEqual(result['summary']['included'],0)
        self.assertEqual(result['rows'][0]['p'],-.2)
        self.assertIn('实发负值',result['rows'][0]['note'])
        self.assertIsNone(result['rows'][0]['dispatch'])

    def test_duplicate_conflict_rejected_identical_deduplicated(self):
        f=forecast_file([('2026-07-31 23:45',80)])
        forecasts,meta=read_forecast_tables([f,f])
        self.assertEqual(len(forecasts),1)
        with self.assertRaisesRegex(ValueError,'冲突'):
            read_forecast_tables([f,forecast_file([('2026-07-31 23:45',81)])])

    def test_mixed_plants_rejected_and_blank_future_rows_ignored(self):
        with self.assertRaisesRegex(ValueError,'场站'):
            read_forecast_tables([forecast_file([('2026-07-31 23:45',80)]),
                                  forecast_file([('2026-07-31 23:45',80)],'plant-2')])
        forecasts,meta=read_forecast_tables([forecast_file([('2026-07-31 23:45',80),('2026-08-01 00:00',None)])])
        self.assertEqual(len(forecasts),1)

    def test_gap_interval_half_open_and_boundary_not_extra_day(self):
        result=self.calculate([['2026/8/1 0:00',100,100,80,80],
                               ['2026/8/2 0:00',100,100,80,80]], [('2026-07-31 23:45',80)])
        self.assertEqual(len(result['rows']),1440)
        self.assertEqual(result['gaps'][0]['start'],'2026-08-01T00:01:00+08:00')
        self.assertEqual(result['gaps'][-1]['end'],'2026-08-02T00:00:00+08:00')

    def test_missing_column_rejected(self):
        with self.assertRaisesRegex(ValueError,'列'):
            analyze_uploads([('bad.csv',b'time,actual\n1,2')],[],start='2026-08-01',end='2026-08-01',capacity=56)

    def test_invalid_forecast_endpoint_does_not_create_valid_interpolated_minutes(self):
        result=self.calculate([['2026/8/1 0:10',100,100,50,60]],
                              [('2026-07-31 23:45',-1),('2026-08-01 00:00',80)])
        self.assertFalse(result['rows'][10]['included'])
        self.assertIn('预测节点',result['rows'][10]['note'])

    def test_conflicting_minute_files_fail_instead_of_averaging(self):
        with self.assertRaisesRegex(ValueError,'分钟功率重复冲突'):
            analyze_uploads([power_file([['2026/8/1 0:00',100,100,50,60]]),
                             power_file([['2026/8/1 0:00',100,100,51,60]])],
                            [forecast_file([('2026-07-31 23:45',80)])],capacity=100)

    def test_inferred_period_ignores_next_midnight_endpoint(self):
        result=analyze_uploads([power_file([['2026/8/1 0:00',100,100,50,60],
                                          ['2026/8/2 0:00',100,100,50,60]])],
                              [forecast_file([('2026-07-31 23:45',80)])],capacity=100)
        self.assertEqual(result['meta']['end'],'2026-08-01')
        self.assertEqual(result['summary']['expected'],1440)


if __name__ == '__main__':
    unittest.main()
