// Minimal ORIGINAL Cordis/DSH persistence for an owned inactive history candidate.
// No model, preset, QQ plugin or production profile is loaded.
import {readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {checkedPath} from '../TideMind/deploy/existing/tide-replica.mjs'
export async function openNativeSessionStorage(root){
 checkedPath(root)
 const base=process.env.TIDEMIND_APP_MODULES||'<DSH_APP_DIR>/resources/app/node_modules/@deepseek-ai',pins=JSON.parse(readFileSync(new URL('../host/SESSION-SOURCE-MANIFEST.json',import.meta.url),'utf8'))
 for(const [name,pin]of Object.entries(pins)){const file=join(base,name,'lib/index.js');if(createHash('sha256').update(readFileSync(file)).digest('hex')!==pin.sha256)throw Error('native DSH history dependency changed: '+name)}
 const [{Context},backend]=await Promise.all(['cordis','dsh-session-persistence-jsonl'].map(name=>import(pathToFileURL(join(base,name,'lib/index.js')).href)))
 const ctx=new Context()
 try{await backend.apply(ctx,{root,compression:'none'});return {persistence:ctx.sessionPersistence,async close(){await ctx.fiber.dispose();if(ctx.fiber.inertia)await ctx.fiber.inertia}}}
 catch(error){await ctx.fiber.dispose();if(ctx.fiber.inertia)await ctx.fiber.inertia;throw error}
}
