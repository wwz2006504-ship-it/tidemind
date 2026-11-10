"""Integration tests of revised ORIGINAL entries with synthetic DBs only."""
import json,os,socket,sqlite3,subprocess,tempfile,time,unittest,urllib.request
from pathlib import Path
from manage import check_compose
ROOT=Path(__file__).resolve().parent
ENTRY=ROOT/'deploy/existing'
class EntryTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name)
  self.env=dict(os.environ,TIDEMIND_AGENT_ID='my-agent',TIDEMIND_SANDBOX_ROOT=str(self.root),TIDEMIND_LEASE_DB=str(self.root/'lease.db'),TIDEMIND_DB=str(self.root/'shadow.db'),TIDEMIND_LIVE_DB=str(self.root/'live.db'),TIDEMIND_REPORT=str(self.root/'report.json'))
 def tearDown(self):self.tmp.cleanup()
 def run_node(self,name,*args):
  r=subprocess.run(['node',str(ENTRY/name),*args],env=self.env,capture_output=True,text=True,encoding="utf-8",check=True)
  return json.loads(r.stdout.splitlines()[0])
 def fixture(self,path):
  c=sqlite3.connect(path)
  c.executescript('CREATE TABLE memories(id TEXT,layer TEXT,category TEXT,content TEXT,created_at INTEGER,updated_at INTEGER,valid_to INTEGER,status TEXT); CREATE VIRTUAL TABLE memories_fts USING fts5(content,tokenize="trigram");')
  for i,text in enumerate(['rice synthetic','服务器 synthetic','服务器 archived']):
   c.execute('INSERT INTO memories VALUES (?,?,?,?,?,?,?,?)',(str(i),'semantic','fact',text,1,1,None if i<2 else 1,'active'))
   c.execute('INSERT INTO memories_fts(rowid,content) VALUES (?,?)',(i+1,text))
  c.commit();c.close()
 def test_all_dry_runs_no_files_twice(self):
  for _ in range(2):
   for name in ['lease.mjs','reconcile.mjs','tidemind-api.mjs']:self.assertTrue(self.run_node(name,'--dry-run')['dryRun'])
  self.assertEqual(list(self.root.iterdir()),[])
 def test_original_lease_five_cases_and_release(self):
  a=self.run_node('lease.mjs','acquire','local','10000');self.assertTrue(a['ok'])
  self.assertFalse(self.run_node('lease.mjs','acquire','cloud')['ok'])
  self.assertFalse(self.run_node('lease.mjs','renew','impostor',str(a['term']))['ok'])
  self.assertTrue(self.run_node('lease.mjs','release','local',str(a['term']))['ok'])
  b=self.run_node('lease.mjs','acquire','cloud','1');time.sleep(.02)
  c=self.run_node('lease.mjs','acquire','local','10000');self.assertEqual(c['term'],b['term']+1)
  self.assertFalse(self.run_node('lease.mjs','renew','cloud',str(b['term']))['ok'])
  self.assertFalse(self.run_node('lease.mjs','release','cloud',str(b['term']))['ok'])
 def test_original_reconcile_repeat_readonly(self):
  import hashlib
  for key in ['TIDEMIND_DB','TIDEMIND_LIVE_DB']:self.fixture(self.env[key])
  paths=[Path(self.env[k]) for k in ['TIDEMIND_DB','TIDEMIND_LIVE_DB']]
  before=[hashlib.sha256(p.read_bytes()).hexdigest() for p in paths]
  for _ in range(2):
   report=self.run_node('reconcile.mjs');self.assertEqual(report,{'total':8,'pass':8,'fail':0})
  self.assertEqual(before,[hashlib.sha256(p.read_bytes()).hexdigest() for p in paths])
 def test_original_api_empty_error_history_isolation(self):
  self.fixture(self.env['TIDEMIND_DB'])
  with socket.socket() as s:s.bind(('127.0.0.1',0));port=s.getsockname()[1]
  self.env['TIDEMIND_PORT']=str(port)
  child=subprocess.Popen(['node',str(ENTRY/'tidemind-api.mjs')],env=self.env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
  def request(body):
   req=urllib.request.Request(f'http://127.0.0.1:{port}/retrieve',data=json.dumps(body).encode(),headers={'Content-Type':'application/json'})
   with urllib.request.urlopen(req,timeout=2) as r:return json.load(r)
  try:
   for _ in range(100):
    try:request({});break
    except OSError:time.sleep(.02)
   self.assertEqual(len(request({'agentId':'my-agent','query':'服务器'})['items']),1)
   self.assertEqual(request({'agentId':'other','query':'服务器'})['items'],[])
   self.assertEqual(request({'agentId':'my-agent','query':''})['items'],[])
   self.assertEqual(request({'agentId':'my-agent','query':'服务器','history':1})['items'],[])
   self.assertEqual(request(None)['items'],[])
   Path(self.env['TIDEMIND_DB']).rename(self.root/'away.db')
   self.assertEqual(request({'agentId':'my-agent','query':'服务器'})['items'],[])
  finally:child.terminate();child.wait(timeout=5)
 def test_compose_rejects_bind_mount(self):
  source=ROOT/'deploy/compose.yaml';self.assertIn('PASS',check_compose(source))
  doc=json.loads(source.read_text(encoding='utf-8-sig'))
  doc['services']['api']['volumes']=[{'type':'bind','source':'<MEMORY_LAYERS_DIR>','target':'/data'}]
  target=self.root/'bad.json';target.write_text(json.dumps(doc))
  with self.assertRaises(ValueError):check_compose(target)


class AuthorityProcessTests(unittest.TestCase):
 def test_real_process_restart_preserves_term_journal_and_dedup(self):
  import hashlib
  with tempfile.TemporaryDirectory() as directory:
   root=Path(directory)
   with socket.socket() as sock:sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
   env=dict(os.environ,TIDEMIND_ALLOW_LEGACY_SYNTHETIC='1',TIDEMIND_SANDBOX_ROOT=directory,TIDEMIND_LEASE_DB=str(root/'lease.db'),
       TIDEMIND_LOCAL_TOKEN='synthetic-local',TIDEMIND_CLOUD_TOKEN='synthetic-cloud',
       TIDEMIND_PROTECTED_IDS='["core-one"]',TIDEMIND_AUTHORITY_PORT=str(port),
       TIDEMIND_BASELINE_DATA_HASH=hashlib.sha256(b'synthetic-data').hexdigest(),
       TIDEMIND_BASELINE_PROTECTED_HASH=hashlib.sha256(b'synthetic-persona').hexdigest())
   def request(path,body,token='synthetic-local'):
    req=urllib.request.Request(f'http://127.0.0.1:{port}'+path,data=json.dumps(body).encode(),
      headers={'content-type':'application/json','authorization':'Bearer '+token})
    with urllib.request.urlopen(req,timeout=1) as response:return json.load(response)
   def start():
    process=subprocess.Popen(['node',str(ENTRY/'lease.mjs'),'serve'],env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    for _ in range(100):
     if process.poll() is not None:self.fail('authority exited before readiness')
     try:request('/head',{});return process
     except OSError:time.sleep(.02)
    process.terminate();process.wait(timeout=5);self.fail('authority readiness timeout')
   process=start()
   try:
    lease=request('/admin',{'command':'acquire','ttl':30000});term=lease['term']
    mutation={'id':'synthetic-one','fields':{'layer':'episodic','content':'synthetic memory','tags':'[]','created_at':1,'updated_at':1,'norm_hash':hashlib.sha256(b'synthetic memory').hexdigest()[:32]}}
    committed=request('/commit',{'term':term,'op':'persist','expectedRevision':0,'expectedHash':'GENESIS','mutation':mutation})
    event={'term':term,'channel':'qq-synthetic','eventId':'persist-event','payload':'synthetic reply'}
    queued=request('/enqueue',event)
   finally:process.terminate();process.wait(timeout=5)
   process=start()
   try:
    status=request('/admin',{'command':'status'});self.assertEqual(status['term'],term)
    self.assertEqual(request('/head',{})['hash'],committed['hash'])
    replay=request('/enqueue',event);self.assertTrue(replay['replayed']);self.assertEqual(replay['key'],queued['key'])
    self.assertEqual(len(request('/entries',{'after':0})['entries']),1)
    request('/admin',{'command':'release','term':term})
    cloud=request('/admin',{'command':'acquire'},'synthetic-cloud');self.assertEqual(cloud['term'],term+1)
   finally:process.terminate();process.wait(timeout=5)
