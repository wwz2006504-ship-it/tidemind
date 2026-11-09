import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createOwnedAgentDrain} from './owned-agent-drain.mjs'
function fixture(){const a=id=>({id,session:{id},status:'idle',inbox:{hasPending:false}}),owner=a('owner'),cognitive=a('cognitive'),other=a('unrelated'),map=new Map([owner,cognitive,other].map(a=>[a.id,a])),bindings=[{agentId:'owner'}],flushed=[];return {owner,cognitive,other,map,bindings,flushed,q:createOwnedAgentDrain({registry:{bindings,inspect(){}},resolveAgent:id=>map.get(id),cognitiveAgent:cognitive,flushSession:async s=>flushed.push(s.id)})}}
test('owned agent drain waits actual pending inbox even when status is idle',async()=>{const f=fixture();f.owner.inbox.hasPending=true;await assert.rejects(f.q.drain({timeoutMs:10}),/timed out/);f.owner.inbox.hasPending=false;assert.equal((await f.q.drain()).pending,0)})
test('session flush includes mapped and cognitive sessions and excludes unrelated busy agent',async()=>{const f=fixture();f.other.status='running';await f.q.flush();assert.deepEqual(f.flushed,['owner','cognitive']);assert.equal(f.q.status().agents,2)})
test('missing mapping and unknown inbox evidence fail closed',()=>{const f=fixture();f.bindings.push({agentId:'missing'});assert.throws(f.q.status,/unavailable/);f.bindings.pop();delete f.owner.inbox.hasPending;assert.throws(f.q.status,/unavailable/)})
