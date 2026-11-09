"""Synthetic-only file switch journal. This is NOT a production installer.
Allowed targets are code/profile/preset files, never databases or persona/memory files.
"""
import argparse,hashlib,json,os,uuid
from pathlib import Path
DATA=(Path(__file__).resolve().parents[1]/'data').resolve()
FILES=('src/host.js','cordis.patch.yml','presets/aurabot-private.json','presets/aurabot-social.json')
def sha(b):return hashlib.sha256(b).hexdigest()
def checked(root):
 root=Path(root).resolve()
 if not root.is_relative_to(DATA) or root==DATA or not (root/'.synthetic-host-switch').is_file():raise ValueError('synthetic marked root under package data required; production paths prohibited')
 return root
def child(root,name):
 target=(root/name).resolve()
 if not target.is_relative_to(root) or target==root:raise ValueError('path escapes synthetic root')
 return target
def atomic(root,name,content):
 target=child(root,name);target.parent.mkdir(parents=True,exist_ok=True)
 temporary=child(root,name+'.'+uuid.uuid4().hex+'.tmp')
 try:
  with temporary.open('xb') as stream:stream.write(content);stream.flush();os.fsync(stream.fileno())
  os.replace(temporary,target)
 finally:
  if temporary.exists():temporary.unlink()
def save(root,plan):atomic(root,'switch-plan.json',json.dumps(plan,sort_keys=True,indent=2).encode())
def load(root):
 plan=json.loads(child(root,'switch-plan.json').read_text(encoding='utf-8'))
 if plan.get('version')!=1 or set(plan.get('files',{}))!=set(FILES):raise ValueError('invalid switch manifest')
 return plan
def prepare(root,dry_run=False):
 root=checked(root);inputs={name:(child(root,'live/'+name).read_bytes(),child(root,'candidate/'+name).read_bytes()) for name in FILES}
 rows={name:{'before':sha(old),'after':sha(new)} for name,(old,new) in inputs.items()}
 existing=child(root,'switch-plan.json')
 if existing.exists():
  prior=load(root)
  if any(rows[name]['after']!=prior['files'][name]['after'] for name in FILES):raise ValueError('candidate changed; keep existing rollback record')
  return {'prepared':True,'replayed':True,'state':prior['state'],'syntheticOnly':True}
 if dry_run:return {'dryRun':True,'files':list(FILES),'syntheticOnly':True}
 for name,(old,_) in inputs.items():atomic(root,'rollback/'+name,old)
 save(root,{'version':1,'state':'prepared','files':rows})
 return {'prepared':True,'syntheticOnly':True}
def apply(root,dry_run=False,after_write=None):
 root=checked(root);plan=load(root)
 payloads={name:child(root,'candidate/'+name).read_bytes() for name in FILES}
 for name,row in plan['files'].items():
  if sha(payloads[name])!=row['after']:raise ValueError('candidate changed')
  if sha(child(root,'live/'+name).read_bytes()) not in {row['before'],row['after']}:raise ValueError('live file changed; do not overwrite')
 if plan['state']=='rolled-back':raise ValueError('closed operation; prepare a new rehearsal for another switch')
 if dry_run:return {'dryRun':True,'action':'apply','syntheticOnly':True}
 if plan['state']=='applied':
  if any(sha(child(root,'live/'+name).read_bytes())!=row['after'] for name,row in plan['files'].items()):raise ValueError('applied state diverged; review before switching again')
  return {'applied':True,'replayed':True,'syntheticOnly':True}
 plan['state']='applying';save(root,plan)
 for name,row in plan['files'].items():
  if sha(child(root,'live/'+name).read_bytes())!=row['after']:
   atomic(root,'live/'+name,payloads[name])
   if after_write:after_write(name)
 plan['state']='applied';save(root,plan);return {'applied':True,'syntheticOnly':True}
def rollback(root,dry_run=False):
 root=checked(root);plan=load(root);backups={name:child(root,'rollback/'+name).read_bytes() for name in FILES}
 # Validate the ENTIRE operation before replacing even one file.
 for name,row in plan['files'].items():
  if sha(backups[name])!=row['before']:raise ValueError('rollback snapshot changed')
  if sha(child(root,'live/'+name).read_bytes()) not in {row['before'],row['after']}:raise ValueError('live file changed; stop for review')
 if dry_run:return {'dryRun':True,'action':'rollback','syntheticOnly':True}
 unchanged=all(sha(child(root,'live/'+name).read_bytes())==row['before'] for name,row in plan['files'].items())
 if plan['state']=='rolled-back' and unchanged:return {'restored':True,'replayed':True,'syntheticOnly':True,'memoryAndLeaseUntouched':True}
 for name,row in plan['files'].items():
  if sha(child(root,'live/'+name).read_bytes())!=row['before']:atomic(root,'live/'+name,backups[name])
 plan['state']='rolled-back';save(root,plan)
 return {'restored':True,'replayed':False,'syntheticOnly':True,'memoryAndLeaseUntouched':True}
def main():
 p=argparse.ArgumentParser();p.add_argument('action',choices=['prepare','apply','status'],nargs='?',default='status');p.add_argument('--root',required=True);p.add_argument('--dry-run',action='store_true');p.add_argument('--rollback',action='store_true');args=p.parse_args();root=checked(args.root)
 if args.rollback:result=rollback(root,args.dry_run)
 elif args.action=='prepare':result=prepare(root,args.dry_run)
 elif args.action=='apply':result=apply(root,args.dry_run)
 else:result={'syntheticOnly':True,'state':load(root)['state'],'dryRun':args.dry_run}
 print(json.dumps(result))
if __name__=='__main__':main()
