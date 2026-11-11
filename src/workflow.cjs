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
const RULES = {
  quote: { from: ['draft', 'quoted', 'accepted'], roles: ['requester', 'worker'], to: 'quoted' },
  accept: { from: ['quoted'], roles: ['requester', 'worker'], to: 'quoted' },
  fund: { from: ['accepted'], roles: ['requester'], to: 'funded', effect: true },
  start: { from: ['funded'], roles: ['worker'], to: 'running', effect: true },
  submit: { from: ['running'], roles: ['worker'], to: 'submitted', effect: true },
  verify: { from: ['submitted'], roles: ['verifier'], to: 'verified', effect: true },
  release: { from: ['verified'], roles: ['verifier'], to: 'paid', effect: true },
  refund: { from: ['funded', 'running'], roles: ['requester'], to: 'refunded', effect: true },
  cancel: { from: ['draft', 'quoted', 'accepted'], roles: ['requester'], to: 'cancelled' },
  expire: { from: ['draft', 'quoted', 'accepted'], roles: ['requester', 'worker'], to: 'expired', effect: true },
  dispute: { from: ['submitted', 'verified'], roles: ['requester', 'worker', 'verifier'], to: 'disputed' },
  resolve: { from: ['disputed'], roles: ['verifier'], to: 'resolved', effect: true }
};
/** Pure canonical JSON SHA-256. This is an integrity commitment, not authentication. */
function hashAgreement(terms) { return digest(terms); }
function createWorkflow({ store, adapters = {}, authorize, validateTerms, validateEvidence, transitions = {} } = {}) {
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
  async function allowed(job, action, actor, input, rule) {
    if (!rule.roles.some(role => job.participants[role] === actor)) error('FORBIDDEN', 'Actor cannot perform this action', 403);
    if (authorize && await authorize({ job: copy(job), action, actor, input: copy(input) }) !== true) error('FORBIDDEN', 'Application policy rejected action', 403);
  }
  async function complete(job, result) {
    const pending = job.pending;
    if (!result || !['confirmed', 'pending', 'rejected'].includes(result.status)) error('INVALID_ADAPTER_RESULT', 'Adapter must return confirmed, pending or rejected', 502);
    canonical(result);
    if (result.status === 'pending') {
      const next = copy(job); next.pending.observation = copy(result);
      return save(job, next, pending.action + '.pending', pending.actor, result);
    }
    if (result.status === 'rejected') {
      const next = copy(job); next.pending = null;
      next.operations[pending.key] = { request_hash: pending.request_hash, status: 'rejected', result: copy(result) };
      return save(job, next, pending.action + '.rejected', pending.actor, result);
    }
    if (!result.evidence || typeof result.evidence !== 'object' || Array.isArray(result.evidence)) error('INVALID_ADAPTER_RESULT', 'Confirmed effects require structured evidence', 502);
    if(validateEvidence)await validateEvidence({job:copy(job),action:pending.action,evidence:copy(result.evidence)});
    const next = copy(job); next.pending = null; next.state = pending.target;
    next.operations[pending.key] = { request_hash: pending.request_hash, status: 'confirmed', result: copy(result) };
    next.evidence.push({ action: pending.action, operation_id: pending.id, evidence: copy(result.evidence) });
    if (pending.action === 'submit') next.submission = copy(pending.input);
    return save(job, next, pending.action + '.confirmed', pending.actor, result.evidence);
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
  return {
    async create({ id = randomUUID(), participants, metadata = {} }, actor) {
      identifier(id); identifier(actor);
      if (!participants || !participants.requester || !participants.worker || !participants.verifier) throw new TypeError('Supply requester, worker and verifier participants');
      Object.values(participants).forEach(identifier);
      if (participants.requester === participants.worker || actor !== participants.requester) error('FORBIDDEN', 'Requester must create the job and differ from worker', 403);
      canonical(metadata); canonical(participants);
      const at = stamp();
      const job = { id, protocol: 'a423.workflow.v1', version: 1, state: 'draft', participants: copy(participants), metadata: copy(metadata), agreement: null, submission: null, pending: null, operations: {}, evidence: [], events: [{ sequence: 1, type: 'created', actor_id: actor, at, data: {} }], created_at: at, updated_at: at };
      if (authorize && await authorize({ job: copy(job), action: 'create', actor, input: {} }) !== true) error('FORBIDDEN', 'Application policy rejected creation', 403);
      if (!await store.create(job)) error('CONFLICT', 'Job ID already exists');
      return copy(job);
    },
    get,
    async assertSafe(id,actor){const job=await get(id,actor);const safety=store.getSafety?await store.getSafety(id):null;if(safety?.blocked)error('SAFETY_HOLD','Evidence requires reconciliation',409);return job;},
    async act(id, action, input, { actor, idempotencyKey } = {}) {
      identifier(actor); identifier(idempotencyKey); identifier(action); canonical(input);
      let job = await get(id, actor);
      const safety=store.getSafety ? await store.getSafety(id) : null;
      if(safety?.blocked) error('SAFETY_HOLD','Evidence requires reconciliation before further actions',409);
      const rule = Object.hasOwn(rules,action) ? rules[action] : null;
      if (!rule) error('UNKNOWN_ACTION', 'Unknown workflow action', 400);
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
      if (!rule.from.includes(job.state)) error('INVALID_STATE', `Cannot ${action} from ${job.state}`);
      let next = copy(job);
      if (action === 'quote') {
        if (!input || !input.terms || typeof input.terms !== 'object' || Array.isArray(input.terms)) error('INVALID_INPUT', 'Supply a terms object', 400);
        if (validateTerms) await validateTerms(copy(input.terms));
        next.agreement = { revision: (job.agreement?.revision || 0) + 1, terms: copy(input.terms), hash: hashAgreement(input.terms), accepted_by: [] };
      }
      if (action === 'accept') {
        if (!input || input.agreement_hash !== job.agreement.hash || input.revision !== job.agreement.revision) error('AGREEMENT_MISMATCH', 'Accept the current agreement hash and revision');
        next.agreement.accepted_by = [...new Set([...job.agreement.accepted_by, actor])];
      }
      if (rule.effect) {
        if (!adapters[action]) error('ADAPTER_REQUIRED', `Configure ${action} adapter`, 501);
        next.pending = { id: `a423:${id}:${key}`, key, action, actor, input: copy(input), request_hash: requestHash, target: rule.to, created_at: stamp(), observation: null };
        job = await save(job, next, action + '.requested', actor);
        return execute(job);
      }
      next.state = action === 'accept' && [job.participants.requester, job.participants.worker].every(p => next.agreement.accepted_by.includes(p)) ? 'accepted' : rule.to;
      next.operations[key] = { request_hash: requestHash, status: 'confirmed', result: { status: 'confirmed' } };
      return save(job, next, action, actor, input);
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
      await allowed(job, job.pending.action, actor, job.pending.input, rules[job.pending.action]);
      return execute(job, true);
    },
    async receipts(id, actor) {
      const job = await get(id, actor);
      return { protocol: job.protocol, job_id: id, state: job.state, agreement: job.agreement, submission: job.submission, evidence: job.evidence, events: job.events, pending: job.pending };
    }
  };
}
function createWorkflowHandler({ workflow, authenticate, basePath = '/api/a423', maxBodyBytes = 65536, onError } = {}) {
  if (!workflow || typeof authenticate !== 'function' || !/^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+$/.test(basePath)) throw new TypeError('Supply workflow, authenticate and valid basePath');
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1 || maxBodyBytes > 1048576) throw new TypeError('Invalid maxBodyBytes');
  const respond = (value, status = 200) => Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
  return async request => {
    try {
      const path = new URL(request.url).pathname;
      if (!path.startsWith(basePath + '/')) error('NOT_FOUND', 'Route not found', 404);
      const match = /^\/jobs(?:\/([A-Za-z0-9_-]{1,128})(?:\/(actions|reconcile|receipts))?)?$/.exec(path.slice(basePath.length));
      if (!match) error('NOT_FOUND', 'Route not found', 404);
      const [, id, action] = match;
      const method = !id || action === 'actions' || action === 'reconcile' ? 'POST' : 'GET';
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
  return {
    async create(input) { return (await request('/jobs',input)).job; },
    async get(id) { return (await request(path(id))).job; },
    async act(id,action,input,{idempotencyKey}={}) { identifier(action);identifier(idempotencyKey);return (await request(path(id)+'/actions',{action,input},idempotencyKey)).job; },
    async reconcile(id) { return (await request(path(id)+'/reconcile',{})).job; },
    async receipts(id) { return request(path(id)+'/receipts'); }
  };
}
module.exports.createWorkflowClient = createWorkflowClient;
