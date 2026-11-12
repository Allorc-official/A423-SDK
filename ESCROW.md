# Reference on-chain escrow (0.5.0)

[Start here: installation, arguments and lifecycle maps](./README.md) · [All examples](./examples/README.md)

For negotiated cancellation and partial compensation, see [SETTLEMENT.md](./SETTLEMENT.md). The 0.5 contract adds proposal/counter/accept operations and a Negotiating state; a new deployment is required.

This opt-in module implements a real ERC-20 escrow path. The generic workflow remains provider-independent. It includes Solidity source, reproducibly compiled ABI/bytecode, an ethers v6 adapter and local-EVM tests. It is experimental and has not received an independent security audit; deploy to a local chain/testnet for evaluation. No contract is deployed automatically and no funds move merely by installing the package.

## Installation and deployment

```sh
npm install @allorc/a423-sdk@0.5.0 ethers@^6.15.0
```

```ts
import { ContractFactory } from 'ethers';
import { ESCROW_ABI, ESCROW_BYTECODE } from '@allorc/a423-sdk/escrow';
const contract = await new ContractFactory(ESCROW_ABI, ESCROW_BYTECODE, deploymentSigner)
  .deploy(standardTokenAddress);
await contract.waitForDeployment();
```

Deployment is an explicit, separately authorised transaction. Each deployment supports one immutable token. There are no owner withdrawals, token replacements, upgrades or pause switches. Standard ERC-20 transfers must preserve exact sender/recipient amounts. Fee-on-transfer/rebasing/blacklisting/pausable tokens are unsupported; an issuer blocking transfers can defeat timeout liveness. Arbitrary token code cannot be made safe by SDK validation. Use a reviewed token and verify the deployed contract bytecode/configuration before trusting it. Forced token transfers do not create job credits; there is no recovery sweep for unsolicited deposits.

## Exact agreement recipe

Include every application-specific condition in JSON terms. Include this `escrow` object with these field names. IDs, application identities and wallet addresses are separate concepts; use a trusted identity-to-wallet registry.

```js
const terms = {
  task: { description: 'Your task', acceptance: { /* your criteria */ } },
  escrow: {
    chain_id: '31337',
    contract: escrowAddress,
    token: tokenAddress,
    amount: '100', // raw integer token units, NOT necessarily 100 displayed tokens
    payer: payerAddress,
    worker: workerAddress,
    verifier: verifierAddress,
    arbitrator: arbitratorAddress,
    work_deadline: workDeadlineSeconds,
    review_deadline: reviewDeadlineSeconds,
    resolution_deadline: resolutionDeadlineSeconds,
    timeout_worker_bps: 2500, // agreed fallback: 25% worker, 75% payer
  },
};
```

All deadlines are absolute Unix seconds and strictly increasing. The work deadline must be in the future at funding. `amount` is a positive uint256 decimal string. The SHA-256 hash of the entire canonical terms object is stored on-chain; it includes payment rules and the task criteria. The Solidity EIP-712 terms digest is a separate encoding for worker consent. `jobId` is SHA-256 of UTF-8 `a423:escrow:v1:` plus the application job ID. One job ID may only be funded once per deployed contract.

The arbitrator must differ from payer and worker. The verifier may be the payer: this is a trusted verifier policy, not trustless proof of output quality. The 0.4 reference contract supports EOA EIP-712 worker signatures and ERC-1271 wallet signatures. Existing 0.3 deployments remain EOA-only. For smart-account transaction execution, submit through the account wallet and supply verified `transaction_hash` evidence to the SDK; the raw-transaction sender itself is still an EOA/managed signer.

## Connect Next.js and the workflow

```ts
import { createWorkflow, createWorkflowHandler } from '@allorc/a423-sdk/workflow';
import { createEscrowAdapters, escrowTransitions } from '@allorc/a423-sdk/escrow';

const adapters = createEscrowAdapters({
  provider,
  chainId,
  contractAddress: escrowAddress,
  tokenAddress,
  confirmations: requiredConfirmations,
  transactions: durableTransactionStore,
  signerFor: async actor => signerRegistry.getSigner(actor),
  addressFor: async actor => signerRegistry.getAddress(actor),
  authorizeTransaction, // REQUIRED: spending/delegation policy; see OPERATIONS.md
  validateArtifact: async ({ job, resultHash }) => {
    // Fetch exact bytes, check digest and evaluate accepted criteria.
    // Return true only after all checks pass.
    return artifactService.validate(job, resultHash);
  },
});
const workflow = createWorkflow({
  store: durableWorkflowStore,
  adapters: { ...adapters, expire: applicationExpiryAdapter },
  transitions: escrowTransitions,
  validateTerms: applicationTermsValidator,
  authorize: applicationPolicy,
});
const handler = createWorkflowHandler({ workflow, authenticate: authenticateRequest });
// In app/api/a423/[...path]/route.ts:
export const runtime = 'nodejs';
export { handler as GET, handler as POST };
```

