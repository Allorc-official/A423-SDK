# Configurable workflows in 0.2.0

The new `@allorc/a423-sdk/workflow` entry point provides middleware for agent job lifecycles. It supports different task types and payment systems through application-supplied policies and adapters. It does not assume a particular blockchain, token, wallet, artifact format, database or AI framework. This is experimental software with a reference lifecycle; it does not promise every possible business workflow.

The original root exports remain compatible. Choose the workflow entry point for the full lifecycle; do not mix its records with the original root API. See [integration and migration instructions](./INTEGRATION.md).

```ts
import { createWorkflow, createWorkflowHandler } from '@allorc/a423-sdk/workflow';

const workflow = createWorkflow({
  store: durableWorkflowStore,
  adapters: applicationAdapters,
  validateTerms: validateYourTerms,
  authorize: checkYourPolicy,
});
const handler = createWorkflowHandler({ workflow, authenticate: authenticateRequest });
// app/api/a423/[...path]/route.ts
export const runtime = 'nodejs';
export { handler as GET, handler as POST };
```

The names `durableWorkflowStore`, `applicationAdapters`, `validateYourTerms`, `checkYourPolicy` and `authenticateRequest` are application implementations, not SDK exports. Configure them once in a server module and import the handler into your route.

## Workflow coverage

| Action | From | Default role | Result | Required adapter |
|---|---|---|---|---|
| create | — | requester | draft | none |
| quote | draft / quoted / accepted | requester or worker | quoted, acceptances reset | none |
| accept | quoted | requester and worker separately | accepted after both | none |
| fund | accepted | requester | funded | fund |
| start | funded | worker | running | start (funding/work gate) |
| submit | running | worker | submitted | submit |
| verify | submitted | verifier | verified | verify |
| release | verified | verifier | paid | release |
| refund | funded / running | requester | refunded | refund |
| cancel | draft / quoted / accepted | requester | cancelled | none |
| expire | draft / quoted / accepted | requester or worker | expired | expire |
| dispute | submitted / verified | any of the three parties | disputed | none |
| resolve | disputed | verifier | resolved | resolve |

`resolved` records a completed resolution process; it does not mean paid or refunded. The resolution adapter must record its actual outcome in evidence. Refund eligibility, quote expiry, deadlines, spending limits, asset rules and verification semantics belong in application policies/adapters. There is no automatic timer. A scheduler calls the API using an authenticated participant or an explicitly configured scheduler role.

### Terms and acceptance

Use JSON terms for your domain: task specification, price, asset, raw amount, deadline, wallet addresses, verifier policy and artifact expectations. Put every term you want committed into this object, including parties and settlement configuration where relevant. The SDK does not invent or validate those domain fields; `validateTerms` should throw on invalid terms. Use decimal strings for raw token amounts, not floating point or JSON bigint.

The SDK hashes sorted-key canonical JSON with SHA-256 (array order preserved, no whitespace). Hash inputs must be plain JSON; avoid cyclic structures and sparse arrays. This is the SDK's own format, not a claim of RFC 8785 compatibility. Names and IDs are case-sensitive. A quote stores revision, terms, hash and acceptances. Accept requires both `agreement_hash` and `revision`; editing a quote clears acceptance. Terms cannot be revised after funding begins under the default rules. Hashes establish integrity, not caller identity or legal consent.

### Adapter contract and recovery

Each effect adapter is either an async function or `{ execute, reconcile }`. It receives `{ job, input, operation }` and returns:

```js
{ status: 'pending', reference: 'provider-operation-reference' }
{ status: 'confirmed', evidence: { /* domain-specific verified observations */ } }
{ status: 'rejected', reason: 'definitive rejection' }
```

Confirmed results require an evidence object. The SDK trusts the adapter's verdict; it cannot independently establish payment, artifact quality or chain finality. An arbitrary reference is not payment proof. Chain adapters should compare configured chain/contract, job ID, amount, token, participants, deadline and commitments against the accepted terms, plus relevant successful transaction events and the chosen finality policy. `start` must recheck eligibility before work is dispatched.

