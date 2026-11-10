"""Isolated acceptance runner. --dry-run reads only; --rollback never restores a lease DB."""
import argparse,hashlib,json,os,re,subprocess,sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
def _input(name, default):
 raw=os.environ.get(name)
 return Path(raw).expanduser() if raw else default
SOURCE=_input('TIDEMIND_SOURCE', Path.home()/'.dsh/profiles/desktop/node_modules/dsh-memory-layers/src')
QQ_SOURCE=_input('TIDEMIND_QQ_SOURCE', Path.home()/'.dsh/profiles/desktop/node_modules/dsh-aurabot-qq/src')
ORIGINALS=_input('TIDEMIND_ORIGINALS', Path.home()/'Aurabot/qq-chats/tidemind-shadow')
APP_MODULES=_input('TIDEMIND_APP_MODULES', Path.home()/'.dsh/profiles/desktop/node_modules/@deepseek-ai')
HOST_INPUTS=['host/aurabot/SOURCE-MANIFEST.json','host/aurabot-upstream/SOURCE-MANIFEST.json','host/heartbeat/SOURCE-MANIFEST.json','host/custom-modules/SOURCE-MANIFEST.json','host/SESSION-SOURCE-MANIFEST.json','host/AURABOT-PACKAGE-SOURCE-MANIFEST.json','host/ai-memory/SOURCE-MANIFEST.json']
def missing_inputs():
 """Host-only inputs. This package never ships the author's private host clone or custom modules."""
 missing=[p for p in HOST_INPUTS if not (ROOT/p).is_file()]
 for extra in (SOURCE, QQ_SOURCE):
  if not extra.is_dir():missing.append(str(extra))
 return missing
def fingerprints():
 result={}
 for p in list(SOURCE.glob('*.js')):result[str(p)]=hashlib.sha256(p.read_bytes()).hexdigest()
 if ORIGINALS.is_dir():
  for n in ['lease.mjs','reconcile.mjs','tidemind-api.mjs']:result[str(ORIGINALS/n)]=hashlib.sha256((ORIGINALS/n).read_bytes()).hexdigest()
 for name in json.loads((ROOT/'host/AURABOT-PACKAGE-SOURCE-MANIFEST.json').read_text(encoding='utf-8')):
  p=QQ_SOURCE.parent/name;result[str(p)]=hashlib.sha256(p.read_bytes()).hexdigest()
 for name in json.loads((ROOT/'host/aurabot/SOURCE-MANIFEST.json').read_text(encoding='utf-8')):
  p=QQ_SOURCE/name;result[str(p)]=hashlib.sha256(p.read_bytes()).hexdigest()
 for name in json.loads((ROOT/'host/custom-modules/SOURCE-MANIFEST.json').read_text(encoding='utf-8')):
  p=Path.home()/'.dsh/plugins-data/aurabot/modules'/name;result[str(p)]=hashlib.sha256(p.read_bytes()).hexdigest()
 for name in json.loads((ROOT/'host/heartbeat/SOURCE-MANIFEST.json').read_text(encoding='utf-8')):
  p=Path.home()/'.dsh/profiles/desktop/node_modules/dsh-plugin-heartbeat/lib'/name;result[str(p)]=hashlib.sha256(p.read_bytes()).hexdigest()
 for name in json.loads((ROOT/'host/aurabot-upstream/SOURCE-MANIFEST.json').read_text(encoding='utf-8')):
  p=QQ_SOURCE/name;result[str(p)]=hashlib.sha256(p.read_bytes()).hexdigest()
 for name in json.loads((ROOT/'host/SESSION-SOURCE-MANIFEST.json').read_text(encoding='utf-8')):
  p=APP_MODULES/name/'lib/index.js';result[str(p)]=hashlib.sha256(p.read_bytes()).hexdigest()
 for name in json.loads((ROOT/'host/ai-memory/SOURCE-MANIFEST.json').read_text(encoding='utf-8')):
  p=Path.home()/'.dsh/profiles/desktop/node_modules/dsh-ai-memory/src'/name;result[str(p)]=hashlib.sha256(p.read_bytes()).hexdigest()
 return result

