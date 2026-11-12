// Opt-in operational loop; application config must explicitly supply signer approvals and execution callbacks.
import {pathToFileURL} from 'node:url';
import {setTimeout} from 'node:timers/promises';
import {watchEvidenceOnce,runMaintenanceOnce,enqueueRunningJobs,runExecutionOnce} from '../src/operations/index.mjs';
if(!process.env.A423_CONFIG_MODULE)throw Error('A423_CONFIG_MODULE required');
const {applicationOptions:app,workerOptions:worker}=await import(pathToFileURL(process.env.A423_CONFIG_MODULE).href);
if(!worker?.actorFor)throw Error('workerOptions.actorFor must explicitly delegate maintenance actors');
const controller=new AbortController();for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>controller.abort());
while(!controller.signal.aborted){
 try{
  await watchEvidenceOnce({store:app.store,revalidate:app.revalidate});
  if(worker.index)await worker.index();
  if(worker.replaceFees)await worker.replaceFees();
  const maintenance=await runMaintenanceOnce({workflow:app.workflow,store:app.store,actorFor:worker.actorFor,allowExecute:worker.allowExecute===true});
  for(const result of maintenance)if(result.error)console.error('A423 maintenance failed for job',result.id);
  await enqueueRunningJobs({store:app.store,queue:app.queue});
  if(worker.execute)await runExecutionOnce({workflow:app.workflow,queue:app.queue,execute:worker.execute,beforeExecute:worker.beforeExecute,canContinue:worker.canContinue});
  if(worker.webhooks){await worker.webhooks.project(app.store);for(let i=0;i<10;i++)if(!await worker.webhooks.deliverOne())break;}
  if(worker.authority)await worker.authority.pruneChallenges();
 }catch(error){console.error('A423 worker tick failed:',error.code||error.name);}
 try{await setTimeout(5000,undefined,{signal:controller.signal});}catch{}
}
