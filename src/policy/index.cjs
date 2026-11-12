'use strict';
const {hashAgreement}=require('../workflow.cjs');
const BPS=10000n,MAX=(1n<<256n)-1n;
function check(ok,message){if(!ok)throw new TypeError(message);}
function raw(value,name){check(typeof value==='string'&&/^(0|[1-9][0-9]*)$/.test(value),name+' must be an unsigned raw-unit integer string');const n=BigInt(value);check(n<=MAX,name+' exceeds uint256');return n;}
const min=(a,b)=>a<b?a:b,ceil=(a,b)=>(a+b-1n)/b;
const floor=(a,b)=>a>=0n?a/b:-ceil(-a,b);
function margin(cost,payout){return payout===0n?null:(floor((payout-cost)*BPS,payout)).toString();}
function createSettlementPolicy(options={}){
 check(options&&Object.getPrototypeOf(options)===Object.prototype,'Policy thresholds must be a plain object');
 const keys=['target_margin_bps','min_margin_bps','max_margin_bps','require_counter'];
 check(Object.keys(options).every(key=>keys.includes(key)),'Unknown policy threshold; use target_margin_bps, min_margin_bps, max_margin_bps or require_counter');
 const {target_margin_bps=5000,min_margin_bps=1000,max_margin_bps=5000,require_counter=true}=options;
 for(const v of [target_margin_bps,min_margin_bps,max_margin_bps])check(Number.isSafeInteger(v)&&v>=0&&v<10000,'Margins must be integer basis points between 0 and 9999');
 check(min_margin_bps<=target_margin_bps&&target_margin_bps<=max_margin_bps,'Require minimum <= target <= maximum');check(typeof require_counter==='boolean','require_counter must be boolean');
 const configuration={target_margin_bps,min_margin_bps,max_margin_bps,require_counter};
 function evaluate({cost_basis_raw,budget_raw,escrow_raw,offer_raw,negotiation_round=0}){
  const cost=raw(cost_basis_raw,'cost_basis_raw'),budget=raw(budget_raw,'budget_raw'),escrow=raw(escrow_raw,'escrow_raw'),affordable=min(budget,escrow);
  check(Number.isSafeInteger(negotiation_round)&&negotiation_round>=0,'negotiation_round must be nonnegative');
  const target=ceil(cost*BPS,BPS-BigInt(target_margin_bps)),minimum=ceil(cost*BPS,BPS-BigInt(min_margin_bps)),maximum=ceil(cost*BPS,BPS-BigInt(max_margin_bps));
  const recommended=min(target,affordable),offer=offer_raw===undefined?null:raw(offer_raw,'offer_raw');
  const viability=cost===0n?'no_cost':affordable<cost?'below_cost':affordable<minimum?'below_minimum':affordable<target?'below_target':'target_affordable';
  const offerIssue=offer===null?null:offer>affordable?'above_budget_or_escrow':offer>maximum?'above_maximum':offer<cost?'below_cost':offer<minimum?'below_minimum':null;
  const requires=cost>0n&&(affordable<minimum||['below_cost','below_minimum'].includes(offerIssue));
  let decision=cost===0n?'refund':requires?'owner_approval_required':offer===null?'propose':offerIssue?'counter':require_counter&&negotiation_round===0?'counter':'accept';
  if(cost===0n&&offer!==null&&offer!==0n)decision='counter';
  return {version:'a423.profit_policy.v1',...configuration,cost_basis_raw,budget_raw,escrow_raw,affordable:affordable.toString(),target_payout:target.toString(),min_payout:minimum.toString(),max_payout:maximum.toString(),recommended_payout:recommended.toString(),expected_profit:(recommended-cost).toString(),expected_margin_bps:margin(cost,recommended),viability,decision,requires_owner_approval:requires,offer_issue:offerIssue,offer_raw:offer?.toString()??null,offer_profit_raw:offer===null?null:(offer-cost).toString(),offer_margin_bps:offer===null?null:margin(cost,offer),negotiation_round};
 }
 return Object.freeze({configuration:Object.freeze(configuration),evaluate});
}
function profitProjection({evaluation,payout_raw,confirmed=false}){
 check(typeof confirmed==='boolean','confirmed must be boolean');const payout=raw(payout_raw,'payout_raw'),cost=raw(evaluation.cost_basis_raw,'cost_basis_raw');
 const projected={projected_payout_raw:payout_raw,projected_profit_raw:(payout-cost).toString(),projected_margin_bps:margin(cost,payout),target_status:payout>=BigInt(evaluation.target_payout)?'target_met':'below_target'};
 return {...evaluation,...projected,advisory:true,receipt_confirmed:confirmed,realized_payout_raw:confirmed?payout_raw:null,realized_profit_raw:confirmed?projected.projected_profit_raw:null,realized_margin_bps:confirmed?projected.projected_margin_bps:null};
}
function settlementPolicyPrompt({role='worker',policy=createSettlementPolicy(),override}={}){
 check(['worker','requester'].includes(role),'Unknown policy role');if(override!==undefined){check(typeof override==='string','Prompt override must be text');return override;}
 const c=policy.configuration;
 const shared='Use list_jobs to discover unknown IDs; never invent IDs. Reconcile OPERATION_PENDING before another action. Both parties approve the exact revision/hash. Acceptance is not payment; require a freshly confirmed receipt. The runner submits artifacts. Simulated costs are estimates, not invoices.';
 return (role==='worker'?`Profit is the primary objective. Inspect cost basis before quoting or proposing a closing split. Target ${c.target_margin_bps} basis points gross margin on revenue, minimum ${c.min_margin_bps}, maximum ${c.max_margin_bps}. Use the policy recommendation within budget and escrow caps. Never silently accept below cost or minimum; obtain explicit owner approval. ${c.require_counter?'Counter before accepting the first buyer offer. ':''}No cost means a full refund. Publicly share progress, work claims and proposed amounts only; never disclose internal cost, token counts or margin calculations.`:'Evaluate proposals against completed work and the original budget. Do not demand zero solely because work is incomplete; use progress and claims. Never exceed the original budget. Internal worker cost/margins are private.')+' '+shared;
}
function createProfitSettlementService({kv,costBasisFor,budgetFor,policy,thresholds,approveException,canViewPrivate=async()=>false}={}){
 check(policy===undefined||thresholds===undefined,'Supply either thresholds or policy, not both');
 policy=policy===undefined?createSettlementPolicy(thresholds):policy;
 check(policy&&typeof policy.evaluate==='function'&&policy.configuration,'A valid SettlementPolicy is required');
 // Capture and validate configuration at initialization, before any job or cost lookup.
 const configuration=createSettlementPolicy(policy.configuration).configuration;
 check(kv&&typeof kv.create==='function'&&typeof costBasisFor==='function'&&typeof budgetFor==='function','Durable private KV, costBasisFor and budgetFor required');
 const key=job=>hashAgreement([job.id,job.agreement?.hash,job.epoch||0]);
 async function basis(job,freeze=false){
  check(job.agreement?.terms.escrow,'Escrow agreement required');const id=key(job),stored=await kv.get('a423_profit_basis',id);if(stored)return stored;
  const [cost,budget]=await Promise.all([costBasisFor(structuredClone(job)),budgetFor(structuredClone(job))]);
  const snapshot={cost_basis_raw:cost,budget_raw:budget,escrow_raw:job.agreement.terms.escrow.amount,configuration:{...configuration},frozen_at:new Date().toISOString()};
  policy.evaluate(snapshot);
  if(!freeze)return snapshot;await kv.create('a423_profit_basis',id,snapshot);return await kv.get('a423_profit_basis',id);
 }
 async function evaluate(job,{freeze=false,offer_raw}={}){const snapshot=await basis(job,freeze);const history=job.negotiation?.history||[],firstBuyer=history.findIndex(p=>p.proposer_id===job.participants.requester);const round=firstBuyer<0?0:history.filter((p,i)=>i>firstBuyer&&p.proposer_id===job.participants.worker).length;return createSettlementPolicy(snapshot.configuration).evaluate({...snapshot,offer_raw,negotiation_round:round});}
 async function prepare({job,actor,action,input}){
  if(!['propose_settlement','counter_settlement'].includes(action))return input;
  const e=await evaluate(job,{freeze:true});return {...input,worker_amount:input.worker_amount===undefined?(actor===job.participants.worker?e.recommended_payout:'0'):input.worker_amount};
 }
 async function authorize({job,actor,action,input}){
  const workerProposal=['propose_settlement','counter_settlement'].includes(action)&&actor===job.participants.worker;
  const acceptance=['accept_settlement','approve_cancellation','execute_cancellation'].includes(action);
  if(!workerProposal&&!acceptance)return true;
  // Adopting already executed chain evidence is observation, not authorization to spend.
  if(['accept_settlement','execute_cancellation'].includes(action)&&/^0x[0-9a-fA-F]{64}$/.test(input.transaction_hash||''))return true;
  const payout=workerProposal?input.worker_amount:job.negotiation?.current?.worker_amount;
  if(payout===undefined)return true; // The protocol adapter rejects malformed or absent proposals.
  const e=await evaluate(job,{freeze:true,offer_raw:payout});
  if(['above_budget_or_escrow','above_maximum'].includes(e.offer_issue))return false;
  if(e.requires_owner_approval){
   if(typeof approveException!=='function')return false;
   const approval=await approveException({job:structuredClone(job),actor,action,payout_raw:payout,evaluation:structuredClone(e),proposal_hash:job.negotiation?.current?.proposal_hash||null});
   if(approval?.approved!==true||typeof approval.approval_id!=='string'||!approval.approval_id.trim())return false;
   await kv.create('a423_profit_approvals',hashAgreement([key(job),action,payout,job.negotiation?.current?.proposal_hash||null,approval.approval_id]),{job_id:job.id,agreement_hash:job.agreement.hash,action,actor,proposal_hash:job.negotiation?.current?.proposal_hash||null,approval_id:approval.approval_id,payout_raw:payout,at:new Date().toISOString()});
  }
  if(acceptance&&job.negotiation?.current?.proposer_id!==job.participants.worker&&e.require_counter&&e.cost_basis_raw!=='0'&&e.negotiation_round===0)return false;
  return true;
 }
 async function project(job,actor,{revalidate}={}){
  if(!job.agreement?.terms.escrow)return null;
  const proof=[...job.evidence].reverse().find(item=>item.evidence.event==='Settled')?.evidence;
  let confirmed=false,evidence_status=proof?'unavailable':'not_settled';
  if(proof&&revalidate){try{const result=await revalidate(job,proof);confirmed=result.status==='valid';evidence_status=result.status;}catch{evidence_status='unavailable';}}
  const payout=confirmed?proof.worker_paid:job.negotiation?.current?.worker_amount||'0';
  // Never call the cost provider or disclose its output to the requester.
  if(actor!==job.participants.worker&&await canViewPrivate({job:structuredClone(job),actor})!==true)return {advisory:true,proposed_payout_raw:job.negotiation?.current?.worker_amount||null,realized_payout_raw:confirmed?payout:null,receipt_confirmed:confirmed,evidence_status};
  const e=await evaluate(job);const frozen=!!await kv.get('a423_profit_basis',key(job));
  return {...profitProjection({evaluation:e,payout_raw:payout,confirmed}),basis_frozen:frozen,evidence_status};
 }
 return {configuration,evaluate,prepare,authorize,project,prompt:options=>settlementPolicyPrompt({...options,policy:createSettlementPolicy(configuration)})};
}
module.exports={createSettlementPolicy,profitProjection,settlementPolicyPrompt,createProfitSettlementService};
