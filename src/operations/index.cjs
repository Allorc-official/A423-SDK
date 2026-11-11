'use strict';
const {createHash,createHmac,randomUUID}=require('node:crypto');
const hash=x=>createHash('sha256').update(x).digest('hex');
function assert(ok,message){if(!ok)throw new TypeError(message);}
function validateTask(task){
 assert(task&&typeof task==='object'&&!Array.isArray(task),'Task required');
 for(const name of ['id','type','description'])assert(typeof task[name]==='string'&&task[name].trim()&&task[name].length<=16000,'Invalid task '+name);
 assert(Array.isArray(task.deliverables)&&task.deliverables.length>0&&task.deliverables.length<=100,'Deliverables required');
 const ids=new Set();for(const d of task.deliverables){assert(d&&typeof d.id==='string'&&!ids.has(d.id),'Unique deliverable IDs required');ids.add(d.id);assert(typeof d.media_type==='string'&&typeof d.description==='string','Deliverable media_type and description required');}
 assert(task.acceptance&&typeof task.acceptance.validator==='string'&&typeof task.acceptance.version==='string'&&task.acceptance.criteria&&typeof task.acceptance.criteria==='object','Versioned acceptance criteria required');
 JSON.stringify(task);return structuredClone(task);
}
function validateEscrowEvidence(e){
 assert(e&&typeof e==='object','Escrow evidence required');
 for(const key of ['chain_id','amount','worker_paid'])assert(typeof e[key]==='string'&&/^(0|[1-9][0-9]*)$/.test(e[key]),'Invalid evidence '+key);
 for(const key of ['contract','token','payer','worker','verifier','arbitrator'])assert(/^0x[0-9a-fA-F]{40}$/.test(e[key]),'Invalid evidence '+key);
 for(const key of ['job_id','agreement_hash','transaction_hash','block_hash','result_hash'])assert(/^0x[0-9a-fA-F]{64}$/.test(e[key]),'Invalid evidence '+key);
 assert(Number.isSafeInteger(e.block_number)&&e.block_number>=0&&Number.isSafeInteger(e.confirmations)&&e.confirmations>0,'Invalid evidence block');
 assert(['Funded','Submitted','Verified','Disputed','Settled','SettlementProposed'].includes(e.event),'Invalid evidence event');
 assert(Number.isInteger(e.state)&&e.state>=1&&e.state<=8&&BigInt(e.worker_paid)<=BigInt(e.amount),'Invalid evidence allocation/state');
 return structuredClone(e);
}
function createSpendingAuthorizer({spending,limitsFor,authorize}={}){
 assert(spending&&typeof limitsFor==='function'&&typeof authorize==='function','Spending store, limitsFor and authorize required');
 return async context=>{
  if(await authorize(context)!==true)return false;
  if(['fund','approve','approve_zero'].includes(context.step)){
   const e=context.job.agreement.terms.escrow,limits=await limitsFor(context);
   try {await spending.reserve({...limits,id:hash(JSON.stringify([e.chain_id,e.contract.toLowerCase(),context.job.id])),scope:JSON.stringify([e.chain_id,e.payer.toLowerCase(),e.token.toLowerCase()]),amount:e.amount});}catch(error){if(error.code==='SPENDING_LIMIT_EXCEEDED')return false;throw error;}
  }
  return true;
 };
}
/** Resume is deliberately separate from observe-only reconcile; caller must authorize execution. */
async function runMaintenanceOnce({workflow,store,actorFor,allowExecute=false,now=Date.now()}={}){
 const results=[];let after='';
 while(true){const jobs=await store.list({after,limit:100});if(!jobs.length)break;after=jobs.at(-1).id;
  for(const job of jobs){try{
   const actor=await actorFor(job);if(!actor)continue;
   let result=job;
   if(job.pending){result=await workflow.reconcile(job.id,actor);if(result.pending&&allowExecute)result=await workflow.resume(job.id,actor);}
   else if((job.subflows||[]).some(s=>s.kind==='cancellation'&&s.status==='accepted')&&allowExecute){
     const subflow=job.subflows.find(s=>s.kind==='cancellation');result=await workflow.act(job.id,'execute_cancellation',{instruction_id:subflow.instruction.id},{actor,idempotencyKey:'cancel_forward_'+hash(JSON.stringify(subflow.instruction.id))});
   }
   else if(job.agreement){const e=job.agreement.terms.escrow;const seconds=Math.floor(now/1000);let action;
    if(e&&(['funded','running'].includes(job.state)||(['settlement_negotiation','disputed'].includes(job.state)&&!job.submission))&&seconds>e.work_deadline)action='timeout';
    if(e&&['submitted','verified','disputed','settlement_negotiation'].includes(job.state)&&seconds>e.resolution_deadline)action='timeout';
    const expiry=job.agreement.terms.expires_at;
    if(['quoted','accepted'].includes(job.state)&&Number.isSafeInteger(expiry)&&seconds>expiry)action='expire';
    if(action&&allowExecute)result=await workflow.act(job.id,action,{}, {actor,idempotencyKey:'keeper_'+hash(job.id+':'+action)});
   }
   results.push({id:job.id,state:result.state,pending:!!result.pending});
  }catch(error){results.push({id:job.id,error:error.message});}}
 }
 return results;
}
function createExpiryAdapter({now=()=>Date.now()}={}){const run=async({job})=>{
 const expiry=job.agreement?.terms.expires_at;
 if(!Number.isSafeInteger(expiry)||Math.floor(now()/1000)<=expiry)return {status:'rejected',reason:'Agreement has not expired'};
 return {status:'confirmed',evidence:{expires_at:expiry,observed_at:new Date(now()).toISOString()}};
};return {execute:run,reconcile:run};}
async function runExecutionOnce({workflow,queue,execute,beforeExecute,leaseMs=30000}={}){
 const item=await queue.claim({kind:'execution',leaseMs});if(!item)return null;
 const controller=new AbortController();
 const heartbeat=setInterval(async()=>{try{if(!await queue.heartbeat(item.id,item.lease,{leaseMs}))throw Error('Execution lease lost');const current=await workflow.assertSafe(item.payload.job_id,item.payload.actor);if(current.state!=='running')throw Error('Work paused');}catch(error){controller.abort(error);}},Math.max(1,Math.min(1000,Math.floor(leaseMs/3))));
 try{
  let result=item.result;
  if(!result){const job=await workflow.assertSafe(item.payload.job_id,item.payload.actor);assert(job.state==='running','Work requires running state');validateTask(job.agreement.terms.task);assert(typeof beforeExecute==='function'&&await beforeExecute(job)===true,'Execution eligibility check required');result=await execute({job,idempotencyKey:item.id,signal:controller.signal});assert(await queue.checkpoint(item.id,item.lease,result),'Execution lease lost');}
  assert(typeof result.result_hash==='string','Execution must return artifact commitment');
  const job=await workflow.act(item.payload.job_id,'submit',result,{actor:item.payload.actor,idempotencyKey:'execution_'+hash(item.id)});
  assert(await queue.complete(item.id,item.lease,{job_id:job.id,state:job.state}),'Execution lease lost');return job;
 }catch(error){await queue.retry(item.id,item.lease,{delayMs:1000});throw error;}finally{clearInterval(heartbeat);}
}
async function enqueueRunningJobs({store,queue}){let after='',count=0;while(true){const jobs=await store.list({after,limit:100});if(!jobs.length)break;after=jobs.at(-1).id;for(const j of jobs)if(j.state==='running'&&!j.pending){const event=j.events.filter(e=>e.type==='start.confirmed').at(-1);if(event&&await queue.enqueue({id:'execution_'+hash(j.id+':'+event.sequence),kind:'execution',payload:{job_id:j.id,actor:j.participants.worker}}))count++;}}return count;}
function createEventStream({store,authenticate,pollMs=1000,maxDurationMs=25000}={}){
 return async request=>{
  const actor=await authenticate(request);if(!actor)return Response.json({error:'unauthenticated'},{status:401});
  let cursor=Number(request.headers.get('last-event-id')||new URL(request.url).searchParams.get('after')||0);if(!Number.isSafeInteger(cursor)||cursor<0)return Response.json({error:'invalid cursor'},{status:400});
  let closed=false,timer;const encoder=new TextEncoder(),began=Date.now();
  const stream=new ReadableStream({start(controller){const tick=async()=>{if(closed)return;try{const events=await store.events({actor,after:cursor,limit:100});for(const event of events){cursor=event.cursor;controller.enqueue(encoder.encode(`id: ${cursor}\nevent: a423\ndata: ${JSON.stringify(event)}\n\n`));}if(request.signal.aborted||Date.now()-began>=maxDurationMs){closed=true;controller.close();return;}controller.enqueue(encoder.encode(': heartbeat\n\n'));timer=setTimeout(tick,pollMs);}catch(e){closed=true;controller.error(e);}};void tick();},cancel(){closed=true;clearTimeout(timer);}});
  return new Response(stream,{headers:{'content-type':'text/event-stream','cache-control':'no-store','x-accel-buffering':'no'}});
 };
}
function createWebhookDispatcher({queue,kv,subscriptions,secretFor,fetch:fetchImpl=globalThis.fetch,timeoutMs=10000}={}){
 assert(queue&&kv&&Array.isArray(subscriptions)&&typeof secretFor==='function','Webhook configuration required');
 const targets=new Map();for(const s of subscriptions){const u=new URL(s.url);assert(u.protocol==='https:'&&!u.username&&!u.password&&!u.hash,'Use explicitly configured HTTPS webhook destinations');targets.set(s.id,{...s,url:u.href});}
 return {
  async project(store){for(const s of targets.values()){const events=await store.events({actor:s.actor,after:(await kv.get('webhook-cursors',s.id))?.cursor||s.after||0,limit:1000});for(const event of events){await queue.enqueue({id:'webhook_'+hash(s.id+':'+event.cursor),kind:'webhook',payload:{subscription:s.id,event}});await kv.put('webhook-cursors',s.id,{cursor:event.cursor});}}},
  async deliverOne(){const item=await queue.claim({kind:'webhook',leaseMs:timeoutMs+5000});if(!item)return null;try{
   const target=targets.get(item.payload.subscription);assert(target,'Subscription removed');const body=JSON.stringify(item.payload.event),timestamp=String(Math.floor(Date.now()/1000));const secret=await secretFor(target.id);assert(typeof secret==='string'&&secret.length>=32,'Webhook signing secret must have at least 32 characters');
   const signature=createHmac('sha256',secret).update(timestamp+'.'+body).digest('hex');const response=await fetchImpl(target.url,{method:'POST',body,headers:{'content-type':'application/json','a423-delivery-id':item.id,'a423-timestamp':timestamp,'a423-signature':'v1='+signature},redirect:'error',signal:AbortSignal.timeout(timeoutMs)});
   await response.body?.cancel();if(!response.ok)throw Error('Webhook HTTP '+response.status);await queue.complete(item.id,item.lease,{status:response.status});return {id:item.id,status:'delivered'};
  }catch(error){await queue.retry(item.id,item.lease,{delayMs:Math.min(3600000,1000*2**Math.min(item.attempts,12))});return {id:item.id,status:'retry',error:error.message};}}
 };
}
async function watchEvidenceOnce({store,revalidate}){const results=[];let after='';while(true){const jobs=await store.list({after,limit:100});if(!jobs.length)break;after=jobs.at(-1).id;for(const job of jobs){if(!job.evidence.length)continue;const checks=[];for(const item of job.evidence)if(item.evidence.transaction_hash){try{checks.push(await revalidate(job,item.evidence));}catch(error){checks.push({status:'unavailable',message:'Evidence provider unavailable'});}}
 const blocked=checks.some(c=>c.status!=='valid');const safety={blocked,checks,checked_at:new Date().toISOString()};await store.setSafety(job.id,safety);results.push({id:job.id,...safety});}}return results;}
