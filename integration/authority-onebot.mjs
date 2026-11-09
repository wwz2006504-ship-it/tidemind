import {createOneBotClient} from '../host/aurabot/src/onebot/client.js'

// Gateway credentials stay in the authority process. Each holder uses its own
// loopback gateway or private tunnel. Calls never fall through to the other home.
export function createAuthorityOneBot({url,token,selfId}){
 const target=new URL(url)
 if(target.protocol!=='ws:'||target.hostname!=='127.0.0.1'||!target.port||
    target.pathname!=='/'||target.search||target.hash||target.username||target.password||
    typeof token!=='string'||token.length<16||!/^[1-9]\d*$/.test(String(selfId))){
  throw Error('Private OneBot endpoint, token and expected account required')
 }
 let generation=0,verified=false
 const client=createOneBotClient({
  endpoint:()=>({wsUrl:target.href,wsToken:token}),
  onEvent(){},
  onState(state){
   const current=++generation
   verified=false
   if(state!=='connected')return
   client.call('get_login_info',{}, {timeoutMs:5000,singleAttempt:true}).then(info=>{
    if(current===generation)verified=String(info?.user_id)===String(selfId)
   }).catch(()=>{})
  },
  log:{info(){},warn(){},debug(){}},
 })
 return {
  start:()=>client.start(),
  close:()=>client.stop(),
  ready:()=>verified,
  transport(action,params,options){
   if(!verified)throw Error('OneBot session account is not verified')
   return client.call(action,params,{...options,singleAttempt:true})
  },
 }
}
