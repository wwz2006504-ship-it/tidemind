"""Fixed Linux authority survives Windows real-plugin clients and its own process restart.
No systemd installation: owned SSH stdio starts/stops ORIGINAL lease.mjs serve only.
Preview: python fixed-authority-rehearsal.py --digest <sha> --key <path> --known-hosts <path> --dry-run
Rollback: same args --rollback (no persistent service; keep the synthetic authority DB).
"""
import argparse,concurrent.futures,json,os,re,shlex,socket,subprocess
from pathlib import Path
LAB='/srv/tidemind-staging/authority-lab'
def run(args):
 if not re.fullmatch('[a-f0-9]{64}',args.digest):raise ValueError('candidate digest required')
 plan={'dryRun':args.dry_run,'rollback':args.rollback,'productionEnabled':False,'realQQ':False,'syntheticOnly':True,'fixedAuthority':'Linux','systemdChanged':False}
 if args.dry_run or args.rollback:return plan|{'rollbackAction':'stdin EOF stops only the owned test process; retain lab authority DB and environment'}
 key=Path(args.key).resolve();known=Path(args.known_hosts).resolve()
 if not key.is_file() or not known.is_file():raise ValueError('existing SSH key and pinned host file required')
 options=['ssh','-i',str(key),'-o','BatchMode=yes','-o','IdentitiesOnly=yes','-o','StrictHostKeyChecking=yes','-o','UserKnownHostsFile='+str(known),'-o','ConnectTimeout=10','-o','ServerAliveInterval=5','-o','ServerAliveCountMax=2'];host='root@CLOUD_HOST_PLACEHOLDER';source='/srv/tidemind-staging/candidates/'+args.digest+'/source'
 with socket.socket() as sock:sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
 code="""import sys,subprocess,json,os,hashlib
from pathlib import Path
lab=Path('/srv/tidemind-staging/authority-lab');source=Path(SOURCE_PLACEHOLDER)
assert (lab/'OWNER').read_text()=='TideMind isolated authority lab v1'
meta=json.loads((lab/'lab-config.json').read_text());assert Path(meta['source'])==source
assert hashlib.sha256((lab/'authority.env').read_bytes()).hexdigest()==meta['environmentSha256']
assert not (source.parent/'DISABLED').exists()
node='/srv/tidemind-staging/runtime/node-v24.17.0-linux-x64/node'
env={k:v for k,v in os.environ.items() if not k.startswith('TIDEMIND_')}
p=None
def stop():
 global p
 if p is not None:
  p.terminate()
  try:p.wait(timeout=10)
  except subprocess.TimeoutExpired:p.kill();p.wait(timeout=5)
  p=None
def start():
 global p
 p=subprocess.Popen([node,'--env-file='+str(lab/'authority.env'),str(source/'TideMind/deploy/existing/lease.mjs'),'serve'],cwd=source,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
 if 'lease authority ready' not in p.stdout.readline():raise RuntimeError('owned authority failed to listen')
 print('TIDEMIND_LAB_READY '+json.dumps({'ready':True,'port':5191}),flush=True)
try:
 start()
 for line in sys.stdin:
  request=json.loads(line)
  if request['command']=='restart':stop();start()
  elif request['command']=='stop':break
  else:raise ValueError('unknown lab control')
finally:stop()
""".replace('SOURCE_PLACEHOLDER',repr(source))
 server=None
 def ready():
  for line in server.stdout:
   if line.startswith('TIDEMIND_LAB_READY '):return json.loads(line[len('TIDEMIND_LAB_READY '):])
  raise ValueError('cloud lab authority did not start')
 def wait_ready():
  pool=concurrent.futures.ThreadPoolExecutor(max_workers=1);f=pool.submit(ready)
  try:return f.result(timeout=20)
  finally:pool.shutdown(wait=False)
 try:
  server=subprocess.Popen(options+['-o','ExitOnForwardFailure=yes','-L',f'127.0.0.1:{port}:127.0.0.1:5191',host,'python3 -c '+shlex.quote(code)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,encoding='utf-8');wait_ready()
  export="""from pathlib import Path
import json,shlex,hashlib,base64
lab=Path('/srv/tidemind-staging/authority-lab');assert (lab/'OWNER').read_text()=='TideMind isolated authority lab v1'
meta=json.loads((lab/'lab-config.json').read_text());raw=(lab/'authority.env').read_bytes();assert hashlib.sha256(raw).hexdigest()==meta['environmentSha256']
env={}
for line in raw.decode().splitlines():
 k,v=line.split('=',1);env[k]=shlex.split(v)[0]
spec=json.loads((lab/'state-spec.json').read_text());originals=Path(spec['sourceDataRoot'])
print(json.dumps({'tag':'TideMind isolated authority lab v1','baseline':meta['baseline'],'baselineFile':base64.b64encode((lab/'baseline/memory.db').read_bytes()).decode(),'localToken':env['TIDEMIND_LOCAL_TOKEN'],'storeSigningKey':env['TIDEMIND_STORE_SIGNING_KEY'],'sidecarOriginals':{'persona':(originals/'personas/synthetic.md').read_text(),'json':(originals/'memories.json').read_text(),'ai':Path(spec['aiSource']).read_text()}}))
"""
  p=subprocess.run(options+[host,'python3 -c '+shlex.quote(export)],capture_output=True,text=True,encoding='utf-8',timeout=20)
  if p.returncode:raise ValueError('lab capsule export failed')
  capsule=json.loads(p.stdout);capsule['authorityUrl']=f'http://127.0.0.1:{port}/'
  env={k:v for k,v in os.environ.items() if not k.startswith('TIDEMIND_')};results=[]
  def probe(variant,replay=False):
   request=capsule|{'variant':variant,'replay':replay}
   p=subprocess.run([args.node,'integration/remote-plugin-probe.mjs'],cwd=Path(__file__).resolve().parents[1],env=env,input=json.dumps(request)+'\n',capture_output=True,text=True,encoding='utf-8',timeout=45)
   if p.returncode:raise ValueError('real original-plugin probe failed: '+p.stderr[-2000:])
   result=json.loads(p.stdout.strip().splitlines()[-1]);assert result['passed'] and not result['localAuthorityDatabaseCreated'];results.append(result);return result
  first=probe('first')
  # No Windows runtime stays alive here; canonical journal remains in the cloud.
  server.stdin.write(json.dumps({'command':'restart'})+'\n');server.stdin.flush();wait_ready()
  replay=probe('first',True);assert replay['headBefore']==first['headAfter'] and replay['headAfter']==first['headAfter'] and replay['remoteCommitAttempts']==0 and replay['sidecarCommitAttempts']==0
  second=probe('second');assert second['headBefore']==replay['headAfter'] and second['headAfter']>=second['headBefore']
  server.stdin.write(json.dumps({'command':'stop'})+'\n');server.stdin.flush();server.stdin.close();server.wait(timeout=15)
  if server.returncode:raise ValueError('owned authority cleanup failed')
  return plan|{'passed':True,'cloudProcessRestartPassed':True,'clientExitPreservesHistory':True,'replayDidNotResubmit':True,'originalMemoryToolsVerified':True,'probes':results,'privateCredentialsPrinted':False}
 finally:
  if server and server.poll() is None:
   try:server.stdin.close()
   except OSError:pass
   try:server.wait(timeout=10)
   except subprocess.TimeoutExpired:server.terminate();server.wait(timeout=5)
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--digest',required=True);p.add_argument('--key',required=True);p.add_argument('--known-hosts',required=True);p.add_argument('--node',default='node');p.add_argument('--dry-run',action='store_true');p.add_argument('--rollback',action='store_true')
 try:print(json.dumps(run(p.parse_args())))
 except Exception as e:raise SystemExit(type(e).__name__+': '+str(e))
