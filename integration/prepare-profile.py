"""Prepare, activate, or restore the desktop profile entry in an owned install.

Before DSH starts the new entry, use --restore-entry --plan-id <id> to undo it.
After a new term has been acquired, use the data-preserving handover protocol.
"""
import argparse,csv,hashlib,json,os,re,subprocess,uuid
from contextlib import contextmanager
from pathlib import Path
BASE=Path('C:/Users/USERNAME/Documents/Codex').resolve()
PACKAGE=Path(__file__).resolve().parents[1]
def sha(b):return hashlib.sha256(b).hexdigest()
def load(p):return json.loads(p.read_text(encoding='utf-8-sig'))
def owned(root):
 root=Path(root).resolve()
 if root==BASE or not root.is_relative_to(BASE):raise ValueError('owned installation under Codex required')
 state=load(root/'install.json');owner=load(root/'owner.json')['owner'];service=load(root/'runtime/service-config.json')
 if state.get('owner')!=owner or service.get('owner')!=owner or state.get('mode')!='installed-not-activated':raise ValueError('matching inactive installation required')
 if (root/'runtime').resolve()!=root/'runtime':raise ValueError('runtime directory link prohibited')
 return root,state
def atomic(path,raw):
 if path.exists() and path.resolve()!=path:raise ValueError('plan link prohibited')
 temp=path.with_name(path.name+'.'+uuid.uuid4().hex+'.tmp')
 try:
  with temp.open('xb') as stream:stream.write(raw);stream.flush();os.fsync(stream.fileno())
  os.replace(temp,path)
 finally:
  temp.unlink(missing_ok=True)

def selected(root):
 pointer=root/'runtime/profile-plan-current.json'
 if not pointer.exists():return None,None
 plan_id=load(pointer)['planId']
 if not isinstance(plan_id,str) or not re.fullmatch('[a-f0-9]{20}',plan_id):raise ValueError('invalid profile plan identity')
 path=root/'runtime/profile-plans'/plan_id/'plan.json'
 if pointer.resolve()!=pointer or path.resolve()!=path:raise ValueError('linked plan prohibited')
 return plan_id,path

@contextmanager
def profile_lock(root):
 import msvcrt
 path=root/'runtime/profile-transaction.lock'
 if path.exists() and path.resolve()!=path:raise ValueError('linked profile lock prohibited')
 with path.open('a+b') as lock:
  lock.seek(0)
  msvcrt.locking(lock.fileno(),msvcrt.LK_NBLCK,1)
  try:yield
  finally:
   lock.seek(0)
   msvcrt.locking(lock.fileno(),msvcrt.LK_UNLCK,1)

