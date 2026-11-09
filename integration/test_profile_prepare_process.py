import unittest,tempfile,json,hashlib,importlib.util,subprocess,sys
from pathlib import Path
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('profile_prepare',Path(__file__).with_name('prepare-profile.py'));mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod)
class ProfilePrepareTests(unittest.TestCase):
 def fixture(self):
  data=mod.PACKAGE/'data';data.mkdir(exist_ok=True);temp=tempfile.TemporaryDirectory(dir=data,prefix='profile-prepare-');self.addCleanup(temp.cleanup);root=Path(temp.name);install=root/'install';(install/'runtime').mkdir(parents=True)
  for name,value in [('owner.json',{'owner':'synthetic-owner'}),('install.json',{'owner':'synthetic-owner','mode':'installed-not-activated'}),('runtime/service-config.json',{'owner':'synthetic-owner'})]:(install/name).write_text(json.dumps(value))
  profile=root/'cordis.patch.yml';original=b"# SYNTHETIC profile\n- id: unrelated-plugin\n  disabled: false\n# Preserve platform guards and allow-all\n- id: tool-bash\n  disabled: !!js process.platform === 'win32'\n- id: aurabot-computer\n  config:\n    accessMode: allow-all\n";profile.write_bytes(original)
  candidate=root/'candidate';manifest={}
  for name in ['host/aurabot/src/host.js','host/plugin/src/index.js','integration/profile-entry.mjs']:
   p=candidate/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_text('export function apply() {}');manifest[name]=hashlib.sha256(p.read_bytes()).hexdigest()
  (candidate/'MANIFEST-SHA256.json').write_text(json.dumps(manifest));return install,profile,candidate,original
 def test_dry_run_and_idempotent_prepare_preserve_original_profile_and_guards(self):
  root,profile,candidate,original=self.fixture();r=mod.prepare(root,profile,candidate,True);self.assertTrue(r['dryRun']);self.assertFalse((root/'runtime/profile-plans').exists())
  r=mod.prepare(root,profile,candidate);again=mod.prepare(root,profile,candidate);self.assertTrue(again['replayed']);self.assertFalse(r['productionReady']);self.assertEqual(r['overrideIds'],['aurabot','dsh-memory-layers','dsh-heartbeat']);self.assertEqual(profile.read_bytes(),original)
  proposed=(Path(r['directory'])/'candidate-profile.yml').read_bytes();self.assertTrue(proposed.startswith(original));self.assertIn(b"!!js process.platform === 'win32'",proposed);self.assertIn(b'accessMode: allow-all',proposed)
 def test_rollback_only_cancels_plan_and_preserves_new_state(self):
  root,profile,candidate,original=self.fixture();r=mod.prepare(root,profile,candidate)
  for name in ['lease.db','memory.db','persona-versions.json','new-memories.json']:(root/'runtime'/name).write_bytes(b'SYNTHETIC NEW STATE')
  self.assertTrue(mod.rollback(root,True)['dryRun']);self.assertEqual(mod.load(Path(r['directory'])/'plan.json')['state'],'prepared');mod.rollback(root);self.assertTrue(mod.rollback(root)['replayed']);self.assertEqual(profile.read_bytes(),original)
  for name in ['lease.db','memory.db','persona-versions.json','new-memories.json']:self.assertEqual((root/'runtime'/name).read_bytes(),b'SYNTHETIC NEW STATE')
 def test_changed_original_produces_separate_plan_without_overwriting_previous_backup(self):
  root,profile,candidate,original=self.fixture();a=mod.prepare(root,profile,candidate);profile.write_bytes(original+b'\n# ANOTHER LIVE EDIT\n');b=mod.prepare(root,profile,candidate);self.assertNotEqual(a['planId'],b['planId']);self.assertEqual((Path(a['directory'])/'original-profile.bin').read_bytes(),original)
 def test_candidate_or_preview_tampering_is_rejected(self):
  root,profile,candidate,original=self.fixture();r=mod.prepare(root,profile,candidate);(Path(r['directory'])/'candidate-profile.yml').write_text('CHANGED');self.assertRaises(ValueError,mod.prepare,root,profile,candidate)
  (candidate/'host/aurabot/src/host.js').write_text('CHANGED');self.assertRaises(ValueError,mod.prepare,root,profile,candidate)
 def test_foreign_owner_or_production_root_is_refused(self):
  root,profile,candidate,original=self.fixture();(root/'owner.json').write_text(json.dumps({'owner':'foreign'}));self.assertRaises(ValueError,mod.prepare,root,profile,candidate);self.assertRaises(ValueError,mod.owned,Path.home()/'.dsh')
 def test_cli_dry_run_and_rollback_are_available(self):
  root,profile,candidate,_=self.fixture();p=subprocess.run([sys.executable,str(Path(mod.__file__)),'--root',str(root),'--profile',str(profile),'--candidate',str(candidate),'--dry-run'],capture_output=True,text=True);self.assertEqual(p.returncode,0,p.stderr);self.assertTrue(json.loads(p.stdout)['dryRun'])
  p=subprocess.run([sys.executable,str(Path(mod.__file__)),'--root',str(root),'--rollback'],capture_output=True,text=True);self.assertEqual(p.returncode,0,p.stderr);self.assertTrue(json.loads(p.stdout)['cancelled'])

 def production_fixture(self):
  root,profile,candidate,original=self.fixture()
  home=root.parent/'desktop-home'
  actual=home/'.dsh/profiles/desktop/cordis.patch.yml'
  actual.parent.mkdir(parents=True)
  profile.replace(actual)
  release='1'*16
  install=mod.load(root/'install.json');install['release']=release
  (root/'install.json').write_text(json.dumps(install))
  installed=root/'releases'/release
  installed.parent.mkdir()
  candidate.rename(installed)
  manifest=mod.load(installed/'MANIFEST-SHA256.json')
  verifier=installed/'integration/profile-activation-check.mjs'
  verifier.write_text('// Synthetic readiness check')
  manifest['integration/profile-activation-check.mjs']=mod.sha(verifier.read_bytes())
  (installed/'INSTALL-FILES-SHA256.json').write_text(json.dumps(manifest))
  (root/'runtime/profile-runtime-inputs.json').write_text(json.dumps({'aiMemory':{}}))
  plan=mod.prepare(root,actual,installed)
  return root,actual,original,home,plan['planId']

 def test_apply_and_restore_verified_entry_only(self):
  root,profile,original,home,plan_id=self.production_fixture()
  frontier={'term':0,'storeDigest':'a'*64,'historyDigest':'b'*64}
  state=root/'runtime/memory.db'
  state.write_bytes(b'CURRENT DATA')
  with patch.object(mod.Path,'home',return_value=home),patch.object(mod,'verify_activation',return_value=frontier),patch.object(mod,'desktop_stopped') as stopped:
   self.assertTrue(mod.transition(root,plan_id,dry_run=True)['preflightPassed'])
   stopped.assert_not_called()
   self.assertEqual(profile.read_bytes(),original)
   self.assertTrue(mod.transition(root,plan_id)['profileWritten'])
   self.assertIn(b'profile-entry.mjs',profile.read_bytes())
   self.assertTrue(mod.transition(root,plan_id)['replayed'])
   self.assertTrue(mod.transition(root,plan_id,restore=True)['profileWritten'])
   self.assertTrue(mod.transition(root,plan_id,restore=True)['replayed'])
  self.assertEqual(profile.read_bytes(),original)
  self.assertEqual(state.read_bytes(),b'CURRENT DATA')

 def test_advanced_authority_or_unavailable_preflight_preserves_entry(self):
  root,profile,original,home,plan_id=self.production_fixture()
  frontier={'term':0,'storeDigest':'a'*64,'historyDigest':'b'*64}
  with patch.object(mod.Path,'home',return_value=home),patch.object(mod,'desktop_stopped'):
   with patch.object(mod,'verify_activation',side_effect=ValueError('standby')):
    with self.assertRaisesRegex(ValueError,'standby'):mod.transition(root,plan_id)
   self.assertEqual(profile.read_bytes(),original)
   with patch.object(mod,'verify_activation',return_value=frontier):mod.transition(root,plan_id)
   candidate=profile.read_bytes()
   with patch.object(mod,'verify_activation',return_value=frontier|{'term':1}):
    with self.assertRaisesRegex(ValueError,'authority advanced'):mod.transition(root,plan_id,restore=True)
   self.assertEqual(profile.read_bytes(),candidate)
if __name__=='__main__':unittest.main()
