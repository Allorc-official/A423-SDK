'use strict';
const {createHash}=require('node:crypto');
const {hashAgreement}=require('./workflow.cjs');
const {settlementProposal}=require('./closing.cjs');
const clone=structuredClone;
function check(ok,message){if(!ok)throw new TypeError(message);}
function cancellationSubflowId(job){check(job.agreement,'Agreement required');return 'cancellation_'+hashAgreement([job.id,job.agreement.hash]);}
function getCancellationSubflow(job){return clone((job.subflows||[]).find(s=>s.kind==='cancellation')||null);}
function canonicalProposal(job){
 const p=job.negotiation?.current;check(p,'Closing proposal required');
 const canonical=settlementProposal(job,{worker_amount:p.worker_amount,payer_amount:p.payer_amount,expected_revision:p.escrow_version-1,expires_at:p.expires_at,reason:p.reason,claims:p.claims});
 check(canonical.proposal_hash===p.proposal_hash,'Proposal claims or allocation changed');return canonical;
}
/** Constructs a JSON instruction. Cryptographic approval is checked separately by the escrow adapter. */
function createCancellationInstruction(job,{payer_signature,worker_signature}={}){
 const p=canonicalProposal(job),e=job.agreement.terms.escrow;
 const address=x=>{check(typeof x==='string'&&/^0x[0-9a-fA-F]{40}$/.test(x),'Invalid escrow address');return x.toLowerCase();};
 const signature=x=>check(typeof x==='string'&&x.length<=32768&&/^0x(?:[0-9a-fA-F]{2})*$/.test(x),'Both wallet signature proofs required');
 signature(payer_signature);signature(worker_signature);
 const body={version:'a423.cancellation_instruction.v1',purpose:'close_job',funds_status:'not_executed',job_id:job.id,subflow_id:cancellationSubflowId(job),agreement_hash:'0x'+job.agreement.hash,chain_id:e.chain_id,escrow_contract:address(e.contract),token:address(e.token),onchain_job_id:'0x'+createHash('sha256').update('a423:escrow:v1:'+job.id).digest('hex'),escrow_version:p.escrow_version,proposal_hash:p.proposal_hash,expires_at:p.expires_at,payer:{agent_id:job.participants.requester,address:address(e.payer),amount:p.payer_amount},worker:{agent_id:job.participants.worker,address:address(e.worker),amount:p.worker_amount},proposal:p};
 return {id:'cancel_instruction_'+hashAgreement(body),...body,authorization:{scheme:'eip712_closing_settlement_v1',payer_signature,worker_signature}};
}
function validateCancellationInstruction(job,instruction){
 check(instruction&&instruction.authorization?.scheme==='eip712_closing_settlement_v1','Cancellation authorization required');
 const expected=createCancellationInstruction(job,instruction.authorization);
 check(hashAgreement(expected)===hashAgreement(instruction),'Cancellation instruction changed or does not match this proposal');
 return clone(instruction);
}
function createCancellationReceipt(job,evidence,instruction=null){
 const e=job.agreement?.terms.escrow;
 check(e&&evidence?.event==='Settled'&&[5,6,7].includes(evidence.state)&&/^0x[0-9a-fA-F]{64}$/.test(evidence.transaction_hash),'Confirmed closing transaction required');
 check(evidence.chain_id===e.chain_id&&evidence.contract.toLowerCase()===e.contract.toLowerCase()&&evidence.token.toLowerCase()===e.token.toLowerCase()&&evidence.agreement_hash==='0x'+job.agreement.hash,'Closing evidence destination mismatch');
 check(evidence.job_id==='0x'+createHash('sha256').update('a423:escrow:v1:'+job.id).digest('hex'),'Closing evidence job mismatch');
 const amount=BigInt(e.amount),paid=BigInt(evidence.worker_paid);
 check(evidence.amount===e.amount&&paid>=0n&&paid<=amount&&((evidence.state===5&&paid===amount)||(evidence.state===6&&paid===0n)||(evidence.state===7&&paid>0n&&paid<amount)),'Invalid actual allocation');
 check(evidence.payer.toLowerCase()===e.payer.toLowerCase()&&evidence.worker.toLowerCase()===e.worker.toLowerCase(),'Closing evidence parties mismatch');
 const reason=evidence.settlement_reason;check([0,1,2,3,4].includes(reason),'Unknown closing outcome');
 const mutual=reason===4;
 if(mutual&&instruction){validateCancellationInstruction(job,instruction);check(instruction.worker.amount===paid.toString()&&instruction.proposal_hash===evidence.proposal_hash&&instruction.escrow_version===evidence.escrow_version,'Instruction was not the executed allocation');}
 const proof=Object.fromEntries(Object.entries(evidence).filter(([key])=>!['observed_at','instruction_id'].includes(key)));
 const body={version:'a423.cancellation_receipt.v1',status:'confirmed',job_id:job.id,subflow_id:cancellationSubflowId(job),agreement_hash:'0x'+job.agreement.hash,outcome:['verified_payment','expiry_refund','arbitrated_split','timeout_allocation','mutual_cancellation'][reason],instruction_id:mutual&&instruction?instruction.id:null,prior_instruction_id:instruction?.id||null,allocations:{worker:{address:e.worker.toLowerCase(),amount:paid.toString()},payer:{address:e.payer.toLowerCase(),amount:(amount-paid).toString()}},remaining_locked:'0',evidence:proof};
 return {id:'cancel_receipt_'+hashAgreement(body),...body};
}
function validateCancellationReceipt(job,receipt){
 check(receipt?.version==='a423.cancellation_receipt.v1','Final cancellation receipt required');
 const instruction=getCancellationSubflow(job)?.instruction||null;
 const expected=createCancellationReceipt(job,receipt.evidence,instruction);
 check(hashAgreement(expected)===hashAgreement(receipt),'Final cancellation receipt changed');return clone(receipt);
}
function updateCancellationSubflow(previous,next,{action,actor,phase,input={},evidence={},instruction,error,at}){
 const old=getCancellationSubflow(previous);
 if(!old&&!['propose_settlement','counter_settlement','approve_cancellation','execute_cancellation','accept_settlement'].includes(action))return;
 const s=old||{id:cancellationSubflowId(previous),kind:'cancellation',parent_job_id:previous.id,status:'negotiating',started_at:at,updated_at:at,proposal_revision:previous.negotiation?.current?.escrow_version||0,instruction:null,receipt:null,events:[]};
 if(phase==='requested'){
  if(['propose_settlement','counter_settlement'].includes(action))s.status='proposal_pending';
  if(action==='approve_cancellation')s.status='acceptance_pending';
  if(action==='execute_cancellation')s.status='execution_pending';
 }
 if(phase==='pending'&&action==='execute_cancellation')s.execution_reference=evidence.reference||null;
 if(phase==='rejected'){
  s.status=action==='execute_cancellation'?'execution_failed':s.instruction?'accepted':previous.negotiation?.current?'negotiating':'proposal_rejected';s.last_error=error||'Operation rejected';
 }
 if(phase==='confirmed'){
  if(['propose_settlement','counter_settlement'].includes(action)){s.status='negotiating';s.proposal_revision=evidence.escrow_version;s.instruction=null;s.last_error=null;}
  if(action==='approve_cancellation'){s.status='accepted';s.instruction=clone(instruction);s.accepted_at=at;s.approved_by=[previous.participants.requester,previous.participants.worker];s.last_error=null;}
  if(action==='dispute')s.status='disputed';
  if(['execute_cancellation','accept_settlement','refund','resolve','timeout','release'].includes(action)&&evidence.event==='Settled'){
   s.receipt=createCancellationReceipt(previous,evidence,s.instruction);s.status='completed';s.completed_at=at;s.execution_reference=evidence.transaction_hash;s.closing_action=action;s.last_error=null;
  }
 }
 s.updated_at=at;s.events.push({sequence:s.events.length+1,type:action+'.'+phase,actor_id:actor,at,data:{proposal_hash:evidence.proposal_hash||previous.negotiation?.current?.proposal_hash||null,instruction_id:s.instruction?.id||null,receipt_id:s.receipt?.id||null,error:error||null}});
 next.subflows=[...(next.subflows||previous.subflows||[]).filter(flow=>flow.id!==s.id),s];next.active_subflow_id=['completed','proposal_rejected'].includes(s.status)?null:s.id;
}
module.exports={cancellationSubflowId,getCancellationSubflow,createCancellationInstruction,validateCancellationInstruction,createCancellationReceipt,validateCancellationReceipt,updateCancellationSubflow};
