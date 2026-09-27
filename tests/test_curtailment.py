import itertools
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
from curtailment import calculate_interval, calculate_dataset


def row(a=100, f=80, g=60, p=50, **extra):
    value = dict(start='2026-09-01T00:00:00+08:00',
                 end='2026-09-01T00:15:00+08:00',
                 available_mw=a, forecast_mw=f, agc_mw=g, actual_mw=p,
                 agc_state='automatic', attribution_state='applicable',
                 forecast_version='v1', forecast_issued_at='2026-08-31T23:45:00+08:00',
                 forecast_received_at='2026-08-31T23:46:00+08:00',
                 forecast_target_at='2026-09-01T00:00:00+08:00',
                 agc_effective_at='2026-09-01T00:00:00+08:00',
                 alignment_verified=True)
    value.update(extra)
    return value


class CalculationTests(unittest.TestCase):
    def test_eight_acceptance_examples(self):
        cases = [(100,80,80,80,20,0,0), (100,100,60,60,0,40,0),
                 (100,80,60,60,20,20,0), (100,80,60,50,20,20,10),
                 (70,100,80,70,0,0,0), (100,80,60,70,20,10,0),
                 (100,60,80,80,0,0,20), (40,20,60,30,0,0,10)]
        for a,f,g,p,pred,dispatch,other in cases:
            with self.subTest(case=(a,f,g,p)):
                result = calculate_interval(row(a,f,g,p))
                self.assertEqual((result['prediction_mw'],result['dispatch_mw'],
                                  result['other_mw']), (pred,dispatch,other))

    def test_nonnegative_and_closure_across_orderings(self):
        for a,f,g,p in itertools.product([0,20,60,100], repeat=4):
            r = calculate_interval(row(a,f,g,p))
            values = [r[k] for k in ('prediction_mw','dispatch_mw','other_mw')]
            self.assertTrue(all(v >= 0 for v in values))
            self.assertAlmostEqual(sum(values), max(a-p,0))

    def test_special_case_subcategories(self):
        r = calculate_interval(row(100,60,80,50))
        self.assertEqual((r['other_above_agc_mw'],r['other_below_agc_mw']), (20,30))
        self.assertEqual(r['status'], 'pending')

    def test_energy_is_integrated_per_interval(self):
        rows = [row(), row(100,80,60,90, start='2026-09-01T00:15:00+08:00',
                          end='2026-09-01T00:30:00+08:00')]
        result = calculate_dataset({'intervals': rows})
        self.assertEqual(result['summary']['prediction_mwh'], 7.5)
        self.assertEqual(result['summary']['dispatch_mwh'], 5)
        self.assertEqual(result['summary']['other_mwh'], 2.5)

    def test_missing_nonfinite_negative_or_boolean_power_not_zero_filled(self):
        for value in [None, '', float('nan'), float('inf'), -1, True, 'bad']:
            with self.subTest(value=value):
                r = calculate_interval(row(f=value))
                self.assertEqual(r['status'], 'invalid')
                self.assertIsNone(r['prediction_mwh'])

    def test_unknown_evidence_is_estimate(self):
        r = calculate_interval(row(alignment_verified=False, agc_state='unknown'))
        self.assertEqual(r['status'], 'estimated')
        self.assertEqual(r['dispatch_mw'],20)

    def test_inactive_control_is_pending(self):
        for updates in [dict(agc_state='manual'), dict(agc_state='off'),
                        dict(attribution_state='transition'),
                        dict(attribution_state='other_limit')]:
            r = calculate_interval(row(**updates))
            self.assertEqual((r['prediction_mw'],r['dispatch_mw'],r['other_mw']), (0,0,50))

    def test_tolerance_moves_small_dispatch_to_pending_without_losing_energy(self):
        r = calculate_interval(row(g=79.9,p=79.9), {'comparison_tolerance_mw':0.2})
        self.assertEqual(r['dispatch_mw'],0)
        self.assertAlmostEqual(r['other_mw'],0.1)
        self.assertAlmostEqual(r['raw_dispatch_mw'],0.1)
        self.assertEqual(r['prediction_mw'],20)

    def test_missing_tolerance_never_claims_verified_dispatch(self):
        r = calculate_interval(row())
        self.assertEqual(r['status'], 'estimated')
        r = calculate_interval(row(), {'comparison_tolerance_mw':0, 'available_basis_confirmed':True})
        self.assertEqual(r['status'], 'rule_verified')

    def test_revised_or_not_yet_effective_data_rejected(self):
        for field in ['forecast_issued_at','forecast_received_at','agc_effective_at']:
            r = calculate_interval(row(**{field:'2026-09-01T00:01:00+08:00'}))
            self.assertEqual(r['status'], 'invalid')

    def test_actual_above_available_is_flagged_not_netting_other_losses(self):
        r = calculate_interval(row(p=101))
        self.assertEqual(r['status'], 'baseline_anomaly')
        self.assertEqual(r['total_gap_mw'],0)

    def test_time_errors_fail_explicitly(self):
        for updates in [dict(end='2026-09-01T00:00:00+08:00'),
                        dict(start='2026-09-01T00:00:00'), dict(start='bad')]:
            with self.assertRaises(ValueError):
                calculate_interval(row(**updates))

    def test_duplicate_or_overlapping_intervals_rejected(self):
        with self.assertRaises(ValueError):
            calculate_dataset({'intervals':[row(),row()]})

    def test_coverage_includes_gaps_and_invalid_rows(self):
        rows = [row(),row(f=None,start='2026-09-01T00:30:00+08:00',
                          end='2026-09-01T00:45:00+08:00')]
        s = calculate_dataset({'intervals':rows})['summary']
        self.assertAlmostEqual(s['coverage_ratio'],1/3)
        self.assertEqual(s['gap_hours'],0.25)
        self.assertEqual(s['invalid_hours'],0.25)

    def test_daily_monthly_split_at_local_midnight(self):
        r = calculate_dataset({'intervals':[row(start='2026-09-30T23:45:00+08:00',
                             end='2026-10-01T00:15:00+08:00')]})
        self.assertEqual(len(r['daily']),2)
        self.assertEqual(len(r['monthly']),2)
        self.assertEqual([v['dispatch_mwh'] for v in r['daily']], [5,5])

    def test_invalid_settings_and_states_rejected(self):
        for settings in [{'comparison_tolerance_mw':-1}, {'comparison_tolerance_mw':True},
                         {'available_basis_confirmed': 'yes'}, {'typo':1}]:
            with self.assertRaises(ValueError):
                calculate_dataset({'settings':settings,'intervals':[row()]})
        self.assertEqual(calculate_interval(row(agc_state='autmatic'))['status'], 'invalid')

    def test_unusable_available_basis_blocks_attribution(self):
        r = calculate_interval(row(), {'available_basis_confirmed':False})
        self.assertEqual(r['status'],'invalid')

    def test_cli_writes_auditable_outputs(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp)/'input.json'
            source.write_text(json.dumps({'intervals':[row()]}),encoding='utf-8')
            output = Path(tmp)/'output'
            proc = subprocess.run([sys.executable,str(ROOT/'curtailment.py'),str(source),
                                   '--output',str(output)],capture_output=True,text=True)
            self.assertEqual(proc.returncode,0,proc.stderr)
            report = json.loads((output/'report.json').read_text(encoding='utf-8'))
            self.assertEqual(report['summary']['total_gap_mwh'],12.5)
            self.assertTrue((output/'intervals.csv').exists())
            self.assertTrue((output/'daily.csv').exists())
            self.assertTrue((output/'monthly.csv').exists())

    def test_summary_separates_estimated_and_rule_verified_energy(self):
        verified = row()
        estimated = row(start='2026-09-01T00:15:00+08:00',end='2026-09-01T00:30:00+08:00',
                        alignment_verified=False)
        r = calculate_dataset({'settings':{'available_basis_confirmed':True,
                                            'comparison_tolerance_mw':0},
                               'intervals':[verified,estimated]})
        self.assertEqual(r['by_status']['estimated']['dispatch_mwh'],5)
        self.assertEqual(r['by_status']['rule_verified']['dispatch_mwh'],5)

    def test_explicit_report_window_counts_completely_missing_days(self):
        r = calculate_dataset({'report_start':'2026-09-01T00:00:00+08:00',
                               'report_end':'2026-09-03T00:00:00+08:00',
                               'intervals':[row()]})
        self.assertEqual(r['summary']['window_hours'],48)
        self.assertEqual(r['daily'][1]['coverage_ratio'],0)
        self.assertEqual(r['daily'][1]['gap_hours'],24)

    def test_cli_does_not_overwrite_existing_output(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp)/'input.json'
            source.write_text(json.dumps({'intervals':[row()]}),encoding='utf-8')
            marker = Path(tmp)/'report.json'
            marker.write_text('preserve',encoding='utf-8')
            proc = subprocess.run([sys.executable,str(ROOT/'curtailment.py'),str(source),
                                   '--output',tmp],capture_output=True)
            self.assertEqual(proc.returncode,2)
            self.assertEqual(marker.read_text(encoding='utf-8'),'preserve')

    def test_non_mw_unit_is_not_silently_treated_as_mw(self):
        with self.assertRaises(ValueError):
            calculate_dataset({'station':{'power_unit':'kW'},'intervals':[row()]})


if __name__ == '__main__':
    unittest.main()