The SDK atomically stores a pending operation before invoking an effect. Its `operation.id` is stable across retries: use it as the provider idempotency key. **Adapters must durably deduplicate effects, including concurrent calls.** Compare-and-set does not make an external payment exactly-once. If execution throws or returns an invalid result, pending remains; inspect/reconcile it. A pending result retains its observation. A rejected result clears pending without advancing state; repeat the same action key returns the stored job, so use a new key only after a definitive rejection and a deliberate new attempt.

`reconcile(id, actor)` calls only the pending adapter's `reconcile`, never its execute method. That implementation should inspect known provider operations, not blindly repeat a transaction. Supply reconciliation for every external effect. Reuse the same adapter configuration and transitions across restarts. Reconciliation can record additional pending observations. No other action runs while an operation remains pending. If a final database save fails, recovery relies on the same persisted operation and provider key.

The SDK does not run agents or background queues. Persist intent and schedule work in adapters; use a durable worker to submit actual output. Do not mark work submitted merely because a worker was queued. Custom transitions can add milestones, rejection/revision loops, manual review, nonpayment completion, or alternative arbitration. Override whole rules with `{ from, roles, to, effect }`; applications assume responsibility for the resulting invariants. Effect adapters must be trusted server code.

### Storage, permissions and receipts

A workflow store implements `get`, atomic insert-if-absent `create`, and atomic version-checked `compareAndSet`. Persist the entire record (state, pending operation, evidence, events, idempotency history) atomically. Use a separate table/namespace from legacy records. The root `createMemoryStore()` also works structurally at runtime for development, but is not durable or suitable for distributed deployment; a typed workflow store should implement the interface from the workflow entry point.

The handler requires authentication. It obtains actor identity from your callback, never from action bodies. Default role checks always run; `authorize` adds application policy and must return exactly true. Creation requires requester authentication, and requester must differ from worker. The verifier may be the requester or a separate participant. Authentication, wallet/key custody, identity-to-wallet binding and proof of ownership remain application responsibilities. `@allorc/identity` only derives public identifiers.

Receipts are JSON snapshots of agreement, submission, stored adapter evidence, events and pending state. They are not freshly queried chain proofs or signed attestations. Render PDFs separately, and revalidate provider evidence if fresh verification is required. Protect credentials and never put secrets in terms, evidence, metadata or events: all participants can read these fields. Records/events grow over time; production storage should enforce application quotas. The HTTP client limits responses to 1 MiB.

### HTTP and client

| Method | Path beneath `/api/a423` | Body |
|---|---|---|
| POST | `/jobs` | `{ id, participants, metadata? }` |
| GET | `/jobs/:id` | — |
| POST | `/jobs/:id/actions` | `{ action, input }` plus `Idempotency-Key` |
| POST | `/jobs/:id/reconcile` | `{}` |
| GET | `/jobs/:id/receipts` | — |

The handler uses standard Web Request/Response, bounded streaming JSON (64 KiB default), explicit errors, and no background HTTP work. IDs and idempotency keys use 1–128 ASCII letters/digits/underscores/hyphens. Create with a stable application-assigned ID; duplicate creation returns conflict, then retrieve and compare the existing record. Every action needs an actor-scoped key; reusing it with different input fails. Transient conflicts should reload and retry using the same key. Authentication callbacks must inspect headers/cookies or a cloned request if they need the body.

```ts
import { createWorkflowClient } from '@allorc/a423-sdk/workflow';
const client = createWorkflowClient({
  baseUrl: 'https://your-app.example/api/a423',
  headers: () => ({ Authorization: `Bearer ${serverCredential}` }),
});
const quote = await client.act(jobId, 'quote', { terms }, { idempotencyKey: 'quote_1' });
await client.act(jobId, 'accept', {
  agreement_hash: quote.agreement!.hash,
  revision: quote.agreement!.revision,
}, { idempotencyKey: 'accept_1' });
```

Each participant needs its own credentials. The client does not automatically retry. Default timeout is 30 seconds; adapters should return pending quickly for long operations. Use TLS and appropriate CSRF protection for cookie-authenticated mutations.

## Original 0.1 API documentation

# @allorc/a423-sdk

One experimental package for exposing an agent job API from a Next.js App Router application. Configure a handler, export it from a catch-all route, and use the typed client to offer, accept, submit and approve work.

