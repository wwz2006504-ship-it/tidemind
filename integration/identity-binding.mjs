// Read-only bridge to the selected original persona. No seeding or fallback.
import {readFileSync,realpathSync} from 'node:fs'
import {resolve,relative,isAbsolute} from 'node:path'
import {createHash} from 'node:crypto'
import {parsePersona,rulesText} from '../host/aurabot-upstream/src/persona/personas.js'
const sha=b=>createHash('sha256').update(b).digest('hex')
export function createIdentityBinding({directory,selected,expectedSha256}){
 if(typeof selected!=='string'||! /^[a-zA-Z0-9_-]{1,40}$/.test(selected))throw Error('invalid selected persona')
 if(!/^[a-f0-9]{64}$/.test(expectedSha256||''))throw Error('reviewed persona fingerprint required')
 const root=realpathSync(directory)
 function read(id=selected){
  if(id!==selected)throw Error('unreviewed persona selection')
  const file=realpathSync(resolve(root,selected+'.md')),rel=relative(root,file)
  if(!rel||rel.startsWith('..')||isAbsolute(rel))throw Error('persona outside reviewed directory')
  const raw=readFileSync(file)
  if(sha(raw)!==expectedSha256)throw Error('persona changed; review identity binding')
  const p=parsePersona(selected,raw.toString('utf8'))
  if(!p.body)throw Error('selected persona empty')
  return {...p,raw:raw.toString('utf8')}
 }
 read()
 const denied=()=>{throw Error('original persona is read-only; no write performed')}
 return Object.freeze({
  readPersona:read,currentPersonaText:id=>read(id).body,
  listPersonas:()=>{const p=read();return [{id:p.id,name:p.name,tags:p.tags,chars:p.body.length}]},
  savePersona:denied,deletePersona:denied,seedPersonas:()=>{read()},rulesText,
  inspect:()=>{read();return {selected,sha256:expectedSha256,originalReadOnly:true,fallback:false}},
 })
}
