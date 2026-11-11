# A423 SDK — 0.4.0

Experimental Node.js/Next.js middleware for agent tasks, agreements and escrow. Version 0.4 adds working persistence, authority credentials and operational services around the configurable workflow and reference contract. Installing the SDK never publishes endpoints or deploys a contract automatically.

```sh
npm install @allorc/a423-sdk@0.4.0 ethers@^6.15.0 pdf-lib@^1.17.1
```

Node.js 22.13+ is required for the SQLite module. Node 24 is the tested runtime. `ethers` is optional unless you import `/escrow`; `pdf-lib` is optional unless you render PDFs. Core/workflow remain framework-independent.

## Modules

| Import | Implemented behaviour |
|---|---|
| `/workflow` | Versioned terms, bilateral acceptance, role guards, CAS state/events, pending operations, explicit observe/resume and safety holds |
| `/escrow` | Reference ERC-20 contract, full custody lifecycle, EOA/ERC-1271 worker consent, strict chain evidence, managed signing/delegation, allowlisted deployment registry, bounded fee replacements and incremental log indexing |
| `/storage` | Single-host SQLite workflow store, transaction/replacement journal, atomic nonce reservations, leased queue/checkpoints, spending reservations and authority/event storage |
| `/authority` | Operator-approved organization registry, organization-signed agent enrollment, single-use challenges, signed audience-bound bearer credentials, revocation, public-key verification and renewal |
| `/operations` | Typed task/evidence validation, spending authorizer, maintenance/keeper ticks, durable execution dispatcher, fresh receipts/PDF, reorg quarantine, SSE, webhook outbox, safe migration planning and app/chat integration handler |
| Root | Preserved original simple offer/accept/submit/approve API; [legacy documentation](./LEGACY.md) |

## Start with the actual lifecycle

Create a draft → propose immutable terms → both parties accept the exact revision/hash → worker signs consent → payer authorizes funding → contract holds tokens → worker passes fresh eligibility gate → deliver/commit artifact → verify → release. Expired unsubmitted jobs can refund; submitted disagreements can dispute/resolve; the agreed timeout allocation remains available if trusted roles disappear.

**Acceptance, token approval and confirmed custody are different states.** Only matching confirmed chain evidence establishes that money is locked. Neither a public identity hash nor a caller-supplied agent ID authenticates the caller.

Read [ESCROW.md](./ESCROW.md) for exact fields, inputs, roles and contract limits. Read [OPERATIONS.md](./OPERATIONS.md) for configuration, authority enrollment, storage, worker scheduling, spending limits, fresh receipts, monitoring, UI/chat wiring and migration.

## Minimal server setup

```ts
import { createSqliteStorage } from '@allorc/a423-sdk/storage';
import { createWorkflow } from '@allorc/a423-sdk/workflow';
import { createEscrowAdapters, escrowTransitions } from '@allorc/a423-sdk/escrow';
import { createSpendingAuthorizer, createApplicationHandler } from '@allorc/a423-sdk/operations';

const storage = createSqliteStorage({ filename: '/your-protected-local-disk/a423.sqlite' });
const authorizeTransaction = createSpendingAuthorizer({
  spending: storage.spending,
  limitsFor: loadApprovedRawTokenLimits,
  authorize: checkSignerDelegationAndJobSafety,
});
const adapters = createEscrowAdapters({
  provider, chainId, contractAddress, tokenAddress, confirmations,
  transactions: storage.transactions, signerFor, addressFor,
  authorizeTransaction, validateArtifact,
});
const workflow = createWorkflow({
  store: storage.jobs, adapters, transitions: escrowTransitions,
  validateTerms, authorize: authorizeWorkflowAction,
});
const handler = createApplicationHandler({
  workflow, store: storage.jobs, queue: storage.queue,
  authenticate, revalidate, consentFor,
});
// Import this configured handler in the appropriate Next.js catch-all route:
export const runtime = 'nodejs';
export { handler as GET, handler as POST };
```