**Status:** local experimental v0.1.0. The npm package has not been published by this checkout. Source repository: https://github.com/Allorc-official/A423-SDK. This implements an initial workflow, not a finalized A423 standard or a production escrow system. Node.js 22+. ESM, CommonJS and TypeScript declarations; zero runtime dependencies.

## Quick setup in Next.js

Until publication, install the local package into your existing Next.js application:

```sh
npm install /absolute/path/to/servers/server/a423_sdk
```

After publication: `npm install @allorc/a423-sdk`.

Create `lib/a423.ts`:

```ts
import 'server-only';
import { createA423Handler, createMemoryStore } from '@allorc/a423-sdk';

// Development only. Replace with a durable StateStore before deployment.
const store = createMemoryStore();
const token = process.env.A423_API_TOKEN;
const actorId = process.env.A423_AGENT_ID;
if (!token || !actorId) throw new Error('Configure A423_API_TOKEN and A423_AGENT_ID');

export const a423 = createA423Handler({
  store,
  authenticate(request) {
    return request.headers.get('authorization') === `Bearer ${token}`
      ? actorId
      : null;
  }
});
```

This minimal authentication example maps one secret credential to one public actor ID. A complete workflow requires separate requester and worker credentials. The two-actor example is in `examples/nextjs/lib/a423.ts`; replace it with your own authenticated identity integration when connecting real agents.

Create `app/api/a423/[...path]/route.ts`:

```ts
import { a423 } from '@/lib/a423';

export const runtime = 'nodejs';
export const GET = a423;
export const POST = a423;
```

The `@/` import assumes your application's usual root alias; adjust it if your app uses `src/` or relative imports. This is one catch-all route, not one file per action. Do not run it in the Edge runtime. The SDK does not start a listener or publish routes on its own: Next.js exposes the route you configure.

Keep credentials in server environment variables without `NEXT_PUBLIC_`. The package's client is designed for Node/server use, not for embedding worker credentials in client-side React. Your existing Next.js application supplies Next.js, React, TypeScript and `server-only`; the SDK itself does not import framework internals.

## Use the typed client

```ts
import { createA423Client } from '@allorc/a423-sdk';

const requester = createA423Client({
  baseUrl: 'https://your-app.example/api/a423',
  headers: { authorization: `Bearer ${requesterToken}` }
});
const worker = createA423Client({
  baseUrl: 'https://your-app.example/api/a423',
  headers: { authorization: `Bearer ${workerToken}` }
});

const job = await requester.offer({
  worker_id: workerAgentId,
  title: 'Prepare a short brief',
  description: 'Research the topic and return a deliverable link.',
  price: { amount_minor: 500, currency: 'USD' }
}, { idempotencyKey: 'brief-request-001' });

await worker.accept(job.id);
await worker.submit(job.id, { deliverable: 'https://example.com/brief.md' });
await requester.approve(job.id);
const receipts = await requester.receipts(job.id);
```

`requesterToken`, `workerToken` and `workerAgentId` come from your application, not the SDK. The requester and worker are distinct authenticated actors. The example orchestrates both sides for demonstration; in a real integration they normally run independently.

The price is an agreed term: 500 USD minor units means $5.00 when your adapter uses USD cents. Currency codes are uppercase strings of 3–12 letters/digits starting with a letter. The SDK does not calculate exchange rates, currency precision, fees or blockchain token decimals; define those semantics in your settlement integration. `amount_minor` must be a nonnegative safe integer. Zero-price jobs are allowed.

A deliverable is an opaque string, such as a URL, repository reference or storage path. The SDK stores it and never downloads or executes it. It does not perform the work, evaluate quality or run an agent automatically.

Client methods return `Job`, except `receipts`, which returns `Receipts`. `headers` may be an async function for fresh credentials. `fetch` can be injected for tests or custom networking. Requests default to a 30-second timeout, refuse redirects and do not retry automatically.

## HTTP API

Every request requires successful `authenticate(request)`. POSTs use `Content-Type: application/json`.

| Method | Route | Body | Who can call |
| --- | --- | --- | --- |
| POST | `/api/a423/offers` | `{worker_id,title,description,price}` and `Idempotency-Key` header | Authenticated requester |
| GET | `/api/a423/jobs/:id` | None | Requester or assigned worker |
| POST | `/api/a423/jobs/:id/accept` | `{}` | Assigned worker |
| POST | `/api/a423/jobs/:id/submit` | `{deliverable}` | Assigned worker |
| POST | `/api/a423/jobs/:id/approve` | `{}` | Requester |
| GET | `/api/a423/jobs/:id/receipts` | None | Requester or assigned worker |

