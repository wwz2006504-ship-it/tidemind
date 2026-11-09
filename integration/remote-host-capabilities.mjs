// Explicit prepared capability factory for the SAME original host. No local lease,
// local OneBot sender, or remote code executor is constructed here.
import {createRemoteQQ} from './remote-qq.mjs'
import {createRemoteQQToolScope} from './remote-qq-tool-scope.mjs'
import {wrapRemoteOperationTool} from './remote-operation-scope.mjs'
export async function prepareRemoteHostCapabilities({authority,term,holder='local',selfId,historyReader,historyKey,mediaRoot,mediaReadRoots,sourceAdmission}){
 if(typeof historyReader!=='function'||typeof historyKey!=='string'||historyKey.length<32||!mediaRoot||typeof sourceAdmission?.currentCallback!=='function')throw Error('actual original history, private key, owned media and source scope required')
 const request={term:typeof term==='function'?term():term},protocol=await authority.request('/qq/protocol',request)
 if(protocol.protocol!=='original-host-v1'||protocol.media!=='immutable-upload-v1'||protocol.history!==true||protocol.source!=='canonical-callbacks-v1')throw Error('complete reviewed remote authority protocol unavailable')
 let used=false
 return options=>{
  if(used)throw Error('remote capability factory already mounted');if(String(options.selfId)!==String(selfId)||typeof options.assertHostActive!=='function')throw Error('bound original host identity/lifecycle differs');used=true
  let tools
  const outbound=createRemoteQQ({authority,term,holder,selfId,historyReader,historyKey,mediaRoot,mediaReadRoots,sourceContext:sourceAdmission.currentCallback,toolContext:()=>tools.currentFrame()})
  tools=createRemoteQQToolScope({qq:outbound,outbound,assertHostActive:options.assertHostActive})
  return Object.freeze({moduleClient:tools.moduleClient,outbound,wrapAutonomousTool:(definition,options)=>tools.wrapTool(wrapRemoteOperationTool(definition),options),currentSignal:tools.currentSignal,authorizationMode:'autonomous'})
 }
}
