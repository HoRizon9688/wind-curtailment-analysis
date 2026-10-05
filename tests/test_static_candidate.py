import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import build_pages_demo
try:
    import build_static_candidate as candidate
except ImportError:
    candidate = None


class StaticCandidateTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(candidate, 'T6 independent static candidate builder is required')
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def bundle(self):
        output = self.root / 'release'
        sha = 'a' * 64
        html = f'<html><head><meta name="data-app-snapshot-sha256" content="{sha}"></head><body>合成示例</body></html>'.encode()
        candidate.write_package(output, html, {'minute-power.csv': b'time,power\n','forecast.csv': b'time,forecast\n'}, sha, {'synthetic': True})
        return output

    def test_demo_inputs_are_reusable_raw_bytes_and_independently_reproduce_demo(self):
        files = build_pages_demo.create_demo_inputs()
        from upload_pipeline import analyze_uploads
        self.assertTrue(all(name.startswith('synthetic-') for name, _ in files['power'] + files['forecast']))
        actual = analyze_uploads(files['power'],files['forecast'],**files['options'])
        self.assertEqual(actual,build_pages_demo.create_demo())

    def test_snapshot_has_distinct_stable_identity_and_explicit_browser_synthetic_mode(self):
        snapshot = candidate.synthetic_snapshot()
        self.assertTrue(snapshot['pagesDemo'])
        self.assertEqual(snapshot['calculationMode'],'browser')
        self.assertEqual(snapshot['buildStatus'],'complete')
        self.assertEqual(snapshot,candidate.synthetic_snapshot())
        self.assertIn('合成',snapshot['queries']['wind_minutes']['source']['label'])
        self.assertEqual(snapshot['wind']['meta']['stationId'],'SYNTHETIC_DEMO')

    def test_output_is_immutable_and_must_stay_in_reports_static_candidates(self):
        allowed = self.root/'reports/static-candidates/a'
        self.assertEqual(candidate.safe_output(self.root,allowed),allowed.resolve())
        for path in [self.root/'docs', self.root/'dashboard/dist',self.root/'reports/static-candidates',self.root/'reports/static-candidates/../../docs']:
            with self.assertRaises(ValueError): candidate.safe_output(self.root,path)
        allowed.mkdir(parents=True)
        with self.assertRaises(FileExistsError): candidate.safe_output(self.root,allowed)

    def test_copy_ignores_private_snapshot_generated_files_and_hosted_identity(self):
        names=['dashboard/src/data.json','dashboard/src/content/a.mjs','dashboard/.openai/hosting.json','dashboard/.openai/deploy.json','dashboard/dist/index.html']
        for name in names:
            p=self.root/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_text('PRIVATE' if 'data.json' in name else 'program')
        destination=self.root/'copy'
        records=candidate.copy_source(self.root,destination,names)
        self.assertEqual(set(records),{'src/content/a.mjs','.openai/hosting.json'})
        self.assertFalse((destination/'src/data.json').exists())
        self.assertFalse((destination/'dist').exists())
        self.assertFalse((destination/'.openai/deploy.json').exists())
        with self.assertRaises(ValueError):candidate.copy_source(self.root,destination,['dashboard/../secret'])

    def test_public_html_rejects_real_meta_tags_not_runtime_query_strings(self):
        candidate.check_public_html(b'<script>document.querySelector(\'meta[name="data-app-local-thread"]\')</script>',self.root)
        for attr in ['data-app-local-thread','data-app-local-reference']:
            with self.assertRaises(ValueError):candidate.check_public_html(f'<META content="x" NAME="{attr}">'.encode(),self.root)
        with self.assertRaises(ValueError):candidate.check_public_html(str(self.root).encode(),self.root)

    def test_package_is_allowlisted_and_hashes_and_zip_are_verified(self):
        output=self.bundle();review=candidate.verify_candidate(output)
        self.assertEqual(review['files'],4)
        self.assertEqual(len(review['archiveSha256']),64)
        manifest=json.loads((output/'candidate-manifest.json').read_text())
        self.assertEqual({r['path'] for r in manifest['files']},{'site/index.html','site/samples/minute-power.csv','site/samples/forecast.csv','USAGE.md'})
        self.assertTrue(manifest['synthetic'])
        self.assertFalse(manifest['published'])

    def test_tamper_extra_file_and_corrupt_zip_are_rejected(self):
        output=self.bundle();html=output/'site/index.html';old=html.read_bytes()
        html.write_bytes(old+b'x')
        with self.assertRaises(ValueError):candidate.verify_candidate(output)
        html.write_bytes(old);(output/'secret.txt').write_text('private')
        with self.assertRaises(ValueError):candidate.verify_candidate(output)
        (output/'secret.txt').unlink();(output/'candidate.zip').write_bytes(b'broken')
        with self.assertRaises(ValueError):candidate.verify_candidate(output)

    def test_missing_file_is_rejected(self):
        output=self.bundle();(output/'site/samples/forecast.csv').unlink()
        with self.assertRaises(ValueError):candidate.verify_candidate(output)

    def test_symlink_root_is_refused_before_resolving(self):
        from unittest.mock import Mock
        output=self.bundle();link=Mock();link.is_symlink.return_value=True;link.resolve.return_value=output
        with patch.object(candidate,'Path',return_value=link):
            with self.assertRaises(ValueError):candidate.verify_candidate('linked-release')

    def test_redirected_output_base_cannot_authorize_writes_outside_workspace(self):
        base=self.root/'reports/static-candidates';output=base/'a';elsewhere=self.root/'outside'
        original=Path.resolve
        def redirected(path,*args,**kwargs):
            if path==base:return elsewhere
            if path==output:return elsewhere/'a'
            return original(path,*args,**kwargs)
        with patch.object(Path,'resolve',autospec=True,side_effect=redirected):
            with self.assertRaises(ValueError):candidate.safe_output(self.root,output)

    def test_manifest_cannot_escape_root_or_change_required_site_files(self):
        output=self.bundle();path=output/'candidate-manifest.json';m=json.loads(path.read_text());m['files'][0]['path']='../private.json';path.write_text(json.dumps(m))
        with self.assertRaises(ValueError):candidate.verify_candidate(output)

    def test_installed_dependencies_must_match_lock_without_network_install(self):
        lock={'packages':{'node_modules/react':{'version':'19.2.3'}}}
        path=self.root/'node_modules/react/package.json';path.parent.mkdir(parents=True);path.write_text('{"version":"19.2.3"}')
        self.assertEqual(candidate.locked_versions(self.root,lock,names=['react']),{'react':'19.2.3'})
        path.write_text('{"version":"0.0.0"}')
        with self.assertRaises(ValueError):candidate.locked_versions(self.root,lock,names=['react'])


if __name__=='__main__':unittest.main()