Offer creation returns HTTP 201 with `{job}`; an identical retry returns 200 with the existing job. Other actions return `{job}`. Receipts return `{job_id,state,settlement,events}`. Responses use `Cache-Control: no-store`. Unknown jobs and jobs belonging to other actors both return 404.

External agents can use plain HTTP without installing the SDK. For example:

```sh
curl https://your-app.example/api/a423/offers \
  -H "Authorization: Bearer $A423_REQUESTER_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: brief-request-001' \
  -d '{"worker_id":"worker-agent-id","title":"Brief","description":"Prepare a short brief","price":{"amount_minor":500,"currency":"USD"}}'
```

Adjust `basePath` if you mount at a different URL. This initial implementation has no list/search, cancellation, disputes, amendments, webhooks, discovery endpoint, background scheduler or UI. Poll known job IDs or coordinate workers through your own queue. Authentication is mandatory; signatures and message-level cryptographic verification are not built in.

## Workflow and retry behaviour

A job follows `offered → accepted → submitted → completed`. With a settlement adapter it follows `submitted → settlement_pending → completed` during approval.

The server checks the actor and current state before each change. Every successful change increments the job version and appends an event. Submission is immutable: retrying with the same deliverable succeeds, but replacing it is rejected. Repeating acceptance after acceptance or approval after completion returns the current job without adding a duplicate event.

Offer IDs are deterministic SHA-256 values scoped by protocol version, authenticated requester ID and `Idempotency-Key`. Reuse the same key and exact logical offer when retrying after a network failure. Reusing it with different offer details returns 409. Store the key on your side; a freshly generated key means a new offer. Keys are visible ASCII without spaces, at most 200 characters, and should not contain secrets.

Storage changes use compare-and-set. Concurrent writes can return 409 `CONFLICT`; reload the job and retry the intended action. The SDK does not keep an HTTP request open for the duration of a task. Worker execution and scheduling belong in your application's background jobs.

## Storage adapter

`store` is required. `createMemoryStore()` is only for local development/tests: it loses data on restart and is not shared across serverless instances or processes. There is no silent in-memory default.

Implement the `StateStore` interface against your database:

```ts
interface StateStore {
  get(id: string): Promise<Job | null>;
  create(job: Job): Promise<boolean>;
  compareAndSet(id: string, expectedVersion: number, job: Job): Promise<boolean>;
}
```

`create` must atomically insert only if the ID is absent; enforce a unique ID constraint. `compareAndSet` must atomically update only when both ID and version match, then report whether one row changed. Store job fields and events in the same transaction. A read followed by an unconditional update is not sufficient. Return independent snapshots so caller mutations do not change stored state.

For example, a relational adapter can use an ID primary key, a version column and a JSON document. Create with insert-on-conflict-do-nothing; update using `WHERE id = ? AND version = ?`. This is a contract, not a shipped SQL adapter. Durable storage must also support pending settlement recovery.

## Identity and authentication

`authenticate(request)` is the integration point for your identity system. It returns an authenticated actor's public agent ID or `null` to reject. It may verify a bearer credential, a session, or an externally signed request. The returned ID determines permissions; an untrusted ID in a request body/header does not.

`@allorc/identity` 0.3.0 can form a public agent ID:

```ts
import { VERSION, createIdentity } from '@allorc/identity';

const identity = createIdentity({
  version: VERSION,
  organization_public_key: 'externally-supplied-public-value',
  agent_reference: 'worker-42',
  agent_name: 'Alice',
  agent_email: 'alice@example.com'
});
// Register identity.agent_id with your credential/authority system separately.
```

Install that optional package separately when needed. A hash match proves record consistency, not ownership or authentication. This SDK does not claim to verify the organisation behind a public key, and does not depend on the identity package to authenticate actors. Changes to that package's public ingredients change its derived agent ID; your identity integration must manage those updates.

For cookie-based authentication, your integration must also enforce its CSRF/origin policy. The SDK does not configure sessions, CORS, network access, rate limits or tenant onboarding for you. The supplied example uses server-issued bearer tokens with fixed actor bindings.

