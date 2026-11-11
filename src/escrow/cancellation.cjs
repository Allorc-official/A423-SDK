'use strict';
const {Contract,TypedDataEncoder,verifyTypedData,getAddress}=require('ethers');
const {createCancellationInstruction,validateCancellationInstruction}=require('../cancellation.cjs');
function check(ok,message){if(!ok)throw new TypeError(message);}
function cancellationCall(instruction){
 check(instruction?.version==='a423.cancellation_instruction.v1'&&instruction.authorization?.scheme==='eip712_closing_settlement_v1','Signed cancellation instruction required');
 return {functionName:'settleByConsent',args:[{jobId:instruction.onchain_job_id,agreementHash:instruction.agreement_hash,escrowVersion:instruction.escrow_version,workerAmount:BigInt(instruction.worker.amount),payerAmount:BigInt(instruction.payer.amount),proposalHash:instruction.proposal_hash,expiresAt:instruction.expires_at},instruction.authorization.payer_signature,instruction.authorization.worker_signature]};
}
async function verifyCancellationAuthorization(job,instruction,{provider,chainId,contractAddress,tokenAddress}={}){
 validateCancellationInstruction(job,instruction);
 const {escrowTerms,ESCROW_ABI,settlementConsent}=require('./index.cjs');
 const config={chainId,contractAddress,tokenAddress},terms=escrowTerms(job,config),typed=settlementConsent(job,config);
 if(Number((await provider.getNetwork()).chainId)!==chainId)throw Error('RPC chain mismatch');
 const escrow=new Contract(contractAddress,ESCROW_ABI,provider),block=await provider.getBlock('latest');
 if(getAddress(await escrow.token())!==getAddress(tokenAddress))throw Error('Escrow token mismatch');
 const snapshot=await escrow.getJob(terms.jobId,{blockTag:block.number});
 const invalid=message=>({valid:false,reason:message});
 for(const [key,value] of Object.entries(terms))if(String(snapshot.terms[key]).toLowerCase()!==String(value).toLowerCase())return invalid('On-chain agreement mismatch');
 if(Number(snapshot.state)!==8)return invalid('Escrow is not negotiating');
 const p=snapshot.proposal;
 if(Number(p.revision)!==instruction.escrow_version||p.proposalHash!==instruction.proposal_hash||p.workerAmount.toString()!==instruction.worker.amount||Number(p.expiresAt)!==instruction.expires_at)return invalid('On-chain cancellation proposal changed');
 const proposer=job.negotiation.current.proposer_id===job.participants.requester?terms.payer:job.negotiation.current.proposer_id===job.participants.worker?terms.worker:null;
 if(!proposer||getAddress(p.proposer)!==getAddress(proposer))return invalid('Proposal owner mismatch');
 if(block.timestamp>instruction.expires_at||block.timestamp>terms.resolutionDeadline)return invalid('Cancellation approval expired');
 const digest=TypedDataEncoder.hash(typed.domain,typed.types,typed.value);
 for(const [account,signature] of [[terms.payer,instruction.authorization.payer_signature],[terms.worker,instruction.authorization.worker_signature]]){
  if(await provider.getCode(account,block.number)!=='0x'){
   const wallet=new Contract(account,['function isValidSignature(bytes32,bytes) view returns(bytes4)'],provider);
   try{if(await wallet.isValidSignature(digest,signature,{blockTag:block.number})!=='0x1626ba7e')return invalid('Invalid smart-wallet approval');}catch(error){if(error.code==='CALL_EXCEPTION')return invalid('Smart-wallet approval rejected');throw error;}
  }else{try{if(getAddress(verifyTypedData(typed.domain,typed.types,typed.value,signature))!==getAddress(account))return invalid('Invalid party approval');}catch{return invalid('Invalid party approval');}}
 }
 return {valid:true,checked_block:block.number};
}
module.exports={createCancellationInstruction,validateCancellationInstruction,cancellationCall,verifyCancellationAuthorization};
