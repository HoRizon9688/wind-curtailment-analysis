import base64
import unittest
from types import SimpleNamespace
from unittest.mock import patch
from serve_app import build_dashboard, decode_uploads, validate_origin


class LocalServerTests(unittest.TestCase):
    def test_local_build_resolves_installed_dependencies_from_source(self):
        with patch.dict('os.environ', {'WIND_NODE': 'node', 'WIND_DATA_APP_SCRIPT': 'data-app.mjs'}), patch('serve_app.subprocess.run', return_value=SimpleNamespace(returncode=0)) as run:
            build_dashboard(source_build=True)
        command = run.call_args.args[0]
        self.assertIn('--source', command)
        self.assertNotIn('--separate-data', command)

    def test_upload_names_are_labels_not_server_paths(self):
        with self.assertRaisesRegex(ValueError, '文件名'):
            decode_uploads([{'name':'../data.csv','data':base64.b64encode(b'ok').decode()}])

    def test_bad_base64_rejected(self):
        with self.assertRaises(ValueError):
            decode_uploads([{'name':'a.csv','data':'not base64!!'}])

    def test_only_same_origin_can_calculate(self):
        self.assertTrue(validate_origin('http://127.0.0.1:4180','127.0.0.1:4180',4180))
        self.assertFalse(validate_origin('https://evil.example','127.0.0.1:4180',4180))
        self.assertFalse(validate_origin('http://evil.example:4180','evil.example:4180',4180))


if __name__ == '__main__':
    unittest.main()
