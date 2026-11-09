"""Read-only live inventory; reports contain hashes and counts, never credential/persona text.
--dry-run prints the same inspection without saving a report; --rollback is a no-op.
This script never enables plugins, writes databases, or calls a live persona helper.
"""
import argparse,hashlib,json,os,re,sys,sqlite3,collections
from urllib.parse import urlsplit
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
def digest(data):return hashlib.sha256(data).hexdigest()
def parse_persona(raw,selected):
 text=raw.lstrip('\ufeff');result={'name':selected,'tags':[]}
 match=re.match(r'^---\r?\n([\s\S]*?)\r?\n---\r?\n?',text)
 if match:
  for line in match[1].splitlines():
   kv=re.match(r'^(\w+):\s*(.*)$',line,flags=re.ASCII)
   if kv and kv[1]=='name':result['name']=kv[2].strip()
   if kv and kv[1]=='tags':result['tags']=[v.strip() for v in re.split('[,，]',re.sub(r'^\[|\]$','',kv[2])) if v.strip()]
  text=text[match.end():]
 result['body']=text.strip();return result

def compare_records(old,new):
 old={v['id']:v for v in old};new={v['id']:v for v in new};fields=collections.Counter()
 for key in old.keys()&new.keys():
  for field in old[key].keys()|new[key].keys():
   if old[key].get(field)!=new[key].get(field):fields[field]+=1
 # Field names are whitelisted: unknown user fields must not leak into the report.
 safe={'hits','lastHit','text','content','tags','status','valid_to','superseded_by','importance','about','aboutName','updatedAt','createdAt'}
 return {'added':len(new.keys()-old.keys()),'removed':len(old.keys()-new.keys()),'changedKnownFieldCounts':{k:v for k,v in fields.items() if k in safe},'changedOtherFields':sum(v for k,v in fields.items() if k not in safe)}

def inspect_known_backups(directory):
 directory=Path(directory);versions=directory/'modules-data/xiyu-self-control/versions'
 result={'comparisonOnly':True,'restorePerformed':False}
 config=json.loads((directory/'config.json').read_text(encoding='utf-8-sig'));selected=config['persona']['current']
 if re.fullmatch(r'[a-zA-Z0-9_-]{1,40}',selected) is None:raise ValueError('invalid persona')
 persona=list(versions.glob('5d61cef4*.data'));memory=list(versions.glob('3918cb01*.data'))
 if len(persona)==1:
  old=json.loads(persona[0].read_text(encoding='utf-8-sig'));new=parse_persona((directory/'personas'/(selected+'.md')).read_text(encoding='utf-8-sig'),selected)
  result['personaBackup']={'versionId':persona[0].stem,'format':'JSON name/tags/body, not raw Markdown','semanticEqual':old==new}
 if len(memory)==1:
  old=json.loads(memory[0].read_text(encoding='utf-8-sig'));new=json.loads((directory/'memories.json').read_text(encoding='utf-8-sig'))
  result['jsonMemoryBackup']={'versionId':memory[0].stem,'backupItems':len(old['items']),'currentItems':len(new['items']),**compare_records(old['items'],new['items'])}
 # Only the named standalone BACKUP is opened, never the live SQLite database.
 backup=Path('<MEMORY_LAYERS_DIR>/backups/memory-20261102-192324-manual.db')
 if backup.is_file():
  connection=sqlite3.connect(backup.as_uri()+'?mode=ro&immutable=1',uri=True)
  try:result['sqliteBackup']={'path':str(backup),'quickCheck':connection.execute('pragma quick_check').fetchone()[0],'memories':connection.execute('select count(*) from memories').fetchone()[0],'liveDatabaseCompared':False}
  finally:connection.close()
 ledger=Path.home()/'.dsh/ai-memory/ledger.jsonl'
 if ledger.is_file():
  content=ledger.read_bytes();valid=invalid=0
  for line in content.splitlines():
   if not line.strip():continue
   try:json.loads(line);valid+=1
   except ValueError:invalid+=1
  result['independentLedger']={'defaultPath':str(ledger),'runtimePathVerified':False,'bytes':len(content),'sha256':digest(content),'validJsonLines':valid,'invalidJsonLines':invalid,'runtimeWritesVerified':False}
 profile=Path.home()/'.dsh/profiles/desktop/package.json'
 bundles=json.loads(profile.read_text(encoding='utf-8-sig')).get('dsh',{}).get('profile',{}).get('bundles',[])
 result['profileBundleCount']=len(bundles)
 result['profileBundleNames']=bundles
 result['customModuleDirectories']=sorted(p.name for p in (directory/'modules').iterdir() if p.is_dir() and not p.name.startswith(('.','_')))
 result['customModuleStaticAudit']=[]
 for name in result['customModuleDirectories']:
  entry=next((directory/'modules'/name/n for n in ['index.mjs','index.js'] if (directory/'modules'/name/n).is_file()),None)
  if entry is None:continue
  content=entry.read_bytes();text=content.decode('utf-8-sig')
  result['customModuleStaticAudit'].append({'module':name,'entrySha256':digest(content),'runtimeTested':False,
   'markers':{label:bool(re.search(pattern,text)) for label,pattern in {
    'registersTools':r'api\.tool\(', 'managedTimers':r'api\.(every|later)\(',
    'nativeTimers':r'\b(setInterval|setTimeout)\(', 'processCalls':r'\b(spawn|execFile|exec|fork)\(',
    'fileWrites':r'\b(writeFileSync|appendFileSync|renameSync|unlinkSync)\(',
    'memoryInterfaces':r'lmem_|features/memory|memories\.json',
    'personaInterfaces':r'persona/personas|savePersona|currentPersona'}.items()}})
 return result
