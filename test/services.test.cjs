const {test}=require('node:test');
const assert=require('node:assert/strict');
const {Wallet,Transaction}=require('ethers');
const {createSqliteStorage}=require('../src/storage/index.cjs');
const {replacePendingTransaction,createFeeReplacementWorker,createManagedSigner}=require('../src/escrow/index.cjs');
async function pending(s,id='tx'){
 const signer=Wallet.createRandom(),to=Wallet.createRandom().address;
 const raw=await signer.signTransaction({to,data:'0xdeadbeef',nonce:7,chainId:1337,type:2,maxFeePerGas:100n,maxPriorityFeePerGas:10n,gasLimit:100000n,value:0n});
 const tx=Transaction.from(raw);await s.transactions.create(id,{raw,hash:tx.hash,to,data:tx.data,from:signer.address,created_at:'2000-01-01T00:00:00.000Z'});return {signer,tx};
}
test('same-nonce fee replacement preserves intent, rejects low fees and journals before any broadcast',async()=>{
 const s=createSqliteStorage({filename:':memory:'});try{
 const {signer,tx}=await pending(s);const provider={getTransactionReceipt:async()=>null};
 await assert.rejects(replacePendingTransaction({id:'tx',transactions:s.transactions,provider,signer,authorize:async()=>true,maxFeePerGas:101n,maxPriorityFeePerGas:11n}));
 const replacement=await replacePendingTransaction({id:'tx',transactions:s.transactions,provider,signer,authorize:async()=>true,maxFeePerGas:125n,maxPriorityFeePerGas:13n});
 const parsed=Transaction.from(replacement.raw);assert.equal(parsed.nonce,7);assert.equal(parsed.to,tx.to);assert.equal(parsed.data,tx.data);
 assert.equal((await s.transactions.get('tx')).replacements[0].hash,replacement.hash);
 await assert.rejects(replacePendingTransaction({id:'tx',transactions:s.transactions,provider:{getTransactionReceipt:async()=>({status:1})},signer,authorize:async()=>true,maxFeePerGas:160n,maxPriorityFeePerGas:17n}));
 }finally{s.close();}
});
test('automatic fee planner respects age, fee cap and attempt cap',async()=>{
 const s=createSqliteStorage({filename:':memory:'});try{
 const {signer}=await pending(s);const options={transactions:s.transactions,provider:{getTransactionReceipt:async()=>null},signerForRecord:async()=>signer,authorize:async()=>true,minAgeMs:60000,maxAttempts:1};
 const denied=createFeeReplacementWorker({...options,maxFeePerGas:110n,maxPriorityFeePerGas:11n});assert.equal((await denied())[0].status,'cap_reached');
 const allowed=createFeeReplacementWorker({...options,maxFeePerGas:200n,maxPriorityFeePerGas:20n});assert.equal((await allowed())[0].status,'prepared');assert.deepEqual(await allowed(),[]);
 }finally{s.close();}
});
test('managed signer rejects a signature returned by a different key',async()=>{
 const expected=Wallet.createRandom(),wrong=Wallet.createRandom();const signer=createManagedSigner({address:expected.address,provider:null,authorize:async()=>true,signDigest:async digest=>wrong.signingKey.sign(digest).serialized});
 await assert.rejects(signer.signMessage('hello'),/wrong key/);
});
test('incremental escrow indexer persists cursor, deduplicates events, and flags reorged observations',async()=>{
 const {createEscrowIndexer,ESCROW_ABI}=require('../src/escrow/index.cjs');const {Interface}=require('ethers');const iface=new Interface(ESCROW_ABI);
 const s=createSqliteStorage({filename:':memory:'});try{
 const address=Wallet.createRandom().address,payer=Wallet.createRandom().address,worker=Wallet.createRandom().address;
 const job='0x'+'1'.repeat(64),agreement='0x'+'2'.repeat(64),tx='0x'+'3'.repeat(64);let blockHash='0x'+'4'.repeat(64);let deliveries=0,reorgs=0;
 const encoded=iface.encodeEventLog(iface.getEvent('Funded'),[job,agreement,payer,worker,100n]);
 const provider={getNetwork:async()=>({chainId:1n}),getBlock:async()=>({number:1,hash:blockHash}),getLogs:async()=>[{address,...encoded,transactionHash:tx,blockHash,index:0,blockNumber:1}]};
 const tick=createEscrowIndexer({provider,chainId:1,contractAddress:address,confirmations:1,fromBlock:1,kv:s.kv,onEvent:async()=>{deliveries++;},onReorg:async()=>{reorgs++;}});
 assert.equal((await tick()).indexed,1);assert.equal((await tick()).indexed,0);blockHash='0x'+'5'.repeat(64);assert.equal((await tick()).indexed,1);assert.equal(deliveries,2);assert.equal(reorgs,1);
 assert.equal((await s.kv.list('index-events:1:'+address)).filter(r=>r.value.orphaned).length,1);
 }finally{s.close();}
});
