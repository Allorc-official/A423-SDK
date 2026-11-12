'use strict';
const { createHash, randomUUID } = require('node:crypto');
const { A423Error } = require('./index.cjs');
const copy = value => structuredClone(value);
const error = (code, message, status = 409) => { throw new A423Error(code, message, status); };
function canonical(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length) throw new TypeError('Use dense JSON arrays');
    return '[' + value.map(item => canonical(item)).join(',') + ']';
  }
  if (value && Object.getPrototypeOf(value) === Object.prototype) return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  throw new TypeError('Use JSON values only (no undefined, bigint, class instances or nonfinite numbers)');
}
function digest(value) { return createHash('sha256').update(canonical(value)).digest('hex'); }
function identifier(value) { if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new TypeError('IDs must contain 1–128 letters, digits, underscores or hyphens'); return value; }
const {DEFAULT_TRANSITIONS:RULES}=require('./workflow-actions.cjs');
/** Pure canonical JSON SHA-256. This is an integrity commitment, not authentication. */
function hashAgreement(terms) { return digest(terms); }
function createWorkflow({ store, adapters = {}, authorize, prepareInput, validateTerms, validateEvidence, transitions = {} } = {}) {
  if (!store || ['get', 'create', 'compareAndSet'].some(k => typeof store[k] !== 'function')) throw new TypeError('Supply an atomic workflow store');
  const rules = copy(RULES);
  for (const [action, rule] of Object.entries(transitions)) {
    identifier(action);
    if (!rule || !Array.isArray(rule.from) || !rule.from.length || !Array.isArray(rule.roles) || !rule.roles.length || typeof rule.to !== 'string' || !rule.to) throw new TypeError('Transitions require from, roles and to');
    rules[action] = copy(rule);
  }
  const stamp = () => new Date().toISOString();
  async function save(job, next, type, actor, data = {}) {
    next.version = job.version + 1; next.updated_at = stamp();
    next.events.push({ sequence: next.events.length + 1, type, actor_id: actor, at: next.updated_at, data: copy(data) });
    if (!await store.compareAndSet(job.id, job.version, next)) error('CONFLICT', 'Reload and retry', 409);
    return next;
  }
  async function get(id, actor) {
    identifier(id); identifier(actor);
    const job = await store.get(id);
    if (!job || !Object.values(job.participants).includes(actor)) error('NOT_FOUND', 'Job not found', 404);
    return copy(job);
  }
  async function allowed(job, action, actor, input, rule, phase='execute') {
    if (!rule.roles.some(role => job.participants[role] === actor)) error('FORBIDDEN', 'Actor cannot perform this action', 403);
    if (authorize && await authorize({ job: copy(job), action, actor, input: copy(input), phase }) !== true) error('FORBIDDEN', 'Application policy rejected action', 403);
  }
  async function complete(job, result) {
    const pending = job.pending;
    if (!result || !['confirmed', 'pending', 'rejected'].includes(result.status)) error('INVALID_ADAPTER_RESULT', 'Adapter must return confirmed, pending or rejected', 502);
    canonical(result);
    if (result.status === 'pending') {
      const next = copy(job); next.pending.observation = copy(result);
      require('./cancellation.cjs').updateCancellationSubflow(job,next,{action:pending.action,actor:pending.actor,phase:'pending',evidence:result,at:stamp()});
      return save(job, next, pending.action + '.pending', pending.actor, result);
    }
    if (result.status === 'rejected') {
      const next = copy(job); next.pending = null;
      next.operations[pending.key] = { request_hash: pending.request_hash, status: 'rejected', result: copy(result) };
      require('./cancellation.cjs').updateCancellationSubflow(job,next,{action:pending.action,actor:pending.actor,phase:'rejected',error:result.reason,at:stamp()});
      return save(job, next, pending.action + '.rejected', pending.actor, result);
    }
    if (!result.evidence || typeof result.evidence !== 'object' || Array.isArray(result.evidence)) error('INVALID_ADAPTER_RESULT', 'Confirmed effects require structured evidence', 502);
    if(validateEvidence)await validateEvidence({job:copy(job),action:pending.action,evidence:copy(result.evidence)});
    const next = copy(job); next.pending = null; next.state = pending.target;
    next.operations[pending.key] = { request_hash: pending.request_hash, status: 'confirmed', result: copy(result) };
    next.evidence.push({ action: pending.action, operation_id: pending.id, evidence: copy(result.evidence) });
    if (pending.action === 'submit') next.submission = copy(pending.input);
    let eventData=copy(result.evidence);
    if(['propose_settlement','counter_settlement'].includes(pending.action)){
      const proposal=require('./closing.cjs').settlementProposal(job,pending.input);
      if(result.evidence.proposal_hash!==proposal.proposal_hash || result.evidence.escrow_version!==proposal.escrow_version)error('INVALID_ADAPTER_RESULT','Confirmed proposal must match exact claimed terms',502);
      const record={...proposal,proposer_id:pending.actor,at:stamp()};
      next.negotiation={status:'open',origin_state:job.negotiation?.origin_state||job.state,current:record,history:[...(job.negotiation?.history||[]),record]};
      next.work_status='paused';eventData={...eventData,proposal:record};
    }
    if(pending.action==='approve_cancellation'){
      const instruction=require('./cancellation.cjs').validateCancellationInstruction(job,result.evidence.instruction);
      next.negotiation={...copy(job.negotiation),status:'accepted',acceptance_basis:'dual_wallet_signatures'};next.work_status='paused';
      eventData={...eventData,instruction_id:instruction.id};
    }
    if(['accept_settlement','execute_cancellation'].includes(pending.action)){
      const p=job.negotiation?.current;
      if(!p || result.evidence.settlement_reason!==4 || result.evidence.worker_paid!==p.worker_amount || result.evidence.proposal_hash!==p.proposal_hash || result.evidence.escrow_version!==p.escrow_version)error('INVALID_ADAPTER_RESULT','Closing settlement evidence mismatch',502);
      next.negotiation={...copy(job.negotiation),status:'settled',accepted_by:pending.actor,settled_at:stamp()};next.work_status='stopped';
    }
    if(pending.action==='dispute'){next.work_status='paused';if(next.negotiation)next.negotiation.status='disputed';}
    if(['release','refund','resolve','timeout'].includes(pending.action)){
      next.work_status=pending.action==='release'?'completed':'stopped';
      if(next.negotiation)next.negotiation={...next.negotiation,status:'settled',settled_at:stamp()};
    }
    if(['start','submit','verify'].includes(pending.action))next.work_status={start:'running',submit:'submitted',verify:'verified'}[pending.action];
    const e=result.evidence;
    if(typeof e.amount==='string'&&typeof e.worker_paid==='string'&&Number.isInteger(e.state)){
      const closed=[5,6,7].includes(e.state);
      next.escrow_ledger={funded_amount:e.amount,worker_paid:e.worker_paid,payer_refunded:closed?(BigInt(e.amount)-BigInt(e.worker_paid)).toString():'0',locked_amount:closed?'0':e.amount,escrow_version:e.escrow_version??0};
    }
    require('./cancellation.cjs').updateCancellationSubflow(job,next,{action:pending.action,actor:pending.actor,phase:'confirmed',evidence:result.evidence,instruction:result.evidence.instruction,at:stamp()});
    return save(job, next, pending.action + '.confirmed', pending.actor, eventData);
  }
  async function execute(job, reconcile = false) {
    const pending = job.pending;
    const adapter = adapters[pending.action];
    const fn = reconcile ? adapter?.reconcile : (typeof adapter === 'function' ? adapter : adapter?.execute);
    if (typeof fn !== 'function') error('ADAPTER_REQUIRED', `Configure ${pending.action}${reconcile ? '.reconcile' : ''}`, 501);
    // Persisted idempotency key is reused even after crashes. Adapters must deduplicate durably.
    const result = await fn({ job: copy(job), input: copy(pending.input), operation: copy(pending) });
    return complete(job, result);
  }
  const workflow={
    async create({ id = randomUUID(), participants, metadata = {} }, actor) {
      identifier(id); identifier(actor);
      if (!participants || !participants.requester || !participants.worker || !participants.verifier) throw new TypeError('Supply requester, worker and verifier participants');
      Object.values(participants).forEach(identifier);
      if (participants.requester === participants.worker || actor !== participants.requester) error('FORBIDDEN', 'Requester must create the job and differ from worker', 403);
      canonical(metadata); canonical(participants);
      const at = stamp();
      const job = { epoch:0,agreement_revision:0,pre_funding_cancellations:[],subflows:[],active_subflow_id:null,work_status:'not_started',negotiation:null,escrow_ledger:null,id, protocol: 'a423.workflow.v1', version: 1, state: 'draft', participants: copy(participants), metadata: copy(metadata), agreement: null, submission: null, pending: null, operations: {}, evidence: [], events: [{ sequence: 1, type: 'created', actor_id: actor, at, data: {} }], created_at: at, updated_at: at };
      if (authorize && await authorize({ job: copy(job), action: 'create', actor, input: {} }) !== true) error('FORBIDDEN', 'Application policy rejected creation', 403);
      if (!await store.create(job)) error('CONFLICT', 'Job ID already exists');
      return copy(job);
    },
    get,
    async assertSafe(id,actor){const job=await get(id,actor);const safety=store.getSafety?await store.getSafety(id):null;if(safety?.blocked)error('SAFETY_HOLD','Evidence requires reconciliation',409);if(['propose_settlement','counter_settlement','dispute'].includes(job.pending?.action)||job.state==='settlement_negotiation')error('WORK_PAUSED','Settlement negotiation pauses work',409);return job;},
    async act(id, action, input, { actor, idempotencyKey } = {}) {
      identifier(actor); identifier(idempotencyKey); identifier(action); canonical(input);
      let job = await get(id, actor);
      const safety=store.getSafety ? await store.getSafety(id) : null;
      if(safety?.blocked) error('SAFETY_HOLD','Evidence requires reconciliation before further actions',409);
      const rule = Object.hasOwn(rules,action) ? rules[action] : null;
      if (!rule) error('UNKNOWN_ACTION', 'Unknown workflow action', 400);
      if(!rule.roles.some(role=>job.participants[role]===actor))error('FORBIDDEN','Actor cannot perform this action',403);
      if(prepareInput){input=await prepareInput({job:copy(job),action,actor,input:copy(input)});canonical(input);}
      await allowed(job, action, actor, input, rule);
      const key = digest([actor, idempotencyKey]);
      const requestHash = digest([action, input]);
      if (Object.hasOwn(job.operations, key)) {
        if (job.operations[key].request_hash !== requestHash) error('IDEMPOTENCY_CONFLICT', 'Key used for another request');
        return job;
      }
      if (job.pending) {
        if (job.pending.key !== key || job.pending.request_hash !== requestHash) error('OPERATION_PENDING', 'Reconcile or retry the pending operation first');
        return execute(job);
      }
      const cancellation=require('./cancellation.cjs').getCancellationSubflow(job);
      if(['propose_settlement','counter_settlement'].includes(action)&&cancellation?.instruction)error('CANCELLATION_ACCEPTED','An accepted instruction must be executed or resolved before renegotiating',409);
      if(action==='approve_cancellation'&&cancellation?.instruction){const candidate=require('./cancellation.cjs').createCancellationInstruction(job,input);if(input.expected_revision!==job.negotiation.current.escrow_version||input.proposal_hash!==job.negotiation.current.proposal_hash||hashAgreement(candidate)!==hashAgreement(cancellation.instruction))error('CANCELLATION_CONFLICT','Another instruction is already accepted',409);return job;}
      if (!rule.from.includes(job.state)) error('INVALID_STATE', `Cannot ${action} from ${job.state}`);
      let next = copy(job);
      const fundingStarted=Object.values(job.operations).some(op=>op.result?.evidence?.event==='Funded') || job.evidence.some(e=>e.action==='fund') || job.events.some(e=>e.type==='fund.requested') || !!job.escrow_ledger;
      if(['cancel','decline','reopen'].includes(action)&&fundingStarted)error('FUNDING_STARTED','Funding activity must be reconciled and closed; this job cannot be reopened',409);
      if((job.epoch||0)>0&&['quote','accept','fund','cancel','decline'].includes(action)&&input?.expected_epoch!==job.epoch)error('STALE_EPOCH','Reload the job and supply its current expected_epoch',409);
      if(['cancel','decline'].includes(action)){
        if(input?.reason!==undefined&&(typeof input.reason!=='string'||!input.reason.trim()||input.reason.length>4000))error('INVALID_INPUT','Cancellation reason must be nonempty text, at most 4000 characters',400);
        const record={id:randomUUID(),epoch:job.epoch||0,action,actor_id:actor,prior_state:job.state,accepted_by:copy(job.agreement?.accepted_by||[]),agreement:copy(job.agreement),reason:input?.reason||null,at:stamp(),reopen_approvals:[],reopened_at:null};
        next.pre_funding_cancellations=[...(job.pre_funding_cancellations||[]),record];next.work_status='stopped';
      }
      if(action==='reopen'){
        const history=copy(job.pre_funding_cancellations||[]),record=history.at(-1);
        if(!record||record.reopened_at||input?.cancellation_id!==record.id)error('CANCELLATION_MISMATCH','Supply the current pre-funding cancellation_id',409);
        const required=[...new Set([job.participants.requester,record.actor_id,...([job.participants.requester,job.participants.worker].every(id=>record.accepted_by.includes(id))?[job.participants.worker]:[])])];
        if(!required.includes(actor))error('FORBIDDEN','This actor is not a required reopening approver',403);
        record.reopen_approvals=[...new Set([...record.reopen_approvals,actor])];next.pre_funding_cancellations=history;
        if(!required.every(id=>record.reopen_approvals.includes(id))){next.operations[key]={request_hash:requestHash,status:'confirmed',result:{status:'confirmed'}};return save(job,next,'reopen.approved',actor,{cancellation_id:record.id,required_approvers:required});}
        record.reopened_at=stamp();next.epoch=(job.epoch||0)+1;next.agreement_revision=Math.max(job.agreement_revision||0,job.agreement?.revision||0);next.agreement=null;next.work_status='not_started';
      }
      if (action === 'quote') {
        if (!input || !input.terms || typeof input.terms !== 'object' || Array.isArray(input.terms)) error('INVALID_INPUT', 'Supply a terms object', 400);
        if (validateTerms) await validateTerms(copy(input.terms));
        const terms=copy(input.terms);
        if((job.epoch||0)>0)terms._a423_reopen={job_id:job.id,epoch:job.epoch};
        next.agreement_revision=Math.max(job.agreement_revision||0,job.agreement?.revision||0)+1;
        next.agreement = { revision: next.agreement_revision, terms, hash: hashAgreement(terms), accepted_by: [] };
      }
      if (action === 'accept') {
        if (!input || input.agreement_hash !== job.agreement.hash || input.revision !== job.agreement.revision) error('AGREEMENT_MISMATCH', 'Accept the current agreement hash and revision');
        next.agreement.accepted_by = [...new Set([...job.agreement.accepted_by, actor])];
      }
      if (rule.effect) {
        if (!adapters[action]) error('ADAPTER_REQUIRED', `Configure ${action} adapter`, 501);
        next.pending = { id: `a423:${id}:${key}`, key, action, actor, input: copy(input), request_hash: requestHash, target: rule.to, created_at: stamp(), observation: null };
        require('./cancellation.cjs').updateCancellationSubflow(job,next,{action,actor,phase:'requested',input,at:stamp()});
        job = await save(job, next, action + '.requested', actor);
        return execute(job);
      }
      next.state = action === 'accept' && [job.participants.requester, job.participants.worker].every(p => next.agreement.accepted_by.includes(p)) ? 'accepted' : rule.to;
      next.operations[key] = { request_hash: requestHash, status: 'confirmed', result: { status: 'confirmed' } };
      return save(job, next, action, actor, input);
    },
    async rejectPendingOperation(id,{operation_id,reason},{actor}={}) {
      const job=await get(id,actor),pending=job.pending;
      if((store.getSafety?await store.getSafety(id):null)?.blocked)error('SAFETY_HOLD','Evidence requires reconciliation before recovery',409);
      if(!pending||pending.id!==operation_id)error('PENDING_MISMATCH','Supply the current pending operation ID',409);
      if(typeof reason!=='string'||!reason.trim()||reason.length>4000)error('INVALID_INPUT','Recovery reason required',400);
      const rule=rules[pending.action];if(!rule)error('RECOVERY_UNSUPPORTED','Unknown pending action',409);
      await allowed(job,pending.action,actor,pending.input,rule);
      if(pending.request_hash!==digest([pending.action,pending.input]))error('RECOVERY_UNSAFE','Pending input integrity mismatch; manual investigation required',409);
      const inspect=adapters[pending.action]?.rejectPending;
      if(typeof inspect!=='function')error('RECOVERY_UNSUPPORTED','Adapter does not prove this operation is never executable',409);
      const proof=await inspect({job:copy(job),input:copy(pending.input),operation:copy(pending)});
      if(proof?.status!=='rejected'||proof.never_executable!==true)error('RECOVERY_UNSAFE','Operation might execute; reconcile instead',409);
      return complete(job,{status:'rejected',reason,recovery:{operation_id,proof:copy(proof)}});
    },
    async resume(id, actor) {
      const job=await get(id,actor);
      if(!job.pending)return job;
      const safety=store.getSafety ? await store.getSafety(id) : null;
      if(safety?.blocked)error('SAFETY_HOLD','Evidence requires reconciliation',409);
      await allowed(job,job.pending.action,actor,job.pending.input,rules[job.pending.action]);
      return execute(job);
    },
    async reconcile(id, actor) {
      const job = await get(id, actor);
      if (!job.pending) return job;
      await allowed(job, job.pending.action, actor, job.pending.input, rules[job.pending.action],'reconcile');
      return execute(job, true);
    },
    async cancellation(id,actor){return require('./cancellation.cjs').getCancellationSubflow(await get(id,actor));},
    async cancellationInstruction(id,actor){const job=await get(id,actor),subflow=require('./cancellation.cjs').getCancellationSubflow(job);if(!subflow?.instruction)error('INSTRUCTION_UNAVAILABLE','No accepted cancellation instruction',409);return require('./cancellation.cjs').validateCancellationInstruction(job,subflow.instruction);},
    async cancellationReceipt(id,actor){const job=await get(id,actor),subflow=require('./cancellation.cjs').getCancellationSubflow(job);if(subflow?.status!=='completed'||!subflow.receipt)error('RECEIPT_UNAVAILABLE','Cancellation payment is not confirmed',409);return require('./cancellation.cjs').validateCancellationReceipt(job,subflow.receipt);},
    async acceptCancellation(id,input,{actor,idempotencyKey,forward=true}={}){
      if(typeof forward!=='boolean')throw new TypeError('forward must be a boolean');
      let job=await workflow.act(id,'approve_cancellation',input,{actor,idempotencyKey});
      const subflow=require('./cancellation.cjs').getCancellationSubflow(job);
      if(!forward||job.pending||!subflow?.instruction||subflow.status!=='accepted')return job;
      return workflow.act(id,'execute_cancellation',{instruction_id:subflow.instruction.id},{actor,idempotencyKey:'cancel_forward_'+digest(subflow.instruction.id)});
    },
    async receipts(id, actor) {
      const job = await get(id, actor);
      return { epoch:job.epoch||0,pre_funding_cancellations:job.pre_funding_cancellations||[],protocol: job.protocol, job_id: id, state: job.state, agreement: job.agreement, submission: job.submission, subflows:job.subflows||[],active_subflow_id:job.active_subflow_id||null,work_status:job.work_status,negotiation:job.negotiation,escrow_ledger:job.escrow_ledger,evidence: job.evidence, events: job.events, pending: job.pending };
    }
  };
  return workflow;
}
function createWorkflowHandler({ workflow, authenticate, basePath = '/api/a423', maxBodyBytes = 65536, onError, forwardCancellations = true, revalidateCancellationReceipt } = {}) {
  if(typeof forwardCancellations!=='boolean')throw new TypeError('forwardCancellations must be a boolean');
  if (!workflow || typeof authenticate !== 'function' || !/^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+$/.test(basePath)) throw new TypeError('Supply workflow, authenticate and valid basePath');
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1 || maxBodyBytes > 1048576) throw new TypeError('Invalid maxBodyBytes');
  const respond = (value, status = 200) => Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
  return async request => {
    try {
      const path = new URL(request.url).pathname;
      if (!path.startsWith(basePath + '/')) error('NOT_FOUND', 'Route not found', 404);
      const match = /^\/jobs(?:\/([A-Za-z0-9_-]{1,128})(?:\/(actions|reconcile|receipts|subflows|cancellation(?:\/(?:accept|execute|instruction|receipt))?))?)?$/.exec(path.slice(basePath.length));
      if (!match) error('NOT_FOUND', 'Route not found', 404);
      const [, id, action] = match;
      const method = !id || ['actions','reconcile','cancellation/accept','cancellation/execute'].includes(action) ? 'POST' : 'GET';
      if (request.method !== method) { const r = respond({ error: { code: 'METHOD_NOT_ALLOWED', message: `Use ${method}` } }, 405); r.headers.set('allow', method); return r; }
      const actor = await authenticate(request);
      if (!actor) error('UNAUTHENTICATED', 'Authentication required', 401);
      let body;
      if (method === 'POST') {
        if (!(request.headers.get('content-type') || '').toLowerCase().startsWith('application/json')) error('INVALID_INPUT', 'Use application/json', 415);
        const reader = request.body?.getReader(); if (!reader) error('INVALID_INPUT', 'JSON body required', 400);
        let size = 0; const chunks = [];
        try { while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > maxBodyBytes) { await reader.cancel(); error('BODY_TOO_LARGE', 'Body too large', 413); } chunks.push(Buffer.from(value)); } } finally { reader.releaseLock(); }
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { error('INVALID_INPUT', 'Invalid JSON', 400); }
      }
      if (!id) return respond({ job: await workflow.create(body, actor) }, 201);
      if(action==='subflows'){const job=await workflow.get(id,actor);return respond({job_id:id,subflows:job.subflows||[],active_subflow_id:job.active_subflow_id||null});}
      if(action==='cancellation')return respond({job_id:id,subflow:await workflow.cancellation(id,actor)});
      if(action==='cancellation/instruction')return respond({instruction:await workflow.cancellationInstruction(id,actor)});
      if(action==='cancellation/receipt'){
        const receipt=await workflow.cancellationReceipt(id,actor);
        if(revalidateCancellationReceipt)await revalidateCancellationReceipt({job:await workflow.get(id,actor),receipt,actor});
        return respond({receipt});
      }
      if(action==='cancellation/accept')return respond({job:await workflow.acceptCancellation(id,body,{actor,idempotencyKey:request.headers.get('idempotency-key'),forward:forwardCancellations})});
      if(action==='cancellation/execute')return respond({job:await workflow.act(id,'execute_cancellation',body,{actor,idempotencyKey:request.headers.get('idempotency-key')})});
      if (action === 'actions') return respond({ job: await workflow.act(id, body.action, body.input ?? {}, { actor, idempotencyKey: request.headers.get('idempotency-key') }) });
      if (action === 'reconcile') return respond({ job: await workflow.reconcile(id, actor) });
      if (action === 'receipts') return respond(await workflow.receipts(id, actor));
      return respond({ job: await workflow.get(id, actor) });
    } catch (err) {
      if (err instanceof A423Error) return respond({ error: { code: err.code, message: err.message } }, err.status);
      if (err instanceof TypeError) return respond({ error: { code: 'INVALID_INPUT', message: 'Invalid workflow input' } }, 400);
      if (onError) { try { await onError(err); } catch {} }
      return respond({ error: { code: 'INTERNAL_ERROR', message: 'Workflow operation failed; inspect and reconcile pending operations' } }, 500);
    }
  };
}
module.exports = { createWorkflow, createWorkflowHandler, hashAgreement };

