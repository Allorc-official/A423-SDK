# A423 0.4 operational integration

This guide covers concrete SDK modules and their deployment boundaries. The remote MVP's source was unavailable during this SDK change, so its chat tools, dashboard, environment, reset route and testnet deployment have not been modified. Use the supplied bridge in that repository, then run the actual app's integration tests. Existing contract-level constraints remain explicit.

## Complete application factory

`createEscrowApplication` wires the concrete implementations into one handler and worker configuration. Supply `storage`, `authority`, allowlisted `escrows` (provider/chain/contract/token/confirmations), `signerFor`, `addressFor`, raw-token `limitsFor`, explicit `approveSigning`, and real `validateArtifact`/optional `execute` handlers. It composes active-authority checks, spending reservations, job safety, task validation, consent, fresh receipts, chat projections and maintenance. Independent arbitration is required by default at the application policy level (arbitrator differs from payer, worker and verifier), even though the reference contract permits verifier/arbitrator overlap. `keeperEnabled` is false by default.

```ts
const app = createEscrowApplication({
  storage, authority, escrows: [escrowConfiguration],
  signerFor, addressFor, limitsFor, approveSigning,
  validateArtifact, execute, keeperEnabled: true,
});
export const { applicationOptions, workerOptions } = app;
// Next.js: export const GET = app.handler; export const POST = app.handler;
```

This factory does not invent wallet approvals or output-quality checks. Its callbacks must call your actual trusted signing/execution services. An inactive registry identity cannot authorize workflow/signing operations. The more granular recipes below are available when integrating with an existing app rather than the full factory.

## 1. Durable state and transaction journal

```ts
import { createSqliteStorage } from '@allorc/a423-sdk/storage';
const storage = createSqliteStorage({ filename: '/private/persistent/a423.sqlite' });
// storage.jobs, transactions, queue, spending, kv, close()
```

The driver uses Node's built-in SQLite, WAL, full synchronous commits, busy timeout, restricted database permissions and `BEGIN IMMEDIATE` for compound operations. Multiple processes on the same host/file coordinate CAS and nonce reservations. It is not a distributed database or a serverless filesystem substitute. Keep the entire SQLite/WAL set on local persistent storage with appropriate backups and access controls. Raw signed transactions are protected operational records; do not expose `transactions` through an API.

Workflow changes and projected events are committed atomically. `jobs.list({ actor, after, limit })` and `jobs.events({ actor, after, limit })` enforce participant filtering when an actor is supplied. Calls without actor are administrative worker capabilities; never expose them unauthenticated. Event cursors are global, monotonic and suitable for resumable SSE.

`transactions.reserveNonce` atomically allocates and deduplicates by chain/account/operation. `appendReplacement` preserves original intent and prior hashes under an expected-last-hash check. All writers using a signer account must coordinate through this journal. A reservation with no signed transaction must be resumed to fill the gap; the driver cannot guess whether an external signer has used a nonce.

## 2. Authority and authentication

```ts
import {
  createAuthority, createAuthorityHandler,
  createCredentialAuthenticator, createCredentialProvider,
} from '@allorc/a423-sdk/authority';

const authority = createAuthority({
  issuer: 'your-authority-id', audience: 'your-app-id',
  privateKey: authoritySigningKey, kv: storage.kv,
  credentialTtlSeconds: 3600,
});
const authenticate = createCredentialAuthenticator({ authority });
const authorityHandler = createAuthorityHandler({
  authority,
  allowRequest: enforceYourRateLimitAndOriginPolicy,
});
```

The authority key is externally supplied Ed25519 key material. Store it securely. **Administrative enrollment is not an HTTP bootstrap endpoint.** After external operator approval, call `registerOrganization({id,name,publicKey})`. The organization signs the JSON bytes of `authority.registration({organization,agentId,publicKey,scopes})` with its own Ed25519 private key. Call `registerAgent` with those fields and the base64url `organizationSignature`. The authority checks the organization signature before enrollment. An existing registration cannot be silently overwritten. Use explicit revocation and a reviewed re-enrollment/rotation process.

This registry is your chosen trust system, not legal-company verification, government accreditation or proof that a public organization name is genuine. Keep `@allorc/identity` as public deterministic record formation; its ID can be the registered `agentId`, but possession/authentication comes from a separate key.

The public proof handler only serves:

- `POST /api/a423-auth/challenge` with `{ agent_id }`.
- `POST /api/a423-auth/exchange` with `{ challengeId, signature }`.

