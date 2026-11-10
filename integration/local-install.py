"""Local installation manager. Original production memory/profile/QQ credentials are never written.
Failure rollback: python integration/local-install.py rollback --root <owned-install-root>
"""
import argparse,csv,hashlib,io,json,os,re,secrets,shutil,socket,subprocess,sys,time,urllib.request,urllib.error,uuid
from pathlib import Path
from multiprocessing.connection import Client
PACKAGE=Path(__file__).resolve().parents[1]
BASE=Path(os.environ.get('TIDEMIND_DESKTOP_ROOT') or (Path.home()/'Documents'/'Codex')).resolve()
DEFAULT=BASE/'TideMind-local'

def load(p):return json.loads(p.read_text(encoding='utf-8-sig'))
def save(p,obj):
 p.parent.mkdir(parents=True,exist_ok=True);tmp=p.with_suffix(p.suffix+'.tmp');tmp.write_text(json.dumps(obj,ensure_ascii=False,indent=2),encoding='utf-8');os.replace(tmp,p)
def checked(root):
 root=Path(root).resolve()
 if root==BASE or not root.is_relative_to(BASE):raise ValueError('installation must be a NEW child of Codex workspace')
 if root==PACKAGE:raise ValueError('cannot install over source/workspace')
 if PACKAGE.is_relative_to(root):
  if PACKAGE.parent.name!='releases' or PACKAGE.parent.parent!=root or not (root/'install.json').exists() or load(root/'install.json')['release']!=PACKAGE.name:raise ValueError('cannot install over source/workspace')
 return root
def rpc(root,command):
 cfg=load(root/'runtime/service-config.json')
 with Client(cfg['pipe'],family='AF_PIPE',authkey=bytes.fromhex(cfg['controlKey'])) as c:c.send(command);return c.recv()
def restrict(root):
 result=subprocess.run(['whoami','/user','/fo','csv','/nh'],capture_output=True,text=True,check=True)
 sid=next(csv.reader(io.StringIO(result.stdout)))[1]
 if not re.fullmatch(r'S-\d+(?:-\d+)+',sid):raise ValueError('cannot resolve current account SID')
 subprocess.run(['icacls',str(root),'/inheritance:r','/grant:r',f'*{sid}:(OI)(CI)F','*S-1-5-18:(OI)(CI)F'],check=True,stdout=subprocess.DEVNULL)
def files():
 for p in sorted(PACKAGE.rglob('*')):
  if not p.is_file():continue
  rel=p.relative_to(PACKAGE)
  if any(part in ['data','reports','__pycache__','.git','node_modules'] for part in rel.parts) or p.name in ['inspect-host.mjs','INSTALL-FILES-SHA256.json'] or (p.name.startswith('.env') and p.name!='.env.example') or p.name.endswith(('.db','.db-wal','.db-shm','.pyc')):continue
  yield p,rel

def write_launcher(root):
 (root/'manage.py').write_text("""# Local installation manager; forwards to the recorded immutable release.
import json,re,runpy,sys
from pathlib import Path
root=Path(__file__).resolve().parent
state=json.loads((root/'install.json').read_text(encoding='utf-8'))
release=state['release']
if not re.fullmatch(r'[a-f0-9]{16}',release):raise SystemExit('invalid installed release')
entry=(root/'releases'/release/'integration/local-install.py').resolve()
if not entry.is_relative_to(root/'releases'):raise SystemExit('invalid entry path')
sys.argv=[str(entry),*sys.argv[1:],'--root',str(root)]
runpy.run_path(str(entry),run_name='__main__')
""",encoding='utf-8')

def stage_release(root, *, launcher=True):
 if launcher:write_launcher(root)
 selected=list(files());digests={r.as_posix():hashlib.sha256(p.read_bytes()).hexdigest() for p,r in selected};release=hashlib.sha256(json.dumps(digests,sort_keys=True).encode()).hexdigest()[:16];dest=root/'releases'/release
 for p,rel in selected:
  target=dest/rel;target.parent.mkdir(parents=True,exist_ok=True)
  if target.exists():
   if hashlib.sha256(target.read_bytes()).hexdigest()!=digests[rel.as_posix()]:raise ValueError('installed release changed')
  else:shutil.copyfile(p,target)
 save(dest/'INSTALL-FILES-SHA256.json',digests)
 return release,dest