## Optional settlement adapter

Without an adapter, approval marks the job completed with:

```json
{"status":"not_configured","reference":null}
```

**This records task approval and moves no money.** A configured adapter is called only after requester approval and after the job is persisted as `settlement_pending`:

```ts
const handler = createA423Handler({
  store,
  authenticate,
  settlement: {
    async settle({ job, idempotencyKey }) {
      // Invoke your own escrow/payment service with this stable key.
      // Persistently deduplicate that key, including concurrent invocations.
      const result = await yourSettlementService.release({
        jobId: job.id,
        requesterId: job.requester_id,
        workerId: job.worker_id,
        price: job.price,
        idempotencyKey
      });
      return { reference: result.receiptId };
    }
  }
});
```

`yourSettlementService` is your external integration, not an included export. The SDK passes `a423:settle:<job-id>` as a stable provider idempotency key. Your adapter MUST durably deduplicate it and return the same result on retries, including simultaneous calls from multiple server instances. The SDK cannot guarantee exactly-once movement of funds across an external provider and a database transaction.

On a provider error the server returns 502 and leaves the job pending; retry `approve` as the requester. If the provider succeeds but the database write fails, retrying approval uses the same key. If you run a recovery worker, route it through equivalent actor and idempotency rules. No automatic retry queue is included.

This is not funded escrow: the SDK does not reserve funds at offer/acceptance, validate wallets, sign financial authorisations, collect mandates or guarantee payment. Your adapter must enforce those rules before moving funds. `settled` records the adapter's reported success, not an independently verified blockchain confirmation.

## Errors and limits

Errors are `{error:{code,message}}`. The client throws `A423Error` with `code` and `status` for HTTP failures. Network/timeout errors propagate from fetch. Internal exception details stay server-side; optional `onError(error)` lets your application record them.

| HTTP status | Typical code |
| --- | --- |
| 400 | `INVALID_INPUT`, `INVALID_JSON` |
| 401 | `UNAUTHENTICATED` |
| 403 | `FORBIDDEN` |
| 404 | `NOT_FOUND` |
| 405 | `METHOD_NOT_ALLOWED` |
| 409 | `INVALID_STATE`, `CONFLICT`, `IDEMPOTENCY_CONFLICT` |
| 413 | `BODY_TOO_LARGE` |
| 415 | `UNSUPPORTED_MEDIA_TYPE` |
| 500 | `INTERNAL_ERROR` |
| 502 | `SETTLEMENT_UNAVAILABLE` |

Request bodies default to 64 KiB and are limited while streaming, even without `Content-Length`; `maxBodyBytes` can set 1 byte through 1 MiB. Description limit: 16,000 characters; deliverable: 8,000; actor IDs and titles: 256. Client response bodies are limited to 1 MiB. Bound requests at your ingress too. There is no multipart/file upload or arbitrary server-side URL fetching.

## Package exports

| Export | Purpose |
| --- | --- |
| `createA423Handler(options)` | Standard Web Request/Response handler usable in Next.js routes |
| `createA423Client(options)` | Typed HTTP client |
| `createMemoryStore()` | Explicit local development store |
| `A423Error` | Structured client/protocol error |
| `PROTOCOL_VERSION` | `a423.experimental.v1` |

ESM and CommonJS expose the same names. Interfaces for `Job`, `StateStore`, `SettlementAdapter` and configuration are in `src/index.d.ts`. The handler is framework-independent at runtime, but the included integration targets Next.js App Router. Installing this SDK does not publish an API or establish protocol compatibility with other A423 implementations.

## Development

```sh
npm test
npm run pack:check
```

Tests exercise the complete workflow through actual Web Request/Response objects, permissions, malformed input, streaming limits, concurrent updates, retry semantics and settlement recovery. An additional socket-based test runs where local listeners are permitted, and explicitly skips when the execution environment blocks them. Next.js example files are templates for an existing application; they are not a standalone generated Next.js app.

No runtime dependencies or build step. Before a public release, review the package allowlist, configure the repository/private security reporting channel, and verify a real Next.js deployment and durable adapter. Publication is a separate maintainer action; this package has not been published by creating these files.
