'use strict';
const { createHash, randomUUID } = require('node:crypto');
const PROTOCOL_VERSION = 'a423.experimental.v1';
const MAX_BODY_BYTES = 65536;
const MAX_RESULT_BYTES = 1048576;

class A423Error extends Error {
  constructor(code, message, status = 400) {
    super(message); this.name = 'A423Error'; this.code = code; this.status = status;
  }
}
function fail(code, message, status = 400) { throw new A423Error(code, message, status); }
function object(value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_INPUT', 'Expected an object');
  const keys = Object.keys(value);
  if (required.some(k => !Object.hasOwn(value, k)) || keys.some(k => ![...required, ...optional].includes(k))) {
    fail('INVALID_INPUT', `Expected fields: ${required.join(', ')}${optional.length ? `; optional: ${optional.join(', ')}` : ''}`);
  }
}
function text(value, name, max = 256) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
    fail('INVALID_INPUT', `${name} must be nonempty text of at most ${max} characters`);
  }
  return value;
}
function offerInput(value) {
  object(value, ['worker_id', 'title', 'description', 'price']);
  object(value.price, ['amount_minor', 'currency']);
  if (!Number.isSafeInteger(value.price.amount_minor) || value.price.amount_minor < 0) fail('INVALID_INPUT', 'amount_minor must be a nonnegative safe integer');
  if (typeof value.price.currency !== 'string' || !/^[A-Z][A-Z0-9]{2,11}$/.test(value.price.currency)) fail('INVALID_INPUT', 'currency must be an uppercase currency code');
  return { worker_id: text(value.worker_id, 'worker_id'), title: text(value.title, 'title'),
    description: text(value.description, 'description', 16000), price: { amount_minor: value.price.amount_minor, currency: value.price.currency } };
}
function submissionInput(value) {
  object(value, ['deliverable']);
  return { deliverable: text(value.deliverable, 'deliverable', 8000) };
}
function hash(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function clone(value) { return structuredClone(value); }
function json(value, status = 200) {
  return Response.json(value, { status, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
}
async function readJson(request, limit) {
  if (!(request.headers.get('content-type') || '').split(';')[0].trim().toLowerCase().endsWith('/json')) {
    fail('UNSUPPORTED_MEDIA_TYPE', 'Use Content-Type: application/json', 415);
  }
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) fail('BODY_TOO_LARGE', 'Request body exceeds the configured limit', 413);
  if (!request.body) fail('INVALID_JSON', 'A JSON body is required');
  const reader = request.body.getReader(); const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); fail('BODY_TOO_LARGE', 'Request body exceeds the configured limit', 413); }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { fail('INVALID_JSON', 'Request body must contain valid JSON'); }
}
/** Development only: no persistence or coordination between processes/serverless instances. */
function createMemoryStore() {
  const jobs = new Map();
  return {
    async get(id) { return jobs.has(id) ? clone(jobs.get(id)) : null; },
    async create(job) { if (jobs.has(job.id)) return false; jobs.set(job.id, clone(job)); return true; },
    async compareAndSet(id, expectedVersion, job) {
      if (!jobs.has(id) || jobs.get(id).version !== expectedVersion) return false;
      jobs.set(id, clone(job)); return true;
    }
  };
}
function createA423Handler({ store, authenticate, settlement, basePath = '/api/a423', maxBodyBytes = MAX_BODY_BYTES, onError } = {}) {
  if (!store || ['get', 'create', 'compareAndSet'].some(k => typeof store[k] !== 'function')) throw new TypeError('Supply a store implementing get, create and atomic compareAndSet');
  if (typeof authenticate !== 'function') throw new TypeError('Supply authenticate(request); there is no implicit anonymous access');
  if (settlement && typeof settlement.settle !== 'function') throw new TypeError('settlement must implement settle');
  if (typeof basePath !== 'string' || !/^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+$/.test(basePath)) throw new TypeError('basePath must be an absolute path without a trailing slash');
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1 || maxBodyBytes > MAX_RESULT_BYTES) throw new TypeError('maxBodyBytes must be between 1 and 1048576');
  if (onError !== undefined && typeof onError !== 'function') throw new TypeError('onError must be a function');
  const event = (job, type, actorId, data = {}) => ({ id: randomUUID(), sequence: job.events.length + 1, type, actor_id: actorId, at: new Date().toISOString(), data });
  async function save(previous, next, type, actorId, data) {
    next.version = previous.version + 1;
    next.updated_at = new Date().toISOString();
    next.events.push(event(next, type, actorId, data));
    if (!await store.compareAndSet(previous.id, previous.version, next)) fail('CONFLICT', 'Job changed concurrently; reload and retry', 409);
    return next;
  }
  async function load(id, actorId) {
    const job = await store.get(id);
    // Do not disclose a job's existence to unrelated actors.
    if (!job || ![job.requester_id, job.worker_id].includes(actorId)) fail('NOT_FOUND', 'Job not found', 404);
    return job;
  }
  return async function handler(request) {
    try {
      const path = new URL(request.url).pathname;
      if (!path.startsWith(basePath + '/')) fail('NOT_FOUND', 'Route not found', 404);
      const relative = path.slice(basePath.length);
      const match = /^\/jobs\/([a-zA-Z0-9_-]{1,128})(?:\/(accept|submit|approve|receipts))?$/.exec(relative);
      if (relative !== '/offers' && !match) fail('NOT_FOUND', 'Route not found', 404);
      const expectedMethod = relative === '/offers' || (match && ['accept', 'submit', 'approve'].includes(match[2])) ? 'POST' : 'GET';
      if (request.method !== expectedMethod) {
        const response = json({ error: { code: 'METHOD_NOT_ALLOWED', message: `Use ${expectedMethod}` } }, 405);
        response.headers.set('allow', expectedMethod); return response;
      }
      const actorId = await authenticate(request);
      if (actorId === null || actorId === undefined) fail('UNAUTHENTICATED', 'Authentication required', 401);
      text(actorId, 'authenticated actor ID');
      if (relative === '/offers') {
        const input = offerInput(await readJson(request, maxBodyBytes));
        if (input.worker_id === actorId) fail('INVALID_INPUT', 'Requester and worker must be different actors');
        const idempotencyKey = text(request.headers.get('idempotency-key'), 'Idempotency-Key', 200);
        if (!/^[\x21-\x7e]+$/.test(idempotencyKey)) fail('INVALID_INPUT', 'Idempotency-Key must use visible ASCII without spaces');
        const id = 'job_' + hash([PROTOCOL_VERSION, actorId, idempotencyKey]);
        const requestHash = hash(input);
        const at = new Date().toISOString();
        const job = { protocol: PROTOCOL_VERSION, id, version: 1, state: 'offered', requester_id: actorId,
          ...input, request_hash: requestHash, deliverable: null, settlement: null, created_at: at, updated_at: at, events: [] };
        job.events.push(event(job, 'offered', actorId));
        if (await store.create(job)) return json({ job }, 201);
        const existing = await load(id, actorId);
        if (existing.request_hash !== requestHash) fail('IDEMPOTENCY_CONFLICT', 'Idempotency-Key was already used with different offer details', 409);
        return json({ job: existing });
      }
      const [, id, action] = match;
      let job = await load(id, actorId);
      if (action === 'receipts') return json({ job_id: job.id, state: job.state, settlement: job.settlement, events: job.events });
      if (!action) return json({ job });
      const body = await readJson(request, maxBodyBytes);
      if (action === 'accept') {
        object(body, []);
        if (actorId !== job.worker_id) fail('FORBIDDEN', 'Only the assigned worker can accept', 403);
        if (job.state !== 'offered') {
          if (['accepted', 'submitted', 'settlement_pending', 'completed'].includes(job.state)) return json({ job });
          fail('INVALID_STATE', 'Job must be offered', 409);
        }
        const next = clone(job); next.state = 'accepted';
        job = await save(job, next, 'accepted', actorId);
        return json({ job });
      }
      if (action === 'submit') {
        const input = submissionInput(body);
        if (actorId !== job.worker_id) fail('FORBIDDEN', 'Only the assigned worker can submit', 403);
        if (job.state !== 'accepted') {
          if (['submitted', 'settlement_pending', 'completed'].includes(job.state) && job.deliverable === input.deliverable) return json({ job });
          fail('INVALID_STATE', 'Job must be accepted; a submitted deliverable cannot be replaced', 409);
        }
        const next = clone(job); next.state = 'submitted'; next.deliverable = input.deliverable;
        return json({ job: await save(job, next, 'submitted', actorId, input) });
      }
      object(body, []);
      if (actorId !== job.requester_id) fail('FORBIDDEN', 'Only the requester can approve', 403);
      if (job.state === 'completed') return json({ job });
      if (!['submitted', 'settlement_pending'].includes(job.state)) fail('INVALID_STATE', 'Job must be submitted before approval', 409);
      if (!settlement) {
        const next = clone(job); next.state = 'completed';
        next.settlement = { status: 'not_configured', reference: null };
        return json({ job: await save(job, next, 'completed', actorId, { settlement: next.settlement }) });
      }
      if (job.state === 'submitted') {
        const next = clone(job); next.state = 'settlement_pending';
        job = await save(job, next, 'settlement_pending', actorId);
      }
      // The adapter MUST deduplicate this stable key across retries/processes.
      const idempotencyKey = `a423:settle:${job.id}`;
      let result;
      try {
        result = await settlement.settle({ job: clone(job), idempotencyKey });
        object(result, ['reference']); text(result.reference, 'settlement reference', 2048);
      } catch (error) {
        if (onError) { try { await onError(error); } catch {} }
        fail('SETTLEMENT_UNAVAILABLE', 'Settlement remains pending; retry approval with the same job', 502);
      }
      const next = clone(job); next.state = 'completed';
      next.settlement = { status: 'settled', reference: result.reference };
      try { return json({ job: await save(job, next, 'completed', actorId, { settlement: next.settlement }) }); }
      catch (error) {
        if (error instanceof A423Error && error.code === 'CONFLICT') {
          const latest = await load(id, actorId);
          if (latest.state === 'completed') return json({ job: latest });
        }
        throw error;
      }
    } catch (error) {
      if (error instanceof A423Error) return json({ error: { code: error.code, message: error.message } }, error.status);
      if (onError) { try { await onError(error); } catch {} }
      return json({ error: { code: 'INTERNAL_ERROR', message: 'Unable to process the request' } }, 500);
    }
  };
}

