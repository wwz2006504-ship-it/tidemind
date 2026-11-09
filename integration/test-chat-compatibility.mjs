import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,writeFileSync,readFileSync,rmSync,mkdirSync} from 'node:fs'
import {resolve,join} from 'node:path'
import {spawnSync} from 'node:child_process'
import {assertChatCompatibility,packageChatPaths} from './chat-compatibility.mjs'
test('original reply algorithm and Hub reply selection retain exact source except reviewed seams',()=>{const result=assertChatCompatibility(packageChatPaths(resolve('.')));assert.equal(result.replyAlgorithmUnchanged,true);assert.equal(result.hubContentSelectionUnchanged,true)})
test('changed reply filtering or Hub output rule fails compatibility guard',()=>{mkdirSync('data',{recursive:true});const dir=mkdtempSync(resolve('data/chat-guard-'));try{
 const paths=packageChatPaths(resolve('.')),reply=join(dir,'reply.js'),hub=join(dir,'hub.js')
 writeFileSync(reply,readFileSync(paths.candidateReply,'utf8').replace('const MAX_BUBBLES = 5','const MAX_BUBBLES = 4'));assert.throws(()=>assertChatCompatibility({...paths,candidateReply:reply}),/original reply algorithm changed/)
 writeFileSync(hub,readFileSync(paths.candidateHub,'utf8').replace('items.length > 3','items.length > 2'));assert.throws(()=>assertChatCompatibility({...paths,candidateHub:hub}),/original Hub reply selection changed/)
 }finally{rmSync(dir,{recursive:true,force:true})}})
test('native original and candidate parse, notes and delivery outputs match on synthetic cases',()=>{const result=spawnSync(process.execPath,['integration/chat-parity-probe.mjs'],{encoding:'utf8',timeout:30000});assert.equal(result.status,0,result.stderr);const receipt=JSON.parse(result.stdout.trim());assert.equal(receipt.passed,true);assert.equal(receipt.realQQ,false);assert.equal(receipt.parserCases,19);assert.equal(receipt.deliveryCases,14)})
