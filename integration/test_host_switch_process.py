import importlib.util,tempfile,unittest,subprocess,sys,json
from pathlib import Path
spec=importlib.util.spec_from_file_location('switch',Path(__file__).with_name('host-switch-rehearsal.py'));switch=importlib.util.module_from_spec(spec);spec.loader.exec_module(switch)
class HostSwitchTests(unittest.TestCase):
 def fixture(self):
  switch.DATA.mkdir(exist_ok=True);temp=tempfile.TemporaryDirectory(dir=switch.DATA,prefix='host-switch-');self.addCleanup(temp.cleanup);root=Path(temp.name);(root/'.synthetic-host-switch').write_text('SYNTHETIC')
  for branch,value in [('live','SYNTHETIC OLD'),('candidate','SYNTHETIC NEW')]:
   for name in switch.FILES:p=root/branch/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_text(value+name,encoding='utf-8')
  return root
 def test_dry_run_idempotent_switch_and_rollback_preserve_new_state(self):
  root=self.fixture();self.assertTrue(switch.prepare(root,True)['dryRun']);self.assertFalse((root/'switch-plan.json').exists())
  before={name:(root/'live'/name).read_bytes() for name in switch.FILES};switch.prepare(root);self.assertTrue(switch.prepare(root)['replayed'])
  self.assertTrue(switch.apply(root,True)['dryRun']);switch.apply(root);self.assertTrue(switch.apply(root)['replayed'])
  for name in ['memory.db','lease.db','ledger.jsonl','personas/default.md']:
   p=root/'state'/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(b'SYNTHETIC NEW STATE')
  self.assertTrue(switch.rollback(root,True)['dryRun']);switch.rollback(root);self.assertTrue(switch.rollback(root)['replayed'])
  self.assertEqual(before,{name:(root/'live'/name).read_bytes() for name in switch.FILES})
  self.assertTrue(all(p.read_bytes()==b'SYNTHETIC NEW STATE' for p in (root/'state').rglob('*') if p.is_file()))
 def test_interruption_after_first_file_can_return_without_changing_data(self):
  root=self.fixture();before={name:(root/'live'/name).read_bytes() for name in switch.FILES};switch.prepare(root)
  def fail(name):raise RuntimeError('synthetic power loss')
  with self.assertRaises(RuntimeError):switch.apply(root,after_write=fail)
  self.assertEqual(switch.load(root)['state'],'applying');switch.rollback(root)
  self.assertEqual(before,{name:(root/'live'/name).read_bytes() for name in switch.FILES})
 def test_foreign_edits_or_tampered_backup_stop_before_any_restore(self):
  root=self.fixture();switch.prepare(root);switch.apply(root);(root/'live/src/host.js').write_text('SYNTHETIC THIRD PARTY EDIT')
  before={name:(root/'live'/name).read_bytes() for name in switch.FILES}
  with self.assertRaisesRegex(ValueError,'live file changed'):switch.rollback(root)
  self.assertEqual(before,{name:(root/'live'/name).read_bytes() for name in switch.FILES})
 def test_production_and_unmarked_roots_are_rejected(self):
  with self.assertRaises(ValueError):switch.checked(Path.home()/'.dsh')
  with tempfile.TemporaryDirectory(dir=switch.DATA) as name:
   with self.assertRaises(ValueError):switch.checked(name)
 def test_tampered_snapshot_is_rejected_before_any_live_file_is_written(self):
  root=self.fixture();switch.prepare(root);switch.apply(root)
  (root/'rollback/src/host.js').write_text('SYNTHETIC TAMPERED BACKUP')
  before={name:(root/'live'/name).read_bytes() for name in switch.FILES}
  with self.assertRaisesRegex(ValueError,'snapshot changed'):switch.rollback(root)
  self.assertEqual(before,{name:(root/'live'/name).read_bytes() for name in switch.FILES})
 def test_cli_dry_run_apply_and_rollback_flags(self):
  root=self.fixture();script=Path(__file__).with_name('host-switch-rehearsal.py')
  def call(*args):
   result=subprocess.run([sys.executable,str(script),*args,'--root',str(root)],capture_output=True,text=True,timeout=10)
   self.assertEqual(result.returncode,0,result.stderr);return json.loads(result.stdout)
  self.assertTrue(call('prepare','--dry-run')['dryRun']);self.assertFalse((root/'switch-plan.json').exists())
  call('prepare');call('apply');self.assertTrue(call('--rollback','--dry-run')['dryRun']);self.assertTrue(call('--rollback')['restored']);self.assertTrue(call('--rollback')['replayed'])
if __name__=='__main__':unittest.main()
