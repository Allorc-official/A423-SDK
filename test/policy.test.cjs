const {test}=require('node:test');const assert=require('node:assert/strict');
const {createSettlementPolicy,profitProjection,settlementPolicyPrompt,createProfitSettlementService}=require('../src/policy/index.cjs');
const {createSqliteStorage}=require('../src/storage/index.cjs');
const policy=createSettlementPolicy();const evaluate=(input={})=>policy.evaluate({cost_basis_raw:'600505',budget_raw:'5000000',escrow_raw:'5000000',...input});
function job(){return {id:'policy-job',epoch:0,agreement:{hash:'agreement',terms:{escrow:{amount:'5000000'}}},metadata:{budget_raw:'5000000'},participants:{requester:'buyer',worker:'worker'},negotiation:null,evidence:[]};}
function service(options={}){const storage=createSqliteStorage({filename:':memory:'});return {storage,service:createProfitSettlementService({kv:storage.kv,costBasisFor:async()=> '600505',budgetFor:async j=>j.metadata.budget_raw,...options})};}
test('profit policy uses gross margin, ceiling payouts and hard affordability caps',()=>{
 const p=evaluate();assert.equal(p.target_payout,'1201010');assert.equal(p.min_payout,'667228');assert.equal(p.max_payout,'1201010');assert.equal(p.recommended_payout,'1201010');assert.equal(p.expected_profit,'600505');assert.equal(p.expected_margin_bps,'5000');
 const limited=evaluate({budget_raw:'800000'});assert.equal(limited.recommended_payout,'800000');assert.equal(limited.expected_margin_bps,'2493');assert.equal(limited.viability,'below_target');
 assert.equal(evaluate({escrow_raw:'700000'}).recommended_payout,'700000');
});
test('below-cost and below-minimum require approval, zero cost refunds, offers are negotiated',()=>{
 assert.equal(evaluate({budget_raw:'550000'}).decision,'owner_approval_required');assert.equal(evaluate({budget_raw:'650000'}).viability,'below_minimum');
 assert.equal(evaluate({cost_basis_raw:'0'}).recommended_payout,'0');assert.equal(evaluate({cost_basis_raw:'0',offer_raw:'1'}).decision,'counter');
 assert.equal(evaluate({offer_raw:'1201010'}).decision,'counter');assert.equal(evaluate({offer_raw:'1201010',negotiation_round:1}).decision,'accept');
 assert.equal(evaluate({offer_raw:'1201011',negotiation_round:1}).offer_issue,'above_maximum');
 assert.equal(evaluate({offer_raw:'1'}).offer_issue,'below_cost');
});
test('raw-unit safety handles huge values, rounding and invalid margins without floats',()=>{
 const big='9007199254740993000000000000000';assert.equal(evaluate({cost_basis_raw:big,budget_raw:(BigInt(big)*3n).toString(),escrow_raw:(BigInt(big)*3n).toString()}).target_payout,(BigInt(big)*2n).toString());
 assert.equal(evaluate({cost_basis_raw:'1'}).min_payout,'2');
 for(const cost of [1,'01','1.5','-1','1e3',(1n<<256n).toString()])assert.throws(()=>evaluate({cost_basis_raw:cost}));
 for(const options of [{target_margin_bps:10000},{min_margin_bps:6000},{target_margin_bps:5000.1},{require_counter:'yes'}])assert.throws(()=>createSettlementPolicy(options));
 const custom=createSettlementPolicy({target_margin_bps:2500,max_margin_bps:5000,min_margin_bps:0});assert.equal(custom.evaluate({cost_basis_raw:'3',budget_raw:'10',escrow_raw:'10'}).target_payout,'4');
});
test('projection distinguishes estimated profit from confirmed realized profit',()=>{
 const e=evaluate();const pending=profitProjection({evaluation:e,payout_raw:'800000'});assert.equal(pending.projected_profit_raw,'199495');assert.equal(pending.realized_profit_raw,null);assert.equal(pending.receipt_confirmed,false);
 const paid=profitProjection({evaluation:e,payout_raw:'1201010',confirmed:true});assert.equal(paid.realized_profit_raw,'600505');assert.equal(paid.target_status,'target_met');assert.equal(profitProjection({evaluation:e,payout_raw:'0',confirmed:true}).realized_margin_bps,null);
});
test('cost basis freezes privately at first proposal and worker/requester defaults differ',async()=>{
 let cost='600505';const {storage,service:s}=service({costBasisFor:async()=>cost});try{
 const j=job();assert.equal((await s.evaluate(j)).cost_basis_raw,cost);
 const worker=await s.prepare({job:j,actor:'worker',action:'propose_settlement',input:{reason:'Partial research'}});assert.equal(worker.worker_amount,'1201010');assert.equal(Object.hasOwn(worker,'cost_basis_raw'),false);
 cost='999999';assert.equal((await s.evaluate(j)).cost_basis_raw,'600505');assert.equal((await s.prepare({job:j,actor:'buyer',action:'propose_settlement',input:{}})).worker_amount,'0');
 const record=await storage.kv.get('a423_profit_basis',require('../src/workflow.cjs').hashAgreement([j.id,j.agreement.hash,0]));assert.equal(record.cost_basis_raw,'600505');assert.equal(Object.hasOwn(j,'profit'),false);
 }finally{storage.close();}
});
test('private projections never call cost provider for requester; only fresh settlement evidence realizes profit',async()=>{
 let calls=0;const {storage,service:s}=service({costBasisFor:async()=>{calls++;return '600505';}});try{
 const j=job();j.negotiation={current:{worker_amount:'1201010'}};
 const publicView=await s.project(j,'buyer');assert.equal(calls,0);assert.equal(JSON.stringify(publicView).includes('600505'),false);assert.equal(Object.hasOwn(publicView,'budget_raw'),false);
 const worker=await s.project(j,'worker');assert.equal(worker.realized_profit_raw,null);assert.equal(worker.projected_profit_raw,'600505');
 j.evidence.push({evidence:{event:'Settled',worker_paid:'1201010'}});
 const invalid=await s.project(j,'worker',{revalidate:async()=>({status:'invalid'})});assert.equal(invalid.realized_profit_raw,null);
 const good=await s.project(j,'worker',{revalidate:async()=>({status:'valid'})});assert.equal(good.realized_profit_raw,'600505');
 const requester=await s.project(j,'buyer',{revalidate:async()=>({status:'valid'})});assert.equal(requester.realized_payout_raw,'1201010');assert.equal(Object.hasOwn(requester,'realized_profit_raw'),false);
 }finally{storage.close();}
});
test('authorization guards losses, minimum, cap and first offers; requester proposals may request refund',async()=>{
 const {storage,service:s}=service();try{
 const j=job(),ctx={job:j,actor:'worker',action:'propose_settlement',input:{worker_amount:'600505'}};
 assert.equal(await s.authorize(ctx),false);assert.equal(await s.authorize({...ctx,input:{worker_amount:'1201011'}}),false);
 assert.equal(await s.authorize({...ctx,input:{worker_amount:'1201010'}}),true);
 assert.equal(await s.authorize({...ctx,actor:'buyer',input:{worker_amount:'0'}}),true);
 j.negotiation={current:{worker_amount:'1201010'},history:[{proposer_id:'buyer'}]};assert.equal(await s.authorize({...ctx,actor:'buyer',action:'approve_cancellation'}),false);
 j.negotiation.history.push({proposer_id:'worker'});assert.equal(await s.authorize({...ctx,actor:'buyer',action:'approve_cancellation'}),true);
 j.negotiation={current:{worker_amount:'1201010',proposer_id:'buyer'},history:[{proposer_id:'worker'},{proposer_id:'buyer'}]};assert.equal(await s.authorize({...ctx,actor:'worker',action:'approve_cancellation'}),false);
 j.negotiation.current.proposer_id='worker';assert.equal(await s.authorize({...ctx,actor:'buyer',action:'approve_cancellation'}),true);
 j.negotiation.current.worker_amount='1';assert.equal(await s.authorize({...ctx,actor:'worker',action:'accept_settlement',input:{transaction_hash:'0x'+'a'.repeat(64)}}),true);
 }finally{storage.close();}
});
test('owner exceptions require a server-approved named decision and never override hard caps',async()=>{
 const approvals=[];const {storage,service:s}=service({approveException:async c=>{approvals.push(c);return {approved:true,approval_id:'owner-decision-1'};}});try{
 const j=job();assert.equal(await s.authorize({job:j,actor:'worker',action:'propose_settlement',input:{worker_amount:'550000'}}),true);assert.equal(approvals[0].evaluation.offer_issue,'below_cost');assert.equal((await storage.kv.list('a423_profit_approvals')).length,1);
 assert.equal(await s.authorize({job:j,actor:'worker',action:'propose_settlement',input:{worker_amount:'5000001'}}),false);assert.equal(approvals.length,1);
 }finally{storage.close();}
});
test('policy prompts are configurable, distinguish roles and never imply a payment is confirmed',()=>{
 assert.match(settlementPolicyPrompt(),/5000 basis points gross margin/);assert.match(settlementPolicyPrompt(),/never disclose internal cost/);assert.match(settlementPolicyPrompt({role:'requester'}),/original budget/);assert.equal(settlementPolicyPrompt({override:'Use organization policy'}),'Use organization policy');
});
test('policy module supports ESM imports',async()=>{const esm=await import('../src/policy/index.mjs');assert.equal(esm.createSettlementPolicy().evaluate({cost_basis_raw:'2',budget_raw:'10',escrow_raw:'10'}).recommended_payout,'4');});
test('initialization accepts direct thresholds, freezes configuration and rejects conflicting or misspelled options',async()=>{
 const storage=createSqliteStorage({filename:':memory:'});let calls=0;const callbacks={kv:storage.kv,costBasisFor:async()=>{calls++;return '600505';},budgetFor:async()=> '5000000'};
 try{
 const thresholds={target_margin_bps:3000,min_margin_bps:500,max_margin_bps:4000,require_counter:false};
 const s=createProfitSettlementService({...callbacks,thresholds});thresholds.target_margin_bps=9000;
 assert.equal(s.configuration.target_margin_bps,3000);assert.equal(Object.isFrozen(s.configuration),true);assert.equal(calls,0);
 const e=await s.evaluate(job());assert.equal(e.target_payout,'857865');assert.equal(e.require_counter,false);assert.match(s.prompt(),/3000 basis points/);
 assert.throws(()=>createProfitSettlementService({...callbacks,thresholds:{target_margin_bps:6000,min_margin_bps:7000,max_margin_bps:8000}}),/minimum <= target/);
 assert.throws(()=>createProfitSettlementService({...callbacks,thresholds:{target_margin_bps:3000},policy}),/either thresholds or policy/);
 assert.throws(()=>createSettlementPolicy({target_magin_bps:3000}),/Unknown policy threshold/);
 for(const value of [null,[],true])assert.throws(()=>createSettlementPolicy(value),/plain object/);
 assert.throws(()=>createProfitSettlementService({...callbacks,policy:{configuration:{target_margin_bps:10000},evaluate:()=>({})}}),/Margins/);
 }finally{storage.close();}
});