def prepare(root,source,node,ports):
 pre=subprocess.run([sys.executable,str(PACKAGE/'integration/acceptance.py'),'--dry-run'],capture_output=True,text=True,encoding='utf-8')
 if pre.returncode:raise ValueError('installed source fingerprints changed; integration must be reviewed')
 if (root/'install.json').exists():
  state=load(root/'install.json')
  if state.get('mode')!='installed-not-activated':raise ValueError('unexpected installation state')
  return {'installed':True,'replayed':True,'root':str(root),'mode':state['mode']}
 if root.exists() and any(root.iterdir()) and not (root/'owner.json').exists():raise ValueError('nonempty unowned target prohibited')
 root.mkdir(parents=True,exist_ok=True);(root/'.gitignore').write_text('runtime/\n',encoding='utf-8')
 owner=load(root/'owner.json')['owner'] if (root/'owner.json').exists() else str(uuid.uuid4());save(root/'owner.json',{'owner':owner})
 runtime=root/'runtime';runtime.mkdir(exist_ok=True);restrict(runtime)
 release,dest=stage_release(root)
 env=dict(os.environ,TIDEMIND_SANDBOX_ROOT=str(runtime),TIDEMIND_LEASE_DB=str(runtime/'lease.db'))
 result=subprocess.run([node,str(dest/'integration/install-db.mjs'),str(source),str(runtime)],env=env,capture_output=True,text=True,encoding='utf-8')
 if result.returncode:raise ValueError('copy/baseline preparation failed; existing install-owned files were preserved')
 db=json.loads(result.stdout.strip().splitlines()[-1]);baseline=db['baseline']
 cfg={'owner':owner,'node':node,'pipe':r'\\.\pipe\TideMind-'+owner,'controlKey':secrets.token_hex(32),'env':{
  'TIDEMIND_SANDBOX_ROOT':str(runtime),'TIDEMIND_LEASE_DB':str(runtime/'lease.db'),'TIDEMIND_DB':db['local'],
  'TIDEMIND_AUTHORITY_PORT':str(ports[0]),'TIDEMIND_PORT':str(ports[1]),'TIDEMIND_LOCAL_TOKEN':secrets.token_hex(32),'TIDEMIND_CLOUD_TOKEN':secrets.token_hex(32),
  'TIDEMIND_STORE_SIGNING_KEY':secrets.token_hex(32),'TIDEMIND_REQUIRE_STORE_PROOF':'1','TIDEMIND_REQUIRE_QQ_BINDING':'1','TIDEMIND_ALLOW_LEGACY_SYNTHETIC':'0','TIDEMIND_AUTHORITY_STANDBY':'1',
  'TIDEMIND_PROTECTED_IDS':json.dumps(db['protectedIds']),'TIDEMIND_BASELINE_DATA_HASH':baseline['data_hash'],'TIDEMIND_BASELINE_PROTECTED_HASH':baseline['protected_hash']}}
 save(runtime/'service-config.json',cfg)
 state={'owner':owner,'release':release,'mode':'installed-not-activated','root':str(root),'source':str(source),'counts':db['counts'],'ports':{'authority':ports[0],'retrieve':ports[1]},'originalEntries':'versioned upgrades of existing lease/reconcile/tidemind-api','liveProfileChanged':False}
 save(root/'install.json',state)
 return {'installed':True,'root':str(root),'release':release,'counts':db['counts'],'mode':state['mode']}

def refresh(root):
 state=load(root/'install.json')
 if state['mode']!='installed-not-activated':raise ValueError('refresh requires inactive installation')
 try:
  rpc(root,'status');raise ValueError('stop owned services before changing release')
 except (FileNotFoundError,ConnectionRefusedError,OSError):pass
 release,dest=stage_release(root)
 if release==state['release']:return {'refreshed':True,'replayed':True,'release':release}
 state['previousRelease']=state['release'];state['release']=release;save(root/'install.json',state)
 return {'refreshed':True,'release':release,'dataPreserved':True,'mode':state['mode']}

