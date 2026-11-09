// Read-only original-data preflight. Failure rollback: node integration/identity-preflight.mjs --rollback
import {readFileSync,writeFileSync,existsSync} from 'node:fs'
import {homedir} from 'node:os'
import {join,resolve,dirname} from 'node:path'
import {fileURLToPath} from 'node:url'
import {createHash} from 'node:crypto'
import {createIdentityBinding} from './identity-binding.mjs'
import {createProtectedJsonMemory} from './protected-json-memory.mjs'
import {createSessionBindings} from './session-bindings.mjs'
const args=process.argv.slice(2),root=resolve(dirname(fileURLToPath(import.meta.url)),'..')
if(args.includes('--rollback')){console.log('NO-OP: original data was read-only; no production activation or data restore.');process.exit(0)}
const value=flag=>{const i=args.indexOf(flag);if(i<0)return undefined;if(!args[i+1]||args[i+1].startsWith('--'))throw Error('missing option value');return args[i+1]}
const directory=resolve(value('--data-root')||join(homedir(),'.dsh/plugins-data/aurabot')),hash=b=>createHash('sha256').update(b).digest('hex')
try{
 const observed=new Map(),read=p=>{const raw=readFileSync(p);observed.set(p,hash(raw));return raw},parse=p=>JSON.parse(read(p).toString('utf8').replace(/^\uFEFF/,''))
 const cfg=parse(join(directory,'config.json')),selected=cfg.persona?.current
 if(typeof selected!=='string'||! /^[a-zA-Z0-9_-]{1,40}$/.test(selected))throw Error('invalid selected identity')
 const persona=join(directory,'personas',selected+'.md'),raw=read(persona),memory=join(directory,'memories.json'),memoryBytes=read(memory)
 const identity=createIdentityBinding({directory:dirname(persona),selected,expectedSha256:hash(raw)})
 const storage=createProtectedJsonMemory({source:memory,expectedSha256:hash(memoryBytes),ownedRoot:root,overlay:join(root,'reports','identity-preflight-unused-overlay.json'),withWriteGuard:()=>{throw Error('read-only preflight')}})
 const mappings=parse(join(directory,'sessions.json')),registry=createSessionBindings({readMappings:()=>mappings,ownerQQ:cfg.ownerQQ,resolveRegisteredAgent:()=>null})
 const stable=[...observed].every(([p,h])=>hash(readFileSync(p))===h)
 const report={readOnly:true,productionEnabled:false,readyForProduction:false,originalDataStableDuringRead:stable,identity:identity.inspect(),jsonMemory:storage.inspect(),sessions:registry.inspect(),runtimeDataRootVerified:false,missing:['production entry and actual profile/preset mount','real QQ delivery and CosyVoice listening','legacy-compatible return with new overlay visible; original inputs unchanged']}
 if(!stable)throw Error('original data changed during read')
 const encoded=JSON.stringify(report,null,2)+'\n',target=join(root,'reports/IDENTITY-PREFLIGHT.json')
 if(!args.includes('--dry-run')&&(!existsSync(target)||readFileSync(target,'utf8')!==encoded))writeFileSync(target,encoded,'utf8')
 console.log(encoded)
}catch(error){console.log(JSON.stringify({readOnly:true,readyForProduction:false,errorType:error.name,stopped:true,originalWritten:false}));process.exitCode=1}
