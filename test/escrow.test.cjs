const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const ganache=require('ganache');
const solc=require('solc');
const {BrowserProvider,Wallet,ContractFactory,Contract,sha256,toUtf8Bytes,ZeroHash}=require('ethers');
const {createWorkflow}=require('../src/workflow.cjs');
const {createMemoryStore}=require('../src/index.cjs');
const {createEscrowAdapters,createMemoryTransactionStore,workerConsent,escrowTransitions,ESCROW_ABI,ESCROW_BYTECODE}=require('../src/escrow/index.cjs');
let rpc,provider,wallets,token,escrow,config;
const hash=x=>sha256(toUtf8Bytes(x));
const actors={buyer:0,worker:1,verifier:2,arb:3,intruder:4};
const participants={requester:'buyer',worker:'worker',verifier:'verifier',arbitrator:'arb'};
before(async()=>{
 rpc=ganache.provider({logging:{quiet:true},chain:{chainId:31337,hardfork:'shanghai'}});
 provider=new BrowserProvider(rpc,undefined,{cacheTimeout:-1});provider.pollingInterval=10;
 wallets=Object.values(rpc.getInitialAccounts()).map(a=>new Wallet(a.secretKey,provider));
 const source=`pragma solidity ^0.8.24; contract Token { mapping(address=>uint) public balanceOf; mapping(address=>mapping(address=>uint)) public allowance; uint public fee; function setFee(uint f) external {fee=f;} function mint(address a,uint n) external {balanceOf[a]+=n;} function approve(address s,uint n) external returns(bool){allowance[msg.sender][s]=n;return true;} function transfer(address to,uint n) external returns(bool){move(msg.sender,to,n);return true;} function transferFrom(address from,address to,uint n) external returns(bool){require(allowance[from][msg.sender]>=n);allowance[from][msg.sender]-=n;move(from,to,n);return true;} function move(address from,address to,uint n) internal {balanceOf[from]-=n;balanceOf[to]+=n-fee;}}`;
 const result=JSON.parse(solc.compile(JSON.stringify({language:'Solidity',sources:{'Token.sol':{content:source}},settings:{evmVersion:'shanghai',outputSelection:{'*':{'*':['abi','evm.bytecode.object']}}}})));
 const t=result.contracts['Token.sol'].Token;
 token=await new ContractFactory(t.abi,t.evm.bytecode.object,wallets[0]).deploy();await token.waitForDeployment();
 escrow=await new ContractFactory(ESCROW_ABI,ESCROW_BYTECODE,wallets[0]).deploy(await token.getAddress());await escrow.waitForDeployment();
 await (await token.mint(wallets[0].address,1000000n)).wait();
 config={chainId:31337,contractAddress:await escrow.getAddress(),tokenAddress:await token.getAddress()};
});
after(async()=>{await provider?.destroy();await rpc?.disconnect();});
async function fixture(id,options={}) {
 const now=(await provider.getBlock('latest')).timestamp;
 const terms={task:'any domain',escrow:{chain_id:'31337',contract:config.contractAddress,token:config.tokenAddress,amount:'100',payer:wallets[0].address,worker:wallets[1].address,verifier:wallets[2].address,arbitrator:wallets[3].address,work_deadline:now+100,review_deadline:now+200,resolution_deadline:now+300,timeout_worker_bps:2500}};
 const transactions=createMemoryTransactionStore();
 const adapters=createEscrowAdapters({provider,...config,signerFor:async actor=>wallets[actors[actor]],addressFor:async actor=>wallets[actors[actor]].address,transactions,confirmations:1,validateArtifact:async()=>true,...options});
 const w=createWorkflow({store:createMemoryStore(),adapters,transitions:escrowTransitions});
 await w.create({id,participants},'buyer');
 let j=await w.act(id,'quote',{terms},{actor:'worker',idempotencyKey:'quote'});
 const acceptance={agreement_hash:j.agreement.hash,revision:1};
 await w.act(id,'accept',acceptance,{actor:'buyer',idempotencyKey:'accept'});
 j=await w.act(id,'accept',acceptance,{actor:'worker',idempotencyKey:'accept'});
 const consent=workerConsent(j,config);
 const signature=await wallets[1].signTypedData(consent.domain,consent.types,consent.value);
 async function act(action,actor,input={},key=action){
  let job;
  for(let i=0;i<8;i++){
   job=await w.act(id,action,input,{actor,idempotencyKey:key});
   if(!job.pending)return job;
   await provider.send('evm_mine',[]);
  }
  throw Error('operation did not complete');
 }
 return {w,act,signature,consent,terms,transactions,adapters,id};
}
async function fund(f){const j=await f.act('fund','buyer',{worker_signature:f.signature});assert.equal(j.state,'funded');return j;}
async function submit(f){await f.act('start','worker');return f.act('submit','worker',{result_hash:hash('actual bytes')});}
async function advance(seconds){await provider.send('evm_increaseTime',[seconds]);await provider.send('evm_mine',[]);}
test('real EVM: bilateral funding locks exactly 100 tokens, submit/verify/release pays once',async()=>{
 const f=await fixture('happy');const before=await token.balanceOf(wallets[1].address);
 await fund(f);assert.equal(await token.balanceOf(config.contractAddress),100n);
 const id=f.consent.value.jobId;
 await assert.rejects(escrow.connect(wallets[2]).release(id));
 await assert.rejects(escrow.connect(wallets[4]).submit(id,hash('fake')));
 await submit(f);await f.act('verify','verifier');
 const paid=await f.act('release','verifier');assert.equal(paid.state,'paid');
 assert.equal(await token.balanceOf(wallets[1].address),before+100n);
 assert.equal(await token.balanceOf(config.contractAddress),0n);
 await f.act('release','verifier');assert.equal(await token.balanceOf(wallets[1].address),before+100n);
 assert.equal((await f.w.receipts('happy','buyer')).evidence.at(-1).evidence.worker_paid,'100');
 await assert.rejects(escrow.connect(wallets[2]).release(id));
});
test('real EVM: signature binds chain, contract, amount and agreement',async()=>{
 const f=await fixture('consent');const t=f.consent.value;
 await assert.rejects(escrow.fund({...t,amount:101n},f.signature));
 const bad=await wallets[1].signTypedData({...f.consent.domain,chainId:1},f.consent.types,t);
 await assert.rejects(escrow.fund(t,bad));
 assert.equal((await f.act('fund','buyer',{worker_signature:bad})).state,'accepted');
 assert.equal(await token.balanceOf(config.contractAddress),0n);
});
test('real EVM: expiry refunds only unsubmitted work, late submissions fail',async()=>{
 const f=await fixture('refund');await fund(f);const before=await token.balanceOf(wallets[0].address);
 await assert.rejects(escrow.refundExpired(f.consent.value.jobId));
 await advance(101);
 await assert.rejects(escrow.connect(wallets[1]).submit(f.consent.value.jobId,hash('late')));
 assert.equal((await f.act('refund','buyer')).state,'refunded');
 assert.equal(await token.balanceOf(wallets[0].address),before+100n);
});
test('real EVM: dispute blocks release/refund and arbitrator splits exact escrow',async()=>{
 const f=await fixture('dispute');await fund(f);await submit(f);
 await f.act('dispute','buyer',{reason_hash:hash('bad output')});
 const id=f.consent.value.jobId;
 await assert.rejects(escrow.connect(wallets[2]).release(id));await assert.rejects(escrow.refundExpired(id));await assert.rejects(escrow.resolve(id,40n));
 const before=await token.balanceOf(wallets[1].address);
 const j=await f.act('resolve','arb',{worker_amount:'40'});assert.equal(j.state,'settled');
 assert.equal(await token.balanceOf(wallets[1].address),before+40n);
 assert.equal(j.evidence.at(-1).evidence.state,7);
});
test('real EVM: missing verifier/arbitrator uses agreed timeout allocation',async()=>{
 const f=await fixture('timeout');await fund(f);await submit(f);
 await assert.rejects(escrow.timeout(f.consent.value.jobId));
 await advance(301);
 const before=await token.balanceOf(wallets[1].address);
 const j=await f.act('timeout','worker');assert.equal(j.state,'settled');
 assert.equal(await token.balanceOf(wallets[1].address),before+25n);
});
test('real EVM: fee-on-transfer funding reverts and does not lock a partial amount',async()=>{
 const f=await fixture('fee');await (await token.setFee(1)).wait();
 assert.equal((await f.act('fund','buyer',{worker_signature:f.signature})).state,'accepted');
 assert.equal(Number((await escrow.getJob(f.consent.value.jobId)).state),0);
 await (await token.setFee(0)).wait();
});
test('real EVM: adapter fails closed for wallet mismatch and bad artifact validation',async()=>{
 const bad=await fixture('wallet',{addressFor:async()=>wallets[4].address});await assert.rejects(fund(bad));
 const f=await fixture('validation',{validateArtifact:async()=>false});await fund(f);await submit(f);
 assert.equal((await f.act('verify','verifier')).pending,null);assert.equal((await f.w.get('validation','buyer')).state,'submitted');
 // Adapter failure leaves pending; changing policy does not erase operation intent.
});
test('real EVM: journal recovers crash after broadcast without new transaction or nonce',async()=>{
 const f=await fixture('recovery');
 // Finish allowance first so the injected outage affects the actual funding broadcast.
 await (await token.approve(config.contractAddress,100n)).wait();
 let crash=true,broadcasts=0;
 const broken=new Proxy(provider,{get(target,key){if(key==='broadcastTransaction')return async raw=>{broadcasts++;const tx=await target.broadcastTransaction(raw);if(crash){crash=false;throw Error('crash after send');}return tx;};if(key==='getTransaction')return async()=>{throw Error('RPC outage');};const value=target[key];return typeof value==='function'?value.bind(target):value;}});
 const adapters=createEscrowAdapters({provider:broken,...config,signerFor:async a=>wallets[actors[a]],addressFor:async a=>wallets[actors[a]].address,transactions:f.transactions,confirmations:1,validateArtifact:async()=>true});
 // Direct adapter context uses an already persisted workflow intent to exercise the crash window.
 const job=await f.w.get(f.id,'buyer');
 const ctx={job,input:{worker_signature:f.signature},operation:{id:'recovery-operation',actor:'buyer'}};
 await assert.rejects(adapters.fund.execute(ctx));
 const record=await f.transactions.get('recovery-operation:fund');assert.ok(record.raw);
 const recovered=await f.adapters.fund.reconcile(ctx);assert.equal(recovered.status,'confirmed');assert.equal(broadcasts,1);
 assert.equal(recovered.evidence.transaction_hash,record.hash);
 // Clean the funded escrow via actual refund.
 await advance(101);await(await escrow.refundExpired(f.consent.value.jobId)).wait();
});
test('real EVM: external permissionless timeout can be adopted with verified transaction evidence',async()=>{
 const f=await fixture('external');await fund(f);await submit(f);await advance(301);
 const tx=await escrow.connect(wallets[4]).timeout(f.consent.value.jobId);await tx.wait();
 const job=await f.act('timeout','worker',{transaction_hash:tx.hash});assert.equal(job.state,'settled');assert.equal(job.evidence.at(-1).evidence.transaction_hash,tx.hash);
});
test('real EVM: configurable confirmation depth stays pending until required blocks exist',async()=>{
 const f=await fixture('depth',{confirmations:3});
 await fund(f);assert.ok((await f.w.get(f.id,'buyer')).evidence[0].evidence.confirmations===3);
 await advance(101);await f.act('refund','buyer');
});
test('real EVM: late submission rejects without trapping workflow, then timeout refunds',async()=>{
 const f=await fixture('late-action');await fund(f);await f.act('start','worker');await advance(101);
 const j=await f.act('submit','worker',{result_hash:hash('too late')});assert.equal(j.state,'running');assert.equal(j.pending,null);
 assert.equal((await f.act('timeout','buyer')).state,'settled');
});
test('real EVM: work gate rejects changed on-chain agreement fields',async()=>{
 const f=await fixture('mismatch');await fund(f);const job=await f.w.get(f.id,'buyer');
 job.agreement.terms.escrow.amount='99';job.agreement.hash=require('../src/workflow.cjs').hashAgreement(job.agreement.terms);
 await assert.rejects(f.adapters.start.execute({job,input:{},operation:{id:'mismatch-start',actor:'worker'}}),/on-chain .* mismatch/);
 await advance(101);await f.act('refund','buyer');
});
