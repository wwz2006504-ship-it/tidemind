"""Upload a verified candidate archive only; never install or start a service.
Rollback: python integration/cloud-stage.py --archive <zip> --key <key-path> --known-hosts <file> --rollback
"""
import argparse,hashlib,json,shlex,subprocess,zipfile
from pathlib import Path
HOST='root@CLOUD_HOST_PLACEHOLDER'
REMOTE='/srv/tidemind-staging'
def verify(path):
 with zipfile.ZipFile(path) as z:
  prefix='existing-upgrade-integration/'
  names=z.namelist()
  if len(names)!=len(set(names)) or any(not n.startswith(prefix) or '..' in n.split('/') or '\\' in n for n in names):raise ValueError('invalid archive paths')
  manifest=json.loads(z.read(prefix+'MANIFEST-SHA256.json'))
  if set(names)!={prefix+n for n in manifest}|{prefix+'MANIFEST-SHA256.json'}:raise ValueError('unmanifested archive file')
  for name,digest in manifest.items():
   if hashlib.sha256(z.read(prefix+name)).hexdigest()!=digest:raise ValueError('archive manifest mismatch')
 return hashlib.sha256(path.read_bytes()).hexdigest()
def run(args):
 archive=Path(args.archive).resolve();digest=verify(archive)
 key=Path(args.key).resolve();known=Path(args.known_hosts).resolve()
 if not key.is_file() or not known.is_file():raise ValueError('existing SSH key and pinned known-hosts file required')
 result={'candidateSha256':digest,'remote':REMOTE+'/'+digest+'.zip','dryRun':args.dry_run,'rollback':args.rollback,'servicesChanged':False,'productionEnabled':False}
 if args.dry_run:return result
 options=['-i',str(key),'-o','BatchMode=yes','-o','IdentitiesOnly=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=10','-o','UserKnownHostsFile='+str(known)]
 def ssh(code):
  proc=subprocess.run(['ssh',*options,HOST,'python3 -c '+shlex.quote(code)],capture_output=True,text=True,timeout=45)
  if proc.returncode:raise RuntimeError('remote staging operation failed; no services started')
  return json.loads(proc.stdout)
 setup="""from pathlib import Path
import json
p=Path('/srv/tidemind-staging');assert not p.is_symlink()
m=p/'OWNER';tag='TideMind candidate staging v1'
if p.exists():assert m.is_file() and not m.is_symlink() and m.read_text()==tag
else:
 p.mkdir(mode=0o700);m.write_text(tag);m.chmod(0o600)
print(json.dumps({'owned':True}))
"""
 ssh(setup)
 target=result['remote'];part=target+'.part'
 if args.rollback:
  ssh("from pathlib import Path;import json;p=Path("+repr(target)+");assert not p.is_symlink();q=Path(str(p)+'.disabled');assert not q.is_symlink();q.write_text('inactive candidate; archive retained');print(json.dumps({'disabled':True}))")
  return result|{'dataPreserved':True}
 pre=ssh("from pathlib import Path;import json,hashlib;p=Path("+repr(target)+");assert not p.is_symlink();print(json.dumps({'exists':p.exists(),'same':p.is_file() and hashlib.sha256(p.read_bytes()).hexdigest()=="+repr(digest)+"}))")
 if pre['exists'] and not pre['same']:raise ValueError('remote candidate differs; refusing overwrite')
 if pre['same']:return result|{'replayed':True,'remoteHashVerified':True}
 ssh("from pathlib import Path;import json;p=Path("+repr(part)+");assert not p.is_symlink();print(json.dumps({'safe':True}))")
 proc=subprocess.run(['scp',*options,str(archive),HOST+':'+part],capture_output=True,text=True,timeout=90)
 if proc.returncode:raise RuntimeError('candidate upload failed; partial archive remains inactive')
 ssh("from pathlib import Path;import hashlib,json,os;p=Path("+repr(part)+");q=Path("+repr(target)+");assert not p.is_symlink() and not q.is_symlink();assert hashlib.sha256(p.read_bytes()).hexdigest()=="+repr(digest)+";p.chmod(0o600);os.replace(p,q);print(json.dumps({'verified':True}))")
 return result|{'replayed':False,'remoteHashVerified':True}
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--archive',required=True);p.add_argument('--key',required=True);p.add_argument('--known-hosts',required=True);p.add_argument('--dry-run',action='store_true');p.add_argument('--rollback',action='store_true')
 try:print(json.dumps(run(p.parse_args()),ensure_ascii=False))
 except Exception as e:raise SystemExit(type(e).__name__+': '+str(e))
