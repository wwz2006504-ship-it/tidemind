"""Start or stop the owned, loopback-only cloud QQ gateway staging container."""

import argparse
import json
from pathlib import Path
import subprocess
import time
import urllib.error
import urllib.request


ROOT = Path('/srv/tidemind-staging/onebot-gateway')
OWNER = 'TideMind isolated cloud OneBot gateway v1'
NAME = 'tidemind-onebot-stage'
IMAGE = 'ghcr.io/napneko/nodenapcat@sha256:c8b726cb6e8e73d80b362afd7ab92c090b8a3ca25913c3003491215fab2ba0ed'
PORTS = {6099: 16099, 3000: 13000, 3001: 13001}


def run(rollback=False, dry_run=False):
    plan = {'container': NAME, 'image': IMAGE, 'loopbackPorts': PORTS,
            'dryRun': dry_run, 'rollback': rollback, 'productionEnabled': False}
    if dry_run:
        return plan
    if ROOT.resolve() != ROOT or (ROOT / 'OWNER').read_text() != OWNER:
        raise ValueError('owned staging root required')
    pin = json.loads((ROOT / 'image-pin.json').read_text())
    if pin['image'] != IMAGE:
        raise ValueError('staged image pin differs')
    prefix = ['podman', '--root', str(ROOT / 'storage'), '--runroot', str(ROOT / 'runroot'),
              '--storage-driver', 'vfs']

    def podman(*args, check=True):
        return subprocess.run([*prefix, *args], capture_output=True, text=True,
                              check=check, timeout=45)

    existing = podman('container', 'exists', NAME, check=False)
    if existing.returncode not in (0, 1):
        raise RuntimeError('cannot verify gateway container ownership')
    if existing.returncode == 0:
        info = json.loads(podman('inspect', NAME).stdout)[0]
        if info['Config']['Labels'].get('org.tidemind.owner') != OWNER or info['Image'] != pin['id']:
            raise ValueError('gateway ownership or image differs')
        if rollback:
            if info['State']['Running']:
                podman('stop', '--time', '5', NAME)
            return plan | {'running': False, 'volumesPreserved': True}
        bindings = info['HostConfig']['PortBindings']
        expected = {f'{port}/tcp': [{'HostIp': '127.0.0.1', 'HostPort': str(host)}]
                    for port, host in PORTS.items()}
        if bindings != expected:
            raise ValueError('gateway port bindings differ from reviewed loopback plan')
        if not info['State']['Running']:
            podman('start', NAME)
    elif rollback:
        return plan | {'running': False, 'volumesPreserved': True}
    else:
        args = ['run', '--detach', '--pull=never', '--name', NAME, '--restart=no',
                '--label', 'org.tidemind.owner=' + OWNER, '--cap-drop=ALL',
                '--security-opt=no-new-privileges', '--pids-limit=256', '--memory=2g', '--cpus=2',
                '--volume', 'tidemind-stage-qq:/app/.config/QQ',
                '--volume', 'tidemind-stage-onebot:/app/napcat/config']
        for port, host in PORTS.items():
            args.extend(['--publish', f'127.0.0.1:{host}:{port}'])
        podman(*args, IMAGE)

    for _ in range(20):
        try:
            with urllib.request.urlopen('http://127.0.0.1:16099/webui/', timeout=1) as response:
                if response.status == 200:
                    return plan | {'running': True, 'webUiReachable': True, 'loginVerified': False}
        except urllib.error.HTTPError as error:
            if error.code in (401, 403):
                return plan | {'running': True, 'webUiReachable': True, 'loginVerified': False}
        except OSError:
            pass
        time.sleep(1)
    podman('stop', '--time', '5', NAME)
    raise RuntimeError('gateway WebUI did not become reachable; owned container stopped')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--dry-run', action='store_true')
    parser.add_argument('--rollback', action='store_true')
    options = parser.parse_args()
    print(json.dumps(run(options.rollback, options.dry_run)))
