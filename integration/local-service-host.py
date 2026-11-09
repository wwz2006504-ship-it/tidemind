"""Private local service supervisor. Existing lease/API entry files are the only business entrypoints."""
import argparse,json,os,subprocess,sys
from pathlib import Path
from multiprocessing.connection import Listener

def main():
 p=argparse.ArgumentParser();p.add_argument('--root');p.add_argument('--dry-run',action='store_true');a=p.parse_args()
 if a.dry_run:print('{"dryRun":true,"localOnly":true}');return
 root=Path(a.root).resolve();cfg=json.loads((root/'runtime/service-config.json').read_text(encoding='utf-8'));state=json.loads((root/'install.json').read_text(encoding='utf-8'))
 if cfg['owner']!=state['owner'] or state['mode']!='installed-not-activated':raise SystemExit('owned inactive installation required')
 release=(root/'releases'/state['release']).resolve()
 if not release.is_relative_to(root/'releases'):raise SystemExit('invalid release')
 env={k:v for k,v in os.environ.items() if k.upper() in ['PATH','SYSTEMROOT','WINDIR','TEMP','TMP','USERPROFILE','HOMEDRIVE','HOMEPATH','LOCALAPPDATA','SYSTEMDRIVE']}
 env.update(cfg['env']);env['TIDEMIND_AUTHORITY_STANDBY']='1';env['TIDEMIND_ALLOW_LEGACY_SYNTHETIC']='0'
 children=[];streams=[]
 try:
  with Listener(cfg['pipe'],family='AF_PIPE',authkey=bytes.fromhex(cfg['controlKey'])) as server:
   for label,entry,args in [('authority','lease.mjs',['serve']),('retrieve','tidemind-api.mjs',[])]:
    log=open(root/'runtime'/f'{label}.log','ab',buffering=0);streams.append(log)
    children.append(subprocess.Popen([cfg['node'],str(release/'TideMind/deploy/existing'/entry),*args],env=env,stdin=subprocess.DEVNULL,stdout=log,stderr=log,creationflags=subprocess.CREATE_NO_WINDOW))
   while True:
    try:connection=server.accept()
    except Exception:continue
    with connection:
     request=connection.recv()
     if request=='status':connection.send({'running':all(c.poll() is None for c in children),'children':len(children),'activation':'blocked','mode':state['mode']})
     elif request=='stop':connection.send({'stopping':True});break
     else:connection.send({'error':'unsupported'})
 finally:
  for child in children:
   if child.poll() is None:
    child.terminate()
    try:child.wait(timeout=5)
    except subprocess.TimeoutExpired:child.kill();child.wait(timeout=5)
  for stream in streams:stream.close()
if __name__=='__main__':main()
