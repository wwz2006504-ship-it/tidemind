// Stage the existing desktop configuration in the installer-owned private runtime.
// Rollback: run with the same arguments and --rollback.
import {createHash} from 'node:crypto'
import {createRequire} from 'node:module'
import {existsSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync} from 'node:fs'
import {dirname, join, resolve} from 'node:path'
import {parseArgs} from 'node:util'
import {captureFreshBaseline, verifyFreshBaseline} from './fresh-baseline.mjs'

const {values} = parseArgs({options:{
  root:{type:'string'}, 'dsh-home':{type:'string'}, 'host-source':{type:'string'},
  'dry-run':{type:'boolean'}, rollback:{type:'boolean'},
}})
const read = path => JSON.parse(readFileSync(path,'utf8').replace(/^\uFEFF/,''))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const root = realpathSync(values.root)
const runtime = join(root,'runtime')
const state = read(join(root,'install.json'))
const owner = read(join(root,'owner.json')).owner
const service = read(join(runtime,'service-config.json'))
if (!owner || state.owner !== owner || service.owner !== owner ||
    state.mode !== 'installed-not-activated' || realpathSync(runtime) !== runtime ||
    realpathSync(service.env.TIDEMIND_SANDBOX_ROOT) !== runtime ||
    !/^[a-f0-9]{16}$/.test(state.release)) throw Error('Inactive installer-owned runtime required')
const target = join(runtime,'profile-runtime-inputs.json')
const receipt = join(runtime,'profile-inputs-preparer.json')
if (values.rollback) {
  if (existsSync(target)) {
    if (realpathSync(target) !== target || !existsSync(receipt) ||
        read(receipt).sha256 !== hash(readFileSync(target))) throw Error('Runtime inputs were changed outside this preparer')
    if (!values['dry-run']) unlinkSync(target)
  }
  if (!values['dry-run'] && existsSync(receipt)) unlinkSync(receipt)
  console.log(JSON.stringify({rollback:true,dryRun:!!values['dry-run'],liveProfileChanged:false}))
  process.exit(0)
}
const dsh = realpathSync(values['dsh-home'])
const profileDir = join(dsh,'profiles','desktop')
const require = createRequire(join(profileDir,'package.json'))
const yaml = require('js-yaml')
// Treat the profile's JS guard as inert text. Never execute a profile expression.
const schema = yaml.DEFAULT_SCHEMA.extend([
  new yaml.Type('tag:yaml.org,2002:js/function',{kind:'scalar',construct:value=>value}),
])
const patch = yaml.load(readFileSync(join(profileDir,'cordis.patch.yml'),'utf8'),{schema})
const heart = patch.filter(row=>row?.id==='dsh-heartbeat').at(-1)
if (typeof heart?.config?.prompt !== 'string' || heart.disabled) throw Error('Original heartbeat prompt unavailable')
const heartbeatConfig = {...heart.config,...read(join(dsh,'heartbeat.json')),prompt:heart.config.prompt}
const memoryConfig = read(join(dsh,'memory-layers','config.json'))
if (resolve(memoryConfig.dir,'memory.db') !== resolve(state.source)) throw Error('Memory configuration points to another database')
const sourceDataRoot = join(dsh,'plugins-data','aurabot')
const selectedPersona = read(join(sourceDataRoot,'config.json')).persona.current
if (!/^[a-zA-Z0-9_-]+$/.test(selectedPersona)) throw Error('Invalid active persona file name')
const release = join(root,'releases',state.release)
const upstream = realpathSync(values['host-source'])
const sourceAi = join(dsh,'ai-memory','ledger.jsonl')
const originalFiles = {
  hub:join(upstream,'src','chat','hub.js'), reply:join(upstream,'src','chat','reply.js'),
  identity:join(sourceDataRoot,'personas',selectedPersona+'.md'),
  jsonMemory:join(sourceDataRoot,'memories.json'), config:join(sourceDataRoot,'config.json'),
  sessions:join(sourceDataRoot,'sessions.json'), aiMemory:sourceAi,
}
const baseline = captureFreshBaseline({sourceFile:state.source,files:originalFiles})
const local = service.env.TIDEMIND_DB
verifyFreshBaseline(baseline,{local,requireAi:true,snapshotFiles:{...originalFiles,
  hub:join(release,'host/aurabot-upstream/src/chat/hub.js'),
  reply:join(release,'host/aurabot-upstream/src/chat/reply.js'),
}})
const paths = {root:runtime,sourceDataRoot,localDir:dirname(local),
  dataRoot:join(runtime,'profile-data'),home:join(runtime,'profile-home'),
  workspace:join(runtime,'profile-workspace'),notes:join(runtime,'profile-notes')}
const aiDirectory = join(runtime,'profile-ai-memory')
const spec = {paths,selectedPersona,memoryConfig,heartbeatConfig,freshBaseline:baseline,
  pins:{config:baseline.files.config.sha256,persona:baseline.files.identity.sha256,jsonMemory:baseline.files.jsonMemory.sha256},
  aiMemory:{source:sourceAi,baselineSha256:baseline.files.aiMemory.sha256,directory:aiDirectory}}
if (!values['dry-run']) {
  if (existsSync(target)) {
    if (realpathSync(target)!==target || !existsSync(receipt) ||
        hash(readFileSync(target))!==read(receipt).sha256) throw Error('Existing runtime inputs belong to another preparation')
    const old = read(target)
    spec.freshBaseline.observedAt = old.freshBaseline?.observedAt
    if (JSON.stringify(old)!==JSON.stringify(spec)) throw Error('Source changed; roll back preparation before staging again')
  } else {
    for (const dir of [paths.dataRoot,paths.home,paths.workspace,paths.notes,aiDirectory]) {
      mkdirSync(dir,{recursive:true})
      if (realpathSync(dir)!==dir) throw Error('Profile directory must stay under private runtime')
    }
    for (const key of ['config','sessions']) {
      const dest = join(paths.dataRoot,key+'.json')
      const bytes = readFileSync(originalFiles[key])
      if (hash(bytes)!==baseline.files[key].sha256) throw Error('Source changed during preparation')
      if (!existsSync(dest)) writeFileSync(dest,bytes,{flag:'wx'})
      if (realpathSync(dest)!==dest || hash(readFileSync(dest))!==baseline.files[key].sha256) throw Error('Working copy differs from source')
    }
    const bytes = Buffer.from(JSON.stringify(spec))
    writeFileSync(receipt,JSON.stringify({sha256:hash(bytes)}),{flag:'wx'})
    writeFileSync(target,bytes,{flag:'wx'})
  }
}
console.log(JSON.stringify({prepared:!values['dry-run'],dryRun:!!values['dry-run'],liveProfileChanged:false,cloudUploaded:false}))
