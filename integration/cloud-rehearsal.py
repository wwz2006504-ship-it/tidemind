"""Verify and expand a source candidate, run synthetic tests, never enable production.
Preview: python3 cloud-rehearsal.py --digest <sha256> --dry-run
Rollback: python3 cloud-rehearsal.py --digest <sha256> --rollback (mark inactive, keep data).
"""
import argparse,hashlib,json,os,platform,re,subprocess,zipfile
from pathlib import Path
ROOT=Path('/srv/tidemind-staging');NODE=ROOT/'runtime/node-v24.17.0-linux-x64/node'
TESTS=['TideMind/test_upgrade.mjs',*[f'integration/test-{s}.mjs' for s in ['authority-http','sync-delta','sync-receipts','materializer-worker','memory-barrier','source-admission','composite-head','state-transfer','sealed-signing','roundtrip','remote-store','remote-sidecars','remote-qq-tasks','remote-media','remote-source','tool-outcome-transfer','fresh-baseline','chat-compatibility']]]
def run(args):
 if not re.fullmatch('[a-f0-9]{64}',args.digest):raise ValueError('candidate SHA256 required')
 archive=ROOT/(args.digest+'.zip');target=ROOT/'candidates'/args.digest;plan={'candidateSha256':args.digest,'directory':str(target),'dryRun':args.dry_run,'rollback':args.rollback,'productionEnabled':False,'servicesChanged':False,'syntheticOnly':True}
 if args.dry_run:return plan|{'tests':TESTS}
 if platform.system()!='Linux':raise ValueError('Linux rehearsal only')
 if ROOT.is_symlink() or (ROOT/'OWNER').read_text()!='TideMind candidate staging v1':raise ValueError('owned staging required')
 if target.parent.is_symlink() or target.is_symlink() or not target.resolve().is_relative_to(ROOT.resolve()):raise ValueError('unsafe candidate path')
 if args.rollback:
  if not target.exists():return plan|{'replayed':True,'dataPreserved':True}
  if (target/'OWNER').is_symlink() or (target/'OWNER').read_text()!=args.digest:raise ValueError('unowned candidate')
  marker=target/'DISABLED'
  if marker.is_symlink():raise ValueError('unsafe disabled marker')
  marker.write_text('inactive synthetic candidate; data retained');return plan|{'disabled':True,'dataPreserved':True}
 if archive.is_symlink() or hashlib.sha256(archive.read_bytes()).hexdigest()!=args.digest:raise ValueError('candidate archive hash differs')
 with zipfile.ZipFile(archive) as z:
  prefix='existing-upgrade-integration/';names=z.namelist()
  if len(names)!=len(set(names)) or any(not n.startswith(prefix) or '\\' in n or '..' in n.split('/') for n in names):raise ValueError('unsafe archive paths')
  manifest=json.loads(z.read(prefix+'MANIFEST-SHA256.json'))
  if set(names)!={prefix+n for n in manifest}|{prefix+'MANIFEST-SHA256.json'}:raise ValueError('archive file set differs')
  for n,digest in manifest.items():
   if hashlib.sha256(z.read(prefix+n)).hexdigest()!=digest:raise ValueError('candidate manifest mismatch')
  if target.exists():
   if (target/'OWNER').is_symlink() or (target/'OWNER').read_text()!=args.digest:raise ValueError('unowned candidate')
   if (target/'DISABLED').exists():raise ValueError('candidate disabled')
   for n in manifest:
    p=target/'source'/n
    if p.is_symlink() or not p.is_file() or hashlib.sha256(p.read_bytes()).hexdigest()!=manifest[n]:raise ValueError('existing candidate changed; refuse overwrite')
  else:
   target.parent.mkdir(mode=0o700,exist_ok=True);target.mkdir(mode=0o700);(target/'OWNER').write_text(args.digest)
   for n in names:
    rel=n[len(prefix):];p=target/'source'/rel;p.parent.mkdir(mode=0o700,parents=True,exist_ok=True);p.write_bytes(z.read(n));p.chmod(0o600)
 if not NODE.is_file() or NODE.is_symlink():raise ValueError('approved isolated Node runtime required')
 env={k:v for k,v in os.environ.items() if not k.startswith('TIDEMIND_')};env['TIDEMIND_FIXTURE_STORE']='isolated-pinned'
 result=subprocess.run([str(NODE),'--test','--test-isolation=none',*TESTS],cwd=target/'source',env=env,capture_output=True,text=True,timeout=120)
 log=target/'test-output.txt';log.write_text(result.stdout+result.stderr);log.chmod(0o600)
 total=re.search(r'(?m)^.*?\btests (\d+)\s*$',result.stdout);passed=result.returncode==0
 receipt=plan|{'passed':passed,'tests':int(total.group(1)) if total else None,'testLog':str(log),'scope':'Linux-only synthetic protocol tests; not two-machine failover or production DSH'}
 receiptPath=target/'receipt.json';receiptPath.write_text(json.dumps(receipt));receiptPath.chmod(0o600)
 if not passed:raise ValueError('cloud tests failed; inspect retained test-output.txt')
 return receipt
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--digest',required=True);p.add_argument('--dry-run',action='store_true');p.add_argument('--rollback',action='store_true')
 try:print(json.dumps(run(p.parse_args())))
 except Exception as e:raise SystemExit(type(e).__name__+': '+str(e))
