// Policy only; requests still use the existing DSH agent/request and configured providers.
const phases=new Set(['reflect','plan','verify'])
export function createModelHelpPolicy(config){
 if(config===undefined||config===null)return ()=>({kind:'ordinary',reason:'help-not-configured'})
 if(!config||Object.keys(config).some(k=>!['provider','model','reasoningEffort','maxOutputTokens'].includes(k)))throw Error('unsupported model help configuration')
 for(const key of ['provider','model','reasoningEffort'])if(typeof config[key]!=='string'||!config[key].trim()||config[key].length>160)throw Error('explicit configured model help route required')
 if(!Number.isSafeInteger(config.maxOutputTokens)||config.maxOutputTokens<1||config.maxOutputTokens>512)throw Error('bounded model help output required')
 const maxOutputTokens=config.maxOutputTokens
 const route=Object.freeze({provider:config.provider,model:config.model,reasoningEffort:config.reasoningEffort})
 return context=>{
  if(!phases.has(context.phase))return {kind:'ordinary',reason:'phase-does-not-request-help'}
  let previous;try{previous=JSON.parse(context.previous)}catch{return {kind:'ordinary',reason:'no-structured-help-request'}}
  // Previous model output is data: it can request advice, never select a provider or grant tools.
  if(previous?.requestHelp!==true||typeof previous.reason!=='string'||!previous.reason.trim()||previous.reason.length>512)return {kind:'ordinary',reason:'no-structured-help-request'}
  return {kind:'help',reason:'previous-phase-requested-help',route,maxTokens:maxOutputTokens}
 }
}