def main():
 parser=argparse.ArgumentParser();parser.add_argument('--dry-run',action='store_true');parser.add_argument('--rollback',action='store_true');args=parser.parse_args()
 if args.rollback:
  print('NO-OP: acceptance owns no persistent services; original profile was never enabled or changed. Preserve reports; do not restore old lease.db.');return
 missing=missing_inputs()
 if missing:
  print(json.dumps({'skipped':True,'reason':'host inputs unavailable; this package does not ship the private host clone or custom modules','missing':missing,'hint':'restore host/ from your own host clone, or set TIDEMIND_SOURCE, TIDEMIND_QQ_SOURCE, TIDEMIND_ORIGINALS and TIDEMIND_APP_MODULES'},ensure_ascii=False));sys.exit(0 if args.dry_run else 2)
 before=fingerprints()
 for name,row in json.loads((ROOT/'host/ai-memory/SOURCE-MANIFEST.json').read_text(encoding='utf-8')).items():
  original=Path.home()/'.dsh/profiles/desktop/node_modules/dsh-ai-memory/src'/name
  if before[str(original)]!=row['sha256'] or hashlib.sha256((ROOT/'host/ai-memory/src'/name).read_bytes()).hexdigest()!=row.get('isolatedSha256',row['sha256']):raise SystemExit('AI memory source drift; review original and adapter before continuing')
 for name,row in json.loads((ROOT/'host/aurabot-upstream/SOURCE-MANIFEST.json').read_text(encoding='utf-8')).items():
  if before[str(QQ_SOURCE/name)]!=row['sha256'] or hashlib.sha256((ROOT/'host/aurabot-upstream/src'/name).read_bytes()).hexdigest()!=row.get('isolatedSha256',row['sha256']):raise SystemExit('Upstream Aurabot source changed; review full-module fixture again')
 for name,row in json.loads((ROOT/'host/heartbeat/SOURCE-MANIFEST.json').read_text(encoding='utf-8')).items():
  p=Path.home()/'.dsh/profiles/desktop/node_modules/dsh-plugin-heartbeat/lib'/name
  if before[str(p)]!=row['originalSha256'] or hashlib.sha256((ROOT/'host/heartbeat'/name).read_bytes()).hexdigest()!=row['isolatedSha256']:raise SystemExit('Heartbeat source changed; review isolated runtime again')
 for name,row in json.loads((ROOT/'host/custom-modules/SOURCE-MANIFEST.json').read_text(encoding='utf-8')).items():
  p=Path.home()/'.dsh/plugins-data/aurabot/modules'/name
  if before[str(p)]!=row.get('originalSha256',row.get('sha256')) or hashlib.sha256((ROOT/'host/custom-modules'/name).read_bytes()).hexdigest()!=row.get('isolatedSha256',row.get('sha256')):raise SystemExit('Custom module source changed; review exact module copy again')
 for name,row in json.loads((ROOT/'host/SESSION-SOURCE-MANIFEST.json').read_text(encoding='utf-8')).items():
  p=APP_MODULES/name/'lib/index.js'
  if before[str(p)]!=row['sha256']:raise SystemExit('Installed session persistence source changed; review adapter again')
 qqPinned=json.loads((ROOT/'host/aurabot/SOURCE-MANIFEST.json').read_text(encoding='utf-8'))
 for name,expected in qqPinned.items():
  if before[str(QQ_SOURCE/name)]!=expected['originalSha256']:raise SystemExit('Installed Aurabot source changed; review isolated copy again')
  if hashlib.sha256((ROOT/'host/aurabot/src'/name).read_bytes()).hexdigest()!=expected['isolatedSha256']:raise SystemExit('Isolated Aurabot source changed without reviewed manifest')
 pinned=json.loads((ROOT/'host/SOURCE-MANIFEST.json').read_text(encoding='utf-8'))
 for name,expected in pinned.items():
  if before[str(SOURCE/name)]!=expected['originalSha256']:raise SystemExit('Installed source changed; isolated copy must be reviewed again')
 for name,row in json.loads((ROOT/'host/AURABOT-PACKAGE-SOURCE-MANIFEST.json').read_text(encoding='utf-8')).items():
  if before[str(QQ_SOURCE.parent/name)]!=row['sha256'] or hashlib.sha256((ROOT/'host/aurabot'/name).read_bytes()).hexdigest()!=row.get('isolatedSha256',row['sha256']):raise SystemExit('Original UI/preset/template asset changed; review before installation')
 if args.dry_run:
  print(json.dumps({'dryRun':True,'scope':'same-package original-store + real SessionController/AgentLoop; synthetic memories and offline I/O','protectedSourceFiles':len(before),'productionEnabled':False,'realQQ':False}));return
 env=dict(os.environ,PYTHONUTF8='1',TIDEMIND_REQUIRE_STORE_PROOF='0')
 env.pop('TIDEMIND_STORE_SIGNING_KEY',None);env.pop('TIDEMIND_ALLOW_LEGACY_SYNTHETIC',None);env.pop('TIDEMIND_REQUIRE_QQ_BINDING',None)
 commands=[([sys.executable,'manage.py','test'],ROOT/'TideMind'),
  (['node','--test','--test-isolation=none',*[str(p.relative_to(ROOT)) for p in sorted((ROOT/'integration').glob('test-*.mjs'))]],ROOT),
  (['node','--experimental-vm-modules','--test','--test-isolation=none','integration/custom-modules-check.mjs'],ROOT),
  ([sys.executable,'-m','unittest','discover','-s','integration','-p','test_*process.py','-v'],ROOT),
  ([sys.executable,'-m','unittest','discover','-s','integration','-p','test_local_install.py','-v'],ROOT)]
 reports=ROOT/'reports';reports.mkdir(exist_ok=True)
 outputs=[];passed=True
 for command,cwd in commands:
  result=subprocess.run(command,cwd=cwd,env=env,capture_output=True,encoding='utf-8',errors='replace')
  outputs.append(result.stdout+result.stderr);passed=passed and result.returncode==0
  if result.returncode:break
 text='\n'.join(outputs)
 (reports/'ACCEPTANCE-OUTPUT.txt').write_text(text,encoding='utf-8')
 node=sum(map(int,re.findall(r'(?m)^.*?\btests (\d+)\s*$',text)))
 python=sum(map(int,re.findall(r'Ran (\d+) tests?',text)))
 unchanged=before==fingerprints()
 summary={'passed':passed and unchanged,'nodeTests':node,'pythonTests':python,'total':node+python,'sourceFilesUnchanged':unchanged,'protectedSourceFiles':len(before),'productionEnabled':False,'scope':'isolated derivative of original Aurabot host.js + module kernel + Hub/parser mounted in real Cordis with actual TimerService, SessionController/AgentLoop/SessionStore/JSONL; synthetic persona/memory/config, offline model and OneBot transport; process/UI/bridge/commands/persona dependencies are test doubles; no real QQ/model network calls'}
 summary.update(productionReady=False,combination='15 upstream-derived builtins + 9 custom modules + managed heartbeat, synthetic I/O',cosyvoiceProtocolValidated=True,realCosyVoiceServiceTested=False,knownFunctionalGaps=['unreviewed OneBot segment types not adapted','actual production DSH/profile cutover and return not validated','actual OneBot delivery and CosyVoice listening/GPU-watcher behaviour not tested'])
 (reports/'ACCEPTANCE-SUMMARY.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2),encoding='utf-8')
 print(json.dumps(summary));sys.exit(0 if summary['passed'] else 1)
if __name__=='__main__':main()
