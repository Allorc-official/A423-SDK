'use strict';
const {createWorkflow,hashAgreement}=require('../workflow.cjs');
const {createCredentialAuthenticator,createAuthorityHandler}=require('../authority/index.cjs');
function createEscrowApplication({storage,authority,escrows,signerFor,addressFor,limitsFor=async()=>({perTransaction:null,daily:null,total:null}),approveSigning,validateArtifact,execute,settlementPolicy,mandates=[],mandateNow,keeperEnabled=false,forwardCancellations=true,allowAuthorityRequest=async()=>false,requireIndependentArbitrator=true}={}){
 const {createEscrowRegistry,createEvidenceRevalidator,escrowTerms,workerConsent,settlementConsent,escrowTransitions}=require('../escrow/index.cjs');
 const {validateTask,validateEscrowEvidence,createSpendingAuthorizer,createExpiryAdapter,createApplicationHandler,createChatTools}=require('./index.cjs');
 if(!storage||!authority||!Array.isArray(escrows)||!escrows.length||typeof approveSigning!=='function'||typeof limitsFor!=='function')throw new TypeError('Explicit storage, authority, escrow configurations and signing approvals required');
 const mandateRegistry=require('../mandate/index.cjs').createMandateRegistry({mandates,kv:storage.kv,spending:storage.spending,now:mandateNow});
 const profit=settlementPolicy?require('../policy/index.cjs').createProfitSettlementService({...settlementPolicy,kv:storage.kv}):null;
 const registry=new Map(escrows.map(c=>[String(c.chainId)+':'+c.contractAddress.toLowerCase(),c]));
 const configFor=job=>{const e=job.agreement?.terms.escrow;const c=registry.get(e?.chain_id+':'+e?.contract?.toLowerCase());if(!c)throw Error('Unregistered escrow');return c;};
 const checkPolicy=async context=>{
  if(typeof authority.isActive!=='function'||await authority.isActive(context.actor)!==true)return false;
  if((await storage.jobs.getSafety(context.job.id))?.blocked)return false;
  const e=context.job.agreement.terms.escrow;
  if(requireIndependentArbitrator&&[e.payer,e.worker,e.verifier].map(a=>a.toLowerCase()).includes(e.arbitrator.toLowerCase()))return false;
  if(await approveSigning(context)!==true)return false;
  return mandateRegistry.authorizeTransaction(context);
 };
 const authorizeTransaction=createSpendingAuthorizer({spending:storage.spending,limitsFor,authorize:checkPolicy});
 const adapters=createEscrowRegistry(escrows.map(c=>({...c,signerFor,addressFor,transactions:storage.transactions,authorizeTransaction,validateArtifact})));
 const workflow=createWorkflow({store:storage.jobs,adapters:{...adapters,expire:createExpiryAdapter()},transitions:escrowTransitions,
  prepareInput:profit?async context=>{if(await authority.isActive(context.actor)!==true||!await mandateRegistry.authorize(context)){const {A423Error}=require('../index.cjs');throw new A423Error('FORBIDDEN','Active identity and permitted mandate required',403);}return profit.prepare(context);}:undefined,
  authorize:async context=>await authority.isActive(context.actor)===true&&await mandateRegistry.authorize(context)&&(context.phase==='reconcile'||!profit||await profit.authorize(context)),
  validateTerms:terms=>{validateTask(terms.task);const job={id:'terms_validation',agreement:{terms,hash:hashAgreement(terms)}};escrowTerms(job,configFor(job));},
  validateEvidence:({evidence})=>{if(evidence.transaction_hash)validateEscrowEvidence(evidence);}
 });
 const validators=new Map(escrows.map(c=>[String(c.chainId)+':'+c.contractAddress.toLowerCase(),createEvidenceRevalidator(c)]));
 const revalidate=(job,evidence)=>validators.get(String(configFor(job).chainId)+':'+configFor(job).contractAddress.toLowerCase())(job,evidence);
 const authenticate=createCredentialAuthenticator({authority});
 const applicationOptions={profitFor:profit?(job,actor)=>profit.project(job,actor,{revalidate}):undefined,forwardCancellations,workflow,store:storage.jobs,queue:storage.queue,authenticate,revalidate,consentFor:async job=>workerConsent(job,configFor(job)),settlementConsentFor:async job=>settlementConsent(job,configFor(job)),authorityHandler:createAuthorityHandler({authority,allowRequest:allowAuthorityRequest})};
 const canContinue=async job=>await authority.isActive(job.participants.worker)===true&&await mandateRegistry.authorize({actor:job.participants.worker,action:'start'});
 const workerOptions={authority,canContinue,actorFor:async job=>job.pending?.actor||job.participants.requester,allowExecute:keeperEnabled,
  execute,beforeExecute:async job=>{await workflow.assertSafe(job.id,job.participants.worker);if(!await canContinue(job))return false;const result=await adapters.start.execute({job,input:{},operation:{actor:job.participants.worker}});return result.status==='confirmed';}
 };
 return {mandates:mandateRegistry,ready:()=>mandateRegistry.ready(),profit,workflow,applicationOptions,workerOptions,handler:createApplicationHandler(applicationOptions),chatTools:actor=>createChatTools({workflow,store:storage.jobs,queue:storage.queue,actor,profitFor:applicationOptions.profitFor,policyPromptFor:profit?(job,actor)=>profit.prompt({role:actor===job.participants.worker?'worker':'requester'}):undefined})};
}
module.exports={createEscrowApplication};
