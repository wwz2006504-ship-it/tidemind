// Bounded resumable staging into the EXISTING immutable media store. No sender.
import {dirname,join} from 'node:path'
import {mkdirSync,existsSync,readFileSync,writeFileSync,renameSync,openSync,fsyncSync,closeSync} from 'node:fs'
import {createHash,randomUUID} from 'node:crypto'
import {checkedPath} from '../TideMind/deploy/existing/tide-replica.mjs'
import {createMediaBlobs} from './media-blobs.mjs'
const sha=b=>createHash('sha256').update(b).digest('hex')
export function createMediaUpload({lease}){
 const db=lease.openAuthority();let root;try{root=dirname(db.prepare('PRAGMA database_list').all().find(r=>r.name==='main').file)}finally{db.close()}
 const media=createMediaBlobs({root}),uploads=join(root,'media-upload')
 const atomic=(file,value)=>{checkedPath(file);const temp=file+'.'+randomUUID()+'.tmp',fd=openSync(temp,'wx',0o600);try{writeFileSync(fd,JSON.stringify(value));fsyncSync(fd)}finally{closeSync(fd)}renameSync(temp,file)}
 return {request(holder,term,path,body){return lease.fenced(holder,term,db=>{
  if(db.prepare('SELECT home FROM tide_head').get().home!==holder)throw Error('standby media staging denied')
  if(!/^[a-f0-9]{64}$/.test(body.id||'')||!['image','record'].includes(body.type)||!Number.isSafeInteger(body.bytes)||body.bytes<1||body.bytes>(body.type==='image'?10:16)*1024*1024)throw Error('bounded media declaration required')
  checkedPath(uploads);mkdirSync(uploads,{recursive:true,mode:0o700});checkedPath(uploads)
  const dir=join(uploads,holder+'-'+term+'-'+body.id);checkedPath(dir)
  if(path==='/qq/media/begin')mkdirSync(dir,{recursive:true,mode:0o700})
  checkedPath(dir);const file=join(dir,'manifest.json');checkedPath(file)
  let meta=existsSync(file)?JSON.parse(readFileSync(file,'utf8')):null
  if(!meta){if(path!=='/qq/media/begin')throw Error('media upload not initialized');meta={holder,term,id:body.id,type:body.type,bytes:body.bytes,offset:0,chunks:[]};atomic(file,meta)}
  if(meta.holder!==holder||meta.term!==term||meta.id!==body.id||meta.type!==body.type||meta.bytes!==body.bytes)throw Error('media upload declaration conflict')
  if(path==='/qq/media/begin')return {offset:meta.offset,complete:!!meta.ref}
  if(path==='/qq/media/chunk'){
   if(!Number.isSafeInteger(body.offset)||body.offset<0||body.offset>meta.offset||typeof body.data!=='string'||body.data.length>65536)throw Error('bounded ordered media chunk required')
   const bytes=Buffer.from(body.data,'base64');if(!bytes.length||bytes.length>48*1024||bytes.toString('base64')!==body.data||body.offset+bytes.length>meta.bytes)throw Error('canonical bounded media chunk required')
   const chunk=join(dir,body.offset+'.part');checkedPath(chunk)
   if(existsSync(chunk)){if(!readFileSync(chunk).equals(bytes))throw Error('media chunk replay differs')}else{if(body.offset!==meta.offset)throw Error('media chunk missing before replay');const fd=openSync(chunk,'wx',0o600);try{writeFileSync(fd,bytes);fsyncSync(fd)}finally{closeSync(fd)}}
   if(body.offset===meta.offset){meta.chunks.push({offset:body.offset,bytes:bytes.length,hash:sha(bytes)});meta.offset+=bytes.length;atomic(file,meta)}
   return {offset:meta.offset,replayed:body.offset+bytes.length<meta.offset}
  }
  if(path==='/qq/media/complete'){
   if(meta.offset!==meta.bytes)throw Error('media upload incomplete')
   const parts=meta.chunks.map(c=>{const bytes=readFileSync(checkedPath(join(dir,c.offset+'.part')));if(bytes.length!==c.bytes||sha(bytes)!==c.hash)throw Error('media chunk changed');return bytes}),bytes=Buffer.concat(parts)
   if(bytes.length!==meta.bytes||sha(bytes)!==meta.id)throw Error('media complete hash differs')
   const ref=media.freeze(meta.type,'base64://'+bytes.toString('base64'));meta.ref=ref;atomic(file,meta);return ref
  }
  throw Error('unknown media staging operation')
 })}}
}
