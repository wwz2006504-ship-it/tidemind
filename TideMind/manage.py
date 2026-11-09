"""Single administrative CLI. Never creates a replacement lease/reconcile/API.
Rollback: python manage.py rollback --dry-run (no production mutations exist).
"""
import argparse
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

ROOT=Path(__file__).resolve().parent

def check_compose(path):
    doc=json.loads(path.read_text(encoding='utf-8-sig'))
    volumes=doc.get('volumes',{})
    for name, opts in volumes.items():
        if name!='tidemind_shadow' or opts not in ({},None):
            raise ValueError('only internal named shadow volume allowed')
    for service in doc['services'].values():
        for mount in service.get('volumes',[]):
            if not isinstance(mount,dict) or mount.get('type')!='volume' or mount.get('source')!='tidemind_shadow':
                raise ValueError('host/bind/external volumes prohibited')
        if service.get('privileged') or service.get('devices') or service.get('volumes_from'):
            raise ValueError('host privilege prohibited')
    if 'E:\\DSH\\memory-layers'.lower() in json.dumps(doc).lower():
        raise ValueError('production path prohibited')
    return 'PASS: named shadow volume only; no host bind mounts'

def main():
    p=argparse.ArgumentParser()
    p.add_argument('action',choices=['check','test','diagnose','lease','reconcile','api','rollback'])
    p.add_argument('--dry-run',action='store_true')
    p.add_argument('--operation',default='run')
    args=p.parse_args()
    if args.action=='check':
        print(check_compose(ROOT/'deploy/compose.yaml'));return
    if args.action=='rollback':
        print('NO-OP: offline research never changes production; preserve outputs and reports.');return
    if args.action=='diagnose':
        if args.dry_run:
            print('PLAN: revised ORIGINAL reconcile.mjs; both databases read-only; new report in docs');return
        env=dict(os.environ,TIDEMIND_LIVE_DB='<MEMORY_LAYERS_DIR>/memory.db',
            TIDEMIND_DB='C:/Users/USERNAME/Aurabot/qq-chats/tidemind-shadow/memory-shadow.db',
            TIDEMIND_REPORT=str(ROOT/'docs/reconcile-current.json'))
        result=subprocess.run(['node',str(ROOT/'deploy/existing/reconcile.mjs')],env=env)
        raise SystemExit(result.returncode)
    if args.action=='test':
        if args.dry_run:
            print('PLAN: synthetic unittest suite; temporary databases only');return
        subprocess.run([sys.executable,'-m','unittest','-v','test_entries'],cwd=ROOT,check=True)
        subprocess.run(['node','--test','--test-isolation=none','test_upgrade.mjs'],cwd=ROOT,check=True);return
    manifest=json.loads((ROOT/'existing-entries.json').read_text(encoding='utf-8-sig'))
    entry=manifest[args.action]
    if not entry['path'] or not entry['sha256']:
        raise SystemExit('BLOCKED: existing entry path/hash/interface not supplied; no substitute launched')
    configured=Path(entry['path'])
    path=(configured if configured.is_absolute() else ROOT/configured).resolve()
    if hashlib.sha256(path.read_bytes()).hexdigest()!=entry['sha256']:
        raise SystemExit('BLOCKED: reviewed entry hash changed')
    command=entry['commands'].get(args.operation)
    if not isinstance(command,list) or not all(isinstance(s,str) for s in command):
        raise SystemExit('BLOCKED: reviewed argument vector missing')
    if args.dry_run:
        print(json.dumps({'entry':args.action,'operation':args.operation,'status':'validated, not executed'}));return
    if command != ['--dry-run']:
        raise SystemExit('BLOCKED: only revised original dry-run is approved by offline acceptance')
    subprocess.run(['node',str(path),*command],check=True)

if __name__=='__main__': main()

