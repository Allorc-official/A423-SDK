# Security

Experimental SDK and independently unaudited reference escrow. Use local/testnet evaluation until the deployment and operational model receive independent review.

Reference-contract custody is distinct from the legacy root API, which has no funded escrow. Authority credentials identify keys approved by your operator registry; they are not proof of legal-company status. Administrative enrollment/revocation capabilities must not be exposed to untrusted callers. Use explicit trust roots, TLS, short credential lifetimes, revocation checks and rate-limited proof endpoints.

Keep private keys, raw signed transaction journals, SQLite files and webhook signing secrets private. The supplied SQLite driver is single-host and requires persistent local disk, restricted filesystem access and backups. Do not use memory stores for production custody, share nonces across uncoordinated writers, or reuse an arbitrator key for treasury/bootstrap. Use the checked managed signer and bounded delegation or your reviewed signing service.

Authorize before signing and rebroadcasting, enforce raw-token spend limits atomically, and preserve unknown outcomes for reconciliation. Queue handlers and webhook receivers must be idempotent; leases do not imply exactly-once external effects. Only configure webhook destinations you control/approve; redirects are disabled, but DNS and egress controls remain deployment responsibilities.

The reference token must support exact transfers. Unsupported fee/rebase/blacklist behaviours can prevent settlement. EOA/ERC-1271 consent is supported by the new contract; verifiers/arbitrators still decide quality and may have conflicts of interest. Timeout allocation must be explicitly agreed. Contract upgrades, admin recovery, challenge windows and partial releases are not introduced by this version.

Reorg watchers quarantine stale/unavailable evidence; they cannot guarantee finality or undo already executed external work. Continuous operation, monitoring, deliberate recovery and chain availability are still necessary. Do not clear holds without current matching evidence.

Report vulnerabilities privately through the repository's configured security reporting channel. Do not post credentials, customer records or live exploit details publicly. No completed independent audit is claimed.

Closing settlements in 0.5 require a new deployment and exact current proposal acceptance. Publishing freezes ordinary release, but cannot reverse a release already mined. Proposals never extend original refund/resolution deadlines. Unsubmitted partial-work claims do not remove the original expiry refund right; arbitrary expenses are not automatically owed. First valid closing settlement/refund/arbitration/timeout wins; no later operation can settle the same job again. See SETTLEMENT.md.
