// Reads only the existing authority tables, under the current final fence.
// SQL silence alone is never evidence that modules, agents or transports are idle.
export function inspectAuthorityQuiet({lease,holder,term}){
 return lease.fenced(holder,term,db=>{
  if(db.prepare('SELECT home FROM tide_head').get()?.home!==holder)throw Error('source is not primary')
  const tables=['tide_source_gate','tide_source_deferred','tide_source_callbacks','tide_tool_permits','tide_outbox','tide_qq_receipts','tide_admissions','tide_input_journal','tide_input_recovery']
  for(const name of tables)if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name))throw Error('original subsystem quiet evidence unavailable: '+name)
  const count=sql=>db.prepare(sql).get().n
  const gate=db.prepare('SELECT state,active FROM tide_source_gate WHERE id=1').get()
  const counts={sourceCallbacks:gate.active,deferred:count("SELECT count(*) n FROM tide_source_deferred WHERE state!='forwarded'"),outgoing:count("SELECT count(*) n FROM tide_outbox WHERE state!='sent'"),parts:count("SELECT count(*) n FROM tide_qq_receipts WHERE state!='sent'"),admissions:count("SELECT count(*) n FROM tide_admissions WHERE state!='accepted'"),unadmitted:count('SELECT count(*) n FROM tide_input_journal WHERE admission_id IS NULL'),recoveries:count("SELECT count(*) n FROM tide_input_recovery WHERE state!='accepted'")}
  counts.remoteCallbacks=count("SELECT count(*) n FROM tide_source_callbacks WHERE state IN ('active','review')")
  counts.toolOutcomes=count("SELECT count(*) n FROM tide_tool_permits WHERE state IN ('executing','attempted','unknown')")
  if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='tide_tasks'").get())counts.tasks=count("SELECT count(*) n FROM tide_tasks WHERE state IN ('running','needs_review')")
  return {quiet:gate.state==='paused'&&Object.values(counts).every(n=>n===0),sourcePaused:gate.state==='paused',counts,scope:'authority-only',wholeRuntimeQuiet:false}
 })
}
