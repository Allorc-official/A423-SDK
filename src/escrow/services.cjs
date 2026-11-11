'use strict';
const {Contract,Interface,AbstractSigner,Transaction,Signature,verifyMessage,verifyTypedData,recoverAddress,hashMessage,TypedDataEncoder,getAddress,ZeroHash}=require('ethers');
const {ESCROW_ABI,escrowTerms,createEscrowAdapters}=require('./index.cjs');
const {validateEscrowEvidence}=require('../operations/index.cjs');
function check(ok,message){if(!ok)throw Error(message);}
function createEscrowRegistry(configurations){
 const map=new Map();for(const c of configurations){const key=c.chainId+':'+getAddress(c.contractAddress).toLowerCase();check(!map.has(key),'Duplicate escrow configuration');map.set(key,createEscrowAdapters(c));}
 const actions=['fund','start','submit','verify','release','refund','dispute','resolve','timeout','propose_settlement','counter_settlement','accept_settlement'];const result={};for(const action of actions){result[action]={};for(const method of ['execute','reconcile'])result[action][method]=ctx=>{const e=ctx.job.agreement?.terms.escrow;const adapter=map.get(e?.chain_id+':'+getAddress(e?.contract).toLowerCase());check(adapter,'Escrow not registered');return adapter[action][method](ctx);};}return result;
}
/** Fresh historical evidence verification. Returns invalid, insufficient_confirmations, or valid; RPC failures throw. */
function createEvidenceRevalidator({provider,chainId,contractAddress,tokenAddress,confirmations}={}){
 const config={chainId,contractAddress:getAddress(contractAddress),tokenAddress:getAddress(tokenAddress)},contract=new Contract(config.contractAddress,ESCROW_ABI,provider),iface=new Interface(ESCROW_ABI);
 check(Number.isSafeInteger(confirmations)&&confirmations>0,'Explicit confirmations required');
 return async(job,evidence)=>{
  validateEscrowEvidence(evidence);const t=escrowTerms(job,config);
  if(Number((await provider.getNetwork()).chainId)!==chainId)throw Error('RPC chain mismatch');
  if(getAddress(await contract.token())!==config.tokenAddress)throw Error('Escrow token mismatch');
  const invalid=message=>({status:'invalid',message});
  if(evidence.chain_id!==String(chainId)||getAddress(evidence.contract)!==config.contractAddress||getAddress(evidence.token)!==config.tokenAddress)return invalid('Evidence destination mismatch');
  const receipt=await provider.getTransactionReceipt(evidence.transaction_hash);
  if(!receipt||receipt.status!==1||receipt.blockHash!==evidence.block_hash||receipt.blockNumber!==evidence.block_number)return invalid('Receipt missing, reverted or changed');
  const block=await provider.getBlock(receipt.blockNumber),head=await provider.getBlock('latest');
  if(!block||block.hash!==receipt.blockHash)return invalid('Orphaned receipt');
  if(head.number-block.number+1<confirmations)return {status:'insufficient_confirmations'};
  const logs=receipt.logs.filter(l=>getAddress(l.address)===config.contractAddress).map(l=>{try{return iface.parseLog(l);}catch{return null;}});
  const event=logs.find(l=>l?.name===evidence.event&&l.args.jobId===t.jobId);if(!event)return invalid('Event absent');
  const snapshot=await contract.getJob(t.jobId,{blockTag:receipt.blockNumber});
  for(const [key,value] of Object.entries(t))if(String(snapshot.terms[key]).toLowerCase()!==String(value).toLowerCase())return invalid('Agreement '+key+' mismatch');
  const expected={amount:t.amount.toString(),payer:t.payer,worker:t.worker,verifier:t.verifier,arbitrator:t.arbitrator,job_id:t.jobId,agreement_hash:t.agreementHash,result_hash:snapshot.resultHash,worker_paid:snapshot.workerPaid.toString(),state:Number(snapshot.state)};
  for(const [key,value] of Object.entries(expected))if(String(evidence[key]).toLowerCase()!==String(value).toLowerCase())return invalid('Cached '+key+' mismatch');
  if(event.name==='Funded'&&(event.args.amount!==t.amount||getAddress(event.args.payer)!==t.payer||getAddress(event.args.worker)!==t.worker||event.args.agreementHash!==t.agreementHash))return invalid('Funding fields mismatch');
  if(['Submitted','Verified'].includes(event.name)&&event.args.resultHash!==snapshot.resultHash)return invalid('Artifact mismatch');
  if(event.name==='Disputed'&&event.args.reasonHash!==evidence.reason_hash)return invalid('Dispute reason mismatch');
  if(event.name==='SettlementProposed'&&(Number(event.args.revision)!==evidence.escrow_version||event.args.proposalHash!==evidence.proposal_hash||event.args.workerAmount.toString()!==evidence.proposal_worker_amount||Number(event.args.expiresAt)!==evidence.proposal_expires_at||getAddress(event.args.proposer)!==getAddress(evidence.proposal_proposer)))return invalid('Proposal fields mismatch');
  if(evidence.escrow_version!==undefined && (Number(snapshot.proposal.revision)!==evidence.escrow_version||snapshot.proposal.proposalHash!==evidence.proposal_hash||snapshot.proposal.workerAmount.toString()!==evidence.proposal_worker_amount||Number(snapshot.proposal.expiresAt)!==evidence.proposal_expires_at||getAddress(snapshot.proposal.proposer)!==getAddress(evidence.proposal_proposer)))return invalid('Cached proposal mismatch');
  if(event.name==='Settled'&&Number(event.args.reason)===4){const acceptance=logs.find(l=>l?.name==='SettlementAccepted'&&l.args.jobId===t.jobId);if(!acceptance||Number(acceptance.args.revision)!==evidence.escrow_version||acceptance.args.proposalHash!==evidence.proposal_hash)return invalid('Mutual acceptance missing');}
  if(event.name==='Settled'&&(event.args.workerAmount!==snapshot.workerPaid||event.args.payerAmount+event.args.workerAmount!==t.amount||Number(event.args.reason)!==evidence.settlement_reason))return invalid('Settlement mismatch');
  return {status:'valid',transaction_hash:receipt.hash,block_hash:block.hash,confirmations:head.number-block.number+1};
 };
}
/** Noncustodial integration surface: the injected digest signer may call a KMS/HSM or remote signer. */
function createManagedSigner({address,provider,signDigest,authorize}={}){
 address=getAddress(address);check(typeof signDigest==='function'&&typeof authorize==='function','Digest signer and authorization required');
 class ManagedSigner extends AbstractSigner {
  async getAddress(){return address;}
  connect(next){return createManagedSigner({address,provider:next,signDigest,authorize});}
  async signature(digest,context){check(await authorize(context)===true,'Managed signer authorization denied');const signature=Signature.from(await signDigest(digest,context));check(getAddress(recoverAddress(digest,signature))===address,'Remote signer returned wrong key');return signature;}
  async signTransaction(request){const copy={...request};if(copy.from){check(getAddress(copy.from)===address,'Wrong signing account');delete copy.from;}const transaction=Transaction.from(copy);const signature=await this.signature(transaction.unsignedHash,{kind:'transaction',transaction:copy});transaction.signature=signature;return transaction.serialized;}
  async signMessage(message){return (await this.signature(hashMessage(message),{kind:'message',message})).serialized;}
  async signTypedData(domain,types,value){return (await this.signature(TypedDataEncoder.hash(domain,types,value),{kind:'typed_data',domain,types,value})).serialized;}
 }
 return new ManagedSigner(provider);
}
/** Explicit bounded same-nonce replacement; never change recipient/calldata/value. Journal preserves lineage. */
async function replacePendingTransaction({id,transactions,provider,signer,authorize,maxFeePerGas,maxPriorityFeePerGas}={}){
 const record=await transactions.get(id);check(record,'Unknown transaction');
 for(const attempt of [record,...(record.replacements||[])])check(!await provider.getTransactionReceipt(attempt.hash),'An attempt is already mined; reconcile instead');
 const last=record.replacements?.at(-1)||record;const old=Transaction.from(last.raw);
 check(old.type===2,'Only EIP-1559 replacements supported');
 const fee=BigInt(maxFeePerGas),tip=BigInt(maxPriorityFeePerGas);
 check(fee>=(old.maxFeePerGas*125n+99n)/100n&&tip>=(old.maxPriorityFeePerGas*125n+99n)/100n&&tip<=fee,'Replacement must raise both fees at least 25%');
 check(await authorize({record,fee,tip})===true,'Replacement not authorized');
 check(getAddress(await signer.getAddress())===old.from,'Wrong replacement signer');
 const request={chainId:old.chainId,nonce:old.nonce,to:old.to,data:old.data,value:old.value,gasLimit:old.gasLimit,type:2,accessList:old.accessList,maxFeePerGas:fee,maxPriorityFeePerGas:tip};
 const raw=await signer.signTransaction(request),tx=Transaction.from(raw);check(tx.from===old.from&&tx.to===old.to&&tx.data===old.data&&tx.value===old.value&&tx.nonce===old.nonce&&tx.chainId===old.chainId&&tx.gasLimit===old.gasLimit&&tx.maxFeePerGas===fee&&tx.maxPriorityFeePerGas===tip,'Replacement signer changed intent');
 check(typeof transactions.appendReplacement==='function','Durable replacement journal required');
 await transactions.appendReplacement(id,last.hash,{hash:tx.hash,raw,to:record.to,data:record.data,from:record.from,created_at:new Date().toISOString()});
 return {hash:tx.hash,raw}; // persisted first; adapter resume broadcasts all known attempts safely.
}
module.exports={createEscrowRegistry,createEvidenceRevalidator,createManagedSigner,replacePendingTransaction};
/** Opt-in bounded fee replacement planning; broadcasting remains the original action's resume path. */
function createFeeReplacementWorker({transactions,provider,signerForRecord,authorize,minAgeMs=60000,maxAttempts=3,maxFeePerGas,maxPriorityFeePerGas}={}){
 check(Number.isSafeInteger(minAgeMs)&&minAgeMs>0&&Number.isSafeInteger(maxAttempts)&&maxAttempts>=1,'Invalid replacement bounds');
 const cap=BigInt(maxFeePerGas),tipCap=BigInt(maxPriorityFeePerGas);
 return async()=>{const results=[];for(const record of await transactions.list()){
  if((record.replacements?.length||0)>=maxAttempts||!record.created_at||Date.now()-Date.parse(record.replacements?.at(-1)?.created_at||record.created_at)<minAgeMs)continue;
  const attempts=[record,...(record.replacements||[])];let mined=false;for(const a of attempts)if(await provider.getTransactionReceipt(a.hash)){mined=true;break;}if(mined)continue;
  const last=Transaction.from(attempts.at(-1).raw);if(last.type!==2)continue;
  const fee=(last.maxFeePerGas*125n+99n)/100n,tip=(last.maxPriorityFeePerGas*125n+99n)/100n;if(fee>cap||tip>tipCap){results.push({id:record.id,status:'cap_reached'});continue;}
  try{const result=await replacePendingTransaction({id:record.id,transactions,provider,signer:await signerForRecord(record),authorize,maxFeePerGas:fee,maxPriorityFeePerGas:tip});results.push({id:record.id,status:'prepared',hash:result.hash});}catch(error){results.push({id:record.id,status:'error',error:error.message});}
 }return results;};
}
module.exports.createFeeReplacementWorker=createFeeReplacementWorker;
/** Concrete transaction-only delegation policy, evaluated again for every signature. */
function createDelegationAuthorizer({expiresAt,chainIds,contracts,selectors,maxValue='0',maxFeePerGas,maxGasLimit,now=()=>Date.now()}={}){
 check(Number.isSafeInteger(expiresAt)&&Array.isArray(chainIds)&&Array.isArray(contracts)&&Array.isArray(selectors),'Explicit delegation bounds required');
 const allowed=new Set(contracts.map(a=>getAddress(a))),methods=new Set(selectors);
 const valueCap=BigInt(maxValue),feeCap=BigInt(maxFeePerGas),gasCap=BigInt(maxGasLimit);
 return async context=>{if(context.kind!=='transaction'||Math.floor(now()/1000)>=expiresAt)return false;const t=context.transaction;
  if(!chainIds.map(String).includes(String(t.chainId))||!t.to||!allowed.has(getAddress(t.to))||!methods.has((t.data||'0x').slice(0,10)))return false;
  if(BigInt(t.value||0)>valueCap||BigInt(t.gasLimit||0)>gasCap||BigInt(t.maxFeePerGas||t.gasPrice||0)>feeCap)return false;
  return true;
 };
}
module.exports.createDelegationAuthorizer=createDelegationAuthorizer;
/** Incremental confirmed log indexer. Consumers must deduplicate key and handle orphan notifications. */
function createEscrowIndexer({provider,chainId,contractAddress,confirmations,fromBlock,kv,onEvent,onReorg,batchSize=1000}={}){
 check(Number.isSafeInteger(fromBlock)&&fromBlock>=0&&Number.isSafeInteger(confirmations)&&confirmations>0&&Number.isSafeInteger(batchSize)&&batchSize>0&&batchSize<=10000,'Explicit indexing bounds required');
 check(kv&&typeof onEvent==='function'&&typeof onReorg==='function','Durable cursor and callbacks required');
 const address=getAddress(contractAddress),iface=new Interface(ESCROW_ABI),scope=chainId+':'+address;
 return async()=>{
  check(Number((await provider.getNetwork()).chainId)===chainId,'Indexer RPC chain mismatch');
  let cursor=await kv.get('index-cursors',scope);
  if(cursor){const block=await provider.getBlock(cursor.block);if(!block||block.hash!==cursor.hash){await onReorg({scope,previous:cursor});
    for(const row of await kv.list('index-events:'+scope)){const b=await provider.getBlock(row.value.block_number);if(!b||b.hash!==row.value.block_hash)await kv.put('index-events:'+scope,row.id,{...row.value,orphaned:true});}
    cursor=null;await kv.put('index-cursors',scope,null);
  }}
  const head=await provider.getBlock('latest'),start=cursor?cursor.block+1:fromBlock,end=Math.min(head.number-confirmations+1,start+batchSize-1);if(end<start)return {indexed:0};
  const scanEnd=await provider.getBlock(end);
  const logs=await provider.getLogs({address,fromBlock:start,toBlock:end});let indexed=0;
  for(const log of logs){let parsed;try{parsed=iface.parseLog(log);}catch{continue;}if(!parsed)continue;
   const key=log.blockHash+':'+log.transactionHash+':'+log.index;
   const old=await kv.get('index-events:'+scope,key);if(old?.delivered&&!old.orphaned)continue;
   const event={key,chain_id:String(chainId),contract:address,block_number:log.blockNumber,block_hash:log.blockHash,transaction_hash:log.transactionHash,log_index:log.index,event:parsed.name,args:parsed.fragment.inputs.reduce((obj,input,i)=>{const value=parsed.args[i];obj[input.name]=typeof value==='bigint'?value.toString():value;return obj;},{}),orphaned:false,delivered:false};
   await kv.put('index-events:'+scope,key,event);await onEvent(event);await kv.put('index-events:'+scope,key,{...event,delivered:true});indexed++;
  }
  const endBlock=await provider.getBlock(end);
  if(!endBlock||endBlock.hash!==scanEnd.hash){await onReorg({scope,during_scan:true});for(const row of await kv.list('index-events:'+scope)){const block=await provider.getBlock(row.value.block_number);if(!block||block.hash!==row.value.block_hash)await kv.put('index-events:'+scope,row.id,{...row.value,orphaned:true});}return {indexed,reorg:true};}
  await kv.put('index-cursors',scope,{block:end,hash:endBlock.hash});return {indexed,through:end};
 };
}
module.exports.createEscrowIndexer=createEscrowIndexer;