All application services in this example must be supplied. Configure explicit `arbitrator` alongside requester, worker and verifier in job participants. `addressFor` must map all four authenticated IDs to the agreed addresses. `signerFor` must reject unknown actors and apply spending/delegation approvals. The adapter uses offline `signTransaction`, so custodial/local/KMS signers must support it. It does not prompt a browser wallet or bypass human approval. Do not use keys in client React code.

## Acceptance is not locking

1. Create a job, quote terms, and record both actors accepting the same revision/hash using the workflow API.
2. Obtain a worker signature over the final on-chain terms:

   ```ts
   import { workerConsent } from '@allorc/a423-sdk/escrow';
   const consent = workerConsent(acceptedJob, { chainId, contractAddress: escrowAddress, tokenAddress });
   const signature = await workerSigner.signTypedData(consent.domain, consent.types, consent.value);
   ```

   The worker should inspect the terms it signs. EIP-712 binds consent to chain, contract, job, parties, amount, deadlines, timeout allocation and the whole agreement hash. The payer authorises the actual funding transaction.
3. Call `workflow.act(id, 'fund', { worker_signature: signature }, { actor: requesterId, idempotencyKey: 'fund_1' })`.
4. The adapter grants token allowance if needed (zero reset first when necessary), then calls the reference contract's `fund`. **Approval alone does not lock money.** The contract checks the worker signature, transfers the exact amount into custody, stores all terms and emits `Funded` atomically.
5. Pending results keep the workflow `accepted` with a `pending` operation. Display “funding pending”, not “locked”. Retry the same action/key to progress approval/funding. Only successful, sufficiently confirmed, canonically included receipts plus matching event and on-chain terms produce `funded`.
6. Start work via `start`; it rereads the actual escrow and deadline. The SDK does not run the worker. Dispatch through a durable queue only after this gate succeeds.

To automatically initiate funding after the second acceptance, orchestrate the above from your application after obtaining payer authorisation. Off-chain acceptance cannot force a wallet to sign. Do not change the UI to “funded” at acceptance time.

## Full lifecycle and exact inputs

| Action | Input | On-chain restriction / result |
|---|---|---|
| fund | `{ worker_signature }` | Payer only; valid worker consent; exact token transfer; new job ID |
| start | `{}` | Adapter checks all terms, funded state and unexpired work deadline; no transaction |
| submit | `{ result_hash: '0x…64 hex chars' }` | Worker only; before work deadline; nonzero artifact commitment |
| verify | `{}` | Callback validates actual artifact; verifier transaction must match submitted digest and review deadline |
| release | `{}` | Verifier only, verified state, before resolution deadline; full worker payout |
| refund | `{}` | Anyone on-chain after work deadline, only if no submission; full payer refund |
| dispute | `{ reason_hash: '0x…64 hex chars' }` | Party only, submitted/verified and before resolution deadline; blocks ordinary release |
| resolve | `{ worker_amount: '40' }` | Arbitrator only, disputed, by resolution deadline; remainder refunded to payer |
| timeout | `{}` | Funded/running: expiry refund. Submitted/verified/disputed: agreed fallback allocation after resolution deadline |

`escrowTransitions` makes dispute an actual on-chain operation, gives resolve to the arbitrator and adds timeout. Resolution and timeout end in workflow `settled`; inspect evidence `worker_paid`, `amount` and contract state to distinguish paid/refunded/split. Contract settlement states: 5 Paid, 6 Refunded, 7 Split. Event reasons: 0 release, 1 expired-unsubmitted refund, 2 arbitration, 3 submitted timeout.

A verifier can approve and release before a dispute is opened; there is no guaranteed challenge window or objective quality oracle. Rejected artifact verification leaves the workflow submitted and clears pending, allowing a dispute. The contract enforces that submission and verifier approval exist; the application verifier still judges task quality. For resubmission/milestones, use a separate contract policy: the reference contract permits one immutable submission and one settlement, not partial milestone releases. Arbitration can split the one escrow.