Names such as `loadApprovedRawTokenLimits`, `provider`, `signerFor`, `validateArtifact`, `authenticate`, `revalidate` and `consentFor` are application services, not invented SDK exports. Complete recipes and actual exports are in OPERATIONS.md and TypeScript declarations. SQLite files must live on persistent local disk; use a different store for serverless/multi-host deployment.

## Integration surfaces

`createApplicationHandler` serves authenticated workflow routes under `/api/a423`, projections under `/api/state`, resumable events at `/api/a423-events`, wallet typed-data at `/api/a423-worker-consent/:id`, and freshly revalidated JSON/PDF at `/api/a423-receipts/:id[.pdf]`. An optional `legacyState(actor)` callback preserves legacy dashboard data alongside `a423.jobs` and `a423.wallet_transactions`.

`createChatTools` maps offer, quote, accept, fund, start, submit, verify, release, refund, dispute, resolve and timeout tools to the same workflow records. Work is dispatched through the durable queue; it is never marked submitted because an AI run was merely scheduled. The HTML application shell includes wallet consent, action controls, states, parties, evidence and receipts.

Run the supplied shell and operational worker with an explicitly configured application module:

```sh
A423_CONFIG_MODULE=/absolute/path/config.mjs node examples/operations-server.mjs
A423_CONFIG_MODULE=/absolute/path/config.mjs node scripts/operations-worker.mjs
```

The shell binds to localhost. There is no bootstrap endpoint, default credential, built-in private key or automatically provisioned arbiter. Supply distinct signer references for treasury, worker, verifier and arbitrator according to your policy.

## Upgrade from 0.3

- `authorizeTransaction` is now mandatory for escrow adapters. Explicitly configure spending/delegation checks; a blanket `true` is appropriate only for controlled tests.
- The transaction-store interface adds `list` and atomic `appendReplacement`. The supplied SQLite and memory implementations include them.
- Use a new deployment for ERC-1271 support. Existing 0.3 contracts/locked jobs stay on their original ABI/contract; an npm upgrade does not upgrade a deployed contract.
- `workflow.resume(id, actor)` explicitly authorizes the next pending step. `reconcile` remains observe-only. `runMaintenanceOnce` only resumes when `allowExecute: true`.
- Reference evidence now includes settlement reason/dispute commitment. Existing incomplete evidence needs explicit refresh/migration; do not fabricate fields or relabel old financial states.
- `getSafety`/`setSafety` enable quarantine. Monitor evidence continuously and require fresh eligibility immediately before executing real work.

## Boundaries

This remains experimental and independently unaudited. Verifiers/arbitrators remain trusted; there is no objective quality oracle or guaranteed challenge window. The reference contract retains one token, one immutable submission and one settlement per job. It does not add partial milestone releases, resubmission, admin withdrawals, pause/upgrades or fee-on-transfer/rebasing support. Separate deployments are selected through the registry. A timeout needs a transaction and a functioning chain/token.

KMS/HSM providers are integrated through a checked digest signer; the package does not provision vendor accounts or certify hardware. Authority approval establishes trust within your configured registry, not government recognition or automatic legal-company verification. AI execution uses your explicitly supplied handler, never an implicit model subscription. Reorg handling quarantines invalid observations; it does not silently rewrite accepted agreements or erase paid history. Fee replacement uses explicit caps and the same intent/nonce; it cannot force a censored transaction to execute.

## Validation and release

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
npm pack --dry-run --ignore-scripts
```

Tests compile and deploy the contract on a local EVM, exercise payment/refund/dispute/timeout, check consent and permissions, and cover credential-protected HTTP → durable SQLite → escrow → fresh PDF evidence. Tests also cover storage leases, spend caps, renewal/revocation, queue dispatch, SSE/webhooks, fee replacement and migration restrictions. External testnet deployment, source-verification completion and an independent audit are separate operations; no result is inferred from a hook or submitted verification ticket.
