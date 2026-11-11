# Changelog

## 0.2.0

- Add opt-in `@allorc/a423-sdk/workflow` exports: workflow engine, Next.js-compatible handler, typed HTTP client and canonical agreement hashing.
- Add versioned quotes, bilateral acceptance, role checks, application policies and configurable transitions.
- Cover funding, execution gate, submission, verification, release, refund, cancellation, expiry, disputes and resolution through explicit adapters.
- Persist pending operations before effects, stable provider idempotency keys, reconciliation observations and structured evidence.
- Preserve the 0.1 root API unchanged. Its approval/settlement behaviour is distinct from the new workflow.
- Add migration instructions and lifecycle/recovery/HTTP tests. No chain adapter, database driver, signer, queue or PDF renderer is bundled.
