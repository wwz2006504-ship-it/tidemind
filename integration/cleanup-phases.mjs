// Run every cleanup in a phase, wait for all outcomes, then continue to the next phase.
// Report failures only after later cleanup has had its chance to finish.
export async function cleanupPhases(phases){
 const failures=[]
 for(const phase of phases){
  const results=await Promise.allSettled(phase.map(fn=>Promise.resolve().then(fn)))
  for(const result of results)if(result.status==='rejected')failures.push(result.reason)
 }
 if(failures.length)throw new AggregateError(failures,'host cleanup incomplete; review required')
}
