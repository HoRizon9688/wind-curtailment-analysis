import unittest
from threshold_allocation import ThresholdAllocator
from test_upload_pipeline import forecast_file, power_file
from upload_pipeline import analyze_uploads


class DispatchDebounceTests(unittest.TestCase):
    def states(self, gaps):
        model = ThresholdAllocator(100)
        return [model.calculate(100, 80, 80-gap, 60) for gap in gaps]

    def test_entry_confirmation_is_causal_and_pending_is_other(self):
        rows = self.states([20, 20, 20])
        self.assertEqual([r['dispatchState'] for r in rows], [False, False, True])
        for r in rows[:2]:
            self.assertEqual(r['dispatch'], 0)
            self.assertEqual(r['prediction'], 0)
            self.assertAlmostEqual(r['unexplainedAbove']*60, 40)
            self.assertIn('进入待确认', r['note'])
            self.assertNotIn('明显高于预测', r['note'])
        self.assertAlmostEqual(rows[2]['dispatch']*60, 20)
        self.assertAlmostEqual(rows[2]['prediction']*60, 20)

    def test_exit_needs_three_consecutive_samples(self):
        rows = self.states([2, 2, 2, .5, .5, .5])
        self.assertEqual([r['dispatchState'] for r in rows], [False, False, True, True, True, False])
        self.assertIn('退出待确认', rows[3]['note'])

    def test_interrupted_entry_and_exit_restart_confirmation(self):
        rows = self.states([2, 2, 1, 2, 2, 2, .5, .5, .7, .5, .5, .5])
        self.assertEqual([r['dispatchState'] for r in rows],
                         [False, False, False, False, False, True, True, True, True, True, True, False])

    def test_reset_clears_pending_and_confirmed_states(self):
        model = ThresholdAllocator(100)
        for _ in range(2): model.calculate(100, 80, 60, 60)
        model.reset()
        self.assertFalse(model.calculate(100, 80, 60, 60)['dispatchState'])
        for _ in range(2): model.calculate(100, 80, 60, 60)
        model.reset()
        self.assertFalse(model.calculate(100, 80, 79.2, 60)['dispatchState'])

    def test_pending_confirmation_crosses_midnight(self):
        p = power_file([[f'2026/8/1 23:{m}', 100, 100, 60, 60] for m in [58, 59]] +
                       [['2026/8/2 0:00', 100, 100, 60, 60]])
        f = forecast_file([('2026-08-01 23:30', 80), ('2026-08-01 23:45', 80)])
        result = analyze_uploads([p], [f], capacity=100, start='2026-08-01', end='2026-08-02')
        self.assertEqual([r['dispatchState'] for r in result['rows'][1438:1441]], [False, False, True])

    def test_excluded_minute_breaks_consecutiveness(self):
        for excluded in [None, -.1]:
            rows = [[f'2026/8/1 0:0{i}', 100, 100, excluded if i==2 else 60, 60]
                    for i in range(6)]
            if excluded is None: rows.pop(2)
            result = analyze_uploads([power_file(rows)], [forecast_file([
                ('2026-07-31 23:45', 80), ('2026-08-01 00:00', 80)])],
                capacity=100, start='2026-08-01', end='2026-08-01')
            self.assertFalse(result['rows'][2]['included'])
            self.assertEqual([r['dispatchState'] for r in result['rows'][3:6]], [False, False, True])

    def test_no_entry_for_threshold_equality_or_two_minute_spike(self):
        self.assertTrue(all(not r['dispatchState'] for r in self.states([1, 1, 1, 2, 2, 0])))

    def test_exit_confirmation_does_not_explain_agc_clearly_above_forecast(self):
        model=ThresholdAllocator(100)
        for _ in range(3): model.calculate(100,80,60,60)
        r=model.calculate(100,80,95,75)
        self.assertTrue(r['dispatchState'])  # Exit confirmation is still pending.
        self.assertEqual(r['dispatch'],0)
        self.assertEqual(r['prediction'],0)
        self.assertAlmostEqual(r['unexplainedAbove']*60,5)
        self.assertIn('原因待核实',r['note'])
