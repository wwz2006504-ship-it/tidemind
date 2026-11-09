import {createHash} from 'node:crypto'
import {readFileSync,realpathSync} from 'node:fs'
import {isAbsolute,relative,resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {createAuthorityOneBot} from './authority-onebot.mjs'

// Private startup wiring is executable operator configuration. Pin it before
// loading it and keep it in the same owned directory as the authority DB.
export async function loadAuthorityWiring(path) {
  const expected=process.env.TIDEMIND_AUTHORITY_WIRING_SHA256
  if (!path || !/^[a-f0-9]{64}$/.test(expected||'')) throw Error('Pinned private authority wiring required')
  const root=realpathSync(process.env.TIDEMIND_SANDBOX_ROOT)
  const file=realpathSync(path)
  const child=relative(root,file)
  if (file!==resolve(path) || !child || child==='..' || child.startsWith('../') ||
      child.startsWith('..\\') || isAbsolute(child) || !/\.(?:json|mjs)$/.test(file)) {
    throw Error('Authority wiring must be an owned file')
  }
  const bytes=readFileSync(file)
  if (createHash('sha256').update(bytes).digest('hex')!==expected) throw Error('Authority wiring hash differs')
  const declarative=file.endsWith('.json')
  const {stateSpec,qqConfig,taskConfig,historyConfig}=declarative
    ? JSON.parse(bytes.toString('utf8'))
    : await import(pathToFileURL(file).href)
  if (!stateSpec || !qqConfig || taskConfig?.execution!=='remote-client' || !historyConfig ||
      !process.env.TIDEMIND_LOCAL_MATERIALIZER_KEY || !process.env.TIDEMIND_CLOUD_MATERIALIZER_KEY) {
    throw Error('Four stores, QQ, remote tasks, history and materializer keys are required')
  }
  if (!declarative) return {stateSpec,qqConfig,taskConfig,historyConfig,requireHome:true}
  const {endpoints,selfId,allowTargets,mediaProtocol,mediaReadRoots}=qqConfig
  if (!Array.isArray(allowTargets) || !allowTargets.length ||
      allowTargets.some(target=>typeof target!=='string'||!/^(private|group):[1-9]\d*$/.test(target)) ||
      !/^[a-f0-9]{64}$/.test(historyConfig.initialDigest||'') || !historyConfig.initialBundle) {
    throw Error('Explicit QQ targets and reviewed initial session history required')
  }
  const gateways=Object.fromEntries(['local','cloud'].map(holder=>[
    holder,createAuthorityOneBot({...endpoints?.[holder],selfId}),
  ]))
  return {
    stateSpec,taskConfig,historyConfig,requireHome:true,
    qqConfig:{selfId,allowTargets,mediaProtocol,mediaReadRoots,
      transports:Object.fromEntries(Object.entries(gateways).map(([holder,gateway])=>[holder,gateway.transport]))},
    startTransports(){for(const gateway of Object.values(gateways))gateway.start()},
    stopTransports(){for(const gateway of Object.values(gateways))gateway.close()},
    transportReadiness(){return {local:gateways.local.ready(),cloud:gateways.cloud.ready()}},
  }
}
