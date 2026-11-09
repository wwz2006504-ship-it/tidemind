// Cloud has the same identity/history, with chat/memory capabilities only.
// This policy is never applied to the local desktop host.
export const CLOUD_MODULES=new Set(['stickers','voice','mood','memory','qq-tools','persona-self','tidemind-control'])
export const CLOUD_TOOLS=new Set(['lmem_search','lmem_write','lmem_update','lmem_forget','lmem_review','lmem_admin','remember','recall_memory','persona_read','persona_edit','qq_chat_history','qq_send_message','tidemind_control','memory_search','memory_write','memory_connect','memory_history','memory_rule','memory_persona','memory_reflect','memory_question','memory_cycle','memory_self','memory_stats'])
export function deriveCloudConfig(original,moduleIds=[]){
 const cfg=structuredClone(original)
 cfg.safeMode=true;cfg.petMirror=false;cfg.snowluma={...cfg.snowluma,autoStart:false,autoAttach:false};cfg.bridge={...cfg.bridge,dshTools:false,http:false}
 cfg.local=Object.fromEntries(Object.keys(cfg.local||{}).map(k=>[k,false]));cfg.modules={...cfg.modules}
 for(const id of new Set([...moduleIds,...Object.keys(cfg.modules)]))if(!CLOUD_MODULES.has(id))cfg.modules[id]={...cfg.modules[id],enabled:false}
 return cfg
}
export function assertCloudConfig(cfg){
 if(cfg?.safeMode!==true||cfg.petMirror!==false||cfg.snowluma?.autoStart!==false||cfg.snowluma?.autoAttach!==false||cfg.bridge?.dshTools!==false||cfg.bridge?.http!==false||Object.values(cfg.local||{}).some(Boolean)||Object.entries(cfg.modules||{}).some(([id,row])=>!CLOUD_MODULES.has(id)&&row?.enabled!==false))throw Error('cloud chat/memory policy forbids local capabilities')
}
export function bindCloudToolGuard(ctx){
 if(typeof ctx.tools?.guard!=='function')throw Error('actual monotonic DSH tool guard required for cloud host')
 // Runs after extensible pre-execute hooks, including for tools registered later.
 return ctx.tools.guard(exec=>CLOUD_TOOLS.has(exec.name)?undefined:'cloud host has chat/memory only; local computer capability unavailable')
}
