import {pathToFileURL} from 'node:url'
const load=name=>import(pathToFileURL('<DSH_APP_DIR>/resources/app/node_modules/@deepseek-ai/'+name+'/lib/index.js').href)
const {Context}=await load('cordis');const {SystemPrompt}=await load('dsh-system-prompt');const {ToolRuntime}=await load('dsh-tools')
const ctx=new Context();const prompt=new SystemPrompt(ctx,{personaPrefix:'SYNTHETIC'});const tools=new ToolRuntime(ctx,{mode:'native'})
console.log('actual services',Boolean(ctx.systemPrompt),Boolean(ctx.tools),typeof ctx.emit,typeof ctx.parallel,typeof ctx.dispose,typeof tools.get,typeof tools.resolve)
console.log((await prompt.assemble({})).sections.length)
await ctx.dispose()
