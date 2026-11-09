"""Run a bounded CPU probe in the owned cloud staging directory."""

import argparse
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import time
import urllib.request
import wave


ROOT = Path('/srv/tidemind-staging/cosyvoice-cpu')
OWNER = 'TideMind isolated CosyVoice CPU probe v1'


def candidate_audio(candidate, endpoint, prompt):
    """Exercise the reviewed candidate binding against the live loopback service."""
    if len(candidate) != 64 or any(c not in '0123456789abcdef' for c in candidate):
        raise ValueError('candidate digest required')
    stage = ROOT.parent
    directory = stage / 'candidates' / candidate
    if directory.is_symlink() or (directory / 'OWNER').read_text() != candidate or (directory / 'DISABLED').exists():
        raise ValueError('reviewed active staging candidate required')
    source = (directory / 'source').resolve(strict=True)
    if source != directory / 'source':
        raise ValueError('candidate source path differs')
    script = '''
import {readFileSync, writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {bindCloudCosyVoice, createCosyVoiceBridge} from './integration/cosyvoice-bridge.mjs';
const [root,url,refAudio]=process.argv.slice(1);
const referenceSha256=createHash('sha256').update(readFileSync(refAudio)).digest('hex');
const cloudVoice=bindCloudCosyVoice({root,url,refAudio,referenceSha256});
const voice={engine:'cosyvoice',cosyvoice:{mode:'cross_lingual',sampleRate:22050}};
const tts=createCosyVoiceBridge({getConfig:()=>({voice}),isLocal:()=>false,cloudVoice});
const result=await tts.speak('你好。');
if(result.engine!=='cosyvoice')throw Error('unexpected voice engine');
writeFileSync(join(root,'result.wav'),readFileSync(result.file),{flag:'wx'});
'''
    with tempfile.TemporaryDirectory(prefix='candidate-voice-', dir=ROOT) as name:
        work = Path(name)
        ref = work / 'public-reference.wav'
        ref.write_bytes(prompt.read_bytes())
        home = work / 'home'
        home.mkdir()
        env = dict(os.environ, TIDEMIND_SANDBOX_ROOT=str(work),
                   TIDEMIND_AURABOT_DATA_ROOT=str(work / 'aurabot'), TIDEMIND_AURABOT_HOME=str(home))
        node = stage / 'runtime/node-v24.17.0-linux-x64/node'
        subprocess.run([str(node), '--input-type=module', '-e', script, name, endpoint, str(ref)],
                       env=env, cwd=source, check=True, timeout=125)
        with wave.open(str(work / 'result.wav'), 'rb') as wav:
            if (wav.getnchannels(), wav.getsampwidth(), wav.getframerate()) != (1, 2, 22050):
                raise ValueError('candidate output format differs')
            return wav.readframes(wav.getnframes())