Sign the exact UTF-8 `JSON.stringify(challenge)` bytes with the registered agent Ed25519 key and base64url-encode the signature. A challenge is single-use, short-lived, audience-bound and tied to the registered key. The exchange returns `{credential,expires_at}`. Present the credential as `Authorization: Bearer …`. Credentials contain issuer, audience, subject, organization, key fingerprint, scopes, expiry and a unique identifier. Revoked agents/organizations are denied on verification. The handler defaults to denying requests unless `allowRequest` explicitly permits them; supply real rate limiting before exposing it. There is no default secret or demo bootstrap.

Use `createCredentialProvider` to renew with a new proof before expiration:

```ts
const credential = createCredentialProvider({
  agentId,
  challenge: fetchChallengeFromAuthority,
  exchange: exchangeProofAtAuthority,
  signChallenge: async bytes => signUsingAgentKey(bytes), // base64url signature
});
// For SDK HTTP clients: headers: async () => ({Authorization: `Bearer ${await credential()}`})
```

Renewal requires key possession, not just an old bearer token. `pruneChallenges()` removes expired unused challenges. For separate receiver services, `createCredentialVerifier({issuer,audience,publicKey,isActive})` uses only the authority public key and your revocation/status lookup; receivers do not need the authority private key. Wrap it as `{verifyCredential: verifier}` for the credential authenticator. `isActive` must check current organization/agent status, key binding and required scopes; unavailable status should fail closed. An offline token signature by itself does not establish current enrollment.

Keep organization, agent, authority, treasury, verifier and arbitrator key references distinct where your trust policy requires it. The SDK does not choose signer indices or fallback to a first key. Protect the whole authority administration capability, not only its HTTP routes.

## 3. Typed tasks and evidence

`validateTask` checks this reference task structure. Use it in `validateTerms`, together with application-specific criteria and escrow validation:

```ts
const task = {
  id: 'research-1', type: 'research', description: 'Produce the agreed report',
  deliverables: [{id: 'report', media_type: 'text/markdown', description: 'Research report'}],
  acceptance: {validator: 'report-validator', version: '1', criteria: {minWords: 200}},
};
```

Task types and criteria remain extensible JSON. This schema does not prove output quality. `validateArtifact` must fetch the actual immutable output, hash its bytes, compare the submitted digest, and evaluate accepted criteria. Execute only explicitly trusted task handlers; never execute arbitrary code because it appears in task metadata.

`validateEscrowEvidence` requires chain/contract/token, job and agreement commitment, transaction/block hashes, parties, raw amount, worker payout, state and event fields. The reference adapter validates its own evidence. For custom adapters, configure the workflow's `validateEvidence({job,action,evidence})` hook with the appropriate schema. A hook being available does not mean an arbitrary custom provider is verified.

## 4. Mandatory spending and signing authorization

```ts
import { createSpendingAuthorizer } from '@allorc/a423-sdk/operations';
const authorizeTransaction = createSpendingAuthorizer({
  spending: storage.spending,
  limitsFor: async context => approvedLimitsFor(context.actor),
  authorize: async context => checkDelegationAndSafety(context),
});
```

Every reference adapter must now supply `authorizeTransaction`. It runs before any initial token approval/reset/funding signature and again before a rebroadcast. Use `checkDelegationAndSafety` to confirm the actor's current grant, job safety status and expected signer. The atomic spending store enforces explicit `perTransaction`, `daily` and `total` caps as raw-token integer strings, scoped to payer/chain/token. A reservation is shared across the job's approval and funding retries; callbacks cannot override its amount or scope through limits. UTC day changes recheck today's allowance before signing. Concurrent jobs cannot each spend the same remaining allowance.

Reservations are conservative and remain after approvals/unknown outcomes. Do not release them merely because an RPC request failed. `spending.release(id)` is an administrative reconciliation capability; releasing a committed spend would defeat the total cap. Retain committed reservations. Apply equivalent policy to any other app-specific transfer/credit tool outside this adapter.

A false pre-sign decision rejects before signing, allowing the workflow to recover or cancel. A denied rebroadcast preserves the pending operation because the transaction may already exist on-chain. Policy exceptions also preserve pending state for investigation.

`createManagedSigner({address,provider,signDigest,authorize})` implements ethers transaction/message/typed-data signing using an external digest signer. It verifies that returned signatures match the configured address. Connect your actual KMS/HSM/remote signing API in `signDigest`; no vendor credentials are fabricated. `createDelegationAuthorizer` provides concrete transaction grants with expiry, chain IDs, contract addresses, calldata selectors, native-value/gas/fee limits. It denies message and typed-data signing by default; define separate narrowly scoped policies for those operations.

## 5. Keeper, execution queue and recovery

`reconcile` observes only. `resume` explicitly authorizes continuation of the original persisted operation, using its original action/input/idempotency key. This solves the approval-confirmed/funding-not-created recovery case without reconstructing a user's original key.

