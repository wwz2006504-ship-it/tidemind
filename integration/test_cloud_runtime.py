import argparse,hashlib,importlib.util,io,tarfile,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('cloud_runtime',Path(__file__).with_name('cloud-runtime.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class RuntimeTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name)/'staging';self.root.mkdir();(self.root/'OWNER').write_text('TideMind candidate staging v1');self.target=self.root/'runtime/node-v24.17.0-linux-x64'
  buf=io.BytesIO()
  with tarfile.open(fileobj=buf,mode='w:xz') as t:
   raw=b'SYNTHETIC NODE BINARY';info=tarfile.TarInfo('node-v24.17.0-linux-x64/bin/node');info.size=len(raw);t.addfile(info,io.BytesIO(raw))
  self.archive=buf.getvalue();self.stack=[]
  for obj,key,value in [(m,'ROOT',self.root),(m,'TARGET',self.target),(m,'SHA256',hashlib.sha256(self.archive).hexdigest())]:
   p=patch.object(obj,key,value);p.start();self.stack.append(p)
  for name,value in [('system','Linux'),('machine','x86_64')]:p=patch.object(m.platform,name,return_value=value);p.start();self.stack.append(p)
 def tearDown(self):
  for p in reversed(self.stack):p.stop()
  self.tmp.cleanup()
 def run_script(self,**kwargs):return m.run(argparse.Namespace(dry_run=kwargs.get('dry_run',False),rollback=kwargs.get('rollback',False)))
 def install(self):
  class Response(io.BytesIO):
   def geturl(self):return m.URL
  with patch.object(m.urllib.request,'urlopen',return_value=Response(self.archive)),patch.object(m.subprocess,'run',return_value=argparse.Namespace(returncode=0,stdout=m.VERSION+'\n')):return self.run_script()
 def test_dry_run_no_writes_or_network(self):
  with patch.object(m.urllib.request,'urlopen',side_effect=AssertionError('network')):self.assertTrue(self.run_script(dry_run=True)['dryRun']);self.run_script(dry_run=True,rollback=True)
  self.assertFalse(self.target.exists())
 def test_install_repeat_and_rollback_preserve_archive(self):
  self.assertFalse(self.install()['replayed']);self.assertTrue(self.run_script()['replayed']);self.run_script(rollback=True);self.run_script(rollback=True)
  self.assertTrue((self.target/'node.disabled').exists());self.assertTrue((self.target/m.ARCHIVE).exists());self.assertFalse((self.target/'node').exists())
  with self.assertRaisesRegex(ValueError,'rolled back'):self.run_script()
 def test_tampered_existing_binary_not_overwritten(self):
  self.install();node=self.target/'node';node.chmod(0o600);node.write_bytes(b'changed')
  with self.assertRaisesRegex(ValueError,'differs'):self.run_script()
  self.assertEqual(node.read_bytes(),b'changed')
 def test_unowned_directory_refused(self):
  self.target.mkdir(parents=True)
  with self.assertRaisesRegex(ValueError,'unowned'):self.run_script()
 def test_bad_checksum_disables_install(self):
  with patch.object(m,'SHA256','0'*64):
   with self.assertRaisesRegex(ValueError,'checksum'):self.install()
  self.assertFalse((self.target/'node').exists())
 def test_failed_smoke_retains_disabled_binary(self):
  class Response(io.BytesIO):
   def geturl(self):return m.URL
  with patch.object(m.urllib.request,'urlopen',return_value=Response(self.archive)),patch.object(m.subprocess,'run',return_value=argparse.Namespace(returncode=1,stdout='')):
   with self.assertRaisesRegex(ValueError,'smoke'):self.run_script()
  self.assertTrue((self.target/'node.disabled').exists());self.assertFalse((self.target/'installed.json').exists())
if __name__=='__main__':unittest.main()
