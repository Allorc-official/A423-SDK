'use strict';
const {hashAgreement}=require('../workflow.cjs');
const {SDK_ACTIONS}=require('../workflow-actions.cjs');
const ACTIONS=new Set(SDK_ACTIONS),MAX=(1n<<256n)-1n;
const clone=structuredClone;
function check(ok,message){if(!ok)throw new TypeError(message);}
function object(value,name){check(value&&Object.getPrototypeOf(value)===Object.prototype,name+' must be a plain object');}
function known(value,keys,name){object(value,name);check(Object.keys(value).every(k=>keys.includes(k)),'Unknown '+name+' argument');}
function identifier(value,name){check(typeof value==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(value),'Invalid '+name);return value;}
function cap(value,name){if(value===undefined||value===null)return null;check(typeof value==='string'&&/^(0|[1-9][0-9]*)$/.test(value)&&BigInt(value)<=MAX,name+' must be a raw integer string or null (unlimited)');return value;}
function normalizeMandate(input){
 known(input,['id','agentId','actions','budget','duration','expiresAt'],'mandate');
 const agentId=identifier(input.agentId,'agentId'),id=identifier(input.id===undefined?agentId:input.id,'mandate id');
 let actions='all';if(input.actions!==undefined&&input.actions!=='all'){check(Array.isArray(input.actions)&&input.actions.every(a=>ACTIONS.has(a)),'actions must be all or an array of supported SDK action names');actions=[...new Set(input.actions)].sort();}
 check(input.duration===undefined||input.expiresAt===undefined,'Supply duration or expiresAt, not both');
 let lifetime={kind:'lifetime'};
 if(input.expiresAt!==undefined&&input.expiresAt!==null&&input.expiresAt!==Infinity){check(Number.isSafeInteger(input.expiresAt)&&input.expiresAt>=0,'expiresAt must be Unix seconds or null');lifetime={kind:'expires_at',expiresAt:input.expiresAt};}
 if(input.duration!==undefined&&input.duration!=='lifetime'){
  known(input.duration,['weeks','days','hours','seconds'],'duration');const entries=Object.entries(input.duration);check(entries.length===1,'Use exactly one duration unit');const [unit,count]=entries[0];check(Number.isSafeInteger(count)&&count>0,'duration must be a positive integer');
  const seconds=count*({weeks:604800,days:86400,hours:3600,seconds:1}[unit]);check(Number.isSafeInteger(seconds),'Duration exceeds safe integer seconds');lifetime={kind:'duration',seconds};
 }
 let budget=null;
 if(input.budget!==undefined&&input.budget!==null){
  known(input.budget,['chainId','tokenAddress','perTransaction','daily','total'],'budget');
  const limits={perTransaction:cap(input.budget.perTransaction,'perTransaction'),daily:cap(input.budget.daily,'daily'),total:cap(input.budget.total,'total')};
  if(Object.values(limits).some(v=>v!==null)){
   check(Number.isSafeInteger(input.budget.chainId)&&input.budget.chainId>0,'A finite budget requires chainId');
   check(typeof input.budget.tokenAddress==='string'&&/^0x[0-9a-fA-F]{40}$/.test(input.budget.tokenAddress),'A finite budget requires tokenAddress');
   budget={chainId:input.budget.chainId,tokenAddress:input.budget.tokenAddress.toLowerCase(),...limits};
  }else check(input.budget.chainId===undefined&&input.budget.tokenAddress===undefined,'Currency fields require at least one finite budget cap');
 }
 return {version:'a423.mandate.v1',id,agentId,actions,budget,lifetime};
}
function createMandateRegistry({mandates=[],kv,spending,now=()=>Date.now()}={}){
 check(Array.isArray(mandates),'mandates must be an array');check(kv&&typeof kv.create==='function'&&typeof kv.get==='function'&&spending&&typeof spending.reserve==='function','Durable private KV and spending store required');check(typeof now==='function','now must be a function');
 const profiles=mandates.map(normalizeMandate),byAgent=new Map(),records=new Map();for(const p of profiles){check(!byAgent.has(p.agentId),'Only one flat mandate per agent can be configured');byAgent.set(p.agentId,p);}
 const initializedAt=Math.floor(now()/1000);check(Number.isSafeInteger(initializedAt)&&initializedAt>=0,'Invalid mandate clock');
 const ready=(async()=>{for(const p of profiles){
  const key=hashAgreement([p.agentId,p.id]),fingerprint=hashAgreement(p);
  const expiresAt=p.lifetime.kind==='lifetime'?null:p.lifetime.kind==='expires_at'?p.lifetime.expiresAt:initializedAt+p.lifetime.seconds;
  check(expiresAt===null||Number.isSafeInteger(expiresAt),'Mandate expiry exceeds safe integer seconds');
  await kv.create('a423_mandates',key,{...p,fingerprint,registeredAt:initializedAt,expiresAt});
  const saved=await kv.get('a423_mandates',key);check(saved?.fingerprint===fingerprint,'Mandate configuration changed for an existing id; use an explicit new id for renewal or replacement');
  check(hashAgreement({version:saved.version,id:saved.id,agentId:saved.agentId,actions:saved.actions,budget:saved.budget,lifetime:saved.lifetime})===fingerprint,'Stored mandate configuration changed');
  check(saved.expiresAt===(saved.lifetime.kind==='lifetime'?null:saved.lifetime.kind==='expires_at'?saved.lifetime.expiresAt:saved.registeredAt+saved.lifetime.seconds),'Stored mandate expiry changed');
  records.set(p.agentId,saved);
 }})();ready.catch(()=>{});
 async function get(agentId){identifier(agentId,'agentId');await ready;return clone(records.get(agentId)||{version:'a423.mandate.v1',id:null,agentId,actions:'all',budget:null,lifetime:{kind:'lifetime'},registeredAt:null,expiresAt:null});}
 async function authorize({actor,action,phase='execute'}){
  const p=await get(actor);
  if(phase==='reconcile')return true; // Observing an existing intent never creates a transaction.
  if(!ACTIONS.has(action))return false;
  if(p.expiresAt!==null&&Math.floor(now()/1000)>=p.expiresAt)return false;
  return p.actions==='all'||p.actions.includes(action);
 }
 async function reserveBudget({actor,action='fund',requestId,amount,chainId,tokenAddress}){
  if(!await authorize({actor,action}))return false;const p=await get(actor);
  check(typeof requestId==='string'&&requestId.length>0,'Budget requestId required');cap(amount,'amount');check(amount!==null&&amount!==undefined,'Budget amount required');if(!p.budget)return true;
  if(chainId!==p.budget.chainId||typeof tokenAddress!=='string'||tokenAddress.toLowerCase()!==p.budget.tokenAddress)return false;
  try{await spending.reserve({...p.budget,id:'mandate_'+hashAgreement([p.agentId,p.id,requestId]),scope:'mandate_'+hashAgreement([p.agentId,p.id,chainId,p.budget.tokenAddress]),amount,now:now()});return true;}catch(error){if(error.code==='SPENDING_LIMIT_EXCEEDED')return false;throw error;}
 }
 async function authorizeTransaction(context){
  const funding=['fund','approve','approve_zero'].includes(context.step),action=context.operation?.action||(funding?'fund':context.step);
  if(!await authorize({actor:context.actor,action}))return false;
  if(!funding)return true;
  const e=context.job.agreement.terms.escrow;
  return reserveBudget({actor:context.actor,action,requestId:hashAgreement([e.chain_id,e.contract.toLowerCase(),context.job.id,context.job.agreement.hash]),amount:e.amount,chainId:Number(e.chain_id),tokenAddress:e.token});
 }
 return {ready:()=>ready,get,list:async()=>{await ready;return clone([...records.values()]);},authorize,reserveBudget,authorizeTransaction};
}
module.exports={SDK_ACTIONS,normalizeMandate,createMandateRegistry};
