# Cancellation subflow — 0.6.0

[Start here: installation, arguments and lifecycle maps](./README.md) · [All examples](./examples/README.md)

A job has one parent lifecycle and an optional cancellation subflow. Cancellation can negotiate compensation for completed work and agreed expenses, then close the job. It does not permit continuing work after a partial release.

The flow is:

1. Publish `propose_settlement`, or alternate `counter_settlement`, with the worker's proposed amount, reason, claims, original deadline and expected revision. The payer receives the remainder. Funds remain in the escrow contract, never the worker's wallet. Work pauses.
2. Both parties review the exact current proposal and sign the `ClosingSettlement` typed data returned by `settlementConsent`. Signature authorization is bound to chain, contract, agreement, job, revision, amounts, proposal hash and expiry.
3. Accept using `workflow.acceptCancellation`. The adapter verifies both EOA/ERC-1271 signatures and current on-chain terms/proposal. The workflow atomically saves an immutable JSON instruction and marks the child flow `accepted` before any closing transaction is signed or broadcast. The instruction says `funds_status: "not_executed"`.
4. Forward the saved instruction. The adapter validates the JSON against the job, encodes `settleByConsent`, applies the signing/broadcast policy and journals the transaction. The contract verifies signatures and distributes the exact split atomically. It does not parse or trust JSON.
5. After the configured confirmations and matching settlement evidence, save the final cancellation receipt. It records actual worker/payer allocations, zero remaining locked amount, transaction/block evidence and the accepted instruction ID.

An acceptance record is an authorization receipt, not proof of payment. Pending, rejected, expired or unavailable execution must not display a completed payment receipt.

## Server API

```js
const proposed = await workflow.act(id, 'propose_settlement', {
  worker_amount: '30', // raw token units; payer gets total minus 30
  expected_revision: 0,
  expires_at: proposalExpiry, // no later than original resolution deadline
  reason: 'Research completed; remaining work cancelled',
  claims: [{ kind: 'work', description: 'Checked source list', evidence: ['artifact:sources'] }]
}, { actor: workerId, idempotencyKey: 'cancel-proposal-1' });

const job = await workflow.acceptCancellation(id, {
  expected_revision: proposed.negotiation.current.escrow_version,
  proposal_hash: proposed.negotiation.current.proposal_hash,
  payer_signature: payerSignature,
  worker_signature: workerSignature
}, { actor: payerId, idempotencyKey: 'cancel-accept-1' });
```

The default forwards immediately AFTER saving acceptance. To separate acceptance and execution, pass `forward: false`, then:

```js
const instruction = await workflow.cancellationInstruction(id, payerId);
await workflow.act(id, 'execute_cancellation', {
  instruction_id: instruction.id
}, { actor: payerId, idempotencyKey: 'cancel-execute-1' });
```

`createEscrowApplication({forwardCancellations:false,...})` stages HTTP acceptance. An explicitly enabled keeper (`allowExecute:true` / factory `keeperEnabled:true`) forwards accepted instructions. Observe-only reconciliation never creates a new payment transaction.

| Route, relative to `/api/a423/jobs/:id` | Meaning |
|---|---|
| `GET /subflows` | Child records and active child ID |
| `GET /cancellation` | Cancellation child or null |
| `POST /cancellation/accept` | Body: revision/hash and both signatures; save then optionally forward |
| `POST /cancellation/execute` | Body: `instruction_id`, optionally external `transaction_hash` |
| `GET /cancellation/instruction` | Accepted instruction; unavailable until acceptance |
| `GET /cancellation/receipt` | Final receipt; HTTP 409 before confirmation |

POST requests require the usual credential and `idempotency-key`. The typed workflow client exposes the corresponding methods. The application handler freshly revalidates final receipt evidence; unavailable/changed evidence returns 503. The lower-level workflow getter validates record integrity only; use `freshCancellationReceipt` with an evidence revalidator for current chain proof.

## State and recovery

Child statuses are `proposal_pending`, `negotiating`, `acceptance_pending`, `accepted`, `execution_pending`, `execution_failed`, `disputed`, `proposal_rejected`, and `completed`. Its ID and `parent_job_id` link it to the parent job; events retain proposal revisions and receipt/instruction IDs. The job remains `settlement_negotiation` while acceptance/execution is pending. The separate escrow ledger changes only with confirmed chain evidence.

Keep the same actor, request and idempotency key on retries. Accepted JSON survives storage restarts. Recovery observes the durable transaction journal; it must not send a duplicate payout. If approval is saved but execution was never started, call acceptance again or use an authorized keeper. A rejected execution preserves the accepted instruction and locked ledger; retry deliberately using a new execution key after resolving its cause. Pending execution must be reconciled/resumed first.