function createA423Client({ baseUrl, headers, fetch: fetchImpl = globalThis.fetch, timeoutMs = 30000 } = {}) {
  const url = new URL(baseUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new TypeError('baseUrl must be an HTTP(S) URL without credentials, query or fragment');
  if (typeof fetchImpl !== 'function') throw new TypeError('Supply a fetch implementation');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new TypeError('timeoutMs must be a positive integer');
  const base = url.href.replace(/\/$/, '');
  async function call(path, method = 'GET', body, idempotencyKey) {
    const supplied = typeof headers === 'function' ? await headers() : headers;
    const requestHeaders = new Headers(supplied);
    requestHeaders.set('accept', 'application/json');
    if (body !== undefined) requestHeaders.set('content-type', 'application/json');
    if (idempotencyKey !== undefined) requestHeaders.set('idempotency-key', idempotencyKey);
    const response = await fetchImpl(base + path, { method, headers: requestHeaders, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
    const data = await readClientJson(response);
    if (!response.ok) throw new A423Error(data?.error?.code || 'HTTP_ERROR', data?.error?.message || `HTTP ${response.status}`, response.status);
    return data;
  }
  function jobPath(id) {
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new TypeError('Invalid job ID');
    return '/jobs/' + id;
  }
  return {
    async offer(input, { idempotencyKey } = {}) {
      if (typeof idempotencyKey !== 'string' || !idempotencyKey) throw new TypeError('Supply an idempotencyKey for offer retries');
      return (await call('/offers', 'POST', input, idempotencyKey)).job;
    },
    async getJob(id) { return (await call(jobPath(id))).job; },
    async accept(id) { return (await call(jobPath(id) + '/accept', 'POST', {})).job; },
    async submit(id, input) { return (await call(jobPath(id) + '/submit', 'POST', input)).job; },
    async approve(id) { return (await call(jobPath(id) + '/approve', 'POST', {})).job; },
    async receipts(id) { return call(jobPath(id) + '/receipts'); }
  };
}
async function readClientJson(response) {
  const reader = response.body?.getReader();
  if (!reader) throw new A423Error('INVALID_RESPONSE', 'Server returned no response body', 502);
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > MAX_RESULT_BYTES) { await reader.cancel(); throw new A423Error('INVALID_RESPONSE', 'Server response exceeds 1 MiB', 502); }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new A423Error('INVALID_RESPONSE', 'Server returned invalid JSON', 502); }
}
module.exports = { PROTOCOL_VERSION, A423Error, createMemoryStore, createA423Handler, createA423Client };
