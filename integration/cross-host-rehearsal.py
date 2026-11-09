"""Windows -> private SSH tunnel -> original cloud authority, synthetic only.
Preview: python cross-host-rehearsal.py --key <path> --known-hosts <path> --digest <sha> --dry-run
Rollback: same arguments --rollback (no persistent services; child stdin closes on exit).
"""
import argparse,concurrent.futures,json,re,shlex,socket,subprocess,time
from pathlib import Path
HOST='root@CLOUD_HOST_PLACEHOLDER'
def run(args):
 if not re.fullmatch('[a-f0-9]{64}',args.digest):raise ValueError('candidate digest required')
 plan={'dryRun':args.dry_run,'rollback':args.rollback,'productionEnabled':False,'realQQ':False,'syntheticOnly':True,'scope':'Windows client to Linux original authority over private SSH; not memory/QQ home cutover'}
 if args.dry_run or args.rollback:return plan|{'persistentServicesChanged':False,'rollbackAction':'normal exit closes both owned SSH stdin pipes; no production state to restore'}
 key=Path(args.key).resolve();known=Path(args.known_hosts).resolve()
 if not key.is_file() or not known.is_file():raise ValueError('key path and pinned hosts required')
 options=['ssh','-i',str(key),'-o','BatchMode=yes','-o','IdentitiesOnly=yes','-o','StrictHostKeyChecking=yes','-o','UserKnownHostsFile='+str(known),'-o','ConnectTimeout=10','-o','ServerAliveInterval=5','-o','ServerAliveCountMax=2']
 directory='/srv/tidemind-staging/candidates/'+args.digest+'/source'
 code="""import {authorityHttpFixture} from './integration/authority-http-fixture.mjs';import {prepareStoreOperation} from './integration/store-adapter.mjs';
const f=await authorityHttpFixture();let stopping=false;
const stop=async()=>{if(stopping)return;stopping=true;await f.cleanup()};
process.stdin.resume();process.stdin.on('end',()=>stop().catch(()=>{process.exitCode=1}));
process.on('SIGTERM',()=>stop().catch(()=>{process.exitCode=1}));
const head=f.gateway.head(f.lease),op='stale-cross-host';
const prepared=await prepareStoreOperation(f.localDir+'/memory.db',{method:'write',args:[{layer:'semantic',content:'SYNTHETIC CROSS HOST WRITE',source:'tool'}],now:2},{MemoryStore:f.MemoryStore,commitContext:{op,holder:'local',term:f.term,revision:head.revision,hash:head.hash}});
f.gateway.validateMutation(prepared.batch);
console.log('TIDEMIND_READY '+JSON.stringify({port:Number(new URL(f.url).port),term:f.term,commit:{op,term:f.term,expectedRevision:head.revision,expectedHash:head.hash,mutation:prepared.batch}}));
"""
 node='/srv/tidemind-staging/runtime/node-v24.17.0-linux-x64/node'
 remote='cd '+shlex.quote(directory)+' && test ! -e ../DISABLED && TIDEMIND_FIXTURE_STORE=isolated-pinned '+shlex.quote(node)+' --input-type=module -e '+shlex.quote(code)
 server=tunnel=None
 try:
  server=subprocess.Popen(options+[HOST,remote],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,encoding='utf-8')
  def ready():
   for line in server.stdout:
    if line.startswith('TIDEMIND_READY '):return json.loads(line[len('TIDEMIND_READY '):])
   raise ValueError('cloud authority did not become ready')
  executor=concurrent.futures.ThreadPoolExecutor(max_workers=1);future=executor.submit(ready)
  try:info=future.result(timeout=20)
  finally:executor.shutdown(wait=False)
  with socket.socket() as sock:sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
  idle="python3 -c 'import sys;sys.stdin.buffer.read()'"
  tunnel=subprocess.Popen(options+['-o','ExitOnForwardFailure=yes','-L',f'127.0.0.1:{port}:127.0.0.1:{info["port"]}',HOST,idle],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
  end=time.monotonic()+15
  while True:
   if tunnel.poll() is not None:raise ValueError('private tunnel failed')
   try:
    with socket.create_connection(('127.0.0.1',port),timeout=.5):break
   except OSError:
    if time.monotonic()>end:raise ValueError('private tunnel timed out')
    time.sleep(.05)
  client="""import assert from 'node:assert/strict';import {createAuthorityClient} from './integration/authority-client.mjs';
const url=process.argv[1],term=Number(process.argv[2]),commit=JSON.parse(process.argv[3]),make=token=>createAuthorityClient({url,token});
const local=make('SYNTHETIC_LOCAL_TOKEN_123456789'),cloud=make('SYNTHETIC_CLOUD_TOKEN_987654321');let checks=0;
assert.equal((await local.request('/admin',{command:'status'})).term,term);checks++;
assert.equal((await cloud.request('/admin',{command:'acquire'})).ok,false);checks++;
assert.equal((await local.request('/admin',{command:'renew',term:term+100})).ok,false);checks++;
await assert.rejects(make('SYNTHETIC_INVALID_TOKEN_12345').request('/head',{}),e=>e.status===401);checks++;
assert.equal((await local.request('/admin',{command:'release',term})).ok,true);
const next=await cloud.request('/admin',{command:'acquire'});assert.equal(next.ok,true);assert.ok(next.term>term);checks++;
assert.equal((await local.request('/admin',{command:'renew',term})).ok,false);checks++;
await assert.rejects(local.request('/commit',commit),e=>e.status===409);checks++;
assert.equal((await cloud.request('/head',{})).revision,0);checks++;
assert.equal((await cloud.request('/admin',{command:'release',term:next.term})).ok,true);
const back=await local.request('/admin',{command:'acquire'});assert.equal(back.ok,true);assert.ok(back.term>next.term);checks++;
console.log(JSON.stringify({passed:true,checks,initialTerm:term,cloudTerm:next.term,returnTerm:back.term,revision:0,realQQ:false}));
"""
  localNode=args.node
  test=subprocess.run([localNode,'--input-type=module','-e',client,f'http://127.0.0.1:{port}/',str(info['term']),json.dumps(info['commit'])],cwd=Path(__file__).resolve().parents[1],capture_output=True,text=True,encoding='utf-8',timeout=30)
  if test.returncode:raise ValueError('cross-host checks failed: '+test.stderr[-2000:])
  return plan|json.loads(test.stdout)
 finally:
  for child in (tunnel,server):
   if child:
    if child.stdin:child.stdin.close()
    try:child.wait(timeout=10)
    except subprocess.TimeoutExpired:child.terminate();child.wait(timeout=5)
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--digest',required=True);p.add_argument('--key',required=True);p.add_argument('--known-hosts',required=True);p.add_argument('--node',default='node');p.add_argument('--dry-run',action='store_true');p.add_argument('--rollback',action='store_true')
 try:print(json.dumps(run(p.parse_args())))
 except Exception as e:raise SystemExit(type(e).__name__+': '+str(e))