def probe(reference=None, candidate=None, serve=False):
    if ROOT.is_symlink() or (ROOT / 'OWNER').read_text() != OWNER:
        raise ValueError('owned staging required')
    commit = json.loads((ROOT / 'source-pin.json').read_text())['commit']
    source = next((ROOT / 'source').glob('*-' + commit))
    matcha = json.loads((ROOT / 'matcha-pin.json').read_text())['source']
    model = json.loads((ROOT / 'model-pin.json').read_text())['modelDirectory']
    for path in (source, Path(matcha), Path(model)):
        if not path.resolve().is_relative_to(ROOT.resolve()):
            raise ValueError('staged dependency outside owned root')
    runner = '''
import importlib.util, socket, sys, tempfile
from pathlib import Path
from fastapi import File, Form, HTTPException, UploadFile
from fastapi.responses import Response
import torch, uvicorn
torch.set_num_threads(4)
torch.set_num_interop_threads(1)
spec = importlib.util.spec_from_file_location('staged_cosyvoice', sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.cosyvoice = module.AutoModel(model_dir=sys.argv[2])
if module.cosyvoice.sample_rate != 22050:
    raise ValueError('reviewed 300M sample rate differs')
# The pinned upstream route preloads a tensor. This model frontend expects a path.
module.app.router.routes[:] = [r for r in module.app.router.routes
                              if getattr(r, 'path', None) != '/inference_cross_lingual']
@module.app.post('/inference_cross_lingual')
def cross_lingual(tts_text: str = Form(), prompt_wav: UploadFile = File(), speed: float = Form(1)):
    sample = prompt_wav.file.read(20 * 1024 * 1024 + 1)
    if len(sample) > 20 * 1024 * 1024 or not 0 < len(tts_text) <= 40 or not 0.5 <= speed <= 2:
        raise HTTPException(status_code=400, detail='probe input exceeds limits')
    with tempfile.TemporaryDirectory(dir=sys.argv[4]) as work:
        path = Path(work) / 'prompt.wav'
        path.write_bytes(sample)
        audio = module.cosyvoice.inference_cross_lingual(tts_text, str(path), speed=speed)
        pcm = bytearray()
        for chunk in module.generate_data(audio):
            if len(pcm) + len(chunk) > 4194304:
                raise HTTPException(status_code=500, detail='probe audio exceeds limit')
            pcm.extend(chunk)
    return Response(bytes(pcm), media_type='application/octet-stream')
listener = socket.socket(fileno=int(sys.argv[3]))
uvicorn.Server(uvicorn.Config(module.app, access_log=False)).run(sockets=[listener])
'''
    env = dict(os.environ, PYTHONPATH=os.pathsep.join((str(source), matcha)),
               CUDA_VISIBLE_DEVICES='', OMP_NUM_THREADS='4', OPENBLAS_NUM_THREADS='2',
               MKL_NUM_THREADS='4', HF_HUB_OFFLINE='1', MPLCONFIGDIR=str(ROOT / 'matplotlib'),
               MODELSCOPE_CACHE=str(ROOT / 'modelscope-cache'), XDG_CACHE_HOME=str(ROOT / 'runtime-cache'))
    if serve:
        with socket.socket() as listener:
            listener.bind(('127.0.0.1', 15000))
            listener.listen(8)
            listener.set_inheritable(True)
            python = str(ROOT / 'venv/bin/python')
            os.chdir(source)
            os.execve(python, [python, '-c', runner,
                              str(source / 'runtime/python/fastapi/server.py'),
                              model, str(listener.fileno()), str(ROOT)], env)
    log = ROOT / 'smoke.log'
    if log.is_symlink():
        raise ValueError('staging log is a symlink')
    with socket.socket() as listener, log.open('wb') as stream:
        listener.bind(('127.0.0.1', 0))
        listener.listen(8)
        base = 'http://127.0.0.1:' + str(listener.getsockname()[1])
        child = subprocess.Popen(
            [str(ROOT / 'venv/bin/python'), '-c', runner,
             str(source / 'runtime/python/fastapi/server.py'), model, str(listener.fileno()), str(ROOT)],
            cwd=source, env=env, pass_fds=(listener.fileno(),), stdout=stream, stderr=stream)
        listener.close()
        try:
            deadline = time.monotonic() + 65
            while time.monotonic() < deadline:
                if child.poll() is not None:
                    raise RuntimeError('CosyVoice exited during startup; inspect smoke.log')
                try:
                    with urllib.request.urlopen(base + '/openapi.json', timeout=1) as response:
                        if '/inference_cross_lingual' in json.load(response)['paths']:
                            break
                except OSError:
                    time.sleep(1)
            else:
                raise TimeoutError('CosyVoice startup timed out')
            if reference is None:
                prompt = ROOT / 'public-probe-reference.wav'
                if prompt.is_symlink():
                    raise ValueError('staging reference is a symlink')
                with wave.open(str(source / 'asset/cross_lingual_prompt.wav'), 'rb') as original:
                    with wave.open(str(prompt), 'wb') as short:
                        short.setparams(original.getparams())
                        short.writeframes(original.readframes(4 * original.getframerate()))
            else:
                prompt = Path(reference).resolve(strict=True)
                if not prompt.is_relative_to(ROOT.resolve()) or not prompt.is_file():
                    raise ValueError('private reference must be in owned staging')
            start = time.monotonic()
            if candidate:
                if reference is not None:
                    raise ValueError('candidate probe accepts the public reference only')
                pcm = candidate_audio(candidate, base, prompt)
            else:
                response = subprocess.run(
                    ['curl', '-fsS', '--max-time', '115', '--max-filesize', '4194304',
                     '-F', 'tts_text=你好。', '-F', 'prompt_wav=@' + str(prompt),
                     base + '/inference_cross_lingual'], capture_output=True, check=True, timeout=120)
                pcm = response.stdout
            if len(pcm) < 2048 or len(pcm) % 2 or not any(pcm):
                raise ValueError('CosyVoice returned invalid or silent PCM')
            wav = ROOT / 'public-probe.wav' if reference is None else prompt.parent / 'reviewed-probe.wav'
            if wav.is_symlink():
                raise ValueError('staging audio is a symlink')
            with wave.open(str(wav), 'wb') as output:
                output.setparams((1, 2, 22050, 0, 'NONE', 'not compressed'))
                output.writeframes(pcm)
            return {'passed': True, 'engine': 'CosyVoice-300M', 'device': 'cpu',
                    'wavBytes': wav.stat().st_size, 'audioSeconds': round(len(pcm) / 44100, 2),
                    'synthesisSeconds': round(time.monotonic() - start, 2), 'publicReference': reference is None,
                    'candidateBinding': candidate}
        finally:
            if child.poll() is None:
                child.terminate()
                try:
                    child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait(timeout=5)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--dry-run', action='store_true')
    parser.add_argument('--rollback', action='store_true')
    parser.add_argument('--candidate')
    parser.add_argument('--serve', action='store_true')
    args = parser.parse_args()
    if args.dry_run or args.rollback:
        print(json.dumps({'dryRun': args.dry_run, 'rollback': args.rollback,
                          'persistentService': args.serve, 'stagingPreserved': True,
                          'endpoint': '127.0.0.1:15000' if args.serve else None}))
    else:
        print(json.dumps(probe(candidate=args.candidate, serve=args.serve)))
