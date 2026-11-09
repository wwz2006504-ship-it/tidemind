"""Prepare pinned DSH dependencies in cloud STAGING only. No services or real data.
Preview: python3 cloud-sdk-prepare.py --plan PLAN --source-root SOURCE --dry-run
Rollback: same command with --rollback; disable candidate, preserve all files.
"""
import argparse,hashlib,json,os,platform,re,subprocess,tarfile
from pathlib import Path
ROOT=Path('/srv/tidemind-staging')
NODE=ROOT/'runtime/node-v24.17.0-linux-x64/node'
TAG='TideMind isolated DSH SDK v1'
def sha(data):return hashlib.sha256(data).hexdigest()
def canonical(value):return json.dumps(value,sort_keys=True,separators=(',',':')).encode()
def validate(plan,source):
 body={k:v for k,v in plan.items() if k!='digest'}
 if body.get('format')!='tidemind-cloud-sdk-plan-v1' or sha(canonical(body))!=plan.get('digest'):raise ValueError('SDK plan digest differs')
 pins=json.loads((source/'host/SESSION-SOURCE-MANIFEST.json').read_text())
 packages=body.get('packages',[])
 if len(packages)!=len(pins) or len({p['name'] for p in packages})!=len(pins):raise ValueError('SDK package set differs')
 for p in packages:
  if not p['name'].startswith('@deepseek-ai/'):raise ValueError('unreviewed SDK package')
  pin=pins.get(p['name'].split('/')[1])
  if not pin or p['version']!=pin['version'] or p['sourceSha256']!=pin['sha256']:raise ValueError('SDK original source pin differs')
 addon=body.get('platformPackage',{})
 if addon.get('name')!='@deepseek-ai/node-addon-system-linux-x64' or addon.get('version')!='0.1.2':raise ValueError('unreviewed Linux addon')
 for p in [*packages,addon]:
  if not re.fullmatch(r'sha512-[A-Za-z0-9+/]+=*',p.get('integrity','')) or not p.get('tarball','').startswith('https://registry.npmjs.org/'):raise ValueError('official registry integrity required')
 return [*packages,addon]
def safe(path):
 if path.is_symlink() or not path.resolve().is_relative_to(ROOT.resolve()):raise ValueError('staging path escaped')
 return path
def installed(target,packages):
 lock=json.loads((target/'package-lock.json').read_text())
 for p in packages:
  row=lock['packages'].get('node_modules/'+p['name'],{})
  if row.get('version')!=p['version'] or row.get('integrity')!=p['integrity']:raise ValueError('installed dependency integrity differs')
  if 'sourceSha256' in p:
   file=target/'node_modules'/p['name']/'lib/index.js';safe(file)
   if sha(file.read_bytes())!=p['sourceSha256']:raise ValueError('installed original SDK code differs')
 files=[]
 for tree in ['node_modules','npm']:
  safe(target/tree)
  for p in sorted((target/tree).rglob('*')):
   if not p.resolve().is_relative_to(target.resolve()):raise ValueError('SDK resource escaped candidate')
   if p.is_symlink():
    if not p.exists():raise ValueError('dangling SDK resource link')
    files.append((str(p.relative_to(target)),'link:'+os.readlink(p)))
    continue
   safe(p)
   if p.is_file():files.append((str(p.relative_to(target)),sha(p.read_bytes())))
 return {'lockSha256':sha((target/'package-lock.json').read_bytes()),'codeSha256':sha(canonical(files)),'codeFiles':len(files)}
