// Activity scope checks rest/fencing; tool authority follows the host policy.
import {AsyncLocalStorage} from 'node:async_hooks'
const activity=new AsyncLocalStorage()
export const runCognitiveScope=(guard,fn,{toolPolicy='read-only',signal}={})=>activity.run({guard,toolPolicy,signal},fn)
export const currentActivitySignal=()=>activity.getStore()?.signal
export function assertCognitiveActive(){activity.getStore()?.guard()}
export function denyCognitiveSideEffect(){const scope=activity.getStore();if(scope){scope.guard();if(scope.toolPolicy==='read-only')throw Error('cognitive task has no write or send permission')}}
