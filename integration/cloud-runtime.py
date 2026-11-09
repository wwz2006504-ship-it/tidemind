"""Isolated cloud Node binary; no services, PATH edits, npm installs, or private data.
Preview: python3 cloud-runtime.py --dry-run
Failure rollback: python3 cloud-runtime.py --rollback (disables executable; retains files).
Run on the VPS only after explicit installation approval.
"""
import argparse,hashlib,json,os,platform,subprocess,tarfile,urllib.request
from pathlib import Path
VERSION='v24.17.0'
ARCHIVE='node-v24.17.0-linux-x64.tar.xz'
SHA256='ab343a1b747c7cbf3630dfd7dbf818c5423fab2eb4f5ad1afc896f6bd121a917'
URL='https://nodejs.org/download/release/'+VERSION+'/'+ARCHIVE
ROOT=Path('/srv/tidemind-staging')
TARGET=ROOT/'runtime'/'node-v24.17.0-linux-x64'
TAG='TideMind isolated Node runtime v1'
def sha(path):return hashlib.sha256(path.read_bytes()).hexdigest()
def run(args):
 plan={'dryRun':args.dry_run,'rollback':args.rollback,'target':str(TARGET),'version':VERSION,'source':URL,'archiveSha256':SHA256,'systemPathChanged':False,'servicesChanged':False,'portsOpened':False,'productionEnabled':False}
 if args.dry_run:return plan
 if platform.system()!='Linux' or platform.machine() not in ('x86_64','AMD64'):raise ValueError('Linux x64 required')
 if ROOT.is_symlink() or not ROOT.is_dir() or (ROOT/'OWNER').is_symlink() or (ROOT/'OWNER').read_text()!='TideMind candidate staging v1':raise ValueError('owned staging root required')
 parent=TARGET.parent
 if parent.is_symlink() or TARGET.is_symlink():raise ValueError('runtime links refused')
 if not TARGET.resolve().is_relative_to(ROOT.resolve()):raise ValueError('runtime escaped staging')
 marker=TARGET/'OWNER';node=TARGET/'node';disabled=TARGET/'node.disabled';meta=TARGET/'installed.json'
 if TARGET.exists():
  if marker.is_symlink() or not marker.is_file() or marker.read_text()!=TAG:raise ValueError('unowned runtime; refusing changes')
  if any(p.is_symlink() for p in (node,disabled,meta)):raise ValueError('runtime links refused')
 if args.rollback:
  if not TARGET.exists():return plan|{'replayed':True,'dataPreserved':True}
  if node.exists():
   if disabled.exists():raise ValueError('disabled binary conflict; keep both for review')
   node.rename(disabled);disabled.chmod(0o400)
  return plan|{'dataPreserved':True,'disabled':True}
 if TARGET.exists():
  if disabled.exists():raise ValueError('runtime was rolled back; explicit recovery required')
  if not meta.is_file():raise ValueError('incomplete runtime; rollback and review required')
  receipt=json.loads(meta.read_text())
  if receipt.get('archiveSha256')!=SHA256 or not node.is_file() or sha(node)!=receipt.get('nodeSha256'):raise ValueError('existing runtime differs; refusing overwrite')
  return plan|{'replayed':True,'nodeSha256':receipt['nodeSha256']}
 parent.mkdir(mode=0o700,exist_ok=True);TARGET.mkdir(mode=0o700);marker.write_text(TAG);marker.chmod(0o600)
 archive=TARGET/ARCHIVE
 try:
  request=urllib.request.Request(URL,headers={'User-Agent':'TideMind-runtime-preparer/1'})
  with urllib.request.urlopen(request,timeout=30) as source,archive.open('xb') as dest:
   if source.geturl()!=URL:raise ValueError('runtime download redirect refused')
   total=0
   while True:
    block=source.read(1024*1024)
    if not block:break
    total+=len(block)
    if total>100*1024*1024:raise ValueError('runtime archive too large')
    dest.write(block)
  archive.chmod(0o600)
  if sha(archive)!=SHA256:raise ValueError('official runtime checksum mismatch')
  with tarfile.open(archive,'r:xz') as tar:
   member=tar.getmember('node-v24.17.0-linux-x64/bin/node')
   if not member.isfile() or member.size>200*1024*1024:raise ValueError('invalid Node binary entry')
   with tar.extractfile(member) as src,node.open('xb') as dst:
    for block in iter(lambda:src.read(1024*1024),b''):dst.write(block)
  node.chmod(0o500)
  command="import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE smoke(id INTEGER)');db.close();console.log(process.version)"
  smoke=subprocess.run([str(node),'--input-type=module','-e',command],capture_output=True,text=True,timeout=10)
  if smoke.returncode or smoke.stdout.strip()!=VERSION:raise ValueError('Node/SQLite smoke test failed')
  receipt={'archiveSha256':SHA256,'nodeSha256':sha(node),'version':VERSION,'sqliteSmokePassed':True}
  meta.write_text(json.dumps(receipt));meta.chmod(0o600)
  return plan|receipt|{'replayed':False}
 except Exception:
  if node.exists() and not disabled.exists():node.rename(disabled);disabled.chmod(0o400)
  raise
if __name__=='__main__':
 parser=argparse.ArgumentParser();parser.add_argument('--dry-run',action='store_true');parser.add_argument('--rollback',action='store_true')
 try:print(json.dumps(run(parser.parse_args())))
 except Exception as error:raise SystemExit(type(error).__name__+': '+str(error))