```ts
await runMaintenanceOnce({
  workflow, store: storage.jobs,
  actorFor: delegatedMaintenanceActor,
  allowExecute: true,
});
```

`actorFor(job)` must return an authorized participant for that action, not an invented system identity. For pending actions it generally returns `job.pending.actor`; timeout/refund can use the agreed requester/worker role. On-chain permissionless timeout does not bypass the workflow's authenticated role policy. When enabled, the keeper resumes pending operations, requests eligible unsubmitted refunds/submitted timeout allocation, and expires unfunded agreements with `terms.expires_at`. Include `createExpiryAdapter()` for the latter. If no expiry is agreed, it is not guessed.

For execution, `enqueueRunningJobs` creates one durable execution item per confirmed start event. `runExecutionOnce` uses a lease/heartbeat and checks workflow safety, running state, task schema and your mandatory `beforeExecute(job)` eligibility callback. Revalidate current chain custody/deadline immediately before doing expensive work. Your `execute({job,idempotencyKey})` performs the actual AI/tool work and returns `{result_hash,…}`. The runner checkpoints the result before submitting, so a submission retry can reuse it without re-running the AI. External effects before checkpoint must still deduplicate the supplied execution key. Leases and CAS do not provide exactly-once external side effects.

Supply the background-worker configuration via `A423_CONFIG_MODULE`; `scripts/operations-worker.mjs` runs monitoring, optional indexing/replacement, maintenance, dispatch, execution, webhooks and challenge pruning on a five-second loop. Its default does not authorize transaction execution: set `workerOptions.allowExecute` explicitly. It stops on SIGINT/SIGTERM. Run it under your own service manager with restart/alerting/health checks. Long work must not depend on a Next.js request staying open.

## 6. Evidence monitoring, indexing and fresh receipts

`createEvidenceRevalidator` checks the configured RPC chain and immutable token, canonical successful receipt and confirmation depth, emitting contract/job/event, all accepted on-chain terms, cached amounts/parties/state/result hash and settlement/dispute fields. It returns valid/invalid/insufficient-confirmations; RPC failures throw rather than being misreported as payment failure. Use the provider corresponding to the job's allowlisted configuration.

`watchEvidenceOnce({store,revalidate})` stores per-job safety results. Invalid or unavailable transaction evidence quarantines the job. The SQLite store's `getSafety` is checked by workflow actions, resume and queued execution; the pre-sign policy should also recheck it to close the interval between monitoring and signing. Read access remains available for investigation. Valid rechecks can clear the hold; orphaned observations are not silently rewritten. Deep reorg recovery requires an explicit authoritative reconstruction of the financial record. Do not roll a paid job back to accepted or erase evidence just to allow a retry.

`createEscrowIndexer` scans confirmed logs in bounded batches from an explicit deployment block using durable cursors. It parses contract events and persists observations; `onEvent` receives a stable key for idempotent projection. On cursor reorg it invokes `onReorg`, marks orphaned indexed observations, rewinds and reindexes. Configure one indexer worker per cursor and make callbacks idempotent. The indexer discovers facts; it does not bypass quote acceptance or automatically authorize a payment. Link observed contract job IDs back to registered workflow jobs before applying any app mutation.

`freshReceipts({workflow,id,actor,revalidate})` refuses stale/unavailable evidence. `renderReceiptPdf(freshReceipt)` renders that structured snapshot; it is a plain evidence document, not a legal attestation or automatically signed certificate. The application handler composes both, so JSON and PDF endpoints perform fresh checks. Formatting raw-token amounts into human display units remains a token-metadata concern. A renderer called directly on arbitrary JSON cannot make those claims true.

## 7. Chat, dashboard, wallet consent and notifications

`createChatTools` supplies `send_job_offer`, `propose_quote`, `accept_quote`, `fund_escrow`, `work_on_job`, `submit_job`, `verify_job`, `release_escrow`, `refund_escrow`, `dispute_job`, `resolve_job`, `timeout_job`, `cancel_job`. Instantiate tools with the authenticated actor from your chat session. Replace legacy service calls behind your app's `A423_CHAT_MODE` flag. Do not choose actor IDs from tool arguments.

`createApplicationHandler` combines the workflow routes and authenticated app projections. Its `/api/state` merges optional legacy state with `a423.jobs` and chain-evidence-based `a423.wallet_transactions`. It exposes arbitrator and settled/disputed/pending states. Fresh receipt routes use `/api/a423-receipts/:id[.pdf]`; wallet consent uses `/api/a423-worker-consent/:id` and returns **typed data only**, restricted to the assigned worker. The SDK never signs worker consent on the server via this route. An EIP-1193 wallet can sign it; supply the public signature to the payer to fund. ERC-1271 wallets may use a custom signature format and account transaction path; the EOA dashboard button is not a universal smart-account UI.

