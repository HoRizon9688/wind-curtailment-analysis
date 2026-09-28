import unittest
from build_pages_demo import create_demo


class PagesDemoTests(unittest.TestCase):
    def test_demo_is_explicitly_synthetic_and_has_no_site_measurements(self):
        result=create_demo()
        self.assertEqual(result['meta']['stationId'],'SYNTHETIC_DEMO')
        self.assertIn('合成',result['meta']['stationName'])
        self.assertEqual(len(result['rows']),2880)
        self.assertTrue(result['summary']['excluded']>0)
        self.assertTrue(result['summary']['dispatch']>0)
        self.assertTrue(result['summary']['prediction']>0)
        self.assertTrue(all(f['name'].startswith('synthetic-') for f in result['meta']['files']))

    def test_demo_generation_is_reproducible(self):
        self.assertEqual(create_demo(),create_demo())


if __name__=='__main__':unittest.main()