def inspect_data(directory):
 directory=Path(directory);config_path=directory/'config.json'
 raw=config_path.read_bytes();config=json.loads(raw.decode('utf-8-sig'))
 selected=config.get('persona',{}).get('current')
 persona={'exists':False,'selectionValid':isinstance(selected,str) and re.fullmatch(r'[a-zA-Z0-9_-]{1,40}',selected) is not None}
 observed={config_path:digest(raw)}
 if persona['selectionValid']:
  path=directory/'personas'/(selected+'.md')
  persona['exists']=path.is_file()
  if path.is_file():
   content=path.read_bytes();observed[path]=digest(content)
   persona.update(sha256=digest(content),bytes=len(content),nonempty=bool(content.decode('utf-8-sig').strip()))
 memory={'exists':False}
 path=directory/'memories.json'
 if path.is_file():
  content=path.read_bytes();observed[path]=digest(content);value=json.loads(content.decode('utf-8-sig'))
  memory={'exists':True,'sha256':digest(content),'bytes':len(content),'shape':'list' if isinstance(value,list) else 'object' if isinstance(value,dict) else 'other'}
  if isinstance(value,list):memory['items']=len(value)
  elif isinstance(value,dict) and isinstance(value.get('items'),list):memory['items']=len(value['items'])
 unchanged=all(p.is_file() and digest(p.read_bytes())==sha for p,sha in observed.items())
 voice=config.get('voice') or {};cosy=voice.get('cosyvoice') or {};endpoint=urlsplit(cosy.get('url') or '')
 voice_inventory={'engine':voice.get('engine'),'mode':cosy.get('mode'),'sampleRate':cosy.get('sampleRate'),
  'endpointHost':endpoint.hostname,'endpointPort':endpoint.port,'referenceExists':Path(cosy.get('refAudio') or '').is_file(),
  'localTtsOverrideEnabled':bool((config.get('local') or {}).get('tts')),
  'configurationSha256':digest(json.dumps(voice,sort_keys=True,ensure_ascii=False).encode('utf-8'))}
 return {'dataRoot':str(directory.resolve()),'runtimeDataRootVerified':False,'configSha256':digest(raw),
  'voice':voice_inventory,
  'selectedPersona':persona,'jsonMemory':memory,'filesStableDuringInspection':unchanged,
  'sideStores':{name:(directory/name).is_file() for name in ['speakup.json','mood.json','sessions.json','persona-evolution.jsonl']}}

def inspect_sources():
 source=Path.home()/'.dsh/profiles/desktop/node_modules/dsh-aurabot-qq/src'
 manifest=json.loads((ROOT/'host/aurabot/SOURCE-MANIFEST.json').read_text(encoding='utf-8'))
 mismatches=[]
 for name,row in manifest.items():
  p=source/name
  if not p.is_file() or digest(p.read_bytes())!=row['originalSha256']:mismatches.append(name)
 return {'originalAurabotFiles':len(manifest),'matchesReviewedVersion':not mismatches,'mismatches':mismatches}

def main():
 parser=argparse.ArgumentParser();parser.add_argument('--dry-run',action='store_true');parser.add_argument('--rollback',action='store_true');parser.add_argument('--data-root',type=Path);parser.add_argument('--audit-known-backups',action='store_true');args=parser.parse_args()
 if args.rollback:
  print('NO-OP: preparation never enabled or changed production. Preserve reports and lease/audit records.');return
 directory=args.data_root or Path(os.environ.get('AURABOT_DATA_DIR') or Path(os.environ.get('DSH_HOME') or Path.home()/'.dsh')/'plugins-data/aurabot')
 blockers=['Verify the running DSH data root and exact existing session/preset mappings.',
  'Bind existing persona read-only without seeding or fallback; test the original parser on synthetic fixtures.',
  'Keep original SQLite/JSON memories and persona untouched; bind reads only. Test any new writes solely in separate synthetic stores.',
  'Connect heartbeat/speakup to the existing authority and task lifecycle in the isolated host.',
  'Complete local cutover/return rehearsal and obtain user confirmation for production activation.']
 try:
  inventory=inspect_data(directory);sources=inspect_sources()
  if not inventory['selectedPersona'].get('exists') or not inventory['selectedPersona'].get('nonempty'):blockers.insert(0,'Selected persona missing or empty: stop; never substitute a default persona.')
  if not inventory['filesStableDuringInspection']:blockers.insert(0,'Files changed while inspecting: stop and inspect again.')
  if not sources['matchesReviewedVersion']:blockers.insert(0,'Live source changed since review: re-review before connection.')
  report={'readOnly':True,'productionEnabled':False,'readyForProduction':False,'inventory':inventory,'sources':sources,'blockers':blockers}
  if args.audit_known_backups:report['knownBackupAudit']=inspect_known_backups(directory)
 except (OSError,ValueError,TypeError,AttributeError) as error:
  # Do not echo exception text: JSON parse errors and file errors may include private data.
  report={'readOnly':True,'productionEnabled':False,'readyForProduction':False,'error':type(error).__name__,'blockers':['Inventory unavailable: stop; do not seed, repair or fall back.']}
 text=json.dumps(report,ensure_ascii=False,indent=2)
 if not args.dry_run:
  reports=ROOT/'reports';reports.mkdir(exist_ok=True);target=reports/'CONNECTION-READINESS.json'
  # Avoid replacing the report on an identical rerun.
  if not target.exists() or target.read_text(encoding='utf-8')!=text:target.write_text(text,encoding='utf-8')
 print(text)
 if 'error' in report:sys.exit(1)
if __name__=='__main__':main()