Mount the combined handler on the routes your Next.js app owns (for example `app/api/[...path]/route.ts`) or delegate existing `/api/state`/receipt/chat endpoints explicitly. Do not shadow unrelated APIs. Use `runtime = 'nodejs'`. All state projections remain actor scoped. Configure your CSRF/CORS/origin policies when adding cookie authentication; the SDK does not silently configure your deployment perimeter.

The localhost shell `examples/operations-server.mjs` with `operations-dashboard.html` displays workflows, parties, agreement, submission, evidence, pending actions, and fresh receipts. It includes quote/accept/fund/start/submit/verify/release/refund/dispute/resolve/timeout/cancel/expire controls, editable JSON input, persistent retry key, and a worker-wallet consent button. It holds bearer credentials only in page memory, uses DOM text rather than interpolating untrusted HTML, and does not provision identities or keys. It is a reference shell, not a claim that the remote MVP dashboard was edited.

`createEventStream` supports authenticated participant-scoped SSE and Last-Event-ID; streams close periodically and reconnect using the cursor. `createWebhookDispatcher` projects durable events to an outbox, signs payloads using HMAC-SHA256 over `timestamp + '.' + exactBody`, and supplies stable delivery IDs. Configure explicit HTTPS endpoints and per-subscription secrets (at least 32 characters), verify timestamps/signatures on receivers, and deduplicate IDs. Redirects are disabled. Destination ownership, DNS/egress restrictions, TLS and quotas remain operator responsibilities. Delivery is at least once with bounded exponential backoff and a failed queue state after exhausted attempts; project and deliver workers must run continuously.

## 8. Multi-deployment routing and bounded fee replacement

`createEscrowRegistry([configuration,…])` selects allowlisted adapters by chain/contract. Each entry binds an immutable token and its own provider/confirmation policy. Unknown destinations fail closed. This supports multiple standard-token deployments without pretending one reference contract supports every asset or chain.

`replacePendingTransaction` checks that no attempt is mined, raises both EIP-1559 fee fields at least 25%, preserves chain/nonce/to/data/value/gas limit, checks the signer and explicit authorization, and atomically appends the signed replacement **before broadcasting**. `createFeeReplacementWorker` can prepare these replacements automatically under explicit age, fee and attempt caps. The original workflow resume path then broadcasts the latest lineage while checking for any already-mined attempt. Replacement policy and any managed-signer delegation both apply. Legacy gas-price transactions, cancellation and intent changes are not supported. This is bounded automation, not a guarantee against censorship or an exhausted payer balance.

## 9. Local reset, migration and deployment

`resetDevelopmentData` is dry-run by default. It requires local chain ID 1337/31337, literal `RESET_LOCAL_A423`, and an application callback confirming the local chain was reset. It never runs automatically on application startup and is not exposed as an unauthenticated HTTP route. Explicitly choose `includeAuthority` when resetting the governor registry; otherwise it survives. Never reset nonce journals independently of the chain/account state.

`planLegacyMigration` reports limitations. `migrateUnfundedLegacy` requires an explicit mapping, a new job ID and an unfunded source state. It creates a new draft with source-hash provenance and never carries old acceptances. Existing funded/terminal jobs stay on their original contracts and receipts. There is no safe generic SQL operation that turns old on-chain custody into a new contract's custody. Move funds only through the original agreed release/refund process, then negotiate a new job if appropriate.

The contract deploy script is a dry-run unless `--broadcast` is explicitly supplied:

```sh
A423_CHAIN_ID=31337 A423_TOKEN_ADDRESS=0x... A423_RPC_URL=http://127.0.0.1:8545 \
  node scripts/deploy-escrow.mjs
# Deployment additionally needs A423_DEPLOYER_KEY and explicit --broadcast.
# --verify submits complete compiler input to Sourcify after deployment.
```

The script checks the RPC chain/token, saves deployment metadata before source verification, and distinguishes submitted verification from completed verification. Public Sourcify does not normally index your private local chain. Verify local deployments by recompilation and the local EVM tests; verify supported testnets with the external service and check its returned ticket separately. No live testnet deployment, source-verification completion or audit is inferred from this script existing.

## 10. Remaining boundaries

No independently completed security audit is claimed. KMS/HSM provisioning, organization/legal vetting, public testnet deployment and verification completion require real external access and operational decisions. The absent remote app's legacy chat/dashboard/seed/reset/environment must be wired in its own repository. Partial releases/milestones, resubmission, fee/rebasing token support, admin recovery/pause/upgrades, guaranteed challenge windows, and an objective quality oracle remain reference-contract constraints. These are not silently added by operational hooks.
