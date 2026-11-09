// Original persona is an immutable base. Native edit/restore APIs append versions here.
import {readFileSync,writeFileSync,renameSync,existsSync,realpathSync,statSync} from 'node:fs'
import {resolve,dirname,basename,relative,isAbsolute} from 'node:path'
import {createHash,randomUUID} from 'node:crypto'
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex')
export function createPersonaVersions({identity,ownedRoot,stateFile,withWriteGuard}){
 if(typeof withWriteGuard!=='function'||identity?.inspect?.().originalReadOnly!==true)throw Error('immutable original identity and write guard required')
 const inspected=identity.inspect(),selected=inspected.selected,baseHash=inspected.sha256,root=realpathSync(ownedRoot),parent=realpathSync(dirname(stateFile)),file=resolve(parent,basename(stateFile)),rel=relative(root,file)
 if(!rel||rel.startsWith('..')||isAbsolute(rel))throw Error('persona versions outside owned root')
 function pathGuard(){if(realpathSync(dirname(file))!==parent||existsSync(file)&&realpathSync(file)!==file)throw Error('persona version path changed')}
 const fields=p=>({id:p.id,name:p.name,tags:p.tags,body:p.body})
 function state(){
  const base=identity.readPersona(selected);pathGuard()
  if(!existsSync(file))return {base,versions:[]}
  if(statSync(file).size>16*1024*1024)throw Error('persona version journal too large')
  const s=JSON.parse(readFileSync(file,'utf8'));if(s.format!=='tidemind-persona-v1'||s.baseHash!==baseHash||s.selected!==selected||!Array.isArray(s.versions))throw Error('persona version baseline mismatch')
  let previous=baseHash
  for(let i=0;i<s.versions.length;i++){
   const v=s.versions[i];if(v.revision!==i+1||v.previous!==previous||v.persona?.id!==selected||!v.persona.body?.trim()||!Array.isArray(v.persona.tags)||typeof v.persona.name!=='string'||v.hash!==hash([v.revision,v.previous,v.persona]))throw Error('persona version chain changed')
   previous=v.hash
  }
  return {base,versions:s.versions}
 }
 function read(id=selected){
  if(id!==selected)throw Error('unreviewed persona selection')
  const s=state(),p=s.versions.at(-1)?.persona
  if(!p)return s.base
  return {...structuredClone(p),raw:`---\nname: ${p.name}\ntags: [${p.tags.join(', ')}]\n---\n\n${p.body}\n`}
 }
 function save(id,input){return withWriteGuard(()=>{
  if(id!==selected)throw Error('unreviewed persona selection')
  const s=state(),p={id:selected,name:String(input?.name||selected).replace(/[\r\n]/g,' '),tags:(input?.tags||[]).map(String),body:String(input?.body||'').trim()}
  if(!p.body||p.body.length>40000||p.name.length>200||p.tags.length>50||p.tags.some(t=>t.length>200||/[\r\n]/.test(t)))throw Error('invalid persona version')
  if(JSON.stringify(fields(s.versions.at(-1)?.persona||s.base))===JSON.stringify(p))return read(id)
  const revision=s.versions.length+1,previous=s.versions.at(-1)?.hash||baseHash
  const version={revision,previous,persona:p,hash:hash([revision,previous,p])}
  const bytes=JSON.stringify({format:'tidemind-persona-v1',selected,baseHash,versions:[...s.versions,version]})
  if(Buffer.byteLength(bytes)>16*1024*1024)throw Error('persona version journal too large')
  pathGuard();const tmp=file+'.tmp-'+randomUUID();writeFileSync(tmp,bytes,{flag:'wx',mode:0o600});renameSync(tmp,file)
  return read(id)
 })}
 return Object.freeze({readPersona:read,currentPersonaText:id=>read(id).body,savePersona:save,
  deletePersona:()=>{throw Error('original persona deletion prohibited')},seedPersonas:()=>{read()},rulesText:identity.rulesText,
  listPersonas:()=>{const p=read();return [{id:p.id,name:p.name,tags:p.tags,chars:p.body.length}]},
  inspect:()=>{const s=state();return {...identity.inspect(),overlayVersion:s.versions.length,currentHash:s.versions.at(-1)?.hash||baseHash,originalReadOnly:true}},
 })
}
