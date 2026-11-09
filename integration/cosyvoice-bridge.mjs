// Calls the original CosyVoice protocol. No server start/stop, model download or voice replacement.
import {textToSpeech} from '../host/aurabot/src/voice/tts.js'
import {currentActivitySignal,assertCognitiveActive} from './activity-gate.mjs'
import {readFileSync,realpathSync,statSync} from 'node:fs'
import {relative,isAbsolute} from 'node:path'
import {createHash} from 'node:crypto'
export function bindCloudCosyVoice({root,url,refAudio,referenceSha256}){
 const endpoint=new URL(url)
 if(endpoint.protocol!=='http:'||!['127.0.0.1','[::1]'].includes(endpoint.hostname)||!endpoint.port||endpoint.username||endpoint.password||endpoint.search||endpoint.hash||endpoint.pathname!=='/')throw Error('reviewed cloud loopback CosyVoice endpoint required')
 const owned=realpathSync(root)
 return voice=>{
  if(!['zero_shot','cross_lingual'].includes(voice.cosyvoice?.mode))throw Error('reviewed cloud reference voice mode required')
  const path=realpathSync(refAudio),rel=relative(owned,path)
  if(!rel||rel==='..'||rel.startsWith('..\\')||rel.startsWith('../')||isAbsolute(rel)||!statSync(path).isFile()||statSync(path).size>20*1024*1024)throw Error('cloud voice reference outside owned data')
  if(createHash('sha256').update(readFileSync(path)).digest('hex')!==referenceSha256)throw Error('cloud voice reference differs from reviewed hash')
  return {...voice,cosyvoice:{...voice.cosyvoice,url:endpoint.origin,refAudio:path,forbidRedirect:true}}
 }
}
export function createCosyVoiceBridge({getConfig,synthesize=textToSpeech,log,getSignal=()=>undefined,isLocal=()=>true,cloudVoice}){
 if(typeof getConfig!=='function'||typeof synthesize!=='function')throw Error('existing voice configuration and synthesizer required')
 return {speak:async text=>{
  const local=isLocal()
  if(!local&&!cloudVoice)throw Error('local CosyVoice unavailable to cloud context')
  const configured=getConfig().voice
  assertCognitiveActive();const signal=getSignal()||currentActivitySignal();signal?.throwIfAborted()
  if(configured?.engine!=='cosyvoice')throw Error('existing CosyVoice engine configuration required')
  const voice=local?configured:cloudVoice(configured)
  let result
  try{result=await synthesize(text,{...voice,cosyvoice:{...voice.cosyvoice},requireRequestedEngine:true,signal},log)}catch(error){if(signal?.aborted){const stopped=Error('CosyVoice activity cancelled');stopped.code='TIDEMIND_ACTIVITY_ABORTED';throw stopped}throw error}
  signal?.throwIfAborted();assertCognitiveActive()
  if(result?.engine!=='cosyvoice'||typeof result.file!=='string')throw Error('CosyVoice did not confirm an audio file')
  return result
 }}
}