async function freshReceipts({workflow,id,actor,revalidate}){const job=await workflow.get(id,actor);for(const p of job.negotiation?.history||[]){const canonical=require('../closing.cjs').settlementProposal(job,{worker_amount:p.worker_amount,payer_amount:p.payer_amount,expected_revision:p.escrow_version-1,expires_at:p.expires_at,reason:p.reason,claims:p.claims});assert(canonical.proposal_hash===p.proposal_hash,'Stored settlement claims changed');}const checks=[];for(const item of job.evidence)if(item.evidence.transaction_hash){const result=await revalidate(job,item.evidence);assert(result.status==='valid','Receipt evidence is not currently valid: '+result.status);checks.push(result);}return {...await workflow.receipts(id,actor),revalidated_at:new Date().toISOString(),checks};}
async function renderReceiptPdf(receipt){const {PDFDocument,StandardFonts}=require('pdf-lib');const pdf=await PDFDocument.create(),font=await pdf.embedFont(StandardFonts.Courier);let page,y;const newPage=()=>{page=pdf.addPage([595,842]);y=800;};newPage();const text=JSON.stringify(receipt,null,2).replace(/[^\x20-\x7e\n]/g,'?');for(const line of ['A423 Evidence Receipt',...text.split('\n')])for(let i=0;i<Math.max(1,line.length);i+=88){if(y<40)newPage();page.drawText(line.slice(i,i+88),{x:32,y,size:9,font});y-=12;}return pdf.save();}
function planLegacyMigration(records){return records.map(record=>({id:record.id,state:record.state,automatic:false,reason:['funded','running','submitted','verified','paid','settlement_pending','completed'].includes(String(record.state).toLowerCase())?'Existing custody/evidence must stay with original contract; do not relabel':'Requires reviewed participant and accepted-terms mapping; create a new job with provenance'}));}
module.exports={validateTask,validateEscrowEvidence,createSpendingAuthorizer,runMaintenanceOnce,createExpiryAdapter,runExecutionOnce,enqueueRunningJobs,createEventStream,createWebhookDispatcher,watchEvidenceOnce,freshReceipts,renderReceiptPdf,planLegacyMigration};

async function migrateUnfundedLegacy({records,workflow,map,actor}){
 const created=[];for(const source of records){assert(['offered','draft','quoted','accepted'].includes(String(source.state).toLowerCase()),'Funded/terminal legacy records cannot be automatically migrated');const target=await map(structuredClone(source));assert(target.id&&target.id!==source.id,'Use a new explicit job ID');const job=await workflow.create({...target,metadata:{...target.metadata,migration:{source_id:source.id,source_state:source.state,source_hash:hash(JSON.stringify(source)),accepted_terms_carried:false}}},actor);created.push(job);}return created;
}
module.exports.migrateUnfundedLegacy=migrateUnfundedLegacy;
Object.assign(module.exports,require('./application.cjs'));

Object.assign(module.exports,require('./factory.cjs'));

async function freshCancellationReceipt({workflow,id,actor,revalidate}){
 const job=await workflow.get(id,actor),receipt=await workflow.cancellationReceipt(id,actor);
 require('../cancellation.cjs').validateCancellationReceipt(job,receipt);
 const check=await revalidate(job,receipt.evidence);assert(check.status==='valid','Cancellation receipt evidence is not currently valid');return receipt;
}
module.exports.freshCancellationReceipt=freshCancellationReceipt;