def health(root):
 state=load(root/'install.json');out={'installed':True,'mode':state['mode'],'liveProfileChanged':False}
 try:out.update(rpc(root,'status'))
 except Exception:out['running']=False
 try:
  with urllib.request.urlopen('http://127.0.0.1:'+str(state['ports']['retrieve'])+'/health',timeout=2) as r:out['retrieveHealthy']=json.load(r).get('ok',False)
 except Exception:out['retrieveHealthy']=False
 return out

def start(root):
 try:
  if rpc(root,'status').get('running'):return health(root)|{'replayed':True}
  raise ValueError('owned supervisor is unhealthy; stop it before restarting')
 except (FileNotFoundError,ConnectionRefusedError,OSError):pass
 state=load(root/'install.json')
 for port in state['ports'].values():
  with socket.socket() as s:s.bind(('127.0.0.1',port))
 host=root/'releases'/state['release']/'integration/local-service-host.py'
 subprocess.Popen([sys.executable,str(host),'--root',str(root)],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,creationflags=subprocess.CREATE_NO_WINDOW|subprocess.DETACHED_PROCESS,close_fds=True)
 for _ in range(60):
  time.sleep(.1);status=health(root)
  if status.get('running') and status.get('retrieveHealthy'):return status
 raise ValueError('local components did not become healthy; use stop and inspect private runtime logs')

def ports_closed(root):
 for port in load(root/'install.json')['ports'].values():
  with socket.socket() as probe:
   probe.settimeout(.2)
   if probe.connect_ex(('127.0.0.1',port))==0:return False
 return True

def stop(root):
 try:rpc(root,'stop')
 except (FileNotFoundError,ConnectionRefusedError,OSError):
  return {'stopped':ports_closed(root),'replayed':True,'dataPreserved':True,'note':'ports must be closed; unrelated processes are never killed'}
 for _ in range(50):
  time.sleep(.1)
  try:rpc(root,'status')
  except (FileNotFoundError,ConnectionRefusedError,OSError):
   if ports_closed(root):return {'stopped':True,'dataPreserved':True,'liveProfileChanged':False}
 return {'stopped':False,'dataPreserved':True,'note':'control/ports have not fully stopped; manual review required'}

def reconcile(root):
 state=load(root/'install.json');report=root/'runtime/reconcile-current.json';release=root/'releases'/state['release']
 pending=report.with_name('reconcile-'+uuid.uuid4().hex+'.json')
 env=dict(os.environ,TIDEMIND_LIVE_DB=state['source'],TIDEMIND_DB=str(root/'runtime/memory/memory.db'),TIDEMIND_REPORT=str(pending))
 try:
  result=subprocess.run([load(root/'runtime/service-config.json')['node'],str(release/'TideMind/deploy/existing/reconcile.mjs')],env=env,capture_output=True,text=True,encoding='utf-8')
  if not pending.is_file():raise ValueError('reconcile did not produce a fresh report')
  summary=load(pending)['summary']
  os.replace(pending,report)
  return {'summary':summary,'exitCode':result.returncode,'report':str(report),'bothDatabasesReadOnly':True}
 finally:
  pending.unlink(missing_ok=True)

def main():
 p=argparse.ArgumentParser();p.add_argument('action',choices=['prepare','start','status','stop','reconcile','refresh','rollback']);p.add_argument('--root',default=str(DEFAULT));p.add_argument('--source-db',default='<MEMORY_LAYERS_DIR>/memory.db');p.add_argument('--authority-port',type=int,default=5181);p.add_argument('--retrieve-port',type=int,default=5180);p.add_argument('--dry-run',action='store_true');a=p.parse_args();root=checked(a.root)
 if a.dry_run:print(json.dumps({'dryRun':True,'action':a.action,'root':str(root),'profileSwitch':False,'sourceWrite':False}));return
 if a.action=='prepare':out=prepare(root,Path(a.source_db).resolve(),shutil.which('node'),[a.authority_port,a.retrieve_port])
 elif a.action=='refresh':out=refresh(root)
 elif a.action=='start':out=start(root)
 elif a.action=='status':out=health(root)
 elif a.action in ['stop','rollback']:out=stop(root)
 else:out=reconcile(root)
 print(json.dumps(out,ensure_ascii=False))
 if out.get('stopped') is False or out.get('exitCode',0)!=0:raise SystemExit(1)
if __name__=='__main__':main()
