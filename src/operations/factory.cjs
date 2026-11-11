'use strict';
const {createWorkflow,hashAgreement}=require('../workflow.cjs');
const {createCredentialAuthenticator,createAuthorityHandler}=require('../authority/index.cjs');
function createEscrowApplication({storage,authority,escrows,signerFor,addressFor,limitsFor,approveSigning,validateArtifact,execute,keeperEnabled=false,allowAuthorityRequest=async()=>false,requireIndependentArbitrator=true}={}){
 const {createEscrowRegistry,createEvidenceRevalidator,escrowTerms,workerConsent,settlementConsent,escrowTransitions}=require('../escrow/index.cjs');
 const {validateTask,validateEscrowEvidence,createSpendingAuthorizer,createExpiryAdapter,createApplicationHandler,createChatTools}=require('./index.cjs');
 if(!storage||!authority||!Array.isArray(escrows)||!escrows.length||typeof approveSigning!=='function'||typeof limitsFor!=='function')throw new TypeError('Explicit storage, authority, escrow configurations and spending/signing approvals required');
 const registry=new Map(escrows.map(c=>[String(c.chainId)+':'+c.contractAddress.toLowerCase(),c]));
 const configFor=job=>{const e=job.agreement?.terms.escrow;const c=registry.get(e?.chain_id+':'+e?.contract?.toLowerCase());if(!c)throw Error('Unregistered escrow');return c;};
 const checkPolicy=async context=>{
  if(typeof authority.isActive!=='function'||await authority.isActive(context.actor)!==true)return false;
  if((await storage.jobs.getSafety(context.job.id))?.blocked)return false;
  const e=context.job.agreement.terms.escrow;
  if(requireIndependentArbitrator&&[e.payer,e.worker,e.verifier].map(a=>a.toLowerCase()).includes(e.arbitrator.toLowerCase()))return false;
  return await approveSigning(context)===true;
 };
 const authorizeTransaction=createSpendingAuthorizer({spending:storage.spending,limitsFor,authorize:checkPolicy});
 const adapters=createEscrowRegistry(escrows.map(c=>({...c,signerFor,addressFor,transactions:storage.transactions,authorizeTransaction,validateArtifact})));
 const workflow=createWorkflow({store:storage.jobs,adapters:{...adapters,expire:createExpiryAdapter()},transitions:escrowTransitions,
  authorize:async({actor})=>authority.isActive(actor),
  validateTerms:terms=>{validateTask(terms.task);const job={id:'terms_validation',agreement:{terms,hash:hashAgreement(terms)}};escrowTerms(job,configFor(job));},
  validateEvidence:({evidence})=>{if(evidence.transaction_hash)validateEscrowEvidence(evidence);}
 });
 const validators=new Map(escrows.map(c=>[String(c.chainId)+':'+c.contractAddress.toLowerCase(),createEvidenceRevalidator(c)]));
 const revalidate=(job,evidence)=>validators.get(String(configFor(job).chainId)+':'+configFor(job).contractAddress.toLowerCase())(job,evidence);
 const authenticate=createCredentialAuthenticator({authority});
 const applicationOptions={workflow,store:storage.jobs,queue:storage.queue,authenticate,revalidate,consentFor:async job=>workerConsent(job,configFor(job)),settlementConsentFor:async job=>settlementConsent(job,configFor(job)),authorityHandler:createAuthorityHandler({authority,allowRequest:allowAuthorityRequest})};
 const workerOptions={authority,actorFor:async job=>job.pending?.actor||job.participants.requester,allowExecute:keeperEnabled,
  execute,beforeExecute:async job=>{await workflow.assertSafe(job.id,job.participants.worker);if(!await authority.isActive(job.participants.worker))return false;const result=await adapters.start.execute({job,input:{},operation:{actor:job.participants.worker}});return result.status==='confirmed';}
 };
 return {workflow,applicationOptions,workerOptions,handler:createApplicationHandler(applicationOptions),chatTools:actor=>createChatTools({workflow,store:storage.jobs,queue:storage.queue,actor})};
}
module.exports={createEscrowApplication};
