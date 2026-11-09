import json,os,queue,shutil,subprocess,threading,unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
class TaskProcessTests(unittest.TestCase):
 def test_checkpoint_and_rest_survive_process_termination_without_repeating_observe(self):
  script=ROOT/'integration/task-process-child.mjs'
  child=subprocess.Popen(['node',str(script)],env=dict(os.environ,TIDEMIND_TASK_TEST_MODE='checkpoint'),stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,encoding='utf-8')
  messages=queue.Queue();root=None
  def reader():
   for line in child.stdout:
    try:messages.put(json.loads(line))
    except ValueError:pass
  thread=threading.Thread(target=reader,daemon=True);thread.start()
  try:
   ready=messages.get(timeout=15);self.assertEqual(ready['phase'],'checkpoint-ready')
   root=Path(ready['root']).resolve();data=(ROOT/'data').resolve();self.assertTrue(root.is_relative_to(data));self.assertNotEqual(root,data)
   child.terminate();child.wait(timeout=5)
   result=subprocess.run(['node',str(script)],env=dict(os.environ,TIDEMIND_TASK_TEST_MODE='resume',TIDEMIND_TASK_TEST_ROOT=str(root)),capture_output=True,text=True,encoding='utf-8',timeout=15)
   self.assertEqual(result.returncode,0,result.stderr)
   value=json.loads(result.stdout.strip().splitlines()[-1])
   self.assertEqual(value,{'restBefore':1,'phaseBefore':1,'spentBefore':2,'stateAfter':'done','spentAfter':5,'calls':['reflect','plan','verify']})
  finally:
   if child.poll() is None:child.terminate();child.wait(timeout=5)
   thread.join(timeout=1);child.stdout.close()
   if root is not None:
    self.assertTrue(root.is_relative_to((ROOT/'data').resolve()));self.assertNotEqual(root,(ROOT/'data').resolve());shutil.rmtree(root)