The SDK blocks counters after instruction acceptance. External transactions can still change the chain state; forwarding checks fresh state and the contract rejects stale signatures. Original expiry refunds, arbitration and timeout allocations remain available under their original conditions. Those exits create a final receipt with their actual outcome and `instruction_id:null`; `prior_instruction_id` preserves the unexecuted acceptance reference. A failed acceptance or proposal produces no payment receipt.

## Compatibility and limits

0.6 reuses the 0.5 `A423Escrow` contract. No new deployment is needed for a verified 0.5 deployment. Existing 0.4/older contracts do not support these methods; retain their original adapter until custody is closed. Existing records without subflows remain readable; a cancellation child is added when negotiation starts.

The legacy `accept_settlement` action remains available for a direct counterparty transaction or dual-signature relay. It can produce a final receipt without a separately saved accepted instruction. Use the new staged flow when the UI needs acceptance before execution.

Amounts use raw integer token units, never floating point. Signatures and claims are public authorization material, not private keys. Persist records securely and avoid exposing participant-specific endpoints without authentication. Pure JSON constructors validate structure/binding; they do not independently prove cryptographic consent or chain finality. The reference adapters perform those checks. No live-chain deployment, external app migration or independent security audit is implied.

## Pre-funding decline and reopening — 0.7

Before funding, the requester can `cancel` and the worker can `decline` from `draft`, `quoted` or `accepted`. Both close the parent job as `cancelled`; neither deletes it. A quote sent afterward is rejected. No token refund or payment receipt is issued because this path has not taken custody of funds. The normal job event and `pre_funding_cancellations` record document the cancellation.

Each cancellation record has a unique `id`, cancelling actor/action/reason, prior state/agreement/acceptances, generation (`epoch`), reopening approvals and reopening timestamp. Participants can read it through the existing job/client GET API. A cancelled job ID cannot be created again or removed through ordinary protocol actions.

```js
let job = await workflow.act(id, 'decline', {
  reason: 'Cannot meet the proposed budget',
  expected_epoch: currentJob.epoch || 0,
}, {actor: workerId, idempotencyKey: 'decline-1'});

const cancellation_id = job.pre_funding_cancellations.at(-1).id;
job = await workflow.act(id, 'reopen', {cancellation_id}, {
  actor: payerId, idempotencyKey: 'reopen-payer-1'
});
// If worker declined, the worker must also explicitly approve reopening.
job = await workflow.act(id, 'reopen', {cancellation_id}, {
  actor: workerId, idempotencyKey: 'reopen-worker-1'
});
```

Required reopening approvers are the requester and the cancelling party. When both had already accepted the agreement, both must approve regardless of who cancelled. Until all required approvals are present, the job remains `cancelled`. An observer/verifier cannot reopen it. A requester cancellation before bilateral acceptance can therefore be reopened by the requester alone; subsequent participation still requires fresh agreement. Application authorization policies apply to every approval.

When reopened, the same job returns to `draft`, the active agreement is cleared, `epoch` increments, and history/idempotency records remain. No old acceptance is restored. The next quote uses a higher agreement revision even when the textual terms are unchanged; its canonical terms include the reserved `_a423_reopen: {job_id, epoch}` field, changing the agreement hash and wallet-signature payload. Hash and sign the returned agreement. Validators must tolerate this SDK-owned top-level field.

After reopening, `quote`, `accept`, `fund`, `cancel` and `decline` require `input.expected_epoch === job.epoch`. This rejects delayed requests from prior negotiations. Existing idempotency keys remain bound to their original requests: an old completed request may return the current record but will not execute again. Use fresh keys for a new negotiation generation. Reopening requires the exact current `cancellation_id`; an old cancellation cannot reopen a later one.

The generic HTTP handler and typed client's `act` method support both actions. Chat tools expose `decline_job` and `reopen_job`; the reference dashboard exposes the same actions and history. Existing cancelled records without a pre-funding cancellation record remain terminal; no historical approval is fabricated.

Any funding attempt (`fund.requested`), pending operation, funding evidence or escrow ledger blocks this reopening path, even if a funding attempt was rejected. This is deliberately conservative because a signed/broadcast transaction may exist outside a cached state. Use reconciliation and escrow exits instead. Paid, refunded and settled jobs remain terminal; repeating that work needs a new job ID linked by application metadata.

This is off-chain workflow cancellation, not on-chain revocation of a previously issued signature. Already shared worker-consent signatures retain their original contract-defined validity; an external payer could still try to fund the old agreement. Reopening changes the new agreement commitment and prevents using an old signature for the new agreement, but cannot erase an old signature. Any external old-agreement funding must be reconciled and handled under its original on-chain terms; do not display it as new-generation custody. Hard revocation before external funding would require an additional on-chain nonce/revocation protocol and deployment, which this release does not add.
