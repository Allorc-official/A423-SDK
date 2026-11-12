# Changelog

## Unreleased documentation

- Replace Mermaid-only README blocks with pre-rendered PNG images, zoomable SVGs and editable diagram sources; include documentation assets in the package.

- Rewrite the README around installation/version checks, initialization argument definitions, typed job fields, end-to-end action tables and Mermaid process maps.
- Add a runnable no-chain quickstart and an examples index; include both in the npm package.
- Explain published versus source versions, private economics, cancellation/reopening boundaries and actual receipt confirmation.

## 0.8.1

- Accept direct `settlementPolicy.thresholds` initialization arguments alongside the existing policy-builder form (mutually exclusive).
- Validate threshold names, types and ordering at startup; capture the configuration so later caller mutations cannot change it.
- Expose the read-only effective configuration and document per-instance setup.

## 0.8.0

- Add optional `/policy` primitives for integer gross-margin evaluation, configurable 50% target/10% minimum/50% maximum defaults, capped recommendations and private profit projections.
- Wire durable cost/budget freezing, owner-approved exceptions, worker/requester proposal defaults and acceptance guards into the application factory.
- Add role-aware policy inspection/prompts, state/receipt projections and reference dashboard economics.
- Add audit-logged malformed-pending rejection with adapter proof; the reference adapter supports only impossible submit encodings with no journal/external/on-chain submission.
- Retain existing contract, signatures and public settlement formats. Remote app metering/UI adoption remains separate.

## 0.7.0

- Add worker `decline` before funding, with retained cancellation IDs, reasons, prior agreements and actor history.
- Add explicit `reopen` approvals: requester plus cancelling party, and both parties after bilateral acceptance.
- Preserve the job ID, clear the active agreement, monotonically advance quote revisions, and bind new agreements to a reopening generation.
- Reject stale-generation quote/accept/fund/cancel/decline requests and any pre-funding cancellation after funding has been attempted.
- Add chat actions, dashboard controls and regression coverage. No contract changes or external signature-revocation claim.

## 0.6.0

- Add a persisted cancellation child flow with proposal, acceptance, escrow execution and confirmed receipt stages.
- Verify both wallet signatures before saving the immutable JSON instruction; encode it into the existing `settleByConsent` call.
- Add typed client/HTTP/chat actions, accepted-instruction and fresh final-receipt routes, keeper forwarding and dashboard controls.
- Preserve locked balances through rejected/expired execution; retain arbitration and original deadline exits.
- Reuse the 0.5 contract without Solidity changes. Earlier contracts still require the 0.5 deployment upgrade.

## 0.5.0

- Add reference-contract closing proposals, counterproposals, exact counterpart acceptance and dual-signature permissionless settlement.
- Add Negotiating state (8), stale-revision protection, expiry/amount/signature binding, ordinary release blocking and original deadline exits.
- Support pre-submission compensation disputes; retain the original unsubmitted expiry refund.
- Track work status, immutable claim/proposal history and a separate escrow ledger.
- Add typed proposal/consent helpers, chat/HTTP/wallet/dashboard integration, cooperative execution abort and fresh proposal/settlement receipts.
- Add local-EVM negotiation, replay, fallback and recovery tests. Requires a new contract deployment; no milestone/continuing-work payments or audit claim.

## 0.4.0

- Add durable single-host SQLite workflow/transaction/nonce/queue/event/spending storage and local-only reset.
- Add organization-approved agent enrollment, challenge proofs, credentials, public-key verification, revocation and renewal.
- Require escrow pre-sign/rebroadcast authorization; provide atomic per-transaction/day/total spending reservations.
- Add EOA/ERC-1271 consent, fresh evidence validation, reorg quarantine, allowlisted multi-deployment routing, log indexing, managed signing/delegation and bounded same-nonce replacement.
- Add task/evidence schemas, keeper/resume, checkpointed execution, signed webhook outbox, resumable SSE and fresh JSON/PDF receipts.
- Add shared app/chat projections, wallet consent/dashboard shell, safe legacy migration planning, local-EVM integration tests and dry-run deployment/source-verification tooling.
- Retain explicit reference-contract constraints. No external deployment or independent audit is claimed.

## 0.3.0

- Add optional ethers-based `/escrow` entry point and a compiled ERC-20 reference contract.
- Enforce EIP-712 worker consent, exact custody amounts, one immutable submission, verifier approval before release, expiry refunds, disputes, arbitrated splits and agreed timeout allocation.
- Add pre-broadcast signed-transaction journaling, coordinated nonce allocation, canonical receipt/term/event validation and external transaction evidence adoption.
- Ship escrow-specific transitions and documentation. Contract is experimental, unaudited and not deployed by the package.
- Add local-EVM lifecycle, failure, recovery and confirmation tests.

## 0.2.0

- Add opt-in `@allorc/a423-sdk/workflow` exports: workflow engine, Next.js-compatible handler, typed HTTP client and canonical agreement hashing.
- Add versioned quotes, bilateral acceptance, role checks, application policies and configurable transitions.
- Cover funding, execution gate, submission, verification, release, refund, cancellation, expiry, disputes and resolution through explicit adapters.
- Persist pending operations before effects, stable provider idempotency keys, reconciliation observations and structured evidence.
- Preserve the 0.1 root API unchanged. Its approval/settlement behaviour is distinct from the new workflow.
- Add migration instructions and lifecycle/recovery/HTTP tests. No chain adapter, database driver, signer, queue or PDF renderer is bundled.
