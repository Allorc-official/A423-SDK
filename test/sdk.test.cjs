'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const sdk = require('../src/index.cjs');
const { createA423Handler, createMemoryStore, createA423Client, A423Error } = sdk;
const input = { worker_id: 'worker', title: 'Brief', description: 'Prepare a brief', price: { amount_minor: 500, currency: 'USD' } };
function fixture(options = {}) {
  const store = options.store || createMemoryStore();
  const handler = createA423Handler({ store, authenticate: req => ({ 'Bearer requester-secret': 'requester', 'Bearer worker-secret': 'worker', 'Bearer stranger-secret': 'stranger' })[req.headers.get('authorization')] || null, ...options });
  const localFetch = (url, init) => handler(new Request(url, init));
  const client = actor => createA423Client({ baseUrl: 'http://localhost/api/a423', headers: { authorization: `Bearer ${actor}-secret` }, fetch: localFetch });
  return { store, handler, requester: client('requester'), worker: client('worker'), stranger: client('stranger') };
}
const offer = f => f.requester.offer(input, { idempotencyKey: 'offer-1' });
async function submitted(f) { const job = await offer(f); await f.worker.accept(job.id); return f.worker.submit(job.id, { deliverable: 'https://example.com/brief' }); }
function rejectsCode(promise, code, status) {
  return assert.rejects(promise, error => error instanceof A423Error && error.code === code && (!status || error.status === status));
}
test('full offer/accept/submit/approve workflow and receipt order', async () => {
  const f = fixture(); const job = await offer(f);
  assert.equal(job.state, 'offered'); assert.equal(job.version, 1);
  assert.equal((await f.worker.accept(job.id)).state, 'accepted');
  assert.equal((await f.worker.submit(job.id, { deliverable: 'https://example.com/brief' })).state, 'submitted');
  const done = await f.requester.approve(job.id);
  assert.equal(done.state, 'completed'); assert.equal(done.version, 4);
  assert.deepEqual(done.settlement, { status: 'not_configured', reference: null });
  const receipt = await f.worker.receipts(job.id);
  assert.deepEqual(receipt.events.map(e => e.type), ['offered', 'accepted', 'submitted', 'completed']);
  assert.deepEqual(receipt.events.map(e => e.sequence), [1, 2, 3, 4]);
  assert.deepEqual(await f.requester.getJob(job.id), done);
});
test('offer retries are actor-scoped and detect different input with the same key', async () => {
  const f = fixture(); const [first, second] = await Promise.all([offer(f), offer(f)]);
  assert.equal(first.id, second.id); assert.equal(second.events.length, 1);
  await rejectsCode(f.requester.offer({ ...input, title: 'Other' }, { idempotencyKey: 'offer-1' }), 'IDEMPOTENCY_CONFLICT', 409);
  const other = await f.stranger.offer(input, { idempotencyKey: 'offer-1' });
  assert.notEqual(other.id, first.id);
});
test('anonymous and unrelated actors cannot read or mutate jobs', async () => {
  const f = fixture(); const job = await offer(f);
  const anonymous = await f.handler(new Request('http://localhost/api/a423/jobs/' + job.id));
  assert.equal(anonymous.status, 401);
  for (const request of [f.stranger.getJob(job.id), f.stranger.accept(job.id), f.stranger.receipts(job.id), f.stranger.approve(job.id)]) {
    await rejectsCode(request, 'NOT_FOUND', 404);
  }
  await rejectsCode(f.requester.accept(job.id), 'FORBIDDEN', 403);
  await rejectsCode(f.requester.submit(job.id, { deliverable: 'x' }), 'FORBIDDEN', 403);
  await rejectsCode(f.worker.approve(job.id), 'FORBIDDEN', 403);
});
test('state rules and safe transition retries', async () => {
  const f = fixture(); const job = await offer(f);
  await rejectsCode(f.worker.submit(job.id, { deliverable: 'x' }), 'INVALID_STATE', 409);
  await rejectsCode(f.requester.approve(job.id), 'INVALID_STATE', 409);
  await f.worker.accept(job.id); await f.worker.accept(job.id);
  await f.worker.submit(job.id, { deliverable: 'x' }); await f.worker.submit(job.id, { deliverable: 'x' });
  await rejectsCode(f.worker.submit(job.id, { deliverable: 'changed' }), 'INVALID_STATE', 409);
  await f.requester.approve(job.id); await f.requester.approve(job.id);
  assert.equal((await f.requester.getJob(job.id)).events.length, 4);
});
test('atomic version checks prevent competing state writes', async () => {
  const f = fixture(); const job = await offer(f);
  const outcomes = await Promise.allSettled([f.worker.accept(job.id), f.worker.accept(job.id)]);
  assert.equal(outcomes.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(outcomes.find(r => r.status === 'rejected').reason.code, 'CONFLICT');
  assert.equal((await f.requester.getJob(job.id)).events.length, 2);
});
test('settlement is explicit, retriable and uses a stable idempotency key', async () => {
  const calls = []; let failOnce = true;
  const f = fixture({ settlement: { async settle({ job, idempotencyKey }) {
    calls.push({ id: job.id, key: idempotencyKey });
    if (failOnce) { failOnce = false; throw new Error('provider temporarily unavailable'); }
    return { reference: 'provider-receipt-123' };
  } } });
  const job = await submitted(f);
  await rejectsCode(f.requester.approve(job.id), 'SETTLEMENT_UNAVAILABLE', 502);
  assert.equal((await f.worker.getJob(job.id)).state, 'settlement_pending');
  const result = await f.requester.approve(job.id);
  assert.equal(result.settlement.reference, 'provider-receipt-123'); assert.equal(result.settlement.status, 'settled');
  assert.equal(calls.length, 2); assert.equal(calls[0].key, calls[1].key);
  await f.requester.approve(job.id); assert.equal(calls.length, 2);
  assert.equal(result.events.filter(e => e.type === 'settlement_pending').length, 1);
});
test('retry after successful settlement but failed database write reuses provider key', async () => {
  const underlying = createMemoryStore(); let rejectCompletion = true; const keys = [];
  const store = { ...underlying, async compareAndSet(id, version, job) {
    if (job.state === 'completed' && rejectCompletion) { rejectCompletion = false; throw new Error('database unavailable'); }
    return underlying.compareAndSet(id, version, job);
  } };
  const f = fixture({ store, settlement: { async settle({ idempotencyKey }) { keys.push(idempotencyKey); return { reference: 'same-provider-reference' }; } } });
  const job = await submitted(f);
  await rejectsCode(f.requester.approve(job.id), 'INTERNAL_ERROR', 500);
  assert.equal((await f.requester.getJob(job.id)).state, 'settlement_pending');
  assert.equal((await f.requester.approve(job.id)).state, 'completed');
  assert.equal(keys.length, 2); assert.equal(keys[0], keys[1]);
});
test('malformed bodies, unsupported methods and route boundaries', async () => {
  const f = fixture();
  const post = (path, body, contentType = 'application/json') => f.handler(new Request('http://localhost' + path, { method: 'POST', headers: { authorization: 'Bearer requester-secret', 'content-type': contentType, 'idempotency-key': 'bad-offer' }, body }));
  assert.equal((await post('/api/a423/offers', '{')).status, 400);
  assert.equal((await post('/api/a423/offers', JSON.stringify(input), 'text/plain')).status, 415);
  for (const body of [{ ...input, requester_id: 'spoofed' }, { ...input, worker_id: 'requester' }, { ...input, price: { amount_minor: -1, currency: 'USD' } }, { ...input, price: { amount_minor: 1.1, currency: 'USD' } }, { ...input, price: { amount_minor: 1, currency: 'usd' } }]) {
    assert.equal((await post('/api/a423/offers', JSON.stringify(body))).status, 400);
  }
  assert.equal((await post('/api/a423-other/offers', '{}')).status, 404);
  assert.equal((await post('/api/a423/unknown', '{}')).status, 404);
  const method = await f.handler(new Request('http://localhost/api/a423/offers'));
  assert.equal(method.status, 405); assert.equal(method.headers.get('allow'), 'POST');
});
test('request body limit works without Content-Length', async () => {
  const f = fixture({ maxBodyBytes: 64 });
  const response = await f.handler(new Request('http://localhost/api/a423/offers', {
    method: 'POST', headers: { authorization: 'Bearer requester-secret', 'content-type': 'application/json' }, body: JSON.stringify(input)
  }));
  assert.equal(response.status, 413);
});
test('internal error details are logged only, never sent to clients', async () => {
  const errors = [];
  const handler = createA423Handler({ store: createMemoryStore(), authenticate() { throw new Error('secret-internal-detail'); }, onError: error => errors.push(error) });
  const response = await handler(new Request('http://localhost/api/a423/jobs/test'));
  assert.equal(response.status, 500); assert.equal((await response.text()).includes('secret-internal-detail'), false);
  assert.equal(errors.length, 1);
});
test('memory store returns copies and implements atomic insert/CAS', async () => {
  const f = fixture(); const job = await offer(f);
  const copy = await f.store.get(job.id); copy.title = 'mutated';
  assert.equal((await f.store.get(job.id)).title, input.title);
  assert.equal(await f.store.create(job), false);
  assert.equal(await f.store.compareAndSet(job.id, 999, job), false);
});
test('configuration and client input fail clearly', async () => {
  assert.throws(() => createA423Handler(), TypeError);
  assert.throws(() => createA423Handler({ store: createMemoryStore() }), TypeError);
  assert.throws(() => fixture({ basePath: '/api/a423/' }), TypeError);
  assert.throws(() => createA423Client({ baseUrl: 'file:///etc/passwd' }), TypeError);
  assert.throws(() => createA423Client({ baseUrl: 'https://user:password@example.com' }), TypeError);
  const f = fixture();
  await assert.rejects(f.requester.offer(input), TypeError);
  await assert.rejects(f.requester.getJob('../offers'), TypeError);
  const broken = createA423Client({ baseUrl: 'https://example.com/api/a423', fetch: async () => new Response('<html>bad response</html>') });
  await rejectsCode(broken.getJob('test'), 'INVALID_RESPONSE');
});
test('a configured custom route prefix works', async () => {
  const f = fixture({ basePath: '/api/tasks' });
  const response = await f.handler(new Request('http://localhost/api/tasks/offers', { method: 'POST', headers: { authorization: 'Bearer requester-secret', 'content-type': 'application/json', 'idempotency-key': 'custom' }, body: JSON.stringify(input) }));
  assert.equal(response.status, 201);
});
test('ESM exposes the same API', async () => {
  const esm = await import('../src/index.mjs');
  assert.deepEqual(Object.keys(esm).sort(), Object.keys(sdk).sort());
});
test('client and handler communicate over an actual HTTP listener', async t => {
  const f = fixture();
  const server = createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      const response = await f.handler(new Request(`http://127.0.0.1${req.url}`, { method: req.method, headers: req.headers, ...(body.length ? { body } : {}) }));
      res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer()));
    } catch { res.writeHead(500); res.end(); }
  });
  try {
    try {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    } catch (error) {
      if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('Execution environment does not allow local HTTP listeners'); return; }
      throw error;
    }
    const requester = createA423Client({ baseUrl: `http://127.0.0.1:${server.address().port}/api/a423`, headers: { authorization: 'Bearer requester-secret' } });
    const job = await requester.offer(input, { idempotencyKey: 'http-smoke' });
    assert.equal((await requester.getJob(job.id)).state, 'offered');
  } finally { if (server.listening) await new Promise(resolve => server.close(resolve)); }
});
