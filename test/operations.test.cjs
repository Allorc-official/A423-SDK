const {test}=require('node:test');
const assert=require('node:assert/strict');
const {mkdtempSync,rmSync}=require('node:fs');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
const {generateKeyPairSync,sign}=require('node:crypto');
const {createSqliteStorage}=require('../src/storage/index.cjs');
const {createAuthority,createCredentialAuthenticator,createCredentialProvider,createAuthorityHandler}=require('../src/authority/index.cjs');
const {createWorkflow}=require('../src/workflow.cjs');
const op=require('../src/operations/index.cjs');
const task={id:'research',type:'research',description:'Independent task',deliverables:[{id:'report',media_type:'text/markdown',description:'report'}],acceptance:{validator:'test',version:'1',criteria:{minWords:10}}};
const participants={requester:'buyer',worker:'worker',verifier:'buyer',arbitrator:'arb'};
const keys=()=>{const p=generateKeyPairSync('ed25519');return {publicKey:p.publicKey.export({type:'spki',format:'pem'}),privateKey:p.privateKey};};
function temp(){const dir=mkdtempSync(join(tmpdir(),'a423-ops-'));return {dir,filename:join(dir,'db.sqlite'),cleanup:()=>rmSync(dir,{recursive:true,force:true})};}
test('SQLite persists workflow, atomic CAS, events, immutable journal and coordinated nonces across connections',async()=>{
 const t=temp();let s=createSqliteStorage(t),other=createSqliteStorage(t);try{
 const w=createWorkflow({store:s.jobs});const j=await w.create({id:'one',participants},'buyer');
 assert.equal(await other.jobs.create(j),false);
 const results=await Promise.all([s.transactions.reserveNonce('chain:wallet',4,'op1'),other.transactions.reserveNonce('chain:wallet',4,'op2')]);assert.deepEqual(results,[4,5]);assert.equal(await s.transactions.reserveNonce('chain:wallet',50,'op1'),4);
 await s.transactions.create('tx',{hash:'one',raw:'signed'});assert.equal(await other.transactions.create('tx',{hash:'other'}),false);
 s.close();s=createSqliteStorage(t);assert.equal((await s.jobs.get('one')).state,'draft');assert.equal((await s.transactions.get('tx')).hash,'one');
 assert.equal((await s.jobs.events({actor:'worker'})).length,1);assert.equal((await s.jobs.events({actor:'intruder'})).length,0);
 const stale={...j,version:2};assert.equal(await s.jobs.compareAndSet('one',1,stale),true);assert.equal(await other.jobs.compareAndSet('one',1,stale),false);
 }finally{s.close();other.close();t.cleanup();}
});
test('SQLite leases and checkpoint survive restart; stale workers cannot complete reclaimed tasks',async()=>{
 const s=createSqliteStorage({filename:':memory:'});try{
 await s.queue.enqueue({id:'task',kind:'execution',payload:{a:1},availableAt:0});
 const a=await s.queue.claim({kind:'execution',now:100,leaseMs:10});await s.queue.checkpoint(a.id,a.lease,{result_hash:'hash'},{now:105});
 assert.equal(await s.queue.claim({kind:'execution',now:105}),null);
 const b=await s.queue.claim({kind:'execution',now:111});assert.deepEqual(b.result,{result_hash:'hash'});
 assert.equal(await s.queue.complete(a.id,a.lease,{}, {now:112}),false);assert.equal(await s.queue.complete(b.id,b.lease,{}, {now:112}),true);
 }finally{s.close();}
});
test('spending caps atomically reserve once per intent and enforce daily/total limits',async()=>{
 const s=createSqliteStorage({filename:':memory:'});try{
 const cap={scope:'wallet:token',perTransaction:'100',daily:'150',total:'200',now:0};
 await s.spending.reserve({...cap,id:'1',amount:'100'});await s.spending.reserve({...cap,id:'1',amount:'100'});
 await assert.rejects(s.spending.reserve({...cap,id:'2',amount:'100'}),{code:'SPENDING_LIMIT_EXCEEDED'});
 await s.spending.reserve({...cap,id:'2',amount:'50'});
 await assert.rejects(s.spending.reserve({...cap,id:'3',amount:'51',now:86400000}),{code:'SPENDING_LIMIT_EXCEEDED'});
 const auth=op.createSpendingAuthorizer({spending:s.spending,limitsFor:async()=>({perTransaction:'0',daily:'0',total:'0'}),authorize:async()=>true});
 assert.equal(await auth({step:'fund',job:{id:'limit',agreement:{terms:{escrow:{chain_id:'1',contract:'contract',payer:'payer',token:'token',amount:'1'}}}}}),false);
 }finally{s.close();}
});
test('governor enrollment, challenge replay protection, auth, credential refresh and revocation',async()=>{
 const s=createSqliteStorage({filename:':memory:'});try{
 const authorityKey=keys(),organization=keys(),agent=keys();let time=1000000;
 const a=createAuthority({issuer:'test',audience:'app',privateKey:authorityKey.privateKey,kv:s.kv,credentialTtlSeconds:10,now:()=>time});
 await a.registerOrganization({id:'org',name:'Organization',publicKey:organization.publicKey});
 const enrollment={organization:'org',agentId:'agent',publicKey:agent.publicKey,scopes:['workflow']};
 const organizationSignature=sign(null,Buffer.from(JSON.stringify(a.registration(enrollment))),organization.privateKey).toString('base64url');
 await a.registerAgent({...enrollment,organizationSignature});
 const challenge=await a.challenge('agent'),signature=sign(null,Buffer.from(JSON.stringify(challenge)),agent.privateKey).toString('base64url');
 const credential=await a.exchange({challengeId:challenge.id,signature});await assert.rejects(a.exchange({challengeId:challenge.id,signature}));
 const auth=createCredentialAuthenticator({authority:a});assert.equal(await auth(new Request('https://app.test',{headers:{authorization:'Bearer '+credential.credential}})),'agent');
 await assert.rejects(a.verifyCredential(credential.credential,{scope:'admin'}));
 const refreshed=await opTestRefresh(a,agent,time,()=>time);assert.ok(refreshed);
 time+=11000;await assert.rejects(a.verifyCredential(credential.credential));
 const provider=createCredentialProvider({agentId:'agent',challenge:id=>a.challenge(id),exchange:v=>a.exchange(v),signChallenge:async bytes=>sign(null,bytes,agent.privateKey).toString('base64url'),refreshBeforeSeconds:2,now:()=>time});
 const c=await provider();time+=9000;const d=await provider();assert.notEqual(c,d);
 await a.revokeOrganization('org');await assert.rejects(a.verifyCredential(d));
 const handler=createAuthorityHandler({authority:a});assert.equal((await handler(new Request('https://app.test/api/a423-auth/challenge',{method:'POST'}))).status,429);
 }finally{s.close();}
});
async function opTestRefresh(a,agent,time,now){const provider=createCredentialProvider({agentId:'agent',challenge:id=>a.challenge(id),exchange:v=>a.exchange(v),signChallenge:async bytes=>sign(null,bytes,agent.privateKey).toString('base64url'),refreshBeforeSeconds:2,now});return provider();}
test('maintenance advances pending approval-to-funding only when execution explicitly enabled',async()=>{
 const s=createSqliteStorage({filename:':memory:'});try{
 let executions=0;const w=createWorkflow({store:s.jobs,adapters:{fund:{execute:async()=>++executions===1?{status:'pending'}:{status:'confirmed',evidence:{funded:true}},reconcile:async()=>({status:'pending'})}}});
 await w.create({id:'job',participants},'buyer');let j=await w.act('job','quote',{terms:{}},{actor:'worker',idempotencyKey:'q'});for(const actor of ['buyer','worker'])j=await w.act('job','accept',{revision:1,agreement_hash:j.agreement.hash},{actor,idempotencyKey:'accept'});
 await w.act('job','fund',{}, {actor:'buyer',idempotencyKey:'fund'});
 await op.runMaintenanceOnce({workflow:w,store:s.jobs,actorFor:async()=> 'buyer'});assert.equal(executions,1);
 await op.runMaintenanceOnce({workflow:w,store:s.jobs,actorFor:async()=> 'buyer',allowExecute:true});assert.equal((await w.get('job','buyer')).state,'funded');
 }finally{s.close();}
});
test('watcher holds orphaned/unavailable evidence, workflow blocks actions, and fresh receipts refuse stale proof',async()=>{
 const s=createSqliteStorage({filename:':memory:'});try{
 const w=createWorkflow({store:s.jobs});let j=await w.create({id:'job',participants},'buyer');j={...j,version:2,evidence:[{action:'fund',evidence:{transaction_hash:'hash'}}]};await s.jobs.compareAndSet('job',1,j);
 await op.watchEvidenceOnce({store:s.jobs,revalidate:async()=>({status:'invalid'})});await assert.rejects(w.act('job','cancel',{}, {actor:'buyer',idempotencyKey:'cancel'}),{code:'SAFETY_HOLD'});
 await assert.rejects(op.freshReceipts({workflow:w,id:'job',actor:'buyer',revalidate:async()=>({status:'invalid'})}));
 await op.watchEvidenceOnce({store:s.jobs,revalidate:async()=>({status:'valid'})});assert.equal((await s.jobs.getSafety('job')).blocked,false);
 }finally{s.close();}
});
test('SSE is actor scoped and webhook outbox delivers signed payload once with durable cursor',async()=>{
 const s=createSqliteStorage({filename:':memory:'});try{
 const w=createWorkflow({store:s.jobs});await w.create({id:'job',participants},'buyer');
 const handler=op.createEventStream({store:s.jobs,authenticate:async()=> 'worker',maxDurationMs:1,pollMs:1});const response=await handler(new Request('https://app.test/events'));const data=await response.text();assert.match(data,/a423/);assert.match(data,/created/);
 let requests=0;const dispatcher=op.createWebhookDispatcher({queue:s.queue,kv:s.kv,subscriptions:[{id:'one',actor:'buyer',url:'https://approved.example/webhook'}],secretFor:async()=> 'a'.repeat(32),fetch:async(url,init)=>{requests++;assert.match(init.headers['a423-signature'],/^v1=/);return new Response('ok');}});
 await dispatcher.project(s.jobs);await dispatcher.project(s.jobs);assert.equal((await dispatcher.deliverOne()).status,'delivered');assert.equal(await dispatcher.deliverOne(),null);assert.equal(requests,1);
 }finally{s.close();}
});
test('typed task validation, PDF bytes, and conservative legacy migration report',async()=>{
 assert.equal(op.validateTask(task).type,'research');assert.throws(()=>op.validateTask({}));
 const bytes=await op.renderReceiptPdf({job_id:'one',state:'funded',revalidated_at:'now',evidence:[]});assert.equal(Buffer.from(bytes).subarray(0,4).toString(),'%PDF');
 assert.equal(op.planLegacyMigration([{id:'old',state:'paid'}])[0].automatic,false);
});
test('execution queue checkpoints results, retries submission without rerunning AI, and requires eligibility gate',async()=>{
 const s=createSqliteStorage({filename:':memory:'});try{
 const w=createWorkflow({store:s.jobs,adapters:{submit:{execute:async()=>({status:'confirmed',evidence:{hash:'ok'}}),reconcile:async()=>({status:'pending'})}}});let job=await w.create({id:'run',participants},'buyer');job={...job,version:2,state:'running',agreement:{revision:1,hash:'test',terms:{task},accepted_by:['buyer','worker']},events:[...job.events,{sequence:2,type:'start.confirmed',actor_id:'worker',at:new Date().toISOString(),data:{}}]};await s.jobs.compareAndSet('run',1,job);
 assert.equal(await op.enqueueRunningJobs({store:s.jobs,queue:s.queue}),1);assert.equal(await op.enqueueRunningJobs({store:s.jobs,queue:s.queue}),0);
 let calls=0;const result=await op.runExecutionOnce({workflow:w,queue:s.queue,beforeExecute:async()=>true,execute:async()=>{calls++;return {result_hash:'0x'+'a'.repeat(64)};}});assert.equal(result.state,'submitted');assert.equal(calls,1);assert.equal(await op.runExecutionOnce({workflow:w,queue:s.queue,beforeExecute:async()=>true,execute:async()=>{calls++;}}),null);
 }finally{s.close();}
});
test('spending reservation rechecks caps when funding crosses a UTC day boundary',async()=>{
 const s=createSqliteStorage({filename:':memory:'});try{
 const limits={scope:'wallet',perTransaction:'100',daily:'100',total:'300'};
 await s.spending.reserve({...limits,id:'approval-yesterday',amount:'60',now:0});
 await s.spending.reserve({...limits,id:'today',amount:'50',now:86400000});
 await assert.rejects(s.spending.reserve({...limits,id:'approval-yesterday',amount:'60',now:86400000}),{code:'SPENDING_LIMIT_EXCEEDED'});
 }finally{s.close();}
});
test('reset is dry-run by default and preserves authority unless explicitly selected; migration never carries acceptance',async()=>{
 const s=createSqliteStorage({filename:':memory:'});try{
 const w=createWorkflow({store:s.jobs});await w.create({id:'old',participants},'buyer');await s.kv.put('authority:test:agents','agent',{approved:true});
 const reset={chainId:31337,confirm:'RESET_LOCAL_A423',assertChainReset:async()=>true};await s.resetDevelopmentData(reset);assert.ok(await s.jobs.get('old'));await assert.rejects(s.resetDevelopmentData({...reset,chainId:1,dryRun:false}));
 await s.resetDevelopmentData({...reset,dryRun:false});assert.equal(await s.jobs.get('old'),null);assert.ok(await s.kv.get('authority:test:agents','agent'));
 const result=await op.migrateUnfundedLegacy({records:[{id:'legacy',state:'accepted'}],workflow:w,actor:'buyer',map:async()=>({id:'replacement',participants})});assert.equal(result[0].state,'draft');assert.equal(result[0].metadata.migration.accepted_terms_carried,false);
 await assert.rejects(op.migrateUnfundedLegacy({records:[{id:'funded',state:'funded'}],workflow:w,actor:'buyer',map:async()=>({id:'bad',participants})}));
 }finally{s.close();}
});
test('application bridge exposes authenticated workflow projections and chat uses the same records',async()=>{
 const s=createSqliteStorage({filename:':memory:'});try{
 const w=createWorkflow({store:s.jobs});const tools=op.createChatTools({workflow:w,store:s.jobs,queue:s.queue,actor:'buyer'});await tools.send_job_offer({id:'chat',worker_id:'worker',verifier_id:'buyer',arbitrator_id:'arb',terms:{task}});
 const handler=op.createApplicationHandler({workflow:w,store:s.jobs,queue:s.queue,authenticate:async r=>r.headers.get('actor'),revalidate:async()=>({status:'valid'})});
 assert.equal((await handler(new Request('https://app.test/api/state'))).status,401);
 const data=await(await handler(new Request('https://app.test/api/state',{headers:{actor:'worker'}}))).json();assert.equal(data.a423.jobs[0].id,'chat');assert.equal(data.a423.jobs[0].state,'quoted');
 const outsider=await(await handler(new Request('https://app.test/api/state',{headers:{actor:'outsider'}}))).json();assert.equal(outsider.a423.jobs.length,0);
 }finally{s.close();}
});
test('receiver authenticates authority credentials with public key only and explicit status lookup',async()=>{
 const {createCredentialVerifier}=require('../src/authority/index.cjs');const s=createSqliteStorage({filename:':memory:'});try{
 const root=keys(),org=keys(),agent=keys(),a=createAuthority({issuer:'public-root',audience:'app',privateKey:root.privateKey,kv:s.kv});await a.registerOrganization({id:'org',name:'Org',publicKey:org.publicKey});const enrollment={organization:'org',agentId:'agent',publicKey:agent.publicKey,scopes:['workflow']};await a.registerAgent({...enrollment,organizationSignature:sign(null,Buffer.from(JSON.stringify(a.registration(enrollment))),org.privateKey).toString('base64url')});const c=await a.challenge('agent'),token=(await a.exchange({challengeId:c.id,signature:sign(null,Buffer.from(JSON.stringify(c)),agent.privateKey).toString('base64url')})).credential;
 let active=true;const verify=createCredentialVerifier({issuer:'public-root',audience:'app',publicKey:a.publicKey,isActive:async()=>active});assert.equal((await verify(token)).sub,'agent');active=false;await assert.rejects(verify(token));
 }finally{s.close();}
});
test('closing proposal helper commits claims/allocations and rejects unbalanced or excessive compensation',()=>{
 const {hashAgreement}=require('../src/workflow.cjs'),{settlementProposal}=require('../src/closing.cjs');
 const terms={escrow:{amount:'100',resolution_deadline:1000}},job={id:'closing',agreement:{terms,hash:hashAgreement(terms)}};
 const input={worker_amount:'30',expected_revision:0,expires_at:500,reason:'Partial work',claims:[{kind:'expense',description:'Research',amount:'10',evidence:['receipt:a']}]};
 const p=settlementProposal(job,input);assert.equal(p.payer_amount,'70');assert.equal(p.escrow_version,1);assert.equal(p.closes_job,true);
 assert.notEqual(settlementProposal(job,{...input,reason:'Changed reason'}).proposal_hash,p.proposal_hash);
 assert.throws(()=>settlementProposal(job,{...input,payer_amount:'80'}));assert.throws(()=>settlementProposal(job,{...input,worker_amount:'101'}));assert.throws(()=>settlementProposal(job,{...input,expires_at:1001}));
});
test('queued execution receives an abort signal when cancellation pauses work',async()=>{
 const s=createSqliteStorage({filename:':memory:'});try{
 const w=createWorkflow({store:s.jobs});let job=await w.create({id:'pause-run',participants},'buyer');job={...job,version:2,state:'running',agreement:{revision:1,hash:'test',terms:{task},accepted_by:['buyer','worker']},events:[...job.events,{sequence:2,type:'start.confirmed',actor_id:'worker',at:new Date().toISOString(),data:{}}]};await s.jobs.compareAndSet(job.id,1,job);await op.enqueueRunningJobs({store:s.jobs,queue:s.queue});
 await assert.rejects(op.runExecutionOnce({workflow:w,queue:s.queue,leaseMs:90,beforeExecute:async()=>true,execute:async({signal})=>{const current=await s.jobs.get(job.id);await s.jobs.compareAndSet(job.id,current.version,{...current,version:current.version+1,pending:{action:'propose_settlement'}});return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));}}),{code:'WORK_PAUSED'});
 }finally{s.close();}
});
test('queued execution cooperatively aborts when its mandate no longer permits running work',async()=>{
 const s=createSqliteStorage({filename:':memory:'});try{
 const w=createWorkflow({store:s.jobs});let job=await w.create({id:'mandate-run',participants},'buyer');job={...job,version:2,state:'running',agreement:{revision:1,hash:'test',terms:{task},accepted_by:['buyer','worker']},events:[...job.events,{sequence:2,type:'start.confirmed',actor_id:'worker',at:new Date().toISOString(),data:{}}]};await s.jobs.compareAndSet(job.id,1,job);await op.enqueueRunningJobs({store:s.jobs,queue:s.queue});
 await assert.rejects(op.runExecutionOnce({workflow:w,queue:s.queue,leaseMs:90,beforeExecute:async()=>true,canContinue:async()=>false,execute:async({signal})=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}))}),/Execution mandate expired/);
 assert.equal((await w.get(job.id,'worker')).submission,null);
 }finally{s.close();}
});
