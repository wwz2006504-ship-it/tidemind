// Guard the original reply algorithm and Hub content selection. No source rewriting
// or dynamic evaluation: only documented I/O/fencing seams are normalized for comparison.
import {readFileSync} from 'node:fs'
import {join} from 'node:path'
const read=file=>readFileSync(file,'utf8').replaceAll('\r\n','\n')
function replaceOnce(text,from,to){if(!from||text.split(from).length!==2)throw Error('chat compatibility seam differs');return text.replace(from,to)}
function between(text,start,end){const a=text.indexOf(start),b=text.indexOf(end,a+start.length);if(a<0||b<0)throw Error('original chat section unavailable');return text.slice(a,b)}
export function assertChatCompatibility({originalHub,candidateHub,originalReply,candidateReply}){
 const reply=read(originalReply);let candidate=read(candidateReply)
 candidate=replaceOnce(candidate,"import {checkedPath} from '../../../../TideMind/deploy/existing/tide-replica.mjs'\n",'')
 candidate=replaceOnce(candidate,"import {join} from 'node:path'\n",'')
 const constant=reply.split('\n').find(line=>line.startsWith('const XINLIHUA_DIR = '))
 candidate=replaceOnce(candidate,"function selfNotesDir(){const dir=process.env.TIDEMIND_SELF_NOTES_DIR;if(!dir)throw new Error('isolated notes root required');return checkedPath(dir)}",constant)
 candidate=replaceOnce(candidate,'mkdirSync(selfNotesDir(),','mkdirSync(XINLIHUA_DIR,')
 candidate=replaceOnce(candidate,"    appendFileSync(join(selfNotesDir(), day + '.md'), body + '\\n', 'utf8')",reply.split('\n').find(line=>line.includes('appendFileSync(XINLIHUA_DIR')))
 if(candidate!==reply)throw Error('original reply algorithm changed; refuse activation')
 const start='  async function deliverImpl(chatId, text, opts = {}) {'
 const original=between(read(originalHub),start,'    // A skipped, dry-run or rejected reply must not postpone the next contact.')
 let rendered=between(read(candidateHub),start,'    if (!deliveryStore.getStore()?.accepted) return')
 if(rendered.split('    outbound.validateItems(items)\n').length!==3)throw Error('reply validation seams differ')
 rendered=rendered.replaceAll('    outbound.validateItems(items)\n','')
 rendered=replaceOnce(rendered,'if (!opts.simulate||captureStore.getStore())','if (!opts.simulate)')
 if(original!==rendered)throw Error('original Hub reply selection changed; refuse activation')
 return {replyAlgorithmUnchanged:true,hubContentSelectionUnchanged:true,scope:'reply algorithm and Hub selection only; transport/lifecycle reviewed separately'}
}
export const packageChatPaths=root=>({originalHub:join(root,'host/aurabot-upstream/src/chat/hub.js'),candidateHub:join(root,'host/aurabot/src/chat/hub.js'),originalReply:join(root,'host/aurabot-upstream/src/chat/reply.js'),candidateReply:join(root,'host/aurabot/src/chat/reply.js')})
