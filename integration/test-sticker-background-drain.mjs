import test from 'node:test'
import assert from 'node:assert/strict'
import {writeFileSync,mkdirSync} from 'node:fs'
import {join} from 'node:path'
import {qqFixture} from './qq-fixture.mjs'
import {createStickerStore} from '../host/aurabot/src/features/stickers.js'

test('original sticker rename remains synchronous but shutdown waits actual pending QQ update',async()=>{
 const f=await qqFixture();let finish
 try{
  const directory=join(process.env.TIDEMIND_AURABOT_DATA_ROOT,'stickers');mkdirSync(directory,{recursive:true})
  writeFileSync(join(directory,'index.json'),JSON.stringify({items:[{md5:'synthetic',name:'old',tags:[],emojiId:'123'}]}))
  const store=createStickerStore({dsh:{},getConfig:()=>({dryRun:false}),onebot:{call:()=>new Promise(resolve=>{finish=resolve})},log:{warn(){}}})
  assert.equal(store.rename('synthetic','new').ok,true);assert.equal(store.backgroundStatus().active,1)
  await assert.rejects(store.idle({timeoutMs:10}),/timed out/)
  let stopped=false;const closing=store.dispose().then(()=>{stopped=true})
  await new Promise(resolve=>setTimeout(resolve,10));assert.equal(stopped,false)
  assert.throws(()=>store.rename('synthetic','late'),/closing/)
  finish({});await closing;assert.equal(stopped,true);assert.equal(store.backgroundStatus().active,0)
 }finally{finish?.({});await f.cleanup()}
})