Cancellation and quote expiry before funding remain workflow/application policies and move no tokens. The optional operations/authority modules provide keeper ticks and an explicit registry; configure and run them as described in OPERATIONS.md.

## Recovery and journal requirements

The workflow job is written before any effect. The transaction journal separately stores signed raw transactions **before broadcasting**, including hash, destination, calldata and signer. Retries reuse the winning journal record and rebroadcast the same bytes; they do not create another payment or nonce. Do not expose raw signed transactions in public workflow metadata/receipts. Treat the journal as protected operational storage.

Implement `TransactionStore`:

- `get(id)`: retrieve a durable record.
- `create(id, record)`: atomic insert-if-absent; return boolean. Never overwrite an existing signed transaction.
- `reserveNonce(scope, minimum, operationId)`: transactionally allocate per-chain/address nonces, at least the RPC pending nonce; the same operation must always retrieve its original reservation. Every process using the account must coordinate through this allocator. External wallet activity requires an explicit operational policy.

`createMemoryTransactionStore()` is only for tests. Production needs a real database implementation. A crash after nonce reservation but before journaling must resume that operation to fill its reserved nonce; later transactions may remain blocked behind it. The optional bounded fee replacement worker can journal a same-nonce fee increase under explicit caps; there is no automatic cancellation. A genuinely stuck transaction requires deliberate recovery with the same nonce and updated journal lineage; do not blindly assign a new nonce. Prefer dedicated signer accounts to uncontrolled mixed wallet usage.

`reconcile` only observes existing journal entries and never signs/broadcasts. If an approval is confirmed but the funding transaction has not yet been created, reconcile returns pending; retry the original fund action/key to authorise progression. After a signed transaction is journaled but not broadcast, execute retries rebroadcast the identical bytes. After broadcast/mining but before the workflow write, reconcile verifies and adopts its evidence. Explicit `rejected` results permit a deliberate new attempt with a new action key; an unknown network outcome stays pending or throws with the pending record retained.

For externally submitted transactions, pass `transaction_hash` in the action input from the beginning (in addition to the normal fields). The adapter observes it without broadcasting and checks the configured contract, exact agreement, action event and allocation. This supports recording permissionless refunds/timeouts submitted by a keeper or another account. Use the correct workflow action; it cannot adopt arbitrary unrelated transfers. Supplying an incorrect hash fails closed and leaves pending for investigation; do not change persisted input to hide errors.

RPC chain ID and immutable token are checked; event emitter, job ID, agreement hash, all stored terms, event amounts and results are verified. Evidence contains transaction/block hash and required confirmation depth. Readers need historical state access for the receipt block. The adapter checks current canonical inclusion at observation time; confirmations are a configurable risk policy, not an absolute finality guarantee. The operations watcher can continuously revalidate evidence and place affected jobs on a safety hold. It does not automatically roll back completed financial states or erase observations; reconcile re-included transactions through an explicitly reviewed recovery procedure. Chain outages preserve uncertainty and cannot be repaired by SDK code.

No timeout is automatic: a keeper or participant must submit a transaction, and the chain must process it. Deadlines provide an eligible escape path under the agreed allocation; they do not guarantee execution during censorship, chain failure or broken token transfers.

## Verification and receipts

Artifact input is a bytes32 commitment. The application chooses the hashing scheme and storage format; for SHA-256, hash the exact delivered bytes, not a mutable URL. The verifier callback must check both bytes and accepted criteria. There is no generic LLM quality proof.

Funding, submission, verification and settlement effects return JSON-safe chain evidence. Workflow receipts retain those observations; they are not live PDFs or perpetual assertions of finality. Fresh PDF/evidence services should recheck canonical receipts and commitments at read time and format raw units with the actual token decimals.

## Development checks

From the source repository:

```sh
npm ci --ignore-scripts
npm run build:escrow
npm test
npm pack --dry-run --ignore-scripts
```

The local-EVM suite exercises custody, consent binding, permissions, submission-before-release, expiry refund, arbitration splits, timeout allocation, unsupported token rejection, recovery, external evidence adoption and confirmation depth. Solidity compiler and OpenZeppelin versions are pinned in dev dependencies; ethers is an optional peer used only by `/escrow`. Core/workflow do not load it.
