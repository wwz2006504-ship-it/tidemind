// One continuous set of ORIGINAL DSH histories, including retired daily sessions.
import {hash} from '../TideMind/deploy/existing/tide-gateway.mjs'
import {captureSessionHistory,checkedSessionSnapshot,assertSessionHistoryExtension,materializeSessionHistoryCandidate,mapSessionWorkspaces} from './session-history-transfer.mjs'
export function createSessionHistoryBundle({sessions,mappings}){
 if(!Array.isArray(sessions)||sessions.length<1||sessions.length>1000||!mappings||typeof mappings!=='object'||Array.isArray(mappings))throw Error('bounded original histories and mappings required')
 const checked=sessions.map(checkedSessionSnapshot).sort((a,b)=>a.header.id.localeCompare(b.header.id)),ids=new Set(checked.map(s=>s.header.id))
 if(ids.size!==checked.length)throw Error('duplicate original session identity')
 const map=JSON.parse(JSON.stringify(mappings))
 for(const [chat,row]of Object.entries(map))if(!/^(private|group):[1-9]\d*$/.test(chat)&&chat!=='system:cognitive'||!ids.has(row?.sessionId)||!['aurabot-private','aurabot-social'].includes(row.preset)||!['full','social'].includes(row.level)||row.preset!==(row.level==='full'?'aurabot-private':'aurabot-social'))throw Error('original history mapping differs')
 if(!Object.keys(map).length)throw Error('original mapping required')
 const body={format:'tidemind-session-bundle-v1',sessions:checked,mappings:map}
 if(Buffer.byteLength(JSON.stringify(body))>32*1024*1024)throw Error('history bundle size limit')
 return {...body,digest:hash(body)}
}
export function checkedSessionHistoryBundle(value){const checked=createSessionHistoryBundle(value||{});if(value?.format!==checked.format||value.digest!==checked.digest)throw Error('history bundle digest differs');return checked}
export function assertSessionBundleExtension(base,next){
 base=checkedSessionHistoryBundle(base);next=checkedSessionHistoryBundle(next)
 const byId=new Map(next.sessions.map(s=>[s.header.id,s]));let appended=0
 for(const old of base.sessions){const current=byId.get(old.header.id);if(!current)throw Error('retired original session missing');appended+=assertSessionHistoryExtension(old,current).appended}
 for(const chat of Object.keys(base.mappings))if(!next.mappings[chat]||base.mappings[chat].preset!==next.mappings[chat].preset||base.mappings[chat].level!==next.mappings[chat].level)throw Error('original chat privilege mapping changed')
 return {baseDigest:base.digest,nextDigest:next.digest,appended}
}
export async function captureSessionHistoryBundle({persistence,mappings,previous}){
 if(previous)previous=checkedSessionHistoryBundle(previous)
 const ids=[...new Set([...(previous?.sessions.map(s=>s.header.id)||[]),...Object.values(mappings).map(r=>r.sessionId)])],sessions=[]
 for(const id of ids)sessions.push(await captureSessionHistory(persistence,id))
 const bundle=createSessionHistoryBundle({sessions,mappings});if(previous)assertSessionBundleExtension(previous,bundle);return bundle
}
export async function materializeSessionHistoryBundle({source,expectedDigest,base,root,openPersistence,dryRun=false,workspaceRoot}){
 source=checkedSessionHistoryBundle(source);if(source.digest!==expectedDigest)throw Error('trusted history bundle digest differs')
 if(base)assertSessionBundleExtension(base,source)
 const open=workspaceRoot?async directory=>{
  const backend=await openPersistence(directory)
  try{return {persistence:mapSessionWorkspaces(backend.persistence,source.sessions.map(s=>s.header),workspaceRoot),close:()=>backend.close()}}
  catch(error){await backend.close();throw error}
 }:openPersistence
 const candidates=[];for(const snapshot of source.sessions)candidates.push(await materializeSessionHistoryCandidate({root,generationId:source.digest,source:snapshot,expectedDigest:snapshot.digest,base:base?.sessions.find(s=>s.header.id===snapshot.header.id),openPersistence:open,dryRun}))
 return {digest:source.digest,directory:candidates[0].directory,candidates,verified:!dryRun,selected:false,dryRun}
}
