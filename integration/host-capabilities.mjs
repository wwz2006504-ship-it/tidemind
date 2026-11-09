// Explicit full-protocol seam in the SAME host. Partial RPC clients never fall back.
import {createOneBotCapabilities} from './onebot-capabilities.mjs'
export function resolveHostCapabilities(factory,options){
 if(factory!==undefined&&typeof factory!=='function')throw Error('explicit host capability factory required')
 const value=(factory??createOneBotCapabilities)(options)
 if(value?.then||typeof value?.moduleClient?.call!=='function'||typeof value?.wrapAutonomousTool!=='function'||typeof value?.currentSignal!=='function')throw Error('complete original host capability protocol required')
 for(const name of ['observeInbound','observePoke','pokeMessageId','observeAutonomous','bindTurn','admitInput','recoverAdmission','recoveryBinding','reviewAdmissions','recoveryStatus','purgeExpiredInputs','reply','validateItems','withInboundEvent','idle','send','withSendIntent'])if(typeof value.outbound?.[name]!=='function')throw Error('incomplete original outbound protocol: '+name)
 return value
}
