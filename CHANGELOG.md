# Changelog

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
