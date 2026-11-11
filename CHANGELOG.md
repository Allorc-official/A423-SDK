# Changelog

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
