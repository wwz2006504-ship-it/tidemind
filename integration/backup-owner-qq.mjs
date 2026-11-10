// Exports private QQ text through the original local OneBot transport.
// Rollback: remove only the receipt's encrypted archive from the backup destination.
import {createCipheriv,createDecipheriv,createHash,randomBytes} from 'node:crypto'
import {existsSync,mkdirSync,readFileSync,realpathSync,writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {parseArgs} from 'node:util'
import {readOneBotEndpoint} from '../host/aurabot/src/snowluma/manager.js'
import {createOneBotClient} from '../host/aurabot/src/onebot/client.js'

const {values}=parseArgs({options:{root:{type:'string'},'dsh-home':{type:'string'},'dry-run':{type:'boolean'}}})
const root=realpathSync(values.root),runtime=join(root,'runtime')
const read=p=>JSON.parse(readFileSync(p,'utf8').replace(/^\uFEFF/,''))
const owner=read(join(root,'owner.json')).owner
if(!owner||read(join(root,'install.json')).owner!==owner||realpathSync(runtime)!==runtime)throw Error('Private TideMind runtime required')
const config=read(join(values['dsh-home'],'plugins-data','aurabot','config.json'))
const userId=Number(config.ownerQQ),botId=Number(config.botQQ)
if(![userId,botId].every(id=>Number.isSafeInteger(id)&&id>0)||userId===botId)throw Error('Distinct configured QQ participants required')
const s=config.snowluma??{}
const local=readOneBotEndpoint(s.dir??'',botId)
const url=new URL(s.httpUrl||local.httpUrl)
if(url.protocol!=='http:'||!['127.0.0.1','[::1]','localhost'].includes(url.hostname)||
   url.username||url.password||url.search||url.hash)throw Error('Private local QQ gateway required')
if(values['dry-run']){
 console.log(JSON.stringify({dryRun:true,privateChats:1,encryption:'AES-256-GCM',cloudChanged:false}))
 process.exit(0)
}
const client=createOneBotClient({endpoint:()=>({httpUrl:url.href,httpToken:s.httpToken||local.httpToken}),
 onEvent(){},log:{info(){},warn(){},debug(){}}})
const call=(action,params)=>client.call(action,params,{singleAttempt:true,timeoutMs:15000})
const sha=b=>createHash('sha256').update(b).digest('hex')
let identity
try{identity=await call('get_login_info',{})}catch{throw Error('Could not check local QQ identity')}
if(Number(identity?.user_id)!==botId)throw Error('Local gateway account differs from configured bot')
const records=new Map()
let cursor,seenOldest=false,pages=0
for(;pages<100;){
 const args={user_id:userId,count:100,reverse_order:true,...(cursor===undefined?{}:{message_id:cursor})}
 let response
 try{response=await call('get_friend_msg_history',args)}catch{
  if(!pages)throw Error('Local QQ history is unavailable')
  break
 }
 const rows=response?.messages
 if(!Array.isArray(rows))throw Error('QQ history response shape differs')
 pages++
 if(!rows.length){seenOldest=true;break}
 let added=0,oldest
 for(const row of rows){
  const sender=Number(row.user_id??row.sender?.user_id)
  if(row.message_type!=='private'||![botId,userId].includes(sender)||
     !Array.isArray(row.message)||!Number.isSafeInteger(row.time)||!Number.isSafeInteger(row.message_seq)) {
   throw Error('QQ history row could not be attributed to the two authorized participants')
  }
  const id=String(row.message_id)
  if(!/^-?[1-9]\d*$/.test(id))throw Error('Invalid QQ history message identity')
  if(!oldest||row.time<oldest.time||row.time===oldest.time&&row.message_seq<oldest.message_seq)oldest=row
  if(!records.has(id)){
   const text=row.message.filter(part=>part.type==='text'&&typeof part.data?.text==='string').map(part=>part.data.text).join('')
   records.set(id,{id,seq:row.message_seq,time:row.time,from:sender===botId?'my-agent':'owner',text})
   added++
  }
 }
 if(!added||Number(oldest.message_id)===cursor)break
 cursor=Number(oldest.message_id)
 if(!Number.isSafeInteger(cursor))throw Error('QQ history cursor is out of range')
}
const messages=[...records.values()].filter(row=>row.text.length).sort((a,b)=>a.time-b.time||a.seq-b.seq)
if(!messages.length)throw Error('No private QQ text was available')
const bytes=Buffer.from(JSON.stringify({format:'tidemind-owner-qq-text-v1',messages}))
const privateRoot=join(runtime,'qq-history-encrypted')
mkdirSync(privateRoot,{recursive:true})
if(realpathSync(privateRoot)!==privateRoot)throw Error('Encrypted backup directory must not be linked')
const keyPath=join(privateRoot,'owner-qq-aes256.key')
if(!existsSync(keyPath))writeFileSync(keyPath,randomBytes(32),{flag:'wx',mode:0o600})
if(realpathSync(keyPath)!==keyPath)throw Error('Backup key must not be linked')
const key=readFileSync(keyPath)
if(key.length!==32)throw Error('Invalid local backup key')
const label=Buffer.from('TMQQGCM1')
const path=join(privateRoot,'owner-qq-'+sha(bytes)+'.enc')
if(!existsSync(path)){
 const nonce=randomBytes(12)
 const cipher=createCipheriv('aes-256-gcm',key,nonce)
 cipher.setAAD(label)
 const ciphertext=Buffer.concat([cipher.update(bytes),cipher.final()])
 writeFileSync(path,Buffer.concat([label,nonce,cipher.getAuthTag(),ciphertext]),{flag:'wx',mode:0o600})
}
if(realpathSync(path)!==path)throw Error('Encrypted archive must not be linked')
const archive=readFileSync(path)
if(!archive.subarray(0,8).equals(label))throw Error('Unexpected encrypted archive format')
const decipher=createDecipheriv('aes-256-gcm',key,archive.subarray(8,20))
decipher.setAAD(label)
decipher.setAuthTag(archive.subarray(20,36))
if(!Buffer.concat([decipher.update(archive.subarray(36)),decipher.final()]).equals(bytes))throw Error('Local encrypted restore mismatch')
console.log(JSON.stringify({archive:path,sha256:sha(archive),bytes:archive.length,messages:messages.length,
 firstTime:messages[0].time,lastTime:messages.at(-1).time,pages,oldestConfirmed:seenOldest,localRestoreVerified:true}))
