// Remote management of the original server-owned scheduler; no local handlers or DB.
export function createRemoteTasks({authority,term}){
 if(typeof authority?.request!=='function')throw Error('explicit authority required')
 const request=(path,body={})=>authority.request(path,{...body,term:typeof term==='function'?term():term})
 return Object.freeze({enqueue:(task,options={})=>request('/task/enqueue',{task,dryRun:options.dryRun===true}),setRest:(rest,options={})=>request('/task/rest',{rest,op:options.op,dryRun:options.dryRun===true}),status:()=>request('/task/status'),trace:(id,options={})=>request('/task/trace',{id,after:options.after??0,limit:options.limit??100})})
}
