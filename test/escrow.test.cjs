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
