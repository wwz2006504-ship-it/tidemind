import json,os,queue,shutil,subprocess,threading,unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
class QQCrashTests(unittest.TestCase):
 def test_real_process_dies_after_send_before_ack_and_restart_never_resends(self):
  self.run_crash('crash-window','recover','sent-before-ACK',{'state':'unknown','wireAttempts':1,'parts':['unknown']})
 def test_real_process_dies_after_durable_admission_and_restart_confirms_without_resubmit(self):
  self.run_crash('crash-admission','recover-admission','durable-before-authority-ack',{'states':['accepted'],'stages':['admitted'],'attempts':1})
 def run_crash(self,mode,recovery,phase,expected):
  env=dict(os.environ,TIDEMIND_QQ_TEST_MODE=mode)
  child=subprocess.Popen(['node',str(ROOT/'integration/qq-process-child.mjs')],env=env,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,encoding='utf-8')
  messages=queue.Queue();root=None
  def reader():
   for line in child.stdout:
    try:messages.put(json.loads(line))
    except ValueError:pass
  reader_thread=threading.Thread(target=reader,daemon=True);reader_thread.start()
  try:
   ready=messages.get(timeout=10);self.assertEqual(ready['phase'],phase)
   root=Path(ready['root']).resolve();data=(ROOT/'data').resolve()
   self.assertTrue(root.is_relative_to(data));self.assertNotEqual(root,data)
   child.terminate();child.wait(timeout=5)
   restored=subprocess.run(['node',str(ROOT/'integration/qq-process-child.mjs')],env=dict(os.environ,TIDEMIND_QQ_TEST_MODE=recovery,TIDEMIND_QQ_TEST_ROOT=str(root)),capture_output=True,text=True,encoding='utf-8',timeout=10)
   self.assertEqual(restored.returncode,0,restored.stderr)
   result=json.loads(restored.stdout.strip().splitlines()[-1])
   self.assertEqual(result,expected)
  finally:
   if child.poll() is None:child.terminate();child.wait(timeout=5)
   reader_thread.join(timeout=1)
   child.stdout.close()
   if root is not None:
    # Verify the exact resolved target before recursive cleanup, one runtime only.
    self.assertTrue(root.is_relative_to((ROOT/'data').resolve()));self.assertNotEqual(root,(ROOT/'data').resolve())
    shutil.rmtree(root)
