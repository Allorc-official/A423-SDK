# Negotiated closing settlements — 0.5.0

This release adds a closing negotiation for cancellation and partial-work compensation. A party proposes a worker payment, the other can counter or accept, and the contract pays the agreed amount and refunds the remainder atomically. It closes the whole job. **It does not introduce partial releases while continuing work or milestone payments.**

## Separate facts

- `job.state` drives allowed workflow operations. Published negotiation uses `settlement_negotiation`.
- `job.work_status` records not_started/running/submitted/verified/paused/completed/stopped.
- `job.escrow_ledger` records funded amount, worker paid, payer refunded, locked amount and proposal version, all as raw units except version.
- `job.negotiation` records origin state, current proposal, complete proposal history, status and closing observation.

No money leaves custody when a proposal is made or countered. Reported effort, token consumption and expenses are claims, not automatically payable debts. Both parties decide the closing allocation, or the agreed arbitrator/deadline rules decide it.

## Lifecycle

| Situation | Action | Result |
|---|---|---|
| Before funding | Existing `cancel` | No token refund needed |
| Funded/running/submitted/verified | `propose_settlement` | Publish allocation commitment; work pauses and contract enters Negotiating |
| Open negotiation | `counter_settlement` | Other party publishes next revision; previous proposal/signatures become stale |
| Open negotiation | `accept_settlement` | Counterparty accepts exact current revision/hash; worker paid, payer refunded, job settled |
| Open negotiation | `dispute` | Escalate to arbitrator; ordinary mutual acceptance is no longer available |
| Disputed | `resolve` | Arbitrator splits and closes escrow under original deadline |
| Unsubmitted job, including negotiation/dispute | `refund` / `timeout` after original work deadline | Full payer refund remains available |
| Submitted job in negotiation/dispute | `timeout` after original resolution deadline | Original signed timeout allocation applies |
| Already paid/refunded/split | Any new proposal/payment attempt | Rejected; settled money cannot be recovered by this protocol |

Negotiation is reusable across the eligible work stages, but remains state-aware. Work must stop while it is pending. Once arbitration is engaged, parties cannot unilaterally reopen negotiations and obstruct the arbitrator. Proposed payment never exceeds the locked balance. There is one closing settlement, not a remaining-work agreement.

## Example: request 30, agree on 20 out of 100

```ts
const offered = await client.act(jobId, 'propose_settlement', {
  expected_revision: 0,
  worker_amount: '30',
  expires_at: proposalExpiryUnixSeconds,
  reason: 'Research complete; analysis is unfinished. I propose closing the job.',
  claims: [
    {kind: 'work', description: 'Collected and checked sources', amount: '20', evidence: ['artifact:source-list']},
    {kind: 'expense', description: 'Agreed research cost', amount: '10', evidence: ['receipt:research-cost']},
  ],
}, {idempotencyKey: 'closing_offer_1'});
```

The payer uses its own authenticated client:

```ts
const counter = await payerClient.act(jobId, 'counter_settlement', {
  expected_revision: offered.negotiation!.current.escrow_version,
  worker_amount: '20',
  expires_at: proposalExpiryUnixSeconds,
  reason: 'The source list is useful; I propose 20 for the completed portion.',
  claims: [],
}, {idempotencyKey: 'closing_counter_1'});
```

The worker accepts the exact counter:

```ts
await workerClient.act(jobId, 'accept_settlement', {
  expected_revision: counter.negotiation!.current.escrow_version,
  proposal_hash: counter.negotiation!.current.proposal_hash,
}, {idempotencyKey: 'closing_accept_1'});
```

After confirmation: work stopped, workflow settled, funded 100, worker paid 20, payer refunded 80, locked 0. A payment transaction pending confirmation does not establish these final amounts. Raw amount `100` is not necessarily 100 displayed tokens; apply the configured token decimals only for presentation.

Use the same action/key to progress a pending transaction; `workflow.reconcile` observes known transactions and `workflow.resume` authorizes continued execution. A stale, expired, unauthorized or failed proposal does not move tokens. Check operation results: a definitively rejected action leaves the last confirmed job state unchanged. Use a new action key only for a deliberate new request after rejection.

## Exact proposal recipe

`settlementProposal(job, input)` derives the payer refund and returns a canonical `a423.closing.v1` record/hash. Input fields:

- `expected_revision`: current on-chain proposal revision; 0 for the first proposal.
- `worker_amount`: nonnegative raw-token integer string. `payer_amount` is optional but must equal funded amount minus worker amount.
- `expires_at`: absolute Unix seconds, no later than original resolution deadline. The contract also requires it to be in the future when published.
- `reason`: nonempty explanation, up to 4000 characters.
- `claims`: optional list, up to 64 work/expense/other claims, each with description, optional raw amount and up to 32 evidence references.

The canonical commitment includes job ID, original agreement hash, next escrow/proposal version, both allocations, expiry, explanation, claims and `closes_job: true`. The proposal's claim amounts do not automatically sum to the payout; they support the negotiation and can be disputed. Evidence references are not fetched or certified by the helper. Do not place secrets or private customer information in proposal data.

Publish/counter goes on-chain with expected revision, worker amount, proposal hash and expiry. Explanations/claims remain in the app's durable record and are bound by the hash. A transaction per published revision is deliberate: it freezes ordinary release and invalidates old revisions on-chain. Informal chat discussion can remain off-chain until a party actually publishes a proposal.

Counterproposals must alternate parties. A proposer cannot self-accept through `acceptSettlement`, or unilaterally renew its own current proposal. A published offer is actionable until it expires, is superseded by the counterparty's proposal, enters dispute, or the job is otherwise settled. Choose expiry carefully. Expiration does not resume work or release money automatically; the other party may counter, either party may escalate, or the original fallback remains available.

