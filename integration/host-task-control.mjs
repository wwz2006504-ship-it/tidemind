// Preserve local synchronous controls; remote receipts remain explicitly asynchronous.
export function createHostTaskControl({supervisor,remote,pending,assertHostActive}){
 if(!(pending instanceof Set)||typeof assertHostActive!=='function')throw Error('host lifecycle and pending controls required')
 const track=value=>{const work=Promise.resolve(value);pending.add(work);work.finally(()=>pending.delete(work)).catch(()=>{});return work}
 if(remote!==undefined){
  for(const name of ['status','enqueue','setRest'])if(typeof remote?.[name]!=='function')throw Error('complete remote task controls required')
  return Object.freeze({
   status:()=>{assertHostActive();return track((async()=>{const status=await remote.status();assertHostActive();if(![0,1].includes(status?.control?.rest)||!Number.isSafeInteger(status.active)||status.active<0)throw Error('unconfirmed remote task status');return {...status,rest:status.control.rest===1,drained:status.active===0}})())},
   enqueue:task=>{assertHostActive();return track(remote.enqueue(task))},
   requestRest:(rest,options)=>{assertHostActive();return track((async()=>{const result=await remote.setRest(rest,options);assertHostActive();if(typeof result?.rest!=='boolean'||typeof result.drained!=='boolean'||result.rest!==rest)throw Error('unconfirmed remote rest receipt');return {...result,ok:true,requested:rest,stopping:!result.drained}})())},
  })
 }
 return Object.freeze({status:()=>{assertHostActive();const status=supervisor.status();return {...status,rest:!!status.control.rest,drained:status.active===0}},enqueue:task=>{assertHostActive();return supervisor.enqueue(task)},requestRest:(rest,options)=>{assertHostActive();const request=supervisor.requestRest(rest,options);track(request.completion);const status=supervisor.status();return {ok:!!status.control.rest===rest,requested:rest,rest:!!status.control.rest,drained:status.active===0,stopping:status.stopping}}})
}
