'use strict';
const {createWorkflowHandler}=require('../workflow.cjs');
function createChatTools({workflow,store,queue,actor}={}){
 const {enqueueRunningJobs}=require('./index.cjs');
 const act=(action)=>async({job_id,input={},idempotency_key})=>workflow.act(job_id,action,input,{actor,idempotencyKey:idempotency_key});
 return {
  send_job_offer:async({id,worker_id,verifier_id,arbitrator_id,terms,metadata={}})=>{
   let job=await workflow.create({id,participants:{requester:actor,worker:worker_id,verifier:verifier_id,arbitrator:arbitrator_id},metadata},actor);
   if(terms)job=await workflow.act(job.id,'quote',{terms},{actor,idempotencyKey:'initial_quote'});return job;
  },
  propose_quote:act('quote'),accept_quote:act('accept'),fund_escrow:act('fund'),submit_job:act('submit'),verify_job:act('verify'),release_escrow:act('release'),refund_escrow:act('refund'),dispute_job:act('dispute'),resolve_job:act('resolve'),timeout_job:act('timeout'),cancel_job:act('cancel'),
  work_on_job:async(input)=>{const job=await act('start')(input);if(!job.pending&&job.state==='running')await enqueueRunningJobs({store,queue});return job;}
 };
}
function createApplicationHandler({workflow,store,queue,authenticate,revalidate,consentFor,legacyState=async()=>({}),authorityHandler,basePath='/api/a423'}={}){
 const {createEventStream,freshReceipts,renderReceiptPdf}=require('./index.cjs');
 const protocol=createWorkflowHandler({workflow,authenticate,basePath});const events=createEventStream({store,authenticate});
 return async request=>{
  const path=new URL(request.url).pathname;
  if(path.startsWith('/api/a423-auth/')&&authorityHandler)return authorityHandler(request);
  if(path.startsWith(basePath+'/'))return protocol(request);
  if(request.method!=='GET')return Response.json({error:'not found'},{status:404});
  if(path==='/api/a423-events')return events(request);
  const actor=await authenticate(request);if(!actor)return Response.json({error:'unauthenticated'},{status:401});
  try{
   if(path==='/api/state'){
    const jobs=await Promise.all((await store.list({actor,limit:1000})).map(async job=>({...job,safety:await store.getSafety(job.id)})));const wallet_transactions=jobs.flatMap(j=>j.evidence.filter(e=>e.evidence.transaction_hash).map(e=>({job_id:j.id,action:e.action,...e.evidence})));
    return Response.json({...await legacyState(actor),a423:{jobs,wallet_transactions}},{headers:{'cache-control':'no-store'}});
   }
   const receipt=/^\/api\/a423-receipts\/([A-Za-z0-9_-]{1,128})(\.pdf)?$/.exec(path);
   if(receipt){const data=await freshReceipts({workflow,id:receipt[1],actor,revalidate});if(receipt[2])return new Response(Buffer.from(await renderReceiptPdf(data)),{headers:{'content-type':'application/pdf','cache-control':'no-store'}});return Response.json(data,{headers:{'cache-control':'no-store'}});}
   const consent=/^\/api\/a423-worker-consent\/([A-Za-z0-9_-]{1,128})$/.exec(path);
   if(consent){const job=await workflow.get(consent[1],actor);if(job.participants.worker!==actor)return Response.json({error:'worker required'},{status:403});if(!consentFor)throw Error('Wallet consent not configured');const typed=await consentFor(job);return Response.json(JSON.parse(JSON.stringify(typed,(_,v)=>typeof v==='bigint'?v.toString():v)),{headers:{'cache-control':'no-store'}});}
   return Response.json({error:'not found'},{status:404});
  }catch(error){return Response.json({error:error.code||'EVIDENCE_OR_CONFIGURATION_UNAVAILABLE'},{status:error.code==='NOT_FOUND'?404:503});}
 };
}
module.exports={createChatTools,createApplicationHandler};
