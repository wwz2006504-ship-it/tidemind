// Original API shape, shared by native modules and api.lib. No fallback or seeding.
export {parsePersona,rulesText} from '../../../aurabot-upstream/src/persona/personas.js'
let identity
export function bindReadonlyIdentity(value){
 if(identity)throw Error('identity already bound')
 if(typeof value?.inspect!=='function'||value.inspect().originalReadOnly!==true)throw Error('reviewed read-only identity required')
 identity=value;return ()=>{if(identity===value)identity=undefined}
}
const bound=()=>{if(!identity)throw Error('original identity not bound');return identity}
export const seedPersonas=()=>bound().seedPersonas()
export const listPersonas=()=>bound().listPersonas()
export const readPersona=id=>bound().readPersona(id)
export const currentPersonaText=id=>bound().currentPersonaText(id)
export const savePersona=(...args)=>bound().savePersona(...args)
export const deletePersona=(...args)=>bound().deletePersona(...args)
