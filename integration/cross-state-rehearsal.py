"""Windows source -> cloud worker -> exact immutable return; synthetic four-adapter data only.
Preview: python cross-state-rehearsal.py --digest <sha> --key <path> --known-hosts <path> --dry-run
Rollback: same arguments --rollback (no selected generation; owned stdio children exit).
This is NOT cloud-new-write merge or production failover.
"""
import argparse,concurrent.futures,json,os,re,shlex,subprocess
from pathlib import Path
def state_line(text):
 for line in text.splitlines():
  if line.startswith('TIDEMIND_STATE '):return json.loads(line[len('TIDEMIND_STATE '):])
 raise ValueError('synthetic endpoint returned no result')
def run(args):
 if not re.fullmatch('[a-f0-9]{64}',args.digest):raise ValueError('candidate SHA256 required')
 plan={'dryRun':args.dry_run,'rollback':args.rollback,'productionEnabled':False,'syntheticOnly':True,'cloudNewWriteMerged':False,'hostChanged':False,'scope':'four real adapter formats, physical Windows/cloud forward and immutable return; no live home switch'}
 if args.dry_run or args.rollback:return plan|{'persistentServicesChanged':False,'rollbackAction':'owned stdio processes exit; no selected generation or production data to restore'}
 key=Path(args.key).resolve();known=Path(args.known_hosts).resolve()
 if not key.is_file() or not known.is_file():raise ValueError('existing SSH key path and pinned known-hosts required')
 options=['ssh','-i',str(key),'-o','BatchMode=yes','-o','IdentitiesOnly=yes','-o','StrictHostKeyChecking=yes','-o','UserKnownHostsFile='+str(known),'-o','ConnectTimeout=10','-o','ServerAliveInterval=5','-o','ServerAliveCountMax=2'];host='root@CLOUD_HOST_PLACEHOLDER'
 root=Path(__file__).resolve().parents[1];source=remote=None
 env={k:v for k,v in os.environ.items() if not k.startswith('TIDEMIND_')};env['TIDEMIND_FIXTURE_STORE']='isolated-pinned'
 try:
  source=subprocess.Popen([args.node,'integration/state-transfer-endpoint.mjs','source'],cwd=root,env=env,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,encoding='utf-8')
  def ready():
   for line in source.stdout:
    if line.startswith('TIDEMIND_STATE '):return state_line(line)
   raise ValueError('Windows synthetic source did not become ready')
  pool=concurrent.futures.ThreadPoolExecutor(max_workers=1);future=pool.submit(ready)
  try:info=future.result(timeout=20)
  finally:pool.shutdown(wait=False)
  allocation="python3 -c 'import socket,json;s=socket.socket();s.bind((\"127.0.0.1\",0));print(json.dumps({\"port\":s.getsockname()[1]}));s.close()'"
  allocated=subprocess.run(options+[host,allocation],capture_output=True,text=True,encoding='utf-8',timeout=20)
  if allocated.returncode:raise ValueError('remote loopback port allocation failed')
  port=json.loads(allocated.stdout)['port']
  if not isinstance(port,int) or not 1024<port<65536:raise ValueError('invalid private tunnel port')
  directory='/srv/tidemind-staging/candidates/'+args.digest+'/source';node='/srv/tidemind-staging/runtime/node-v24.17.0-linux-x64/node'
  command='cd '+shlex.quote(directory)+' && test ! -e ../DISABLED && '+shlex.quote(node)+' integration/state-transfer-endpoint.mjs receiver '+shlex.quote(f'http://127.0.0.1:{port}/')+(' --lose-receipt-response' if args.lose_receipt_response else '')
  remote=subprocess.Popen(options+['-o','ExitOnForwardFailure=yes','-R',f'127.0.0.1:{port}:127.0.0.1:{info["port"]}',host,command],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,encoding='utf-8')
  stdout,stderr=remote.communicate(json.dumps(info['capsule'])+'\n',timeout=45)
  if remote.returncode:raise ValueError('cloud worker failed: '+stderr[-1500:])
  received=state_line(stdout)
  if received.get('passed') is not True:raise ValueError('cloud worker not confirmed')
  stdout,stderr=source.communicate(json.dumps(received)+'\n',timeout=20)
  if source.returncode:raise ValueError('Windows return verification failed: '+stderr[-1500:])
  verified=state_line(stdout)
  if verified.get('passed') is not True:raise ValueError('return verification not confirmed')
  return plan|verified|{'cloudChecks':received['checks'],'cloudBaseUnchanged':received['baseUnchanged'],'newerCandidatePreserved':received['newerCandidatePreserved'],'receiptResponseLossInjected':received['receiptResponseLossInjected'],'transport':'SSH stdio data plus loopback reverse forwarding for original authority HTTP','privateDataTransferred':False}
 finally:
  for child in (remote,source):
   if child and child.poll() is None:
    try:
     if child.stdin:child.stdin.close()
    except OSError:pass
    try:child.wait(timeout=10)
    except subprocess.TimeoutExpired:child.terminate();child.wait(timeout=5)
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--digest',required=True);p.add_argument('--key',required=True);p.add_argument('--known-hosts',required=True);p.add_argument('--node',default='node');p.add_argument('--dry-run',action='store_true');p.add_argument('--rollback',action='store_true');p.add_argument('--lose-receipt-response',action='store_true')
 try:print(json.dumps(run(p.parse_args())))
 except Exception as e:raise SystemExit(type(e).__name__+': '+str(e))
