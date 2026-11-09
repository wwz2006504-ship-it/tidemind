"""One Windows authority, real cloud new writes, verified return and local continuation.
Preview: python continuous-roundtrip.py --digest <sha> --key <key-path> --known-hosts <file> --dry-run
Rollback: same args --rollback (no production runtime; EOF closes owned children).
"""
import argparse,concurrent.futures,json,os,re,shlex,subprocess
from pathlib import Path
def read_reply(child):
 for line in child.stdout:
  if line.startswith('TIDEMIND_ROUNDTRIP '):return json.loads(line[len('TIDEMIND_ROUNDTRIP '):])
 raise ValueError('synthetic endpoint exited before reply')
def bounded_reply(child,timeout=30):
 pool=concurrent.futures.ThreadPoolExecutor(max_workers=1);future=pool.submit(read_reply,child)
 try:return future.result(timeout=timeout)
 finally:pool.shutdown(wait=False)
def exchange(child,message):child.stdin.write(json.dumps(message)+'\n');child.stdin.flush();return bounded_reply(child)
def run(args):
 if not re.fullmatch('[a-f0-9]{64}',args.digest):raise ValueError('candidate digest required')
 plan={'dryRun':args.dry_run,'rollback':args.rollback,'syntheticOnly':True,'productionEnabled':False,'realQQ':False,'authorityCopies':1,'scope':'continuous synthetic four-store history and selected candidates; not production DSH or power-loss takeover'}
 if args.dry_run or args.rollback:return plan|{'rollbackAction':'EOF closes only this run owned processes; no production state restored'}
 key=Path(args.key).resolve();known=Path(args.known_hosts).resolve()
 if not key.is_file() or not known.is_file():raise ValueError('existing key path and pinned hosts required')
 options=['ssh','-i',str(key),'-o','BatchMode=yes','-o','IdentitiesOnly=yes','-o','StrictHostKeyChecking=yes','-o','UserKnownHostsFile='+str(known),'-o','ConnectTimeout=10','-o','ServerAliveInterval=5','-o','ServerAliveCountMax=2'];host='root@CLOUD_HOST_PLACEHOLDER';source=cloud=None
 env={k:v for k,v in os.environ.items() if not k.startswith('TIDEMIND_')};env['TIDEMIND_FIXTURE_STORE']='isolated-pinned'
 try:
  source=subprocess.Popen([args.node,'integration/roundtrip-endpoint.mjs','source'],cwd=Path(__file__).resolve().parents[1],env=env,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,encoding='utf-8')
  ready=bounded_reply(source)
  allocation="python3 -c 'import socket,json;s=socket.socket();s.bind((\"127.0.0.1\",0));print(json.dumps({\"port\":s.getsockname()[1]}));s.close()'"
  p=subprocess.run(options+[host,allocation],capture_output=True,text=True,encoding='utf-8',timeout=20)
  if p.returncode:raise ValueError('private port allocation failed')
  port=json.loads(p.stdout)['port']
  if not isinstance(port,int) or not 1024<port<65536:raise ValueError('invalid private port')
  directory='/srv/tidemind-staging/candidates/'+args.digest+'/source';node='/srv/tidemind-staging/runtime/node-v24.17.0-linux-x64/node'
  command='cd '+shlex.quote(directory)+' && test ! -e ../DISABLED && '+shlex.quote(node)+' integration/roundtrip-endpoint.mjs cloud '+shlex.quote(f'http://127.0.0.1:{port}/')
  cloud=subprocess.Popen(options+['-o','ExitOnForwardFailure=yes','-R',f'127.0.0.1:{port}:127.0.0.1:{ready["port"]}',host,command],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,encoding='utf-8')
  forward=exchange(cloud,{'command':'forward','capsule':ready['capsule']})
  released=exchange(source,{'command':'release-forward','received':forward})
  if released.get('released') is not True:raise ValueError('source not released')
  reverse=exchange(cloud,{'command':'advance','loseSigningResponse':args.inject_lost_responses})
  received=exchange(source,{'command':'receive-return','payload':reverse,'loseReceiptResponse':args.inject_lost_responses})
  release=exchange(cloud,{'command':'finish','received':received,'loseHandoverResponse':args.inject_lost_responses})
  if release.get('released') is not True:raise ValueError('cloud not released')
  final=exchange(source,{'command':'activate'})
  cloud.stdin.write(json.dumps({'command':'stop'})+'\n');cloud.stdin.flush()
  for child in (source,cloud):
   child.stdin.close();child.wait(timeout=15)
   if child.returncode:raise ValueError('synthetic cleanup failed: '+child.stderr.read()[-1500:])
  return plan|final|{'sourceWritesBlocked':reverse['sourceWritesBlocked'],'returnReceiptSubmissions':received['receiptSubmissions'],'wrongAckRejected':release['wrongAckRejected'],'oldCloudWriteRejected':release['oldCloudWriteRejected'],'signingReplayVerified':reverse['signingReplayVerified'],'handoverRecoveredByStatus':release['handoverResponseRecoveredByStatus'],'receiptResponseLossInjected':received['responseLossInjected'],'privateDataTransferred':False}
 finally:
  for child in (cloud,source):
   if child and child.poll() is None:
    try:
     if child.stdin:child.stdin.close()
    except OSError:pass
    try:child.wait(timeout=10)
    except subprocess.TimeoutExpired:child.terminate();child.wait(timeout=5)
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--digest',required=True);p.add_argument('--key',required=True);p.add_argument('--known-hosts',required=True);p.add_argument('--node',default='node');p.add_argument('--dry-run',action='store_true');p.add_argument('--rollback',action='store_true');p.add_argument('--inject-lost-responses',action='store_true')
 try:print(json.dumps(run(p.parse_args())))
 except Exception as e:raise SystemExit(type(e).__name__+': '+str(e))
