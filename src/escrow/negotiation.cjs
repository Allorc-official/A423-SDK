'use strict';
const {getAddress}=require('ethers');
const TYPES={ClosingSettlement:[['jobId','bytes32'],['agreementHash','bytes32'],['escrowVersion','uint64'],['workerAmount','uint256'],['payerAmount','uint256'],['proposalHash','bytes32'],['expiresAt','uint64']].map(([name,type])=>({name,type}))};
function check(ok,message){if(!ok)throw new TypeError(message);}
const {settlementProposal}=require('../closing.cjs');
function settlementConsent(job,configuration){
 const {escrowTerms}=require('./index.cjs');const t=escrowTerms(job,configuration),p=job.negotiation?.current;
 check(p&&['open','accepted'].includes(job.negotiation.status),'Open settlement proposal required');
 const canonical=settlementProposal(job,{worker_amount:p.worker_amount,payer_amount:p.payer_amount,expected_revision:p.escrow_version-1,expires_at:p.expires_at,reason:p.reason,claims:p.claims});
 check(canonical.proposal_hash===p.proposal_hash,'Stored proposal claims or allocation changed');
 return {domain:{name:'A423Escrow',version:'1',chainId:configuration.chainId,verifyingContract:getAddress(configuration.contractAddress)},types:TYPES,value:{jobId:t.jobId,agreementHash:t.agreementHash,escrowVersion:p.escrow_version,workerAmount:BigInt(p.worker_amount),payerAmount:BigInt(p.payer_amount),proposalHash:p.proposal_hash,expiresAt:p.expires_at}};
}
module.exports={settlementProposal,settlementConsent};
