// Local installation helper. Source opens read-only; only NEW install-owned DBs change.
if(process.argv.includes('--dry-run')){console.log('{"dryRun":true,"sourceReadOnly":true}');process.exit(0)}
import {DatabaseSync,backup} from 'node:sqlite'
import {join} from 'node:path'
import {mkdirSync,existsSync,readFileSync} from 'node:fs'
const [source,root]=process.argv.slice(2)
if(!source||!root)throw Error('explicit source and new runtime root required')
process.env.TIDEMIND_SANDBOX_ROOT=root;process.env.TIDEMIND_LEASE_DB=join(root,'lease.db')
const {checkedPath,initializeReplica,replicaHead,dataHash}=await import('../TideMind/deploy/existing/tide-replica.mjs')
const local=join(root,'memory','memory.db'),initial=join(root,'backups','initial-memory.db')
mkdirSync(join(root,'memory'),{recursive:true});mkdirSync(join(root,'backups'),{recursive:true})
checkedPath(local);checkedPath(initial)
if(!existsSync(local)){const input=new DatabaseSync(source,{readOnly:true});input.exec('PRAGMA query_only=ON');try{await backup(input,local)}finally{input.close()}}
const copy=new DatabaseSync(local,{readOnly:true});let ids,counts
try{
 if(copy.prepare("PRAGMA integrity_check").get().integrity_check!=='ok')throw Error('copied database failed integrity check')
 ids=copy.prepare("SELECT id FROM memories WHERE layer='core' ORDER BY id").all().map(r=>r.id)
 counts={memories:copy.prepare('SELECT count(*) n FROM memories').get().n,core:ids.length,persona:copy.prepare('SELECT count(*) n FROM persona').get().n}
 if(!existsSync(initial))await backup(copy,initial)
}finally{copy.close()}
initializeReplica(local)
const baseline=replicaHead(local),lease=await import('../TideMind/deploy/existing/lease.mjs'),gateway=await import('../TideMind/deploy/existing/tide-gateway.mjs')
gateway.initialize(lease,{protectedIds:ids,baseline})
const saved=new DatabaseSync(initial,{readOnly:true});try{if(dataHash(saved)!==baseline.data_hash)throw Error('initial backup does not match working snapshot')}finally{saved.close()}
console.log(JSON.stringify({baseline,protectedIds:ids,counts,local,initial,sourceReadOnly:true}))
