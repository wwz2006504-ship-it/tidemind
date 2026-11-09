import socket,json,os,subprocess,sys,tempfile,unittest,urllib.request,urllib.error,hashlib,shutil
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
CLI=ROOT/'integration/local-install.py'
class LocalInstallTests(unittest.TestCase):
 def command(self,*args):
  result=subprocess.run([sys.executable,str(CLI),*args],capture_output=True,text=True,encoding='utf-8',timeout=25)
  self.assertEqual(result.returncode,0,result.stderr)
  return json.loads(result.stdout.strip().splitlines()[-1])
 def test_synthetic_local_install_restart_readonly_gate_and_rollback(self):
  code="import {fixture} from './integration/fixture.mjs';const f=await fixture(s=>s.write({layer:'semantic',content:'合成麦克风安装测试',source:'tool'},1));console.log(JSON.stringify({root:f.root,source:f.local}))"
  seed=subprocess.run(['node','--input-type=module','-e',code],cwd=ROOT,capture_output=True,text=True,encoding='utf-8',check=True);fixture=json.loads(seed.stdout.strip().splitlines()[-1]);source=Path(fixture['source']);before=hashlib.sha256(source.read_bytes()).hexdigest()
  with tempfile.TemporaryDirectory(dir=ROOT/'data',prefix='install-test-') as temp:
   root=Path(temp)/'installed';base=['--root',str(root)]
   try:
    self.assertTrue(self.command('prepare',*base,'--dry-run')['dryRun']);self.assertFalse(root.exists())
    installed=self.command('prepare',*base,'--source-db',str(source),'--authority-port','5196','--retrieve-port','5197');self.assertEqual(installed['mode'],'installed-not-activated')
    self.assertTrue(self.command('prepare',*base)['replayed']);self.assertTrue(self.command('refresh',*base)['replayed']);self.assertTrue((root/'manage.py').exists())
    state=self.command('start',*base);self.assertTrue(state['running']);self.assertTrue(state['retrieveHealthy']);self.assertEqual(state['activation'],'blocked')
    wrapped=subprocess.run([sys.executable,str(root/'manage.py'),'status'],capture_output=True,text=True,encoding='utf-8',timeout=10);self.assertEqual(wrapped.returncode,0,wrapped.stderr);self.assertTrue(json.loads(wrapped.stdout)['running'])
    self.assertTrue(self.command('start',*base)['replayed'])
    cfg=json.loads((root/'runtime/service-config.json').read_text(encoding='utf-8'));token=cfg['env']['TIDEMIND_LOCAL_TOKEN']
    req=urllib.request.Request('http://127.0.0.1:5196/admin',data=b'{"command":"acquire"}',headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'})
    with self.assertRaises(urllib.error.HTTPError) as denied:urllib.request.urlopen(req,timeout=2)
    self.assertEqual(denied.exception.code,423)
    def retrieve(agent):
     req=urllib.request.Request('http://127.0.0.1:5197/retrieve',data=json.dumps({'agentId':agent,'query':'麦克风'}).encode(),headers={'Content-Type':'application/json'})
     with urllib.request.urlopen(req,timeout=2) as response:return json.load(response)
    self.assertGreater(len(retrieve('xiyu')['items']),0);self.assertEqual(retrieve('other')['items'],[])
    self.assertEqual(self.command('reconcile',*base)['summary'],{'total':8,'pass':8,'fail':0})
    self.assertTrue(self.command('rollback',*base)['stopped']);self.assertTrue((root/'runtime/memory/memory.db').exists())
    self.assertTrue(self.command('rollback',*base)['stopped']);self.assertEqual(hashlib.sha256(source.read_bytes()).hexdigest(),before)
    with socket.socket() as unrelated:
     unrelated.bind(('127.0.0.1',5197));unrelated.listen()
     blocked=subprocess.run([sys.executable,str(CLI),'stop',*base],capture_output=True,text=True,encoding='utf-8',timeout=10);self.assertNotEqual(blocked.returncode,0);self.assertFalse(json.loads(blocked.stdout)['stopped'])
    self.assertTrue(self.command('start',*base)['running']);self.assertTrue(self.command('stop',*base)['stopped'])
   finally:
    if (root/'install.json').exists():subprocess.run([sys.executable,str(CLI),'stop',*base],capture_output=True,timeout=15)
    owned=Path(fixture['root']).resolve();data=(ROOT/'data').resolve();self.assertTrue(owned.is_relative_to(data));self.assertNotEqual(owned,data);shutil.rmtree(owned)
