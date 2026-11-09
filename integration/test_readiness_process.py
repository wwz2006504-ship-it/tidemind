import hashlib,importlib.util,json,tempfile,unittest
from pathlib import Path
spec=importlib.util.spec_from_file_location('readiness',Path(__file__).with_name('connection-readiness.py'));module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)

class ReadinessTests(unittest.TestCase):
 def test_semantic_persona_comparison_matches_original_frontmatter_format(self):
  text='---\nname: synthetic\ntags: [one, two]\n---\n\nSYNTHETIC BODY\n'
  self.assertEqual(module.parse_persona(text,'slot'),{'name':'synthetic','tags':['one','two'],'body':'SYNTHETIC BODY'})
 def test_recall_metadata_is_distinguished_from_memory_content(self):
  old=[{'id':'a','text':'private','hits':0,'lastHit':0}];new=[{'id':'a','text':'private','hits':1,'lastHit':10}]
  result=module.compare_records(old,new);self.assertEqual(result['added'],0);self.assertEqual(result['removed'],0);self.assertEqual(result['changedKnownFieldCounts'],{'hits':1,'lastHit':1})
 def test_unknown_field_names_are_not_disclosed(self):
  result=module.compare_records([{'id':'a','PRIVATE FIELD':1}],[{'id':'a','PRIVATE FIELD':2}])
  self.assertEqual(result['changedOtherFields'],1);self.assertNotIn('PRIVATE',json.dumps(result))
 def test_inventory_hashes_existing_persona_without_leaking_content_or_credentials(self):
  with tempfile.TemporaryDirectory() as name:
   root=Path(name);(root/'personas').mkdir();(root/'personas/xiyu.md').write_text('PRIVATE PERSONA',encoding='utf-8');(root/'config.json').write_text(json.dumps({'persona':{'current':'xiyu'},'token':'SECRET TOKEN'}),encoding='utf-8');(root/'memories.json').write_text('[{"text":"PRIVATE MEMORY"}]',encoding='utf-8')
   before={p:hashlib.sha256(p.read_bytes()).hexdigest() for p in root.rglob('*') if p.is_file()}
   first=module.inspect_data(root);second=module.inspect_data(root)
   self.assertEqual(first,second);self.assertEqual(first['jsonMemory']['items'],1);self.assertTrue(first['selectedPersona']['exists'])
   text=json.dumps(first);self.assertNotIn('PRIVATE',text);self.assertNotIn('SECRET TOKEN',text)
   self.assertEqual(before,{p:hashlib.sha256(p.read_bytes()).hexdigest() for p in root.rglob('*') if p.is_file()})
 def test_missing_selected_persona_does_not_create_or_substitute_another(self):
  with tempfile.TemporaryDirectory() as name:
   root=Path(name);(root/'config.json').write_text('{"persona":{"current":"missing"}}',encoding='utf-8')
   result=module.inspect_data(root);self.assertFalse(result['selectedPersona']['exists']);self.assertFalse((root/'personas').exists())
 def test_invalid_selected_id_never_traverses_parent(self):
  with tempfile.TemporaryDirectory() as name:
   root=Path(name);(root/'config.json').write_text('{"persona":{"current":"../outside"}}',encoding='utf-8')
   result=module.inspect_data(root);self.assertFalse(result['selectedPersona']['selectionValid']);self.assertFalse(result['selectedPersona']['exists'])
if __name__=='__main__':unittest.main()
