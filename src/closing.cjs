'use strict';
const {hashAgreement}=require('./workflow.cjs');
function check(ok,message){if(!ok)throw new TypeError(message);}
function settlementProposal(job,input){
 const e=job.agreement?.terms.escrow;check(e&&hashAgreement(job.agreement.terms)===job.agreement.hash,'Valid escrow agreement required');
 check(input&&typeof input.worker_amount==='string'&&/^(0|[1-9][0-9]*)$/.test(input.worker_amount),'worker_amount must be a nonnegative raw-unit decimal string');
 const total=BigInt(e.amount),worker=BigInt(input.worker_amount);check(worker<=total,'Allocation exceeds escrow');
 check(Number.isSafeInteger(input.expected_revision)&&input.expected_revision>=0&&input.expected_revision<Number.MAX_SAFE_INTEGER,'expected_revision required');
 check(Number.isSafeInteger(input.expires_at)&&input.expires_at>0&&input.expires_at<=e.resolution_deadline,'Proposal expiry must respect original resolution deadline');
 check(typeof input.reason==='string'&&input.reason.trim()&&input.reason.length<=4000,'Explain the proposed closing settlement');
 const claims=input.claims||[];check(Array.isArray(claims)&&claims.length<=64,'At most 64 claims');
 for(const claim of claims){check(claim&&['work','expense','other'].includes(claim.kind)&&typeof claim.description==='string'&&claim.description.trim()&&claim.description.length<=4000,'Invalid partial-work/expense claim');if(claim.amount!==undefined)check(typeof claim.amount==='string'&&/^(0|[1-9][0-9]*)$/.test(claim.amount),'Claim amount must use raw units');if(claim.evidence!==undefined)check(Array.isArray(claim.evidence)&&claim.evidence.length<=32&&claim.evidence.every(ref=>typeof ref==='string'&&ref.length>0&&ref.length<=2048),'Invalid evidence references');}
 const payer=(total-worker).toString();if(input.payer_amount!==undefined)check(input.payer_amount===payer,'Amounts must equal remaining escrow');
 const proposal={version:'a423.closing.v1',job_id:job.id,agreement_hash:job.agreement.hash,escrow_version:input.expected_revision+1,worker_amount:worker.toString(),payer_amount:payer,expires_at:input.expires_at,reason:input.reason,claims:structuredClone(claims),closes_job:true};
 return {...proposal,proposal_hash:'0x'+hashAgreement(proposal)};
}
module.exports={settlementProposal};
