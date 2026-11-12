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
 const terms={task:{id:'task',type:'research',description:'any domain',deliverables:[{id:'report',media_type:'text/markdown',description:'report'}],acceptance:{validator:'test',version:'1',criteria:{}}},escrow:{chain_id:'31337',contract:config.contractAddress,token:config.tokenAddress,amount:'100',payer:wallets[0].address,worker:wallets[1].address,verifier:wallets[2].address,arbitrator:wallets[3].address,work_deadline:now+100,review_deadline:now+200,resolution_deadline:now+300,timeout_worker_bps:2500}};
 Object.assign(terms.escrow,options.escrowOverrides||{});
 const transactions=options.transactions||createMemoryTransactionStore();
 const adapters=createEscrowAdapters({authorizeTransaction:async()=>true,provider,...config,signerFor:async actor=>wallets[actors[actor]],addressFor:async actor=>wallets[actors[actor]].address,transactions,confirmations:1,validateArtifact:async()=>true,...options});
 const w=createWorkflow({store:options.workflowStore||createMemoryStore(),adapters,transitions:escrowTransitions});
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
 const adapters=createEscrowAdapters({authorizeTransaction:async()=>true,provider:broken,...config,signerFor:async a=>wallets[actors[a]],addressFor:async a=>wallets[actors[a]].address,transactions:f.transactions,confirmations:1,validateArtifact:async()=>true});
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
test('real EVM: mandatory signing policy blocks all approval/funding signatures',async()=>{
 const f=await fixture('sign-policy',{authorizeTransaction:async()=>false});const before=await token.balanceOf(config.contractAddress);
 const j=await f.act('fund','buyer',{worker_signature:f.signature});assert.equal(j.state,'accepted');assert.equal(j.pending,null);assert.equal((await f.transactions.list()).length,0);assert.equal(await token.balanceOf(config.contractAddress),before);
});
test('real EVM: fresh receipts validate chain evidence and reject tampered cached amount',async()=>{
 const {createEvidenceRevalidator}=require('../src/escrow/index.cjs');const f=await fixture('fresh');const funded=await fund(f);
 const validate=createEvidenceRevalidator({provider,...config,confirmations:1});const e=funded.evidence[0].evidence;
 assert.equal((await validate(funded,e)).status,'valid');assert.equal((await validate(funded,{...e,amount:'99'})).status,'invalid');
 await advance(101);await f.act('refund','buyer');
});
test('real EVM: ERC1271 worker wallet consent and externally signed submission are supported',async()=>{
 const source=`pragma solidity ^0.8.24; contract Worker { address immutable owner;constructor(address o){owner=o;}function isValidSignature(bytes32 h,bytes calldata sig) external view returns(bytes4){(bytes32 r,bytes32 s,uint8 v)=abi.decode(sig,(bytes32,bytes32,uint8));return ecrecover(h,v,r,s)==owner?bytes4(0x1626ba7e):bytes4(0xffffffff);}function execute(address to,bytes calldata data) external {require(msg.sender==owner);(bool ok,)=to.call(data);require(ok);}}`;
 // Encode consent as (r,s,v) for this test wallet's custom ERC1271 signature format.
 const out=JSON.parse(solc.compile(JSON.stringify({language:'Solidity',sources:{'W.sol':{content:source}},settings:{evmVersion:'shanghai',outputSelection:{'*':{'*':['abi','evm.bytecode.object']}}}}))).contracts['W.sol'].Worker;
 const smart=await new ContractFactory(out.abi,out.evm.bytecode.object,wallets[1]).deploy(wallets[1].address);await smart.waitForDeployment();const address=await smart.getAddress();
 const f=await fixture('smart-worker',{escrowOverrides:{worker:address},addressFor:async actor=>actor==='worker'?address:wallets[actors[actor]].address});
 const {Signature,AbiCoder}=require('ethers'),sig=Signature.from(f.signature);f.signature=AbiCoder.defaultAbiCoder().encode(['bytes32','bytes32','uint8'],[sig.r,sig.s,sig.v]);await fund(f);await f.act('start','worker');
 const resultHash=hash('smart account result');const tx=await smart.execute(config.contractAddress,escrow.interface.encodeFunctionData('submit',[f.consent.value.jobId,resultHash]));await tx.wait();
 const j=await f.act('submit','worker',{result_hash:resultHash,transaction_hash:tx.hash});assert.equal(j.state,'submitted');
 await f.act('verify','verifier');await f.act('release','verifier');
});
test('real EVM: managed remote signer enforces concrete delegation and validates returned key',async()=>{
 const {createManagedSigner,createDelegationAuthorizer}=require('../src/escrow/index.cjs');const selector=escrow.interface.getFunction('refundExpired').selector;
 const allow=createDelegationAuthorizer({expiresAt:Math.floor(Date.now()/1000)+60,chainIds:[31337],contracts:[config.contractAddress],selectors:[selector],maxGasLimit:'1000000',maxFeePerGas:'100000000000'});
 const managed=createManagedSigner({address:wallets[0].address,provider,authorize:allow,signDigest:async digest=>wallets[0].signingKey.sign(digest).serialized});
 const tx={to:config.contractAddress,data:escrow.interface.encodeFunctionData('refundExpired',[hash('none')]),nonce:0,chainId:31337,type:2,maxFeePerGas:1000000000n,maxPriorityFeePerGas:1n,gasLimit:100000n};
 assert.equal(require('ethers').Transaction.from(await managed.signTransaction(tx)).from,wallets[0].address);
 await assert.rejects(managed.signTransaction({...tx,to:wallets[4].address}));await assert.rejects(managed.signMessage('unscoped'));
});
test('real EVM application journey uses durable SQLite, credential auth, HTTP actions and fresh PDF receipts',async()=>{
 const {createSqliteStorage}=require('../src/storage/index.cjs');const {createApplicationHandler,createSpendingAuthorizer}=require('../src/operations/index.cjs');const {createEvidenceRevalidator}=require('../src/escrow/index.cjs');
 const {createAuthority,createCredentialAuthenticator}=require('../src/authority/index.cjs');const {generateKeyPairSync,sign}=require('node:crypto');
 const s=createSqliteStorage({filename:':memory:'});try{
 const keys=()=>{const x=generateKeyPairSync('ed25519');return {privateKey:x.privateKey,publicKey:x.publicKey.export({type:'spki',format:'pem'})};};
 const root=keys(),org=keys();const authority=createAuthority({issuer:'integration',audience:'app',privateKey:root.privateKey,kv:s.kv});await authority.registerOrganization({id:'org',name:'Test',publicKey:org.publicKey});const credentials={};
 for(const actor of ['buyer','worker','verifier','arb']){const key=keys(),enrollment={organization:'org',agentId:actor,publicKey:key.publicKey,scopes:['workflow']};await authority.registerAgent({...enrollment,organizationSignature:sign(null,Buffer.from(JSON.stringify(authority.registration(enrollment))),org.privateKey).toString('base64url')});const c=await authority.challenge(actor);credentials[actor]=(await authority.exchange({challengeId:c.id,signature:sign(null,Buffer.from(JSON.stringify(c)),key.privateKey).toString('base64url')})).credential;}
 const authorizeTransaction=createSpendingAuthorizer({spending:s.spending,limitsFor:async()=>({perTransaction:'100',daily:'100',total:'100'}),authorize:async()=>true});
 const f=await fixture('http-app',{workflowStore:s.jobs,transactions:s.transactions,authorizeTransaction});
 const {createEscrowApplication}=require('../src/operations/index.cjs');const app=createEscrowApplication({storage:s,authority,escrows:[{provider,...config,confirmations:1}],signerFor:async actor=>wallets[actors[actor]],addressFor:async actor=>wallets[actors[actor]].address,limitsFor:async()=>({perTransaction:'100',daily:'100',total:'100'}),approveSigning:async()=>true,validateArtifact:async()=>true});const handler=app.handler;
 async function action(name,actor,input={}){let data;for(let i=0;i<8;i++){const response=await handler(new Request('https://app.test/api/a423/jobs/http-app/actions',{method:'POST',headers:{authorization:'Bearer '+credentials[actor],'content-type':'application/json','idempotency-key':name},body:JSON.stringify({action:name,input})}));data=await response.json();assert.equal(response.status,200,JSON.stringify(data));if(!data.job.pending)return data.job;await provider.send('evm_mine',[]);}throw Error('pending');}
 assert.equal((await action('fund','buyer',{worker_signature:f.signature})).state,'funded');await action('start','worker');await action('submit','worker',{result_hash:hash('http bytes')});await action('verify','verifier');await action('release','verifier');
 const headers={authorization:'Bearer '+credentials.buyer};const state=await(await handler(new Request('https://app.test/api/state',{headers}))).json();assert.equal(state.a423.jobs[0].state,'paid');assert.ok(state.a423.wallet_transactions.length>=4);
 const pdf=await handler(new Request('https://app.test/api/a423-receipts/http-app.pdf',{headers}));assert.equal(pdf.status,200);assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0,4).toString(),'%PDF');
 const consent=await handler(new Request('https://app.test/api/a423-worker-consent/http-app',{headers}));assert.equal(consent.status,403);
 }finally{s.close();}
});
function proposal(f,worker='30',expected=0){return {worker_amount:worker,expected_revision:expected,expires_at:f.terms.escrow.work_deadline-1,reason:'Research completed; analysis remains unfinished',claims:[{kind:'work',description:'Collected and checked sources',amount:'20',evidence:['artifact:source-list']},{kind:'expense',description:'Agreed research cost',amount:'10',evidence:['receipt:research-cost']}]};}
function acceptInput(job){return {expected_revision:job.negotiation.current.escrow_version,proposal_hash:job.negotiation.current.proposal_hash};}
test('closing negotiation: partial work and costs, counteroffer, exact acceptance and split ledger',async()=>{
 const f=await fixture('closing');await fund(f);await f.act('start','worker');
 const beforeBuyer=await token.balanceOf(wallets[0].address),beforeWorker=await token.balanceOf(wallets[1].address);
 let job=await f.act('propose_settlement','worker',proposal(f));assert.equal(job.state,'settlement_negotiation');assert.equal(job.work_status,'paused');assert.equal(job.negotiation.current.worker_amount,'30');assert.equal(job.escrow_ledger.locked_amount,'100');assert.equal(job.negotiation.current.claims.length,2);
 await assert.rejects(f.w.assertSafe(f.id,'worker'),{code:'WORK_PAUSED'});
 await assert.rejects(escrow.connect(wallets[1]).submit(f.consent.value.jobId,hash('late work')));
 await assert.rejects(escrow.connect(wallets[2]).release(f.consent.value.jobId));
 const altered=structuredClone(job);altered.negotiation.current.reason='Altered claim';assert.throws(()=>require('../src/escrow/index.cjs').settlementConsent(altered,config));
 const stale=acceptInput(job);job=await f.act('counter_settlement','buyer',proposal(f,'20',1));assert.equal(job.negotiation.history.length,2);assert.equal(job.negotiation.current.payer_amount,'80');
 assert.equal((await f.act('accept_settlement','worker',stale,'stale-accept')).state,'settlement_negotiation');
 assert.equal((await f.act('accept_settlement','buyer',acceptInput(job),'self-accept')).state,'settlement_negotiation');
 job=await f.act('accept_settlement','worker',acceptInput(job));assert.equal(job.state,'settled');assert.equal(job.work_status,'stopped');assert.equal(job.negotiation.status,'settled');
 assert.deepEqual(job.escrow_ledger,{funded_amount:'100',worker_paid:'20',payer_refunded:'80',locked_amount:'0',escrow_version:2});
 assert.equal(await token.balanceOf(wallets[0].address),beforeBuyer+80n);assert.equal(await token.balanceOf(wallets[1].address),beforeWorker+20n);
 await f.act('accept_settlement','worker',acceptInput(job));assert.equal(await token.balanceOf(wallets[1].address),beforeWorker+20n);
 const {createEvidenceRevalidator}=require('../src/escrow/index.cjs');const validate=createEvidenceRevalidator({provider,...config,confirmations:1});for(const item of job.evidence)if(item.evidence.transaction_hash)assert.equal((await validate(job,item.evidence)).status,'valid');
});
test('closing negotiation: proposals work before execution and after submission/verification',async()=>{
 for(const stage of ['funded','submitted','verified']){
  const f=await fixture('closing_'+stage);await fund(f);if(stage!=='funded')await submit(f);if(stage==='verified')await f.act('verify','verifier');
  let job=await f.act('propose_settlement','buyer',proposal(f,'10'));assert.equal(job.negotiation.origin_state,stage);
  if(stage==='verified')await assert.rejects(escrow.connect(wallets[2]).release(f.consent.value.jobId));
  job=await f.act('accept_settlement','worker',acceptInput(job));assert.equal(job.state,'settled');assert.equal(job.escrow_ledger.worker_paid,'10');
 }
});
test('closing negotiation: invalid amounts, roles, revisions and extended deadlines do not move money',async()=>{
 const f=await fixture('closing_invalid');await fund(f);
 assert.equal((await f.act('propose_settlement','buyer',proposal(f,'101'),'over')).state,'funded');
 await assert.rejects(f.act('propose_settlement','verifier',proposal(f)),{code:'FORBIDDEN'});
 await assert.rejects(f.act('propose_settlement','intruder',proposal(f)),{code:'NOT_FOUND'});
 assert.equal((await f.act('propose_settlement','buyer',{...proposal(f),expires_at:f.terms.escrow.resolution_deadline+1},'extended')).state,'funded');
 let job=await f.act('propose_settlement','buyer',proposal(f));
 assert.equal((await f.act('counter_settlement','worker',proposal(f,'20',0),'stale')).negotiation.current.escrow_version,1);
 assert.equal((await f.act('counter_settlement','buyer',proposal(f,'20',1),'same-proposer')).negotiation.current.escrow_version,1);
 job=await f.act('accept_settlement','worker',acceptInput(job));assert.equal(job.escrow_ledger.worker_paid,'30');
});
test('closing negotiation: expired proposals cannot settle or extend the original refund deadline',async()=>{
 const f=await fixture('closing_expired');await fund(f);const now=(await provider.getBlock('latest')).timestamp;
 const job=await f.act('propose_settlement','worker',{...proposal(f),expires_at:now+5});await advance(6);
 assert.equal((await f.act('accept_settlement','buyer',acceptInput(job))).state,'settlement_negotiation');
 await assert.rejects(escrow.acceptSettlement(f.consent.value.jobId,1,job.negotiation.current.proposal_hash));
 await advance(100);const refunded=await f.act('refund','buyer');assert.equal(refunded.state,'refunded');assert.equal(refunded.escrow_ledger.payer_refunded,'100');
});
test('closing negotiation: pre-submission disagreement can escalate to arbitrated compensation',async()=>{
 const f=await fixture('closing_arbitrated');await fund(f);await f.act('start','worker');await f.act('propose_settlement','worker',proposal(f));
 const disputed=await f.act('dispute','buyer',{reason_hash:hash('cannot agree on partial work')});assert.equal(disputed.negotiation.status,'disputed');
 await assert.rejects(escrow.acceptSettlement(f.consent.value.jobId,1,disputed.negotiation.current.proposal_hash));
 const resolved=await f.act('resolve','arb',{worker_amount:'40'});assert.equal(resolved.state,'settled');assert.equal(resolved.escrow_ledger.worker_paid,'40');assert.equal(resolved.escrow_ledger.payer_refunded,'60');
});
test('closing negotiation: submitted negotiations retain the original timeout allocation',async()=>{
 const f=await fixture('closing_timeout');await fund(f);await submit(f);await f.act('propose_settlement','buyer',proposal(f,'10'));await advance(301);
 const job=await f.act('timeout','worker');assert.equal(job.state,'settled');assert.equal(job.escrow_ledger.worker_paid,'25');assert.equal(job.escrow_ledger.payer_refunded,'75');assert.equal(job.negotiation.status,'settled');
});
test('closing negotiation: both signatures can be relayed, while stale/changed/cross-chain proofs fail',async()=>{
 const {settlementConsent}=require('../src/escrow/index.cjs');const f=await fixture('closing_signatures');await fund(f);
 let job=await f.act('propose_settlement','worker',proposal(f));let typed=settlementConsent(job,config);
 const oldPayer=await wallets[0].signTypedData(typed.domain,typed.types,typed.value),oldWorker=await wallets[1].signTypedData(typed.domain,typed.types,typed.value),old=typed;
 job=await f.act('counter_settlement','buyer',proposal(f,'20',1));typed=settlementConsent(job,config);
 await assert.rejects(escrow.connect(wallets[4]).settleByConsent(old.value,oldPayer,oldWorker));
 const payer=await wallets[0].signTypedData(typed.domain,typed.types,typed.value),worker=await wallets[1].signTypedData(typed.domain,typed.types,typed.value);
 const wrongChain=await wallets[0].signTypedData({...typed.domain,chainId:1},typed.types,typed.value);await assert.rejects(escrow.connect(wallets[4]).settleByConsent(typed.value,wrongChain,worker));
 await assert.rejects(escrow.connect(wallets[4]).settleByConsent({...typed.value,workerAmount:21n,payerAmount:79n},payer,worker));
 const tx=await escrow.connect(wallets[4]).settleByConsent(typed.value,payer,worker);await tx.wait();
 job=await f.act('accept_settlement','worker',{...acceptInput(job),transaction_hash:tx.hash});assert.equal(job.state,'settled');assert.equal(job.escrow_ledger.worker_paid,'20');
 await assert.rejects(escrow.connect(wallets[4]).settleByConsent(typed.value,payer,worker));
});
test('closing negotiation: zero/full compensation settle immediately without a work submission',async()=>{
 for(const amount of ['0','100']){const f=await fixture('closing_full_'+amount);await fund(f);let job=await f.act('propose_settlement','worker',proposal(f,amount));job=await f.act('accept_settlement','buyer',acceptInput(job));assert.equal(job.escrow_ledger.worker_paid,amount);assert.equal(job.escrow_ledger.payer_refunded,String(100-Number(amount)));assert.equal(job.state,'settled');}
});
test('closing negotiation: SDK can relay both party signatures through its journal',async()=>{
 const {settlementConsent}=require('../src/escrow/index.cjs');const f=await fixture('closing_sdk_relay');await fund(f);let job=await f.act('propose_settlement','buyer',proposal(f,'35'));const t=settlementConsent(job,config);
 job=await f.act('accept_settlement','buyer',{...acceptInput(job),payer_signature:await wallets[0].signTypedData(t.domain,t.types,t.value),worker_signature:await wallets[1].signTypedData(t.domain,t.types,t.value)});assert.equal(job.state,'settled');assert.equal(job.escrow_ledger.worker_paid,'35');
});
test('closing negotiation: a crash after proposal broadcast recovers and preserves the paused job',async()=>{
 const memory=createMemoryStore();let failSave=true;const store={...memory,compareAndSet:async(id,v,next)=>{if(failSave&&next.negotiation?.status==='open'){failSave=false;return false;}return memory.compareAndSet(id,v,next);}};
 const f=await fixture('closing_recovery',{workflowStore:store});await fund(f);
 await assert.rejects(f.act('propose_settlement','worker',proposal(f)),{code:'CONFLICT'});
 const pending=await f.w.get(f.id,'worker');assert.equal(pending.pending.action,'propose_settlement');await assert.rejects(f.w.assertSafe(f.id,'worker'),{code:'WORK_PAUSED'});
 const recovered=await f.w.reconcile(f.id,'worker');assert.equal(recovered.state,'settlement_negotiation');assert.equal(recovered.negotiation.history.length,1);
 const closed=await f.act('accept_settlement','buyer',acceptInput(recovered));assert.equal(closed.escrow_ledger.worker_paid,'30');
});
async function cancellationApproval(job){
 const t=require('../src/escrow/index.cjs').settlementConsent(job,config);
 return {...acceptInput(job),payer_signature:await wallets[0].signTypedData(t.domain,t.types,t.value),worker_signature:await wallets[1].signTypedData(t.domain,t.types,t.value)};
}
test('cancellation subflow: accepted JSON is durable before transfer; confirmed receipt records actual split',async()=>{
 const f=await fixture('cancel_staged');await fund(f);
 let job=await f.act('propose_settlement','worker',proposal(f));const input=await cancellationApproval(job);
 const before=await token.balanceOf(wallets[1].address);
 job=await f.w.acceptCancellation(f.id,input,{actor:'buyer',idempotencyKey:'approve-json',forward:false});
 assert.equal(job.subflows[0].status,'accepted');assert.equal(job.subflows[0].parent_job_id,f.id);
 assert.equal(job.escrow_ledger.locked_amount,'100');assert.equal(await token.balanceOf(wallets[1].address),before);
 await assert.rejects(f.w.cancellationReceipt(f.id,'buyer'),{code:'RECEIPT_UNAVAILABLE'});
 const instruction=await f.w.cancellationInstruction(f.id,'buyer');assert.equal(instruction.funds_status,'not_executed');assert.equal(instruction.worker.amount,'30');assert.equal(instruction.payer.amount,'70');
 const api=require('../src/escrow/index.cjs');assert.equal(api.cancellationCall(JSON.parse(JSON.stringify(instruction))).functionName,'settleByConsent');
 assert.throws(()=>api.validateCancellationInstruction(job,{...instruction,token:wallets[4].address}));
 await assert.rejects(f.act('counter_settlement','buyer',proposal(f,'20',1)),{code:'CANCELLATION_ACCEPTED'});
 job=await f.act('execute_cancellation','buyer',{instruction_id:instruction.id});assert.equal(job.state,'settled');assert.equal(job.subflows[0].status,'completed');assert.equal(job.active_subflow_id,null);
 const receipt=await f.w.cancellationReceipt(f.id,'buyer');assert.equal(receipt.instruction_id,instruction.id);assert.equal(receipt.remaining_locked,'0');assert.equal(receipt.allocations.worker.amount,'30');assert.equal(receipt.allocations.payer.amount,'70');assert.equal(receipt.outcome,'mutual_cancellation');
 assert.equal(await token.balanceOf(wallets[1].address),before+30n);
 const {freshCancellationReceipt}=require('../src/operations/index.cjs');
 const revalidate=require('../src/escrow/index.cjs').createEvidenceRevalidator({provider,...config,confirmations:1});
 assert.equal((await freshCancellationReceipt({workflow:f.w,id:f.id,actor:'buyer',revalidate})).id,receipt.id);
 await assert.rejects(f.w.cancellationReceipt(f.id,'intruder'),{code:'NOT_FOUND'});
 job=await f.w.acceptCancellation(f.id,input,{actor:'buyer',idempotencyKey:'approve-json',forward:true});assert.equal(job.state,'settled');assert.equal(await token.balanceOf(wallets[1].address),before+30n);
});
test('cancellation subflow: invalid signatures never produce an accepted instruction or payment receipt',async()=>{
 const f=await fixture('cancel_bad_proof');await fund(f);let job=await f.act('propose_settlement','worker',proposal(f));
 const input=await cancellationApproval(job);input.payer_signature=input.worker_signature;
 job=await f.w.acceptCancellation(f.id,input,{actor:'buyer',idempotencyKey:'bad-signatures'});assert.equal(job.state,'settlement_negotiation');assert.equal(job.subflows[0].instruction,null);assert.equal(job.subflows[0].receipt,null);assert.equal(job.escrow_ledger.locked_amount,'100');
 await advance(101);job=await f.act('refund','buyer');assert.equal(job.subflows[0].receipt.outcome,'expiry_refund');assert.equal(job.subflows[0].receipt.instruction_id,null);
});
test('cancellation subflow: automatic forwarding persists acceptance before signing the closing transaction',async()=>{
 let witnessed=false;let f;
 f=await fixture('cancel_auto',{authorizeTransaction:async ctx=>{if(ctx.step==='execute_cancellation'){const stored=await f.w.get(f.id,'buyer');assert.equal(stored.subflows[0].status,'execution_pending');assert.ok(stored.subflows[0].instruction);witnessed=true;}return true;}});
 await fund(f);let job=await f.act('propose_settlement','worker',proposal(f));const input=await cancellationApproval(job);
 job=await f.w.acceptCancellation(f.id,input,{actor:'buyer',idempotencyKey:'accept-auto'});
 for(let n=0;job.pending&&n<8;n++){await provider.send('evm_mine',[]);job=await f.w.reconcile(f.id,'buyer');}
 assert.equal(job.subflows[0].status,'completed');assert.equal(witnessed,true);
});
test('cancellation subflow: expired accepted instructions retain locked balance until a real deadline refund',async()=>{
 const f=await fixture('cancel_expired_instruction');await fund(f);const now=(await provider.getBlock('latest')).timestamp;
 let job=await f.act('propose_settlement','worker',{...proposal(f),expires_at:now+5});const input=await cancellationApproval(job);
 job=await f.w.acceptCancellation(f.id,input,{actor:'buyer',idempotencyKey:'accept-before-expiry',forward:false});const instruction=job.subflows[0].instruction;
 await advance(6);job=await f.act('execute_cancellation','buyer',{instruction_id:instruction.id});assert.equal(job.subflows[0].status,'execution_failed');assert.equal(job.subflows[0].receipt,null);assert.equal(job.escrow_ledger.locked_amount,'100');
 await advance(100);job=await f.act('refund','buyer');assert.equal(job.subflows[0].receipt.outcome,'expiry_refund');assert.equal(job.subflows[0].receipt.instruction_id,null);assert.equal(job.subflows[0].receipt.prior_instruction_id,instruction.id);
});
test('cancellation subflow: HTTP client stages acceptance, keeper forwards after SQLite reopen, fresh receipt fails closed',async()=>{
 const {mkdtempSync,rmSync}=require('node:fs'),{join}=require('node:path'),{tmpdir}=require('node:os');const {createSqliteStorage}=require('../src/storage/index.cjs');
 const {createWorkflowHandler,createWorkflowClient}=require('../src/workflow.cjs');const op=require('../src/operations/index.cjs');
 const dir=mkdtempSync(join(tmpdir(),'a423-cancel-'));let storage=createSqliteStorage({filename:join(dir,'jobs.sqlite')});
 try{
 const f=await fixture('cancel_http',{workflowStore:storage.jobs,transactions:storage.transactions});await fund(f);let job=await f.act('propose_settlement','worker',proposal(f));const input=await cancellationApproval(job);
 let workflow=f.w;const validate=require('../src/escrow/index.cjs').createEvidenceRevalidator({provider,...config,confirmations:1});
 const makeHandler=revalidate=>op.createApplicationHandler({workflow,store:storage.jobs,authenticate:()=> 'buyer',forwardCancellations:false,revalidate});
 let handler=makeHandler(validate);const client=createWorkflowClient({baseUrl:'https://app.test/api/a423',fetch:(url,init)=>handler(new Request(url,init))});
 job=await client.acceptCancellation(f.id,input,{idempotencyKey:'http-accept'});assert.equal((await client.cancellation(f.id)).status,'accepted');assert.equal((await client.subflows(f.id)).length,1);const instruction=await client.cancellationInstruction(f.id);
 await assert.rejects(client.cancellationReceipt(f.id),{code:'RECEIPT_UNAVAILABLE'});
 storage.close();storage=createSqliteStorage({filename:join(dir,'jobs.sqlite')});
 const adapters=createEscrowAdapters({authorizeTransaction:async()=>true,provider,...config,signerFor:async a=>wallets[actors[a]],addressFor:async a=>wallets[actors[a]].address,transactions:storage.transactions,confirmations:1,validateArtifact:async()=>true});
 workflow=createWorkflow({store:storage.jobs,adapters,transitions:escrowTransitions});handler=makeHandler(validate);
 await op.runMaintenanceOnce({workflow,store:storage.jobs,actorFor:async()=> 'buyer'});assert.equal((await client.cancellation(f.id)).status,'accepted');
 for(let i=0;i<8;i++){await op.runMaintenanceOnce({workflow,store:storage.jobs,actorFor:async()=> 'buyer',allowExecute:true});job=await workflow.get(f.id,'buyer');if(!job.pending&&job.state==='settled')break;await provider.send('evm_mine',[]);}
 assert.equal((await client.cancellationReceipt(f.id)).instruction_id,instruction.id);
 handler=makeHandler(async()=>({status:'invalid',reason:'reorg'}));await assert.rejects(client.cancellationReceipt(f.id),{code:'EVIDENCE_UNAVAILABLE'});
 }finally{storage.close();rmSync(dir,{recursive:true,force:true});}
});
test('cancellation subflow: crash after escrow execution recovers one receipt without a duplicate transfer',async()=>{
 const memory=createMemoryStore();let crash=true;
 const store={...memory,compareAndSet:async(id,v,next)=>{if(crash&&next.subflows?.[0]?.status==='completed'){crash=false;return false;}return memory.compareAndSet(id,v,next);}};
 const f=await fixture('cancel_crash',{workflowStore:store});await fund(f);const proposed=await f.act('propose_settlement','worker',proposal(f));
 await f.w.acceptCancellation(f.id,await cancellationApproval(proposed),{actor:'buyer',idempotencyKey:'stage',forward:false});const instruction=await f.w.cancellationInstruction(f.id,'buyer');const before=await token.balanceOf(wallets[1].address);
 await assert.rejects(f.act('execute_cancellation','buyer',{instruction_id:instruction.id}),{code:'CONFLICT'});
 assert.equal((await f.w.cancellation(f.id,'buyer')).status,'execution_pending');assert.equal(await token.balanceOf(wallets[1].address),before+30n);
 const job=await f.w.reconcile(f.id,'buyer');assert.equal(job.subflows[0].status,'completed');const receipt=await f.w.cancellationReceipt(f.id,'buyer');assert.equal(receipt.instruction_id,instruction.id);
 await f.w.reconcile(f.id,'buyer');assert.equal(await token.balanceOf(wallets[1].address),before+30n);assert.equal((await f.w.cancellationReceipt(f.id,'buyer')).id,receipt.id);
});
test('reopened job: fresh agreement binds wallet consent; an old consent cannot fund the new generation',async()=>{
 const f=await fixture('reopen_consent');const old=await f.w.get(f.id,'buyer');
 let job=await f.act('decline','worker',{reason:'Budget negotiation stopped'});const cancellation_id=job.pre_funding_cancellations.at(-1).id;
 await f.act('reopen','buyer',{cancellation_id},'reopen-buyer');job=await f.act('reopen','worker',{cancellation_id},'reopen-worker');assert.equal(job.epoch,1);
 job=await f.act('quote','worker',{terms:f.terms,expected_epoch:1},'new-quote');assert.notEqual(job.agreement.hash,old.agreement.hash);assert.equal(job.agreement.revision,2);
 const acceptance={agreement_hash:job.agreement.hash,revision:2,expected_epoch:1};await f.act('accept','buyer',acceptance,'new-accept-buyer');job=await f.act('accept','worker',acceptance,'new-accept-worker');
 job=await f.act('fund','buyer',{worker_signature:f.signature,expected_epoch:1},'old-consent');assert.equal(job.state,'accepted');assert.equal(Number((await escrow.getJob(f.consent.value.jobId)).state),0);
 const consent=workerConsent(job,config),signature=await wallets[1].signTypedData(consent.domain,consent.types,consent.value);
 job=await f.act('fund','buyer',{worker_signature:signature,expected_epoch:1},'fresh-consent');assert.equal(job.state,'funded');assert.equal(job.escrow_ledger.locked_amount,'100');
 await advance(101);await f.act('refund','buyer');
});
test('profit policy: factory defaults worker amount, protects cost privacy, and realizes profit only after confirmed escrow settlement',async()=>{
 const {createSqliteStorage}=require('../src/storage/index.cjs');const {createEscrowApplication}=require('../src/operations/index.cjs');const storage=createSqliteStorage({filename:':memory:'});let cost='10';
 try{
 const f=await fixture('profit_journey',{workflowStore:storage.jobs,transactions:storage.transactions});await fund(f);
 // Test-only authority isolates policy wiring; credential cryptography is covered separately.
 const authority={isActive:async()=>true,verifyCredential:async credential=>({sub:credential})};
 const app=createEscrowApplication({storage,authority,escrows:[{provider,...config,confirmations:1}],signerFor:async actor=>wallets[actors[actor]],addressFor:async actor=>wallets[actors[actor]].address,limitsFor:async()=>({perTransaction:'100',daily:'1000',total:'10000'}),approveSigning:async()=>true,validateArtifact:async()=>true,settlementPolicy:{thresholds:{target_margin_bps:5000,min_margin_bps:1000,max_margin_bps:5000,require_counter:true},costBasisFor:async()=>cost,budgetFor:async()=> '100'}});
 await assert.rejects(app.workflow.act(f.id,'propose_settlement',{...proposal(f,'7')},{actor:'worker',idempotencyKey:'loss'}),{code:'FORBIDDEN'});
 const input=proposal(f);delete input.worker_amount;let job=await app.workflow.act(f.id,'propose_settlement',input,{actor:'worker',idempotencyKey:'profit-proposal'});
 for(let i=0;job.pending&&i<8;i++){await provider.send('evm_mine',[]);job=await app.workflow.reconcile(f.id,'worker');}
 assert.equal(job.negotiation.current.worker_amount,'20');assert.equal(Object.hasOwn(job.negotiation.current,'cost_basis_raw'),false);cost='99';
 async function state(actor){const response=await app.handler(new Request('https://app.test/api/state',{headers:{authorization:'Bearer '+actor}}));assert.equal(response.status,200);return (await response.json()).a423.jobs[0];}
 let worker=await state('worker'),buyer=await state('buyer');assert.equal(worker.profit.cost_basis_raw,'10');assert.equal(worker.profit.realized_profit_raw,null);assert.equal(Object.hasOwn(buyer.profit,'cost_basis_raw'),false);
 const tools=app.chatTools('worker');assert.match((await tools.inspect_settlement_policy({job_id:f.id})).prompt,/Profit is the primary objective/);assert.equal((await tools.list_jobs())[0].profit.target_payout,'20');
 job=await app.workflow.acceptCancellation(f.id,await cancellationApproval(job),{actor:'buyer',idempotencyKey:'profit-accept'});
 for(let i=0;job.pending&&i<8;i++){await provider.send('evm_mine',[]);job=await app.workflow.reconcile(f.id,'buyer');}
 assert.equal(job.escrow_ledger.worker_paid,'20');worker=await state('worker');assert.equal(worker.profit.realized_profit_raw,'10');assert.equal(worker.profit.realized_margin_bps,'5000');assert.equal(worker.profit.receipt_confirmed,true);
 buyer=await state('buyer');assert.equal(buyer.profit.realized_payout_raw,'20');assert.equal(Object.hasOwn(buyer.profit,'realized_profit_raw'),false);
 const receipt=await app.handler(new Request('https://app.test/api/a423-receipts/'+f.id,{headers:{authorization:'Bearer buyer'}}));assert.equal(Object.hasOwn((await receipt.json()).profit,'cost_basis_raw'),false);
 }finally{storage.close();}
});
test('pending recovery: malformed submit is safely rejected without altering custody; valid submit cannot be discarded',async()=>{
 const f=await fixture('repair_malformed');await fund(f);await f.act('start','worker');
 await assert.rejects(f.w.act(f.id,'submit',{result_hash:'not-a-hash'},{actor:'worker',idempotencyKey:'malformed'}));const pending=(await f.w.get(f.id,'worker')).pending;assert.ok(pending);
 await assert.rejects(f.w.rejectPendingOperation(f.id,{operation_id:pending.id,reason:'Malformed artifact hash'},{actor:'buyer'}),{code:'FORBIDDEN'});
 const journalId=pending.id+':submit';await f.transactions.create(journalId,{hash:'unknown-intent',raw:'unknown'});
 await assert.rejects(f.w.rejectPendingOperation(f.id,{operation_id:pending.id,reason:'Do not discard signed intent'},{actor:'worker'}),/Journaled intent/);
 // Exercise a clean malformed operation separately; the journaled job remains pending.
 const clean=await fixture('repair_clean');await fund(clean);await clean.act('start','worker');await assert.rejects(clean.w.act(clean.id,'submit',{}, {actor:'worker',idempotencyKey:'bad'}));
 const op=(await clean.w.get(clean.id,'worker')).pending;
 await assert.rejects(clean.adapters.submit.rejectPending({job:await clean.w.get(clean.id,'worker'),input:op.input,operation:{...op,observation:{reference:'external-unknown-intent'}}}),/without external transaction references/);
 let job=await clean.w.rejectPendingOperation(clean.id,{operation_id:op.id,reason:'Missing artifact hash; runner will retry with a real result'},{actor:'worker'});assert.equal(job.pending,null);assert.equal(job.state,'running');assert.equal(job.escrow_ledger.locked_amount,'100');assert.equal(job.events.at(-1).data.recovery.proof.never_executable,true);
 job=await clean.act('submit','worker',{result_hash:hash('repaired artifact')},'valid-submit');assert.equal(job.state,'submitted');
 const validCtx={job,input:{result_hash:hash('valid')},operation:{id:'valid-op',actor:'worker'}};await assert.rejects(clean.adapters.submit.rejectPending(validCtx),/syntactically impossible/);
 await advance(301);await clean.act('timeout','buyer');
});
