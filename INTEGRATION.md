# Pre-funding decline and reopening in 0.7

New actions: `decline` (worker) and `reopen` (required participants). Preserve the job ID, inspect `pre_funding_cancellations`, and supply `cancellation_id` when reopening. After reopening, supply `expected_epoch` for quote/accept/fund/cancel/decline. A fresh quote includes a reserved `_a423_reopen` commitment in its terms; sign/hash the returned agreement, not the original input. See [CANCELLATION.md](./CANCELLATION.md#pre-funding-decline-and-reopening--07).

# Cancellation subflows in 0.6

Use `workflow.acceptCancellation` or `POST /api/a423/jobs/:id/cancellation/accept` with both wallet signatures. Acceptance is persisted before forwarding; show the subflow status and issue the final receipt only after confirmation. See [CANCELLATION.md](./CANCELLATION.md) for routes, retry behavior and migration. The actual remote application is not modified by installing this package.

# Closing settlements in 0.5

Read SETTLEMENT.md. Use a new local/testnet reference deployment, preserve older funded contracts with their original adapters, wire proposal/counter/accept actions and the settlement-consent endpoint, and display work status/escrow ledger/negotiation separately. Test partial compensation, stale and expired approvals, arbitration, original deadlines and crash recovery. No real-chain deployment is implicit.

# Integration update for 0.4

Read OPERATIONS.md before following the older integration checklist below. Persistence, authority credentials, renewal, spending authorization, application projections/chat tools, keeper/resume, execution queue, watcher/indexer, PDF receipts and a local UI shell are now provided as concrete modules. Choose the supplied implementation or adapt deliberately.

The remote MVP was not available in the SDK workspace; these utilities do not imply its existing routes or configuration have changed. Wire them into the actual app and run its tests. Deploy new contracts only with explicit deployment authorization; retain legacy custody records on their original contracts.

# Integration instructions for the MVP coding agent

Install after the maintainer publishes:

```sh
npm install @allorc/a423-sdk@0.7.0
```

For testing before publication, install the maintainer's `npm pack` tarball instead. Do not silently install 0.1 and assume the workflow entry point exists.

## Reference escrow option

Read `ESCROW.md` first. The package now includes a concrete `/escrow` adapter plus `ESCROW_ABI`/`ESCROW_BYTECODE` and Solidity source. This contract differs from the old MVP contract: it requires EIP-712 worker consent, verifier approval, explicit arbitration and timeout terms. Do not point this adapter at the old contract. Use a fresh local/testnet deployment for evaluation or write a separately tested legacy adapter.

Use `createEscrowAdapters` and `escrowTransitions` when testing the reference path. Implement both the durable workflow store and protected transaction journal with atomic nonce reservation, map all four roles to trusted wallets, and supply artifact validation. Retain the reference lifecycle tests below. Deployment or real fund movement requires separate authorisation.

## Task

Integrate the opt-in `@allorc/a423-sdk/workflow` API into the existing MVP. Inspect the installed README, declarations and exports first. Preserve the existing app until a complete equivalent journey passes. Do not introduce demo keys, positional signer lookup, unknown-agent fallback, or authentication based only on x-agent-id. Do not deploy or move real funds as part of integration tests.

1. Implement a durable `WorkflowStore` in the app's database using atomic create and version-checked replacement. Store the whole workflow record together. Keep legacy data separate; explicitly migrate records only after reviewing the mapping. Use stable application-assigned job IDs; recover duplicate creates by loading and comparing the record.
2. Implement authentication and bind authenticated agent IDs to the application's wallet/signer registry. Keep `@allorc/identity` as public identity derivation only. Configure participants as requester, worker and verifier. Reject unknown agents before signing anything.
3. Define the application's JSON agreement terms and `validateTerms`: task specification, price, raw amount string, token/chain/contract, participant wallets, deadline, artifact requirements and verification/refund/dispute policy. Preserve decimal metadata. Use the returned SHA-256 agreement hash and revision for bilateral acceptance. Do not substitute this for the existing contract's keccak spec hash: explicitly map and verify both formats where needed.
4. Implement `fund.execute/reconcile`. Use `operation.id` for persistent deduplication; save provider transaction identifiers before waiting. Validate successful funding event plus actual escrow fields against the agreed terms and trusted chain/contract configuration. Return pending while unconfirmed, confirmed with structured observations only when policy passes, and rejected only on definitive failure. Confirm how the actual ABI exposes specHash; do not skip the comparison silently.
5. Implement `start` as a fresh eligibility gate. Fail closed if escrow configuration, evidence or chain access is missing. Match funding and assigned worker before scheduling execution. Dispatch actual work through the app's durable queue using a deduplicated run key. The SDK itself does not execute an AI agent.
6. Implement one submission path: store the actual artifact bytes, hash them, persist the manifest/reference, submit the required on-chain commitment, and wait/reconcile before confirming. If durable execution starts asynchronously, it must not report submitted just because the queue accepted it.
7. Implement `verify`: validate the exact committed artifact against accepted criteria. Only return confirmed after checks pass. A definitive failure returns rejected, then a separately authorized dispute action records the dispute. Record check results and validator version. If revisions are needed, add explicit transitions and define how they interact with already submitted commitments.
8. Implement `release.execute/reconcile`, checking caller role, recorded verification and actual payment evidence. Verify exact amount/recipient and relevant event. The SDK state guard does not change contract rules; document whether the contract itself requires submission. Never infer successful payment from a broadcast hash alone.
9. Implement `refund.execute/reconcile` based on actual contract eligibility. The default rule allows requesting a refund while funded/running; the adapter must enforce the deadline and absence of submission. Submitted disputes require an explicit supported resolution policy. Implement `resolve` only when that policy exists; confirmed resolution evidence must state whether money was released, refunded or remains locked. `resolved` alone does not imply payment.
10. Add application deadline/expiry checks to authorization and the `expire` adapter. Schedule sweeps with authorized roles. Cancellation only applies before funding in the default workflow. Do not claim automatic sweeps or a dispute timeout exist if they are not implemented.
11. Configure each adapter's `reconcile` to inspect the provider using durable operation records. Unknown outcomes remain pending. Poll/reconcile in a durable worker. Handle configured confirmations, disappearing observations and reorgs according to the app's policy; configure watchEvidenceOnce and the incremental indexer. Add explicit corrective transitions/policies if required rather than editing records outside CAS.
12. Expose `createWorkflowHandler` through a Node-runtime Next.js catch-all route. Use `createWorkflowClient` or documented HTTP endpoints externally. The old root API and new workflow API use distinct models; migrate the client deliberately.
13. Build machine-readable receipts through `workflow.receipts`. Revalidate chain evidence before generating chain-backed PDFs; derive amounts/participants from validated observations and use actual token decimals. Distinguish cached observations from freshly checked evidence.

## Adapter shape

```ts
const adapters = {
  fund: {
    async execute({ job, input, operation }) {
      // Deduplicate operation.id durably, enforce agreed terms and submit/observe.
      return { status: 'pending', reference: 'your-provider-operation-id' };
    },
    async reconcile({ job, operation }) {
      // Query your saved provider operation. Do not blindly resend.
      return { status: 'confirmed', evidence: { /* independently validated fields */ } };
    },
  },
  // start, submit, verify, release, refund, expire, resolve as applicable.
};
```

This is a structural example, not a working escrow adapter. Never return confirmed unconditionally in an actual integration.

## Required validation before replacing MVP routes

- Happy path: create → quote → both accept same revision/hash → fund confirmed → start gate → submit confirmed → verify → release confirmed → JSON/PDF evidence.
- Quotes: revised terms clear acceptances; stale revision rejected; funding prevents edits; deadline policy rejects expired quotes.
- Permissions: anonymous/unknown/unrelated actors blocked; each role enforced; identity hash alone cannot authenticate.
- Funding: wrong amount, token, chain, contract, payer, worker, verifier, deadline or spec commitment blocks work; missing escrow configuration fails closed.
- Effects: duplicate requests and simultaneous retries produce one provider operation; differing input with reused key rejected; crashes before/after broadcast and before final DB save recover by reconciliation.
- Submission: asynchronous execution cannot prematurely submit; bytes match committed digest; missing/failed chain submission stays pending/rejected.
- Verification: bad output never enables release; dispute recorded; unsupported resolution leaves explicit unresolved state.
- Refund: before deadline rejected; after deadline/unsubmitted succeeds; submitted work obeys contract restrictions.
- Exceptions: pre-funding cancellation, unfunded expiry, definitive provider rejection and long pending operations.
- Receipts: correct raw units/decimals, matching funding/payment/refund events and artifact linkage; provider outage is distinguished from absent evidence.
- Custom use case: prove a second task type or non-chain provider works without modifying SDK internals.

Report changed files, adapter capabilities, test results and unsupported contract guarantees. Keep real-chain tests opt-in. Do not claim every possible workflow or payment provider is implemented merely because adapter hooks exist.