## Signatures and relayers

The counterparty's direct `acceptSettlement(jobId, revision, proposalHash)` transaction is on-chain acceptance of the proposer's published terms. Alternatively, obtain both signatures:

```ts
import { settlementConsent } from '@allorc/a423-sdk/escrow';
const typed = settlementConsent(job, escrowConfiguration);
const payerSignature = await payerSigner.signTypedData(typed.domain, typed.types, typed.value);
const workerSignature = await workerSigner.signTypedData(typed.domain, typed.types, typed.value);
```

Then a participant may relay through the adapter:

```ts
await client.act(jobId, 'accept_settlement', {
  expected_revision: typed.value.escrowVersion,
  proposal_hash: typed.value.proposalHash,
  payer_signature: payerSignature,
  worker_signature: workerSignature,
}, {idempotencyKey: 'relay_closing_1'});
```

`settleByConsent` is permissionless on-chain: any relayer can submit both approvals. It verifies the EIP-712 domain (chain and contract), job, agreement hash, exact current proposal revision/hash, both allocations and expiry. EOA and ERC-1271 signatures are supported. Old revisions, altered allocations, wrong chains/contracts, expired signatures and already-settled jobs are rejected. A proposal commitment without these approvals is not a payout authorization.

`GET /api/a423-settlement-consent/:id` returns typed data only to the payer/worker. It never generates private keys or signs for them. The reference dashboard can sign the current closing terms with an EIP-1193 EOA wallet and display/share the public signature. For ERC-1271, obtain the account's own signature format through its wallet. A proposer relaying through the SDK must supply both signatures; it cannot self-accept merely by submitting its own transaction. Externally submitted settlement transactions can be adopted with verified `transaction_hash` alongside the expected revision/hash.

## Contract enforcement and deadline behaviour

New reference contract state `Negotiating` is enum value 8; previous state values 0..7 remain unchanged. `proposeSettlement` accepts funded/submitted/verified/current-negotiating jobs. It sets Negotiating before acceptance is possible. `submit`, `verify` and ordinary `release` are blocked in that state. New event `SettlementProposed` records revision, proposer, allocation, hash and expiry. Acceptance emits `SettlementAccepted` and `Settled` with reason **4 (mutual closing settlement)**. Transfers use the same exact-token/nonreentrant settlement path.

Crucially, proposing does not extend `workDeadline`, `reviewDeadline` or `resolutionDeadline`:

- **No committed submission:** after the original work deadline, anyone can still trigger full payer refund—even if a partial-work claim or an unexpired proposal exists. A claim alone does not remove that agreed refund right. Agree or seek arbitration in time; do not imply unpaid effort itself guarantees compensation.
- **Committed submission:** original refund restrictions remain. After the original resolution deadline, anyone may trigger the original `timeoutWorkerBps` split, not the last unaccepted offer.
- **Arbitration:** an arbitrator may resolve an eligible dispute before the original resolution deadline, including pre-submission compensation disputes. That competes with any independently eligible original fallback. The first valid settlement mined closes the job.

If release was mined before cancellation was published, cancellation fails; there is no guaranteed challenge window before verified release. Likewise, acceptance and an eligible timeout/refund can race: whichever valid transaction executes first settles once, and later attempts fail. A chat message or a pending transaction does not establish an on-chain lock on release.

## Worker and UI integration

The SDK marks `work_status: paused` when a proposal is confirmed and blocks queued work through `assertSafe`. Pending proposal/dispute intent also blocks fresh execution immediately. The execution runner supplies `execute({job,idempotencyKey,signal})` and aborts that signal when it observes a pause or lost lease. Your AI/tools must honor cancellation signals to stop ongoing computation. External processes cannot be physically stopped by a Solidity contract. A checkpointed partial artifact is retained, but cannot be automatically submitted while negotiation blocks the job.

Chat tools now expose `request_cancellation`, `propose_settlement`, `counter_settlement`, `accept_settlement`; cancellation maps to a closing proposal after funding. Ordinary `cancel_job` remains pre-funding. The application factory wires the new adapters and settlement-consent endpoint. Existing generic workflow users must use the updated `escrowTransitions` and reference adapters deliberately.

The dashboard shell shows work status, negotiation/history and escrow ledger. It provides proposal/counter/accept actions, raw allocation inputs, claim data and a wallet signing control. Display the two sides distinctly:

> Cancellation / partial-work settlement proposed. Work paused. 100 remains locked. Proposed worker payment 30; payer refund 70. Awaiting the counterparty.

Display completed allocations only after matching confirmed `SettlementAccepted`/`Settled` evidence. `freshReceipts` checks claim commitments and revalidates proposal/settlement events. PDFs/JSON include history and the ledger, without claiming expenses were independently proven.

## Upgrade and limits

Version **0.5.0 requires a newly deployed reference contract** for this functionality. Existing 0.4 and earlier contracts are immutable and cannot acquire these methods by changing the npm version or RPC URL. Keep their adapter/ABI pinned for existing custody; do not relabel their records or move their tokens without the original release/refund process. Node SDK package files include the new compiled artifact and standard compiler input. No public deployment is performed automatically.

The upgrade does not add milestones, payment while continuing work, scope revisions, resubmission after a commitment, a quality/cost oracle, token recovery, admin withdrawals, pause/upgrades or support for broken/fee/rebasing tokens. Verifier/arbitrator trust and reviewed-token assumptions remain. Deployment and funding on a public chain spend real assets; the new contract remains experimental and unaudited.