function createWorkflowClient({ baseUrl, headers, fetch: fetchImpl = globalThis.fetch, timeoutMs = 30000 } = {}) {
  const url = new URL(baseUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || typeof fetchImpl !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new TypeError('Invalid client options');
  const base = url.href.replace(/\/$/, '');
  async function request(path, body, key) {
    const h = new Headers(typeof headers === 'function' ? await headers() : headers);
    h.set('accept', 'application/json');
    if (body !== undefined) h.set('content-type', 'application/json');
    if (key !== undefined) h.set('idempotency-key', identifier(key));
    const response = await fetchImpl(base + path, { method: body === undefined ? 'GET' : 'POST', headers: h, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
    const reader = response.body?.getReader(); if (!reader) error('INVALID_RESPONSE', 'Missing response body', 502);
    const chunks = []; let size = 0;
    try { while (true) { const {done,value} = await reader.read(); if(done) break; size += value.byteLength; if(size > 1048576) { await reader.cancel(); error('INVALID_RESPONSE','Response exceeds 1 MiB',502); } chunks.push(Buffer.from(value)); } } finally { reader.releaseLock(); }
    let data; try { data=JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { error('INVALID_RESPONSE','Invalid JSON response',502); }
    if (!response.ok) error(data.error?.code || 'HTTP_ERROR',data.error?.message || 'Request failed',response.status);
    return data;
  }
  const path = id => '/jobs/' + identifier(id);
  const workflow={
    async create(input) { return (await request('/jobs',input)).job; },
    async get(id) { return (await request(path(id))).job; },
    async act(id,action,input,{idempotencyKey}={}) { identifier(action);identifier(idempotencyKey);return (await request(path(id)+'/actions',{action,input},idempotencyKey)).job; },
    async reconcile(id) { return (await request(path(id)+'/reconcile',{})).job; },
    async cancellation(id){return (await request(path(id)+'/cancellation')).subflow;},
    async cancellationInstruction(id){return (await request(path(id)+'/cancellation/instruction')).instruction;},
    async cancellationReceipt(id){return (await request(path(id)+'/cancellation/receipt')).receipt;},
    async subflows(id){return (await request(path(id)+'/subflows')).subflows;},
    async acceptCancellation(id,input,{idempotencyKey}={}){identifier(idempotencyKey);return (await request(path(id)+'/cancellation/accept',input,idempotencyKey)).job;},
    async executeCancellation(id,input,{idempotencyKey}={}){identifier(idempotencyKey);return (await request(path(id)+'/cancellation/execute',input,idempotencyKey)).job;},
    async receipts(id) { return request(path(id)+'/receipts'); }
  };
  return workflow;
}
module.exports.createWorkflowClient = createWorkflowClient;

module.exports.getCancellationSubflow=(job)=>require('./cancellation.cjs').getCancellationSubflow(job);
module.exports.createCancellationInstruction=(job,proofs)=>require('./cancellation.cjs').createCancellationInstruction(job,proofs);
module.exports.validateCancellationInstruction=(job,instruction)=>require('./cancellation.cjs').validateCancellationInstruction(job,instruction);
module.exports.validateCancellationReceipt=(job,receipt)=>require('./cancellation.cjs').validateCancellationReceipt(job,receipt);
