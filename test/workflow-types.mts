import { createWorkflow, createWorkflowHandler, createWorkflowClient, type WorkflowJob, type WorkflowStore, type Effect } from '@allorc/a423-sdk/workflow';
const records = new Map<string, WorkflowJob>();
const store: WorkflowStore = {
 async get(id) { return records.get(id) ?? null; },
 async create(job) { if(records.has(job.id)) return false;records.set(job.id,structuredClone(job));return true; },
 async compareAndSet(id,v,job) { if(records.get(id)?.version!==v)return false;records.set(id,structuredClone(job));return true; }
};
const effect: Effect = async ({operation}) => ({status:'pending', reference:operation.id});
const workflow=createWorkflow({store, adapters:{fund:{execute:effect,reconcile:effect}},authorize:()=>true});
const handler=createWorkflowHandler({workflow,authenticate:()=> 'buyer'});
const client=createWorkflowClient({baseUrl:'https://example.test/api/a423',fetch:async(url,init)=>handler(new Request(url,init))});
await client.create({id:'job',participants:{requester:'buyer',worker:'seller',verifier:'buyer'}});
await client.act('job','quote',{terms:{amount:'100'}},{idempotencyKey:'q1'});
const approval={expected_revision:1,proposal_hash:'0xhash',payer_signature:'0x01',worker_signature:'0x02'};
await workflow.acceptCancellation('job',approval,{actor:'buyer',idempotencyKey:'approve',forward:false});
await client.acceptCancellation('job',approval,{idempotencyKey:'approve'});
const instruction=await client.cancellationInstruction('job');
await client.executeCancellation('job',{instruction_id:instruction.id},{idempotencyKey:'forward'});
const receipt=await client.cancellationReceipt('job');
const zero:'0'=receipt.remaining_locked;
await client.subflows('job');