def run(args):
 plan=json.loads(Path(args.plan).read_text(encoding='utf-8'));source=Path(args.source_root).resolve();packages=validate(plan,source)
 directory=ROOT/'dsh-sdk';target=directory/plan['digest']
 result={'planDigest':plan['digest'],'directory':str(target),'sdkRoot':str(target/'node_modules/@deepseek-ai'),'dryRun':args.dry_run,'rollback':args.rollback,'productionEnabled':False,'servicesChanged':False}
 if args.dry_run:return result|{'packages':len(packages),'scriptsAllowed':False}
 if platform.system()!='Linux' or ROOT.is_symlink() or (ROOT/'OWNER').read_text()!='TideMind candidate staging v1':raise ValueError('owned Linux staging required')
 if not re.fullmatch(r'/srv/tidemind-staging/candidates/[a-f0-9]{64}/source',str(source)) or (source.parent/'OWNER').read_text()!=source.parent.name:raise ValueError('verified source candidate required')
 safe(source);safe(directory);safe(target)
 if args.rollback:
  if not target.exists():return result|{'replayed':True,'dataPreserved':True}
  if (target/'OWNER').read_text()!=plan['digest']:raise ValueError('SDK ownership differs')
  safe(target/'DISABLED').write_text('inactive SDK candidate; data retained');return result|{'disabled':True,'dataPreserved':True}
 if directory.exists():
  if (directory/'OWNER').read_text()!=TAG:raise ValueError('unowned SDK parent')
 else:directory.mkdir(mode=0o700);(directory/'OWNER').write_text(TAG)
 if target.exists():
  if (target/'OWNER').read_text()!=plan['digest'] or (target/'DISABLED').exists():raise ValueError('SDK candidate not owned or disabled')
 else:target.mkdir(mode=0o700);(target/'OWNER').write_text(plan['digest'])
 ready=safe(target/'ready.json')
 if ready.exists():
  saved=json.loads(ready.read_text());proof=installed(target,packages)
  if any(saved[k]!=v for k,v in proof.items()):raise ValueError('SDK candidate changed after verification')
  return result|proof|{'replayed':True,'nativeHistoryProbe':True}
 if not NODE.is_file() or NODE.is_symlink():raise ValueError('approved isolated Node runtime required')
 manifest={'name':'tidemind-isolated-dsh-sdk','private':True,'type':'module','dependencies':{p['name']:p['version'] for p in packages}}
 package=safe(target/'package.json')
 if package.exists() and json.loads(package.read_text())!=manifest:raise ValueError('SDK manifest conflict')
 package.write_text(json.dumps(manifest));package.chmod(0o600)
 env={k:v for k,v in os.environ.items() if not k.startswith(('TIDEMIND_','NPM_','npm_'))}
 userconfig=safe(target/'npm-user-config');
 if userconfig.exists() and userconfig.read_text()!='':raise ValueError('SDK npm configuration changed')
 userconfig.write_text('');userconfig.chmod(0o600)
 env.update(PATH=str(NODE.parent)+os.pathsep+env.get('PATH',''),NPM_CONFIG_USERCONFIG=str(userconfig),NPM_CONFIG_GLOBALCONFIG='/dev/null')
 # The approved runtime intentionally installed only node. Reuse its retained,
 # checksum-pinned OFFICIAL archive for npm, under this SDK candidate only.
 archive=NODE.parent/'node-v24.17.0-linux-x64.tar.xz'
 if archive.is_symlink() or sha(archive.read_bytes())!='ab343a1b747c7cbf3630dfd7dbf818c5423fab2eb4f5ad1afc896f6bd121a917':raise ValueError('approved original Node archive differs')
 prefix='node-v24.17.0-linux-x64/lib/node_modules/npm/'
 with tarfile.open(archive,'r:xz') as tar:
  for member in tar:
   if not member.name.startswith(prefix) or not member.isfile():continue
   rel=member.name[len(prefix):]
   if not rel or '..' in rel.split('/') or rel.startswith('/'):raise ValueError('unsafe npm archive entry')
   file=target/'npm'/rel;safe(file)
   if not file.resolve().is_relative_to(target.resolve()):raise ValueError('npm extraction escaped candidate')
   file.parent.mkdir(mode=0o700,parents=True,exist_ok=True);data=tar.extractfile(member).read()
   if file.exists():
    if file.read_bytes()!=data:raise ValueError('isolated npm source changed')
   else:file.write_bytes(data);file.chmod(0o600)
 npm=target/'npm/bin/npm-cli.js'
 process=subprocess.run([str(NODE),str(npm),'install','--ignore-scripts','--no-audit','--no-fund','--omit=dev','--registry=https://registry.npmjs.org','--cache='+str(target/'cache')],cwd=target,env=env,capture_output=True,text=True,timeout=240)
 safe(target/'npm-output.txt').write_text(process.stdout+process.stderr)
 if process.returncode:raise ValueError('isolated SDK installation failed; retained npm-output.txt')
 proof=installed(target,packages)
 probe="""import {pathToFileURL} from 'node:url';
const root=process.argv[1],base=root+'/node_modules/@deepseek-ai/';
const [{Context},backend]=await Promise.all(['cordis','dsh-session-persistence-jsonl'].map(n=>import(pathToFileURL(base+n+'/lib/index.js'))));
const ctx=new Context();let writer;try{await backend.apply(ctx,{root:root+'/probe',compression:'none'});try{writer=await ctx.sessionPersistence.open('tidemind-cloud-sdk-probe','write')}catch(e){if(e.name!=='SessionPersistenceNotFoundError')throw e;writer=await ctx.sessionPersistence.create({version:4,id:'tidemind-cloud-sdk-probe',createdAt:1,isSeeded:false,delegationDepth:0,cwd:root})}await writer.flush();await writer.close();writer=null;const reader=await ctx.sessionPersistence.open('tidemind-cloud-sdk-probe','read');if(reader.header.id!=='tidemind-cloud-sdk-probe')throw Error('native history mismatch');await reader.read(0);await reader.close();console.log('NATIVE_HISTORY_OK')}finally{await writer?.close();await ctx.fiber.dispose();if(ctx.fiber.inertia)await ctx.fiber.inertia}
"""
 check=subprocess.run([str(NODE),'--input-type=module','-e',probe,str(target)],cwd=target,env=env,capture_output=True,text=True,timeout=30)
 safe(target/'probe-output.txt').write_text(check.stdout+check.stderr)
 if check.returncode or 'NATIVE_HISTORY_OK' not in check.stdout:raise ValueError('native Linux history probe failed; retained probe-output.txt')
 proof=installed(target,packages);ready.write_text(json.dumps(proof|{'planDigest':plan['digest'],'nativeHistoryProbe':True}));ready.chmod(0o600)
 return result|proof|{'replayed':False,'nativeHistoryProbe':True}
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--plan',required=True);p.add_argument('--source-root',required=True);p.add_argument('--dry-run',action='store_true');p.add_argument('--rollback',action='store_true')
 try:print(json.dumps(run(p.parse_args())))
 except Exception as error:raise SystemExit(type(error).__name__+': '+str(error))
