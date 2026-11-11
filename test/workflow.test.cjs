const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createMemoryStore } = require('../src/index.cjs');
const { createWorkflow, createWorkflowHandler, hashAgreement } = require('../src/workflow.cjs');
function setup(options = {}) { return createWorkflow({ store: createMemoryStore(), ...options }); }
const participants = { requester: 'buyer', worker: 'seller', verifier: 'reviewer' };
const yes = async () => ({ status: 'confirmed', evidence: { reference: 'test-only' } });
async function draft(w, id = 'one') { return w.create({ id, participants }, 'buyer'); }
async function act(w, action, actor, input = {}, key = action) { return w.act('one', action, input, { actor, idempotencyKey: key }); }
async function accepted(w) {
  await draft(w); const j = await act(w, 'quote', 'seller', { terms: { amount: '100', asset: 'TEST' } });
  const input = { agreement_hash: j.agreement.hash, revision: j.agreement.revision };
  await act(w, 'accept', 'buyer', input); return act(w, 'accept', 'seller', input);
}
test('canonical terms and invalid values', () => {
  assert.equal(hashAgreement({ b: 2, a: 1 }), hashAgreement({ a: 1, b: 2 }));
  assert.notEqual(hashAgreement({ a: '100' }), hashAgreement({ a: '101' }));
  for (const value of [undefined, NaN, 1n, new Date()]) assert.throws(() => hashAgreement(value));
});
test('full configurable lifecycle, immutable agreement and receipt evidence', async () => {
  const w = setup({ adapters: { fund: yes, start: yes, submit: yes, verify: yes, release: yes } });
  assert.equal((await accepted(w)).state, 'accepted');
  for (const [action, actor, input, state] of [ ['fund','buyer',{},'funded'], ['start','seller',{},'running'], ['submit','seller',{ uri: 'artifact:abc', hash: 'abc' },'submitted'], ['verify','reviewer',{},'verified'], ['release','reviewer',{},'paid'] ]) assert.equal((await act(w, action, actor, input)).state, state);
  assert.equal((await w.receipts('one','buyer')).evidence.length, 5);
  await assert.rejects(act(w, 'quote','seller',{terms:{a:1}},'late'), { code: 'INVALID_STATE' });
  await assert.rejects(w.get('one','intruder'), { code:'NOT_FOUND' });
});
test('quote revision resets acceptances and rejects stale acceptance', async () => {
  const w = setup(); await accepted(w);
  const before = await w.get('one','buyer');
  const next = await act(w,'quote','buyer',{terms:{amount:'101'}},'revision2');
  assert.deepEqual(next.agreement.accepted_by, []); assert.equal(next.agreement.revision, 2);
  await assert.rejects(act(w,'accept','seller',{agreement_hash:before.agreement.hash,revision:1},'stale'),{code:'AGREEMENT_MISMATCH'});
});
test('missing adapter and wrong roles fail closed', async () => {
  const w = setup(); await accepted(w);
  await assert.rejects(act(w,'fund','seller'),{code:'FORBIDDEN'});
  await assert.rejects(act(w,'fund','buyer'),{code:'ADAPTER_REQUIRED'});
  assert.equal((await w.get('one','buyer')).state,'accepted');
});
test('pending survives engine restart; reconcile observes without repeating execution', async () => {
  const store = createMemoryStore(); let calls = 0;
  let w = createWorkflow({store,adapters:{fund:async () => { calls++; throw Error('crash after broadcast'); }}});
  await accepted(w); await assert.rejects(act(w,'fund','buyer'));
  const pending = (await w.get('one','buyer')).pending;
  w = createWorkflow({store,adapters:{fund:{execute:yes,reconcile:async ctx => {assert.equal(ctx.operation.id,pending.id);return {status:'confirmed',evidence:{transaction:'known'}};}}}});
  assert.equal((await w.reconcile('one','buyer')).state,'funded'); assert.equal(calls,1);
  assert.equal((await act(w,'fund','buyer')).state,'funded');
  await assert.rejects(act(w,'fund','buyer',{changed:true}),{code:'IDEMPOTENCY_CONFLICT'});
});
test('adapter pending, rejection and invalid result cannot advance state', async () => {
  let result = {status:'pending',reference:'tx'};
  const w=setup({adapters:{fund:async()=>result}}); await accepted(w);
  assert.ok((await act(w,'fund','buyer')).pending);
  await assert.rejects(act(w,'cancel','buyer'),{code:'OPERATION_PENDING'});
  result={status:'confirmed'}; await assert.rejects(act(w,'fund','buyer'),{code:'INVALID_ADAPTER_RESULT'});
  result={status:'rejected',reason:'reverted'};
  const j=await act(w,'fund','buyer'); assert.equal(j.state,'accepted');assert.equal(j.pending,null);
});
test('refund, dispute, resolution, expiry, cancellation and custom transitions', async () => {
  const w=setup({adapters:{fund:yes,refund:yes}});await accepted(w);await act(w,'fund','buyer');assert.equal((await act(w,'refund','buyer')).state,'refunded');
  const d=setup({adapters:{fund:yes,start:yes,submit:yes,resolve:yes}});await accepted(d);await act(d,'fund','buyer');await act(d,'start','seller');await act(d,'submit','seller',{artifact:'x'});await act(d,'dispute','buyer',{reason:'quality'});assert.equal((await act(d,'resolve','reviewer')).state,'resolved');
  const e=setup({adapters:{expire:yes}});await draft(e);assert.equal((await act(e,'expire','buyer')).state,'expired');
  const c=setup();await draft(c);assert.equal((await act(c,'cancel','buyer')).state,'cancelled');
  const x=setup({transitions:{manual:{from:['draft'],roles:['verifier'],to:'reviewed'}}});await draft(x);assert.equal((await act(x,'manual','reviewer')).state,'reviewed');
});
test('policy and term validation reject before changes', async()=>{
  const w=setup({authorize:({action})=>action!=='cancel',validateTerms:()=>{throw Error('invalid terms');}});await draft(w);
  await assert.rejects(act(w,'quote','buyer',{terms:{}}));await assert.rejects(act(w,'cancel','buyer'),{code:'FORBIDDEN'});
  assert.equal((await w.get('one','buyer')).version,1);
});
test('concurrent effects use one persisted operation with adapter deduplication', async()=>{
  const seen=new Set();let executions=0;
  const w=setup({adapters:{fund:async({operation})=>{if(!seen.has(operation.id)){seen.add(operation.id);executions++;}return yes();}}});await accepted(w);
  await Promise.allSettled([act(w,'fund','buyer'),act(w,'fund','buyer')]);
  assert.equal(executions,1);assert.equal((await w.get('one','buyer')).state,'funded');
});
test('Next.js Web handler: auth, routes, bounded bodies, actions and receipts', async()=>{
  const w=setup();const h=createWorkflowHandler({workflow:w,authenticate:r=>r.headers.get('actor'),maxBodyBytes:512});
  const request=(path,actor,body,method=body?'POST':'GET')=>h(new Request('https://app.test/api/a423'+path,{method,headers:{actor:actor||'','content-type':'application/json','idempotency-key':'test'},body:body?JSON.stringify(body):undefined}));
  assert.equal((await request('/jobs',null,{participants})).status,401);
  assert.equal((await request('/jobs','buyer',{id:'one',participants})).status,201);
  assert.equal((await request('/jobs/one/actions','buyer',{action:'quote',input:{terms:{kind:'research'}}})).status,200);
  assert.equal((await request('/jobs/one/receipts','seller')).status,200);
  assert.equal((await request('/jobs/one','buyer',{},'POST')).status,405);
  assert.equal((await request('/jobs','buyer',{metadata:'x'.repeat(600),participants})).status,413);
});
test('typed workflow client talks to handler and exposes workflow ESM exports', async()=>{
  const {createWorkflowClient}=require('../src/workflow.cjs');
  const module=await import('../src/workflow.mjs');assert.equal(typeof module.createWorkflowClient,'function');
  const handler=createWorkflowHandler({workflow:setup(),authenticate:()=> 'buyer'});
  const c=createWorkflowClient({baseUrl:'https://app.test/api/a423',fetch:(url,init)=>handler(new Request(url,init))});
  assert.equal((await c.create({id:'one',participants})).state,'draft');
  assert.equal((await c.act('one','quote',{terms:{type:'custom'}},{idempotencyKey:'q1'})).state,'quoted');
  assert.equal((await c.get('one')).id,'one');assert.equal((await c.receipts('one')).job_id,'one');
  assert.equal((await c.reconcile('one')).state,'quoted');
});
