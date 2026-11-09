"""Prepare/install only a named synthetic cloud authority using ORIGINAL lease.mjs serve.
Preview: python3 cloud-authority-lab.py --digest <sha> --dry-run
Prepare: same args --prepare (staging only; no system service installation)
Install: same args --install --review-sha <prepared review hash>, AFTER user approval.
Rollback: same args --rollback (stop/disable only owned lab unit, keep all data).
"""
import argparse,hashlib,json,os,re,subprocess
from pathlib import Path
STAGING=Path('/srv/tidemind-staging');LAB=STAGING/'authority-lab';NODE=STAGING/'runtime/node-v24.17.0-linux-x64/node';UNIT=Path('/etc/systemd/system/tidemind-authority-lab.service');TAG='# TideMind isolated authority lab v1'
def unit_text(source):return f'''{TAG}
[Unit]
Description=TideMind synthetic authority lab (no production QQ or memories)
After=network.target
[Service]
Type=simple
User=root
WorkingDirectory={source}
EnvironmentFile={LAB}/authority.env
ExecStart={NODE} {source}/TideMind/deploy/existing/lease.mjs serve
Restart=on-failure
RestartSec=3
TimeoutStopSec=10
UMask=0077
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
RestrictRealtime=yes
LockPersonality=yes
CapabilityBoundingSet=
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
IPAddressDeny=any
IPAddressAllow=localhost
ReadWritePaths={LAB}
MemoryMax=256M
TasksMax=64
LimitNOFILE=256
[Install]
WantedBy=multi-user.target
'''
def sha(b):return hashlib.sha256(b).hexdigest()
def run(args):
 if not re.fullmatch('[a-f0-9]{64}',args.digest):raise ValueError('candidate SHA required')
 source=STAGING/'candidates'/args.digest/'source';text=unit_text(source)
 plan={'dryRun':args.dry_run,'prepare':args.prepare,'install':args.install,'rollback':args.rollback,'source':str(source),'labRoot':str(LAB),'unit':str(UNIT),'unitSha256':sha(text.encode()),'listen':'127.0.0.1:5191','productionEnabled':False,'realQQ':False,'systemPathChanged':False}
 if args.dry_run:return plan
 if STAGING.is_symlink() or (STAGING/'OWNER').read_text()!='TideMind candidate staging v1':raise ValueError('owned staging root required')
 if source.is_symlink() or not source.resolve().is_relative_to(STAGING.resolve()) or LAB.is_symlink() or UNIT.is_symlink():raise ValueError('unsafe lab paths')
 owner=LAB/'OWNER'
 if LAB.exists() and (owner.is_symlink() or not owner.is_file() or owner.read_text()!='TideMind isolated authority lab v1'):raise ValueError('unowned lab')
 if args.rollback:
  if UNIT.exists():
   if not UNIT.read_text().startswith(TAG+'\n'):raise ValueError('unit not owned; refuse stop')
   subprocess.run(['systemctl','disable','--now',UNIT.name],check=True,capture_output=True,text=True)
  return plan|{'dataPreserved':True,'unitRetained':True,'productionChanged':False}
 if not args.prepare and not args.install:raise ValueError('explicit --prepare or --install required')
 if (source.parent/'DISABLED').exists() or not NODE.is_file():raise ValueError('active source candidate and isolated Node required')
 manifest=json.loads((source/'MANIFEST-SHA256.json').read_text())
 for name,digest in manifest.items():
  f=source/name
  if f.is_symlink() or not f.resolve().is_relative_to(source.resolve()) or sha(f.read_bytes())!=digest:raise ValueError('candidate source drift')
 if args.retarget_uninstalled and not args.prepare:raise ValueError('uninstalled retarget is preparation only')
 initArgs=[str(NODE),str(source/'integration/authority-lab-init.mjs')]+(['--retarget-uninstalled'] if args.retarget_uninstalled else [])
 init=subprocess.run(initArgs,capture_output=True,text=True,timeout=20)
 if init.returncode:raise ValueError('authority baseline preparation failed; retained for review')
 env=LAB/'authority.env';config=json.loads((LAB/'lab-config.json').read_text())
 if env.is_symlink() or sha(env.read_bytes())!=config['environmentSha256']:raise ValueError('lab private environment changed')
 prepared=LAB/'tidemind-authority-lab.service'
 if prepared.is_symlink():raise ValueError('unit preview link refused')
 prepared.write_text(text);prepared.chmod(0o600)
 review=sha((plan['unitSha256']+config['environmentSha256']+args.digest).encode())
 if args.prepare:return plan|{'prepared':True,'reviewSha256':review,'servicesChanged':False,'privateValuesPrinted':False}
 if args.review_sha!=review:raise ValueError('exact prepared review hash required before installation')
 if UNIT.exists() and UNIT.read_text()!=text:raise ValueError('existing unit differs; review upgrade before replacement')
 if not UNIT.exists():
  with UNIT.open('x') as f:f.write(text)
  UNIT.chmod(0o644)
 subprocess.run(['systemctl','daemon-reload'],check=True,capture_output=True,text=True)
 subprocess.run(['systemctl','enable','--now',UNIT.name],check=True,capture_output=True,text=True)
 return plan|{'installed':True,'servicesChanged':True,'reviewSha256':review}
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--digest',required=True);p.add_argument('--dry-run',action='store_true');g=p.add_mutually_exclusive_group();g.add_argument('--prepare',action='store_true');g.add_argument('--install',action='store_true');g.add_argument('--rollback',action='store_true');p.add_argument('--review-sha');p.add_argument('--retarget-uninstalled',action='store_true')
 try:print(json.dumps(run(p.parse_args())))
 except Exception as e:raise SystemExit(type(e).__name__+': '+str(e))
