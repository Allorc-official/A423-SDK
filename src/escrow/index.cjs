'use strict';
const { Contract, Interface, TypedDataEncoder, Transaction, getAddress, sha256, toUtf8Bytes, ZeroHash } = require('ethers');
const { hashAgreement } = require('../workflow.cjs');
const artifact = require('./artifact.json');
const ABI = artifact.abi;
const TOKEN_ABI = ['function allowance(address,address) view returns(uint256)','function approve(address,uint256) returns(bool)'];
const TERMS_TYPES = { Terms: [ ['jobId','bytes32'],['payer','address'],['worker','address'],['verifier','address'],['arbitrator','address'],['amount','uint256'],['workDeadline','uint64'],['reviewDeadline','uint64'],['resolutionDeadline','uint64'],['timeoutWorkerBps','uint16'],['agreementHash','bytes32'] ].map(([name,type])=>({name,type})) };
const transitions = {
  approve_cancellation: {from:['settlement_negotiation'],roles:['requester','worker'],to:'settlement_negotiation',effect:true},
  execute_cancellation: {from:['settlement_negotiation'],roles:['requester','worker'],to:'settled',effect:true},
  propose_settlement: {from:['funded','running','submitted','verified'],roles:['requester','worker'],to:'settlement_negotiation',effect:true},
  counter_settlement: {from:['settlement_negotiation'],roles:['requester','worker'],to:'settlement_negotiation',effect:true},
  accept_settlement: {from:['settlement_negotiation'],roles:['requester','worker'],to:'settled',effect:true},
  refund: {from:['funded','running','settlement_negotiation','disputed'],roles:['requester'],to:'refunded',effect:true},
  dispute: {from:['funded','running','submitted','verified','settlement_negotiation'],roles:['requester','worker','verifier'],to:'disputed',effect:true},
  resolve: {from:['disputed'],roles:['arbitrator'],to:'settled',effect:true},
  timeout: {from:['funded','running','submitted','verified','disputed','settlement_negotiation'],roles:['requester','worker','verifier','arbitrator'],to:'settled',effect:true}
};
function check(condition,message) { if(!condition) throw new Error('Escrow: '+message); }
function positive(value,name) { check(typeof value==='string' && /^[1-9][0-9]*$/.test(value),name+' must be a positive decimal string');const n=BigInt(value);check(n<(1n<<256n),name+' exceeds uint256');return n; }
function bytes32(value) { check(typeof value==='string' && /^0x[0-9a-fA-F]{64}$/.test(value) && value!==ZeroHash,'nonzero bytes32 required');return value; }
function escrowTerms(job,{chainId,contractAddress,tokenAddress}) {
  check(job.agreement && hashAgreement(job.agreement.terms)===job.agreement.hash,'agreement hash mismatch');
  const e=job.agreement.terms.escrow;
  check(e && e.chain_id===String(chainId) && getAddress(e.contract)===getAddress(contractAddress) && getAddress(e.token)===getAddress(tokenAddress),'chain, contract or token mismatch');
  const integer=(value,name)=>{check(Number.isSafeInteger(value)&&value>0,name+' must be positive integer seconds');return value;};
  const t={jobId:sha256(toUtf8Bytes('a423:escrow:v1:'+job.id)),payer:getAddress(e.payer),worker:getAddress(e.worker),verifier:getAddress(e.verifier),arbitrator:getAddress(e.arbitrator),amount:positive(e.amount,'amount'),workDeadline:integer(e.work_deadline,'work_deadline'),reviewDeadline:integer(e.review_deadline,'review_deadline'),resolutionDeadline:integer(e.resolution_deadline,'resolution_deadline'),timeoutWorkerBps:e.timeout_worker_bps,agreementHash:bytes32('0x'+job.agreement.hash)};
  check(t.workDeadline<t.reviewDeadline && t.reviewDeadline<t.resolutionDeadline,'deadlines must be increasing');
  check(Number.isInteger(t.timeoutWorkerBps)&&t.timeoutWorkerBps>=0&&t.timeoutWorkerBps<=10000,'invalid timeout allocation');
  check(t.payer!==t.worker && ![t.payer,t.worker].includes(t.arbitrator),'invalid party separation');
  return t;
}
function workerConsent(job,configuration) { const terms=escrowTerms(job,configuration);return {domain:{name:'A423Escrow',version:'1',chainId:configuration.chainId,verifyingContract:getAddress(configuration.contractAddress)},types:TERMS_TYPES,value:terms}; }
/** Test-only journal. Production must persist records and reserve nonces atomically across instances. */
function createMemoryTransactionStore() {
  const records=new Map(),nonces=new Map(),reservations=new Map();
  return {
    async get(id){return records.has(id)?structuredClone(records.get(id)):null;},
    async create(id,record){if(records.has(id))return false;records.set(id,structuredClone(record));return true;},
    async list(){return [...records].map(([id,record])=>({id,...structuredClone(record)}));},
    async appendReplacement(id,expectedHash,replacement){const record=records.get(id);check(record&&(record.replacements?.at(-1)?.hash||record.hash)===expectedHash,'Replacement conflict');record.replacements=[...(record.replacements||[]),structuredClone(replacement)];},
    async reserveNonce(scope,minimum,operationId){const key=scope+':'+operationId;if(reservations.has(key))return reservations.get(key);const nonce=Math.max(minimum,nonces.get(scope)||0);nonces.set(scope,nonce+1);reservations.set(key,nonce);return nonce;}
  };
}
function createEscrowAdapters({provider,chainId,contractAddress,tokenAddress,signerFor,addressFor,transactions,confirmations,validateArtifact,authorizeTransaction}={}) {
  check(typeof authorizeTransaction==='function','authorizeTransaction is required before any signing or broadcast');
  check(provider && typeof signerFor==='function' && typeof addressFor==='function','provider, signerFor and addressFor required');
  check(Number.isSafeInteger(chainId)&&chainId>0 && Number.isSafeInteger(confirmations)&&confirmations>0,'explicit chain ID and positive confirmations required');
  check(transactions && ['get','create','reserveNonce'].every(k=>typeof transactions[k]==='function'),'durable transaction journal required');
  const config={chainId,contractAddress:getAddress(contractAddress),tokenAddress:getAddress(tokenAddress)};
  const contract=new Contract(config.contractAddress,ABI,provider), iface=new Interface(ABI), token=new Contract(config.tokenAddress,TOKEN_ABI,provider);
  async function context(job) {
    check(Number((await provider.getNetwork()).chainId)===chainId,'RPC chain mismatch');
    check(getAddress(await contract.token())===config.tokenAddress,'contract token mismatch');
    const t=escrowTerms(job,config);
    for(const [role,field] of [['requester','payer'],['worker','worker'],['verifier','verifier'],['arbitrator','arbitrator']]) check(job.participants[role] && getAddress(await addressFor(job.participants[role]))===t[field],role+' wallet mismatch');
    return t;
  }
  function match(snapshot,t) {
    for(const key of Object.keys(t)) check(String(snapshot.terms[key]).toLowerCase()===String(t[key]).toLowerCase(),'on-chain '+key+' mismatch');
  }
  async function receipt(hash) {
    const r=await provider.getTransactionReceipt(hash);
    if(!r)return null;
    const head=await provider.getBlock('latest');
    const block=await provider.getBlock(r.blockNumber);
    if(!block || block.hash!==r.blockHash || head.number-r.blockNumber+1<confirmations)return null;
    return r;
  }
  async function send(ctx,suffix,to,data,reconcile) {
    const id=ctx.operation.id+':'+suffix;
    let record=await transactions.get(id);
    if(!record && reconcile)return {status:'pending',reference:id};
    if(!record) {
      if(await authorizeTransaction({job:structuredClone(ctx.job),operation:structuredClone(ctx.operation),actor:ctx.operation.actor,step:suffix,to:getAddress(to),data,phase:'sign'})!==true)return {status:'rejected',reason:'Signing policy denied before signing'};
      const signer=await signerFor(ctx.operation.actor);
      const address=getAddress(await signer.getAddress());
      check(address===getAddress(await addressFor(ctx.operation.actor)),'signer ownership mismatch');
      const minimum=await provider.getTransactionCount(address,'pending');
      let request;
      try {request=await signer.populateTransaction({to,data,nonce:minimum,chainId});}
      catch(err) {if(err.code==='CALL_EXCEPTION' || err.code==='INSUFFICIENT_FUNDS')return {status:'rejected',reason:'Transaction preflight rejected before signing'};throw err;}
      const nonce=await transactions.reserveNonce(`${chainId}:${address}`,minimum,id);
      request.nonce=nonce;
      const raw=await signer.signTransaction(request);
      const tx=Transaction.from(raw);
      check(tx.from===address && Number(tx.chainId)===chainId && tx.to===getAddress(to) && tx.data===data && tx.nonce===nonce && tx.value===0n,'signed transaction mismatch');
      await transactions.create(id,{hash:tx.hash,raw,to:getAddress(to),data,from:address,created_at:new Date().toISOString()});
      record=await transactions.get(id);
    }
    check(record.to===getAddress(to) && record.data===data && record.from===getAddress(await addressFor(ctx.operation.actor)),'journal request mismatch');
    const attempts=[record,...(record.replacements||[])];
    let active=attempts.at(-1),r=null;
    for(const attempt of attempts){const observed=await receipt(attempt.hash);if(observed){r=observed;active=attempt;break;}}
    if(!r && !reconcile) {
      check(await authorizeTransaction({job:structuredClone(ctx.job),operation:structuredClone(ctx.operation),actor:ctx.operation.actor,step:suffix,to:getAddress(to),data,phase:'broadcast'})===true,'broadcast policy denied');
      try {await provider.broadcastTransaction(active.raw);} catch(err) {if(!await provider.getTransaction(active.hash))throw err;}
      r=await receipt(active.hash);
    }
    if(!r)return {status:'pending',reference:active.hash};
    if(r.status!==1)return {status:'rejected',reason:'Transaction reverted',reference:active.hash};
    return {receipt:r};
  }
  async function observe(ctx,t,suffix,method,args,eventName,validate,reconcile) {
    let sent;
    if(ctx.input.transaction_hash) {
      check(/^0x[0-9a-fA-F]{64}$/.test(ctx.input.transaction_hash),'invalid transaction hash');
      const r=await receipt(ctx.input.transaction_hash);
      sent=!r?{status:'pending',reference:ctx.input.transaction_hash}:r.status===1?{receipt:r}:{status:'rejected',reason:'Transaction reverted',reference:ctx.input.transaction_hash};
    } else sent=await send(ctx,suffix,config.contractAddress,iface.encodeFunctionData(method,args),reconcile);
    if(!sent.receipt)return sent;
    const r=sent.receipt;
    const logs=r.logs.filter(log=>getAddress(log.address)===config.contractAddress).map(log=>{try{return iface.parseLog(log);}catch{return null;}});
    const event=logs.find(log=>log?.name===eventName && log.args.jobId===t.jobId);
    check(event,'matching '+eventName+' event missing');
    const snapshot=await contract.getJob(t.jobId,{blockTag:r.blockNumber});match(snapshot,t);validate(snapshot,event);
    return {status:'confirmed',evidence:require('../operations/index.cjs').validateEscrowEvidence({chain_id:String(chainId),contract:config.contractAddress,token:config.tokenAddress,job_id:t.jobId,agreement_hash:t.agreementHash,transaction_hash:r.hash,block_number:r.blockNumber,block_hash:r.blockHash,confirmations,event:eventName,escrow_version:Number(snapshot.proposal.revision),proposal_hash:snapshot.proposal.proposalHash,proposal_worker_amount:snapshot.proposal.workerAmount.toString(),proposal_expires_at:Number(snapshot.proposal.expiresAt),proposal_proposer:snapshot.proposal.proposer,settlement_reason:eventName==='Settled'?Number(event.args.reason):null,reason_hash:eventName==='Disputed'?event.args.reasonHash:null,amount:t.amount.toString(),payer:t.payer,worker:t.worker,verifier:t.verifier,arbitrator:t.arbitrator,result_hash:snapshot.resultHash,worker_paid:snapshot.workerPaid.toString(),state:Number(snapshot.state),observed_at:new Date().toISOString()})};
  }
  function adapter(run){return {execute:ctx=>run(ctx,false),reconcile:ctx=>run(ctx,true)};}
  const state=(s,n)=>check(Number(s.state)===n,'unexpected escrow state');
  const settled=(s,e,t)=>{check([5,6,7].includes(Number(s.state)),'not settled');check(e.args.workerAmount+e.args.payerAmount===t.amount && e.args.workerAmount===s.workerPaid,'settlement amount mismatch');};
  async function propose(ctx,reconcile){
    const {settlementProposal}=require('./negotiation.cjs');
    const t=await context(ctx.job);let proposal;
    try {proposal=settlementProposal(ctx.job,ctx.input);}catch(error){return {status:'rejected',reason:error.message};}
    return observe(ctx,t,'propose_settlement','proposeSettlement',[t.jobId,ctx.input.expected_revision,BigInt(proposal.worker_amount),proposal.proposal_hash,proposal.expires_at],'SettlementProposed',(s,e)=>{
      check(Number(s.state)===8,'negotiation is not active');
      check(Number(e.args.revision)===proposal.escrow_version && e.args.proposalHash===proposal.proposal_hash && e.args.workerAmount===BigInt(proposal.worker_amount) && e.args.payerAmount===BigInt(proposal.payer_amount) && Number(e.args.expiresAt)===proposal.expires_at && getAddress(e.args.proposer)===getAddress(ctx.settlementActorAddress), 'proposal event mismatch');
    },reconcile);
  }
  const proposeAdapter=adapter(async(ctx,r)=>{ctx.settlementActorAddress=getAddress(await addressFor(ctx.operation.actor));return propose(ctx,r);});
  return {
    approve_cancellation:adapter(async ctx=>{
      await context(ctx.job);const p=ctx.job.negotiation?.current;
      if(!p||ctx.input.expected_revision!==p.escrow_version||ctx.input.proposal_hash!==p.proposal_hash)return {status:'rejected',reason:'Approve the exact current proposal'};
      const {createCancellationInstruction,verifyCancellationAuthorization}=require('./cancellation.cjs');let instruction;
      try{instruction=createCancellationInstruction(ctx.job,ctx.input);}catch(error){return {status:'rejected',reason:error.message};}
      const verified=await verifyCancellationAuthorization(ctx.job,instruction,{provider,...config});
      if(!verified.valid)return {status:'rejected',reason:verified.reason};
      return {status:'confirmed',evidence:{kind:'a423.cancellation_acceptance.v1',instruction,checked_block:verified.checked_block,funds_moved:false}};
    }),
    execute_cancellation:adapter(async(ctx,r)=>{
      const t=await context(ctx.job);const {getCancellationSubflow,validateCancellationInstruction}=require('../cancellation.cjs');
      const instruction=getCancellationSubflow(ctx.job)?.instruction;
      if(!instruction||ctx.input.instruction_id!==instruction.id)return {status:'rejected',reason:'Accepted cancellation instruction required'};
      try{validateCancellationInstruction(ctx.job,instruction);}catch(error){return {status:'rejected',reason:error.message};}
      const {verifyCancellationAuthorization,cancellationCall}=require('./cancellation.cjs');
      if(!ctx.input.transaction_hash&&!await transactions.get(ctx.operation.id+':execute_cancellation')){
        const verified=await verifyCancellationAuthorization(ctx.job,instruction,{provider,...config});if(!verified.valid)return {status:'rejected',reason:verified.reason};
      }
      const call=cancellationCall(instruction);
      const result=await observe(ctx,t,'execute_cancellation',call.functionName,call.args,'Settled',(s,e)=>{
        settled(s,e,t);check(Number(e.args.reason)===4&&e.args.workerAmount.toString()===instruction.worker.amount&&e.args.payerAmount.toString()===instruction.payer.amount&&Number(s.proposal.revision)===instruction.escrow_version&&s.proposal.proposalHash===instruction.proposal_hash,'Instruction allocation mismatch');
      },r);
      if(result.status==='confirmed'){
        const receipt=await provider.getTransactionReceipt(result.evidence.transaction_hash);
        const accepted=receipt.logs.filter(l=>getAddress(l.address)===config.contractAddress).map(l=>{try{return iface.parseLog(l);}catch{return null;}}).find(e=>e?.name==='SettlementAccepted'&&e.args.jobId===t.jobId);
        check(accepted&&Number(accepted.args.revision)===instruction.escrow_version&&accepted.args.proposalHash===instruction.proposal_hash,'Instruction acceptance event missing');
        result.evidence.instruction_id=instruction.id;
      }
      return result;
    }),
    propose_settlement:proposeAdapter,
    counter_settlement:proposeAdapter,
    accept_settlement:adapter(async(ctx,r)=>{
      const {settlementConsent}=require('./negotiation.cjs');const t=await context(ctx.job);const p=ctx.job.negotiation?.current;
      if(!p || ctx.input.expected_revision!==p.escrow_version || ctx.input.proposal_hash!==p.proposal_hash)return {status:'rejected',reason:'Accept the exact current proposal hash and revision'};
      let consent;try{consent=settlementConsent(ctx.job,config);}catch(error){return {status:'rejected',reason:error.message};}
      let method='acceptSettlement',args=[t.jobId,p.escrow_version,p.proposal_hash];
      if(ctx.input.payer_signature!==undefined || ctx.input.worker_signature!==undefined){
        if(typeof ctx.input.payer_signature!=='string'||typeof ctx.input.worker_signature!=='string')return {status:'rejected',reason:'Both party signatures required for relayed settlement'};
        method='settleByConsent';args=[consent.value,ctx.input.payer_signature,ctx.input.worker_signature];
      }else if(ctx.job.negotiation.current.proposer_id===ctx.operation.actor)return {status:'rejected',reason:'Counterparty must accept; proposer cannot self-accept'};
      const result=await observe(ctx,t,'accept_settlement',method,args,'Settled',(s,e)=>{settled(s,e,t);check(Number(e.args.reason)===4 && e.args.workerAmount===BigInt(p.worker_amount) && e.args.payerAmount===BigInt(p.payer_amount) && Number(s.proposal.revision)===p.escrow_version && s.proposal.proposalHash===p.proposal_hash,'closing allocation mismatch');},r);
      if(result.status==='confirmed'){
        const receipt=await provider.getTransactionReceipt(result.evidence.transaction_hash);
        const accepted=receipt.logs.filter(l=>getAddress(l.address)===config.contractAddress).map(l=>{try{return iface.parseLog(l);}catch{return null;}}).find(e=>e?.name==='SettlementAccepted'&&e.args.jobId===t.jobId);
        check(accepted&&Number(accepted.args.revision)===p.escrow_version&&accepted.args.proposalHash===p.proposal_hash,'matching settlement acceptance missing');
      }
      return result;
    }),
    fund:adapter(async(ctx,reconcile)=>{
      const t=await context(ctx.job);
      check([ctx.job.participants.requester,ctx.job.participants.worker].every(p=>ctx.job.agreement.accepted_by.includes(p)),'both acceptances required');
      if(typeof ctx.input.worker_signature!=='string')return {status:'rejected',reason:'worker_signature required'};
      // Consent is checked locally as well as by the contract before moving tokens.
      const {verifyTypedData}=require('ethers');const c=workerConsent(ctx.job,config);
      const digest=TypedDataEncoder.hash(c.domain,c.types,c.value);
      if(await provider.getCode(t.worker)!=='0x'){
        const smart=new Contract(t.worker,['function isValidSignature(bytes32,bytes) view returns(bytes4)'],provider);
        try {if(await smart.isValidSignature(digest,ctx.input.worker_signature)!=='0x1626ba7e')return {status:'rejected',reason:'Invalid smart-account worker consent'};}catch(err){if(err.code==='CALL_EXCEPTION')return {status:'rejected',reason:'Smart-account consent reverted'};throw err;}
      }else {try {if(getAddress(verifyTypedData(c.domain,c.types,c.value,ctx.input.worker_signature))!==t.worker)return {status:'rejected',reason:'Invalid worker consent'};} catch {return {status:'rejected',reason:'Invalid worker consent'};}}
      // Never send further approvals if the funding transaction already exists in the journal.
      if(!ctx.input.transaction_hash && !await transactions.get(ctx.operation.id+':fund')) {
        let allowance=await token.allowance(t.payer,config.contractAddress);
        if(allowance<t.amount) {
          if(allowance>0n){const reset=await send(ctx,'approve_zero',config.tokenAddress,token.interface.encodeFunctionData('approve',[config.contractAddress,0]),reconcile);if(!reset.receipt)return reset;}
          const approval=await send(ctx,'approve',config.tokenAddress,token.interface.encodeFunctionData('approve',[config.contractAddress,t.amount]),reconcile);if(!approval.receipt)return approval;
        }
      }
      return observe(ctx,t,'fund','fund',[t,ctx.input.worker_signature],'Funded',(s,e)=>{check(Number(s.state)>0,'missing funded job');check(e.args.amount===t.amount && getAddress(e.args.payer)===t.payer && getAddress(e.args.worker)===t.worker && e.args.agreementHash===t.agreementHash,'funding event mismatch');},reconcile);
    }),
    start:adapter(async ctx=>{const t=await context(ctx.job);const block=await provider.getBlock('latest');const safeNumber=block.number-confirmations+1;check(safeNumber>=0,'insufficient confirmation depth');const safe=await provider.getBlock(safeNumber);const confirmed=await contract.getJob(t.jobId,{blockTag:safeNumber});match(confirmed,t);state(confirmed,1);const s=await contract.getJob(t.jobId,{blockTag:block.number});match(s,t);state(s,1);check(block.timestamp<=t.workDeadline,'work deadline passed');return {status:'confirmed',evidence:{chain_id:String(chainId),contract:config.contractAddress,job_id:t.jobId,block_number:safe.number,block_hash:safe.hash,confirmations,amount:t.amount.toString(),agreement_hash:t.agreementHash}};}),
    submit:Object.assign(adapter(async(ctx,r)=>{const t=await context(ctx.job);const hash=bytes32(ctx.input.result_hash);return observe(ctx,t,'submit','submit',[t.jobId,hash],'Submitted',(s,e)=>{check(Number(s.state)>=2,'missing submission');check(s.resultHash===hash && e.args.resultHash===hash,'artifact commitment mismatch');},r);}),{rejectPending:async ctx=>{
      const t=await context(ctx.job);let malformed=false;try{bytes32(ctx.input.result_hash);}catch{malformed=true;}
      check(malformed&&!ctx.input.transaction_hash&&!ctx.operation.observation?.reference&&!ctx.operation.observation?.transaction_hash&&!ctx.operation.observation?.evidence?.transaction_hash,'Only syntactically impossible submissions without external transaction references can be rejected');
      check(typeof transactions.list==='function','Transaction journal inventory required');
      check(!(await transactions.list()).some(record=>record.id===ctx.operation.id||record.id.startsWith(ctx.operation.id+':')),'Journaled intent exists; reconcile instead');
      const snapshot=await contract.getJob(t.jobId);match(snapshot,t);check(snapshot.resultHash===ZeroHash,'On-chain submission exists; reconcile instead');
      return {status:'rejected',never_executable:true,reason:'Malformed result_hash cannot encode a submit transaction',checked_chain_id:String(chainId)};
    }}),
    verify:adapter(async(ctx,r)=>{const t=await context(ctx.job);const hash=bytes32(ctx.job.submission?.result_hash);if(!r && !await transactions.get(ctx.operation.id+':verify')){check(typeof validateArtifact==='function','validateArtifact callback required');if(await validateArtifact({job:structuredClone(ctx.job),resultHash:hash})!==true)return {status:'rejected',reason:'Artifact verification failed'};}return observe(ctx,t,'verify','verify',[t.jobId,hash],'Verified',(s,e)=>{check(Number(s.state)>=3,'missing verification');check(s.resultHash===hash && e.args.resultHash===hash,'verified artifact mismatch');},r);}),
    release:adapter(async(ctx,r)=>{const t=await context(ctx.job);return observe(ctx,t,'release','release',[t.jobId],'Settled',(s,e)=>{state(s,5);settled(s,e,t);check(e.args.workerAmount===t.amount && Number(e.args.reason)===0,'not a full release');},r);}),
    refund:adapter(async(ctx,r)=>{const t=await context(ctx.job);return observe(ctx,t,'refund','refundExpired',[t.jobId],'Settled',(s,e)=>{state(s,6);settled(s,e,t);check(e.args.payerAmount===t.amount && Number(e.args.reason)===1,'not an expiry refund');},r);}),
    dispute:adapter(async(ctx,r)=>{const t=await context(ctx.job);const reason=bytes32(ctx.input.reason_hash);return observe(ctx,t,'dispute','dispute',[t.jobId,reason],'Disputed',(s,e)=>{check(Number(s.state)>=4,'missing dispute');check(e.args.reasonHash===reason,'reason mismatch');},r);}),
    resolve:adapter(async(ctx,r)=>{const t=await context(ctx.job);check(typeof ctx.input.worker_amount==='string' && /^(0|[1-9][0-9]*)$/.test(ctx.input.worker_amount),'worker_amount must be decimal string');const amount=BigInt(ctx.input.worker_amount);check(amount<=t.amount,'resolution exceeds escrow');return observe(ctx,t,'resolve','resolve',[t.jobId,amount],'Settled',(s,e)=>{settled(s,e,t);check(e.args.workerAmount===amount && Number(e.args.reason)===2,'resolution mismatch');},r);}),
    timeout:adapter(async(ctx,r)=>{const t=await context(ctx.job);const snapshot=await contract.getJob(t.jobId);const method=snapshot.resultHash===ZeroHash?'refundExpired':'timeout';return observe(ctx,t,'timeout',method,[t.jobId],'Settled',(s,e)=>{settled(s,e,t);const expected=method==='refundExpired'?0n:(t.amount*BigInt(t.timeoutWorkerBps))/10000n;check(e.args.workerAmount===expected && Number(e.args.reason)===(method==='refundExpired'?1:3),'timeout allocation mismatch');},r);})
  };
}
module.exports={createEscrowAdapters,createMemoryTransactionStore,workerConsent,escrowTerms,escrowTransitions:transitions,ESCROW_ABI:ABI,ESCROW_BYTECODE:artifact.bytecode};

Object.assign(module.exports,require('./services.cjs'),require('./negotiation.cjs'),require('./cancellation.cjs'));
