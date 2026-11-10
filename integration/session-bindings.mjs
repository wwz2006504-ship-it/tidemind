// Host-owned mapping, shared with the existing fenced MemoryStore. No session is created.
export function createSessionBindings({readMappings,ownerQQ,resolveRegisteredAgent}){
 if(typeof readMappings!=='function'||typeof resolveRegisteredAgent!=='function'||! /^[1-9]\d*$/.test(String(ownerQQ)))throw Error('trusted original session registry required')
 const bindings=[]
 function reviewed(){
  const map=readMappings();if(!map||typeof map.chats!=='object'||Array.isArray(map.chats))throw Error('original session mapping unavailable')
  const rows=Object.entries(map.chats).map(([chatId,entry])=>{
   if(!/^(private|group):[1-9]\d*$/.test(chatId)&&!/^system:[a-zA-Z0-9_-]{1,80}$/.test(chatId))throw Error('invalid original chat mapping')
   if(!entry||typeof entry.sessionId!=='string'||!entry.sessionId||entry.sessionId.length>200)throw Error('invalid original session identity')
   const owner=chatId==='private:'+ownerQQ
   if(entry.preset!==(owner?'aurabot-private':'aurabot-social')||entry.level!==(owner?'full':'social'))throw Error('original preset privilege mismatch')
   return {chatId,...entry}
  })
  if(new Set(rows.map(r=>r.sessionId)).size!==rows.length)throw Error('multiple chats share one original session; review before binding')
  return rows
 }
 function sync(){const rows=reviewed();bindings.splice(0,bindings.length,...rows.map(r=>({agentId:r.sessionId,sessionId:r.sessionId,logicalAgentId:'my-agent'})));return rows}
 sync()
 return Object.freeze({bindings,ownerChatId:'private:'+ownerQQ,
  ownerSessionId(){const row=sync().find(r=>r.chatId==='private:'+ownerQQ);if(!row)throw Error('original owner session missing');return row.sessionId},
  authorize(agent,chatId){const rows=sync(),row=rows.find(r=>r.chatId===chatId);if(!row||row.sessionId!==agent?.id||agent.session?.id!==agent.id||resolveRegisteredAgent(agent.id)!==agent)throw Error('actual original agent/session mapping required');return row},
  inspect(){const rows=sync();return {sessions:rows.length,private:rows.filter(r=>r.chatId.startsWith('private:')).length,group:rows.filter(r=>r.chatId.startsWith('group:')).length,system:rows.filter(r=>r.chatId.startsWith('system:')).length,ownerFull:rows.filter(r=>r.chatId==='private:'+ownerQQ).length,createsSessions:false}},
 })
}
