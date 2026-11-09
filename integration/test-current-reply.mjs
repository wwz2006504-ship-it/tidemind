import test from 'node:test'
import assert from 'node:assert/strict'
import {readdirSync,readFileSync} from 'node:fs'
import {join} from 'node:path'
import {qqFixture} from './qq-fixture.mjs'
test('current original inner-note rule is preserved; private note never reaches QQ and only writes isolated directory',async()=>{
 const f=await qqFixture();try{
  await f.reply(f.bind([f.event('1501')]),'<内心>合成私下备注</内心>合成公开回复')
  assert.equal(f.sent.length,1);assert.ok(!JSON.stringify(f.sent).includes('合成私下备注'));assert.ok(JSON.stringify(f.sent).includes('合成公开回复'))
  const directory=join(f.root,'self-notes'),files=readdirSync(directory);assert.equal(files.length,1);assert.match(readFileSync(join(directory,files[0]),'utf8'),/合成私下备注/)
 }finally{await f.cleanup()}
})
