// History materialization for an OWNED OFFLINE candidate, using the installed DSH
// persistence API. This does not select a candidate, authorize a lease or pause a host.
import {mkdirSync,existsSync} from 'node:fs'
import {join,isAbsolute,win32,posix} from 'node:path'
import {hash} from '../TideMind/deploy/existing/tide-gateway.mjs'
import {checkedPath} from '../TideMind/deploy/existing/tide-replica.mjs'
const MAX_BYTES=32*1024*1024,MAX_EVENTS=100000

// Adapt only cwd at the native SDK boundary. The signed header remains canonical.
export function mapSessionWorkspaces(persistence,headers,workspaceRoot){
 const mapped=new Map()
 workspaceRoot=checkedPath(workspaceRoot)
 mkdirSync(workspaceRoot,{recursive:true,mode:0o700})
 for(const original of headers){
  if(original.cwd===undefined)continue
  const nativeAbsolute=isAbsolute(original.cwd)&&(process.platform!=='win32'||/^(?:[a-z]:[\\/]|[\\/]{2})/i.test(original.cwd))
  if(nativeAbsolute)continue
  if(!win32.isAbsolute(original.cwd)&&!posix.isAbsolute(original.cwd))throw Error('original session cwd is not absolute')
  const cwd=checkedPath(join(workspaceRoot,hash(original)))
  mkdirSync(cwd,{mode:0o700,recursive:true})
  mapped.set(original.id,{original,native:{...original,cwd}})
 }
 async function wrap(handle,mapping){
  if(!mapping)return handle
  if(hash(handle.header)!==hash(mapping.native)){await handle.close();throw Error('mapped native session header differs')}
  return new Proxy(handle,{get(target,key){if(key==='header')return structuredClone(mapping.original);const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value}})
 }
 return {
  open:async(id,...args)=>wrap(await persistence.open(id,...args),mapped.get(id)),
  async create(header){
   const mapping=mapped.get(header.id)
   if(mapping&&hash(header)!==hash(mapping.original))throw Error('canonical session header differs')
   return wrap(await persistence.create(mapping?.native||header),mapping)
  },
 }
}
export function checkedSessionSnapshot(input){
 const raw=JSON.stringify(input);if(!raw||Buffer.byteLength(raw)>MAX_BYTES)throw Error('bounded original session snapshot required')
 const s=JSON.parse(raw),h=s.header
 if(s.format!=='tidemind-session-history-v1'||typeof h?.id!=='string'||!h.id||h.id.length>200||h.isSeeded!==false||s.inheritedEventCount!==0||!Array.isArray(s.events)||s.events.length>MAX_EVENTS)throw Error('complete unseeded original session required')
 for(let i=0;i<s.events.length;i++)if(s.events[i]?.seq!==i||typeof s.events[i]?.type!=='string')throw Error('session history gap or invalid event')
 const body={format:s.format,header:h,inheritedEventCount:0,events:s.events}
 if(s.digest!==hash(body))throw Error('session history digest differs')
 return {...body,digest:s.digest}
}
export async function captureSessionHistory(persistence,sessionId){
 let reader
 try{
  reader=await persistence.open(sessionId,'read')
  if(reader.access!=='read'||reader.header.id!==sessionId||reader.inheritedEventCount!==0)throw Error('original non-inherited read handle required')
  const first=await reader.read(0,MAX_EVENTS+1),second=await reader.read(0,MAX_EVENTS+1)
  if(hash(first.events)!==hash(second.events))throw Error('session changed while capturing; stop and retry after drain')
  const body={format:'tidemind-session-history-v1',header:structuredClone(reader.header),inheritedEventCount:0,events:second.events}
  return checkedSessionSnapshot({...body,digest:hash(body)})
 }finally{await reader?.close()}
}
export function assertSessionHistoryExtension(base,next){
 base=checkedSessionSnapshot(base);next=checkedSessionSnapshot(next)
 if(hash(base.header)!==hash(next.header))throw Error('original session identity/header differs')
 if(base.events.length>next.events.length)throw Error('newer destination session must not be overwritten')
 if(hash(base.events)!==hash(next.events.slice(0,base.events.length)))throw Error('session history branch; stop without overwrite')
 return {baseDigest:base.digest,nextDigest:next.digest,appended:next.events.length-base.events.length}
}
export async function materializeSessionHistoryCandidate({root,source,expectedDigest,base,openPersistence,dryRun=false,generationId}){
 source=checkedSessionSnapshot(source)
 if(source.digest!==expectedDigest)throw Error('trusted source session digest differs')
 if(typeof openPersistence!=='function')throw Error('installed DSH persistence factory required')
 const extension=base?assertSessionHistoryExtension(base,source):{baseDigest:null,nextDigest:source.digest,appended:source.events.length}
 // A new immutable generation is created; neither base nor active session is edited.
 if(generationId!==undefined&&!/^[a-f0-9]{64}$/.test(generationId))throw Error('owned history generation identity required')
 root=checkedPath(root);const directory=join(root,generationId||source.digest)
 if(dryRun)return {dryRun:true,...extension,directory,selected:false}
 mkdirSync(root,{recursive:true,mode:0o700});checkedPath(root)
 if(!existsSync(directory))mkdirSync(directory,{mode:0o700});checkedPath(directory)
 const backend=await openPersistence(directory);let writer
 try{
  try{writer=await backend.persistence.open(source.header.id,'write')}
  catch(error){if(error?.name!=='SessionPersistenceNotFoundError')throw error;writer=await backend.persistence.create(source.header)}
  if(writer.access!=='write'||writer.inheritedEventCount!==0||hash(writer.header)!==hash(source.header))throw Error('candidate original session identity differs')
  const stored=(await writer.read(0,MAX_EVENTS+1)).events
  if(stored.length>source.events.length||hash(stored)!==hash(source.events.slice(0,stored.length)))throw Error('candidate history is newer or branched; stop')
  if(stored.length<source.events.length)await writer.append(source.events.slice(stored.length))
  await writer.flush();await writer.close();writer=null
  const verified=await captureSessionHistory(backend.persistence,source.header.id)
  if(verified.digest!==source.digest)throw Error('materialized original history differs')
  return {...extension,directory,digest:verified.digest,verified:true,selected:false}
 }finally{try{await writer?.close()}finally{await backend.close()}}
}
