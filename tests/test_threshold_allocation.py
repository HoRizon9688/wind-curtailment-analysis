import unittest
from threshold_allocation import ThresholdAllocator

class ThresholdTests(unittest.TestCase):
    def test_agc_floor_is_forecast_following_not_dispatch(self):
        r=ThresholdAllocator(56).calculate(5,.1,1.12,.9)
        self.assertTrue(r['floorFollowing'])
        self.assertTrue(r['following'])
        self.assertAlmostEqual(r['prediction']*60,3.88)
        self.assertEqual(r['dispatch'],0)
        self.assertAlmostEqual(r['noiseBelow']*60,.22)

    def test_floor_never_counts_space_already_allowed_by_agc(self):
        r=ThresholdAllocator(56).calculate(1,.1,1.12,.5)
        self.assertTrue(r['floorFollowing'])
        self.assertEqual(r['prediction'],0)
        self.assertEqual(r['referenceTotal'],0)
        self.assertAlmostEqual(r['operationalBelow']*60,.5)

    def test_agc_well_above_floor_is_not_automatically_explained(self):
        r=ThresholdAllocator(56).calculate(10,.1,3,1)
        self.assertFalse(r['floorFollowing'])
        self.assertEqual(r['prediction'],0)
        self.assertAlmostEqual(r['unexplainedAbove']*60,7)

    def test_near_following_above_forecast_is_prediction(self):
        r=ThresholdAllocator(56).calculate(31.6056,16.92,17.0594,17.2331)
        self.assertAlmostEqual(r['prediction']*60,14.3725)
        self.assertEqual(r['dispatch'],0)

    def test_hysteresis_avoids_dispatch_chatter(self):
        model=ThresholdAllocator(100)
        states=[model.calculate(100,80,g,70)['dispatchState'] for g in [79.2,78.9,78.9,78.9,79.2,79.5,79.5,79.5,79.2]]
        self.assertEqual(states,[False,False,False,True,True,True,True,False,False])

    def test_prediction_headroom_hysteresis(self):
        model=ThresholdAllocator(100)
        states=[model.calculate(a,80,80,80)['predictionState'] for a in [81.5,82.1,81.5,81,81.5]]
        self.assertEqual(states,[False,True,True,False,False])

    def test_executed_energy_not_counted_and_audit_closes(self):
        model=ThresholdAllocator(100)
        for _ in range(3): r=model.calculate(100,80,60,90)
        self.assertAlmostEqual(r['prediction']*60,10)
        self.assertEqual(r['dispatch'],0)
        self.assertAlmostEqual(r['referenceTotal'],40/60)
        self.assertAlmostEqual(r['releasedAboveAgc'],30/60)

    def test_unexplained_large_agc_above_forecast_stays_pending(self):
        r=ThresholdAllocator(100).calculate(100,60,80,75)
        self.assertEqual(r['prediction'],0)
        self.assertAlmostEqual(r['unexplainedAbove']*60,20)
        self.assertAlmostEqual(r['operationalBelow']*60,5)

    def test_nonnegative_and_two_closures(self):
        import random
        random.seed(43)
        model=ThresholdAllocator(100)
        for _ in range(1000):
            a,f,g,p=[random.random()*100 for _ in range(4)]
            r=model.calculate(a,f,g,p)
            self.assertAlmostEqual(r['gap'],r['dispatch']+r['prediction']+r['other'])
            self.assertAlmostEqual(r['referenceTotal'],r['dispatch']+r['prediction']+r['noiseAbove']+r['unexplainedAbove']+r['releasedAboveAgc'])
            self.assertTrue(all(r[k]>=0 for k in ['dispatch','prediction','other','noiseAbove','noiseBelow','operationalBelow']))
            for key in ['dispatch','prediction','other']:
                self.assertAlmostEqual(r[key],sum((b['top']-b['bottom'])/60 for b in r['allocationBands'] if b['kind']==key))

if __name__=='__main__':unittest.main()
