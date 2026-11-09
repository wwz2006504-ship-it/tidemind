// Private tunnel client for the EXISTING authority transport. No retries on mutating operations.
const routes=new Set(['/admin','/head','/operation','/entries','/commit','/enqueue','/qq/observe','/qq/bind','/qq/reply','/qq/status','/qq/read','/qq/tool','/qq/admission','/qq/admission-status','/qq/observe-poke','/qq/observe-autonomous','/qq/purge','/qq/recovery-binding','/qq/send','/qq/intent-check','/qq/admission-evidence','/qq/review','/qq/recover','/qq/reply-check','/qq/protocol','/qq/media/begin','/qq/media/chunk','/qq/media/complete','/qq/source/begin','/qq/source/finish','/qq/source/callback','/qq/source/status','/qq/source/pause','/qq/source/resume','/qq/source/replay-claim','/qq/source/replay-finish','/task/protocol','/task/phase/next','/task/phase/model-request','/task/phase/finish','/task/activity/begin','/task/activity/check','/task/activity/finish','/task/rest-request','/task/enqueue','/task/rest','/task/status','/task/trace','/state/current','/state/operation','/state/head','/state/commit','/sync/history/current','/sync/history/publish','/sync/sign','/sync/receipt','/sync/status','/sync/check','/transfer/retain','/transfer/quiet','/transfer/status','/transfer/pause','/transfer/resume-input','/transfer/freeze','/transfer/seal','/transfer/resume','/transfer/begin','/transfer/confirm','/transfer/authorize','/transfer/handover'])
routes.add('/activation/status')
export function createAuthorityClient({url,token,timeoutMs=3000}){
 const target=new URL(url)
 if(target.protocol!=='http:'||!['127.0.0.1','[::1]'].includes(target.hostname)||target.pathname!=='/'||target.search||target.hash||target.username||target.password||!target.port)throw Error('explicit loopback private-tunnel authority URL required')
 if(typeof token!=='string'||token.length<16||/[\r\n]/.test(token)||!Number.isSafeInteger(timeoutMs)||timeoutMs<100||timeoutMs>10000)throw Error('private credential and bounded timeout required')
 async function request(path,body={}){
  if(!routes.has(path))throw Error('unknown existing authority operation')
  const text=JSON.stringify(body);if(Buffer.byteLength(text)>(path==='/sync/history/publish'?33*1024*1024:path==='/state/commit'?4*1024*1024:65536))throw Error('authority request too large')
  let response
  try{response=await fetch(new URL(path,target),{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:text,redirect:'manual',signal:AbortSignal.timeout(timeoutMs)})}catch{throw Error('authority request outcome unknown; inspect status before retrying')}
  if(!response.ok){await response.body?.cancel();const error=Error('authority rejected HTTP '+response.status);error.status=response.status;throw error}
  const reader=response.body.getReader(),chunks=[];let size=0
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>(path==='/sync/history/current'?33*1024*1024:path==='/state/current'?4*1024*1024:128*1024)){await reader.cancel();throw Error('authority response too large')};chunks.push(Buffer.from(value))}}finally{reader.releaseLock()}
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'))}catch{throw Error('authority returned invalid JSON')}
 }
 return Object.freeze({request})
}
