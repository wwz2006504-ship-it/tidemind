// Immutable media inside the new authority directory. Never logs raw media or opens memory DBs.
import {mkdirSync,realpathSync,readFileSync,writeFileSync,existsSync,statSync} from 'node:fs'
import {join,resolve,relative,isAbsolute} from 'node:path'
import {fileURLToPath} from 'node:url'
import {createHash} from 'node:crypto'
const sha=b=>createHash('sha256').update(b).digest('hex')
const within=(root,file)=>{const r=relative(root,file);return r&&!r.startsWith('..')&&!isAbsolute(r)}
export function createMediaBlobs({root,readRoots=[root]}){
 root=realpathSync(root);const folder=join(root,'media-outbox'),allowed=readRoots.map(r=>realpathSync(r))
 function mediaPath(id){if(!/^[a-f0-9]{64}$/.test(id))throw Error('invalid media hash');if(existsSync(folder)&&!within(root,realpathSync(folder)))throw Error('media folder escaped authority root');return join(folder,id+'.blob')}
 function validate(type,bytes){
  const max=type==='image'?10*1024*1024:16*1024*1024
  if(!bytes.length||bytes.length>max)throw Error('media size exceeds bounded limit')
  const head=bytes.subarray(0,16),ascii=head.toString('ascii')
  const image=head.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex'))||head.subarray(0,3).equals(Buffer.from([255,216,255]))||ascii.startsWith('GIF8')||(ascii.startsWith('RIFF')&&ascii.slice(8,12)==='WEBP')
  const audio=(ascii.startsWith('RIFF')&&ascii.slice(8,12)==='WAVE')||ascii.startsWith('OggS')||ascii.startsWith('ID3')||(head[0]===255&&(head[1]&224)===224)||ascii.startsWith('#!AMR')||ascii.includes('#!SILK_V3')
  if(type==='image'?!image:!audio)throw Error('media format does not match segment')
 }
 function freeze(type,value){
  if(value&&typeof value==='object'&&!Array.isArray(value)){if(Object.keys(value).some(k=>!['blob','bytes'].includes(k)))throw Error('invalid immutable media reference');materialize(type,value);return {blob:value.blob,bytes:value.bytes}}
  if(!['image','record'].includes(type)||typeof value!=='string')throw Error('supported media source required')
  let bytes
  if(value.startsWith('base64://')){const encoded=value.slice(9);if(encoded.length>24*1024*1024||!encoded||!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)||encoded.length%4!==0)throw Error('invalid media base64');bytes=Buffer.from(encoded,'base64');if(bytes.toString('base64')!==encoded)throw Error('noncanonical media base64')}
  else{
   if(value.includes('://')&&!value.startsWith('file://'))throw Error('remote media must be resolved by original Hub first')
   const file=realpathSync(value.startsWith('file://')?fileURLToPath(value):resolve(value))
   if(!allowed.some(r=>within(r,file)))throw Error('media file outside configured read roots')
   if(statSync(file).size>(type==='image'?10:16)*1024*1024)throw Error('media size exceeds bounded limit')
   bytes=readFileSync(file)
  }
  validate(type,bytes);const id=sha(bytes),file=mediaPath(id)
  mkdirSync(folder,{recursive:true,mode:0o700})
  mediaPath(id)
  if(existsSync(file)){if(!within(root,realpathSync(file))||sha(readFileSync(file))!==id)throw Error('existing media blob changed')}
  else{try{writeFileSync(file,bytes,{flag:'wx',mode:0o600})}catch(error){if(error.code!=='EEXIST'||sha(readFileSync(file))!==id)throw error}}
  return {blob:id,bytes:bytes.length}
 }
 function materialize(type,ref){
  if(!ref||!Number.isSafeInteger(ref.bytes))throw Error('media manifest required')
  const file=mediaPath(ref.blob)
  if(!within(root,realpathSync(file)))throw Error('media blob escaped root')
  const bytes=readFileSync(file);validate(type,bytes)
  if(bytes.length!==ref.bytes||sha(bytes)!==ref.blob)throw Error('media blob changed after enqueue')
  return 'base64://'+bytes.toString('base64')
 }
 function freezeMessage(message){
  if(!Array.isArray(message)||!message.length||message.length>32)throw Error('bounded OneBot segments required')
  let total=0
  const result=message.map(segment=>{
   const data=segment?.data;if(!data||typeof data!=='object'||Array.isArray(data))throw Error('segment data required')
   if(segment.type==='text'){if(Object.keys(data).some(k=>k!=='text')||typeof data.text!=='string'||data.text.length>8000)throw Error('bounded text required');return {type:'text',data:{text:data.text}}}
   if(segment.type==='reply'){if(Object.keys(data).some(k=>k!=='id')||!/^[-]?[1-9]\d*$/.test(String(data.id)))throw Error('reply identity required');return {type:'reply',data:{id:String(data.id)}}}
   if(['image','record'].includes(segment.type)){
    const keys=segment.type==='image'?['file','sub_type','summary']:['file']
    if(Object.keys(data).some(k=>!keys.includes(k)))throw Error('unsupported media segment option')
    const ref=freeze(segment.type,data.file);total+=ref.bytes
    if(total>20*1024*1024)throw Error('combined media size exceeds limit')
    const out={file:ref};if('sub_type'in data){if(![0,1].includes(data.sub_type))throw Error('invalid sticker subtype');out.sub_type=data.sub_type}if('summary'in data){if(typeof data.summary!=='string'||data.summary.length>128)throw Error('bounded sticker summary required');out.summary=data.summary}
    return {type:segment.type,data:out}
   }
   throw Error('unsupported OneBot segment')
  })
  return result
 }
 return {freeze,materialize,freezeMessage,materializeMessage:message=>message.map(s=>['image','record'].includes(s.type)?{...s,data:{...s.data,file:materialize(s.type,s.data.file)}}:structuredClone(s))}
}