def prepare(root,profile,candidate,dry_run=False):
 root,state=owned(root);profile=Path(profile).resolve();candidate=Path(candidate).resolve()
 _,active=selected(root)
 if active and load(active)['state']=='approved':raise ValueError('restore the active entry before preparing another profile')
 if profile.name!='cordis.patch.yml':raise ValueError('explicit cordis.patch.yml profile required')
 original=profile.read_bytes()
 if not original.strip():raise ValueError('empty original profile')
 manifest_name='INSTALL-FILES-SHA256.json' if (candidate/'INSTALL-FILES-SHA256.json').is_file() else 'MANIFEST-SHA256.json'
 manifest_raw=(candidate/manifest_name).read_bytes();manifest=json.loads(manifest_raw)
 for name,digest in manifest.items():
  path=(candidate/name).resolve()
  if not path.is_relative_to(candidate) or not path.is_file() or sha(path.read_bytes())!=digest:raise ValueError('candidate manifest changed')
 entries={name:(candidate/name).as_uri() for name in ['host/aurabot/src/host.js','host/plugin/src/index.js','integration/profile-entry.mjs']}
 if not all(name in manifest for name in entries):raise ValueError('both existing host entry files must be pinned')
 inputs=root/'runtime/profile-runtime-inputs.json'
 rows=[{'id':'aurabot','name':entries['integration/profile-entry.mjs'],'config':{'root':str(root)}},
  {'id':'dsh-memory-layers','disabled':True},
  {'id':'dsh-heartbeat','disabled':True}]
 if inputs.is_file() and load(inputs).get('aiMemory'):rows.append({'id':'dsh-ai-memory','disabled':True})
 # JSON is a valid YAML flow node. Preserve all original text, including !!js guards.
 suffix=('\n\n# TideMind candidate overrides; PREVIEW ONLY, approval and runtime inputs required.\n'+''.join('- '+json.dumps(row,ensure_ascii=False)+'\n' for row in rows)).encode('utf-8')
 inputs=root/'runtime/profile-runtime-inputs.json'
 if inputs.exists() and inputs.resolve()!=inputs:raise ValueError('runtime inputs link prohibited')
 inputs_hash=sha(inputs.read_bytes()) if inputs.is_file() else None
 description={'candidateManifestName':manifest_name,'runtimeInputsSha256':inputs_hash,'owner':state['owner'],'profile':str(profile),'beforeSha256':sha(original),'candidateManifestSha256':sha(manifest_raw),'candidateRoot':str(candidate),'overrides':rows}
 plan_id=sha(json.dumps(description,sort_keys=True).encode())[:20]
 directory=root/'runtime/profile-plans'/plan_id
 result={'planId':plan_id,'dryRun':dry_run,'profileWritten':False,'servicesChanged':False,'productionReady':False,'overrideIds':[r['id'] for r in rows],
  'blockers':['runtime inputs, the selected installed service release and explicit activation approval are required','actual profile loader and all original bundles must be validated','production return must retain visibility of new memory and persona versions']}
 if dry_run:return result
 parent=directory.parent
 if parent.exists() and parent.resolve()!=parent or directory.exists() and directory.resolve()!=directory:raise ValueError('profile plan directory link prohibited')
 directory.mkdir(parents=True,exist_ok=True)
 if not directory.resolve().is_relative_to(root/'runtime'):raise ValueError('plan directory outside owned runtime')
 plan=directory/'plan.json'
 if plan.exists():
  old=load(plan)
  if old['description']!=description:raise ValueError('existing plan differs')
  for name,digest in old['files'].items():
   if sha((directory/name).read_bytes())!=digest:raise ValueError('prepared preview changed')
  return result|{'replayed':True,'state':old['state'],'directory':str(directory)}
 files={'original-profile.bin':original,'candidate-profile.yml':original+suffix}
 for name,raw in files.items():atomic(directory/name,raw)
 saved={'description':description,'state':'prepared','files':{name:sha(raw) for name,raw in files.items()},'result':result}
 atomic(plan,json.dumps(saved,ensure_ascii=False,indent=2).encode('utf-8'))
 atomic(root/'runtime/profile-plan-current.json',json.dumps({'planId':plan_id}).encode())
 return result|{'state':'prepared','directory':str(directory)}
def rollback(root,dry_run=False):
 root,_=owned(root);plan_id,path=selected(root)
 if not path:return {'cancelled':True,'replayed':True,'dryRun':dry_run,'profileWritten':False,'dataPreserved':True}
 plan=load(path);replayed=plan['state']=='cancelled'
 if plan['state']=='approved':raise ValueError('active entry requires --restore-entry or coordinated handover')
 if not dry_run and not replayed:
  plan['state']='cancelled';atomic(path,json.dumps(plan,ensure_ascii=False,indent=2).encode('utf-8'))
 return {'cancelled':True,'replayed':replayed,'dryRun':dry_run,'profileWritten':False,'dataPreserved':True,'planId':plan_id}

def desktop_stopped():
 result=subprocess.run(['tasklist.exe','/FO','CSV','/NH'],capture_output=True,text=True,errors='replace',timeout=10,check=True)
 rows=list(csv.reader(result.stdout.splitlines()))
 if not any(row and row[0].lower().endswith('.exe') for row in rows):raise ValueError('unable to verify desktop process state')
 if any(row and row[0].lower().startswith('dsh desktop') for row in rows):
  raise ValueError('DSH Desktop is running; close it only after online preflight passes')

def verify_activation(candidate,root,mode):
 service=load(root/'runtime/service-config.json')
 result=subprocess.run([service['node'],str(candidate/'integration/profile-activation-check.mjs'),str(root),mode],
                       capture_output=True,text=True,encoding='utf-8',timeout=20)
 if result.returncode:raise ValueError(result.stderr.strip() or 'production authority preflight failed')
 frontier=json.loads(result.stdout)
 if (type(frontier.get('term')) is not int or frontier['term']<0 or
     any(not re.fullmatch('[a-f0-9]{64}',frontier.get(key,'')) for key in ('storeDigest','historyDigest'))):
  raise ValueError('invalid production frontier')
 return frontier

def transition(root,requested_id,restore=False,dry_run=False):
 root,state=owned(root)
 plan_id,path=selected(root)
 if not path or plan_id!=requested_id:raise ValueError('explicit matching profile plan ID required')
 plan=load(path);desc=plan['description']
 if desc['owner']!=state['owner']:raise ValueError('foreign profile plan')
 profile=Path(desc['profile'])
 expected=Path.home()/'.dsh/profiles/desktop/cordis.patch.yml'
 if profile!=expected.resolve() or profile.resolve()!=profile:raise ValueError('real desktop override path required')
 release=state.get('release','')
 if not re.fullmatch('[a-f0-9]{16}',release):raise ValueError('invalid installed release')
 candidate=root/'releases'/release
 if candidate.resolve()!=candidate or Path(desc['candidateRoot'])!=candidate:raise ValueError('plan must pin the selected installed release')
 original=path.with_name('original-profile.bin');proposed=path.with_name('candidate-profile.yml')
 if any(file.resolve()!=file for file in (original,proposed)):raise ValueError('linked profile backup prohibited')
 old,new=original.read_bytes(),proposed.read_bytes()
 if sha(old)!=desc['beforeSha256'] or sha(old)!=plan['files']['original-profile.bin'] or sha(new)!=plan['files']['candidate-profile.yml']:
  raise ValueError('profile preview or original backup changed')
 current=profile.read_bytes()
 if current not in (old,new):raise ValueError('desktop profile changed outside this plan')
 if restore and current==old and plan['state'] in ('prepared','restored'):
  return {'planId':plan_id,'restored':True,'replayed':True,'dryRun':dry_run,'profileWritten':False}
 if plan['state'] not in (('approved',) if restore else ('prepared','approved')):
  raise ValueError('profile plan state does not allow this operation')
 if current==new and plan['state']!='approved':raise ValueError('candidate has no matching activation journal')
 manifest=candidate/'INSTALL-FILES-SHA256.json'
 if desc['candidateManifestName']!=manifest.name or sha(manifest.read_bytes())!=desc['candidateManifestSha256']:
  raise ValueError('installed candidate manifest changed')
 files=load(manifest)
 if 'integration/profile-activation-check.mjs' not in files:raise ValueError('candidate lacks the production preflight')
 for name,digest in files.items():
  file=candidate/name
  if file.resolve()!=file or not file.is_relative_to(candidate) or sha(file.read_bytes())!=digest:
   raise ValueError('installed candidate file changed')
 inputs=root/'runtime/profile-runtime-inputs.json'
 if not inputs.is_file() or inputs.resolve()!=inputs or sha(inputs.read_bytes())!=desc['runtimeInputsSha256']:
  raise ValueError('production runtime inputs missing or changed')
 frontier=verify_activation(candidate,root,'restore' if restore else 'apply')
 if plan['state']=='approved' and plan.get('activationFrontier')!=frontier:
  raise ValueError('authority advanced; preserve new data and use coordinated handover')
 result={'planId':plan_id,'dryRun':dry_run,'profileWritten':False,'desktopRestarted':False,'memoryAndLeaseUntouched':True}
 if dry_run:return result|{'preflightPassed':True,'action':'restore-entry' if restore else 'activate'}
 desktop_stopped()
 if verify_activation(candidate,root,'restore' if restore else 'apply')!=frontier or profile.read_bytes()!=current:
  raise ValueError('authority or desktop profile changed before the write')
 if restore:
  if current!=old:atomic(profile,old)
  plan['state']='restored'
  atomic(path,json.dumps(plan,ensure_ascii=False).encode('utf-8'))
  return result|{'restored':True,'profileWritten':current!=old}
 if current==new:return result|{'activatedEntry':True,'replayed':True}
 # Journal first. A crash between the two writes is replayable while the
 # desktop is closed and the same unheld authority frontier is intact.
 plan.update(state='approved',activationFrontier=frontier)
 atomic(path,json.dumps(plan,ensure_ascii=False).encode('utf-8'))
 atomic(profile,new)
 return result|{'activatedEntry':True,'profileWritten':True}

def main():
 p=argparse.ArgumentParser();p.add_argument('--root',required=True);p.add_argument('--profile',default=str(Path.home()/'.dsh/profiles/desktop/cordis.patch.yml'));p.add_argument('--candidate',default=str(PACKAGE));p.add_argument('--dry-run',action='store_true');p.add_argument('--plan-id')
 actions=p.add_mutually_exclusive_group()
 for flag in ('rollback','activate','restore-entry'):actions.add_argument('--'+flag,action='store_true')
 a=p.parse_args()
 root,_=owned(a.root)
 def run():
  if a.activate or a.restore_entry:return transition(root,a.plan_id,a.restore_entry,a.dry_run)
  if a.rollback:return rollback(root,a.dry_run)
  return prepare(root,a.profile,a.candidate,a.dry_run)
 if a.dry_run:result=run()
 else:
  with profile_lock(root):result=run()
 print(json.dumps(result,ensure_ascii=False))
if __name__=='__main__':main()
