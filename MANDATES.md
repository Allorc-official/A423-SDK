# Generic agent mandates — 0.9.0

**Default: all supported SDK actions, unlimited budget, unlimited lifetime.** A mandate is a flat policy attached to an agent at backend initialization. There is no owner/issuer tree, parent mandate, approval hierarchy or job-specific grant ceremony.

It answers three questions:

1. Which SDK actions may this agent invoke?
2. How much may it commit across jobs?
3. Until when may it initiate those actions?

The mandate does not replace authenticated identity, participant roles, job state rules, spending/signing approval or on-chain signatures. Unlimited means the mandate adds no limit; it does not create funds or grant permission to act as another participant.

## Initialization

```ts
const app = createEscrowApplication({
  ...yourExistingConfiguration,
  mandates: [{
    agentId: 'buyer',
    actions: 'all',
    budget: {
      chainId: deployment.chainId,
      tokenAddress: deployment.tokenAddress,
      total: '1000000', // Shared across every job funded under this mandate
      perTransaction: '250000', // Optional
      daily: '500000', // Optional; UTC day
    },
    duration: {weeks: 4},
  }],
});
await app.ready(); // Complete durable startup registration before serving requests.
```

Registration starts during construction. Actions await registration internally; `app.ready()` makes startup failure explicit. Invalid arguments fail immediately; durable registration/configuration conflicts reject readiness. Configure these records in trusted backend code. No public registration/edit endpoint is added.

`mandates` defaults to `[]`. Agents without an entry have unrestricted mandate defaults, while all existing authentication/role checks remain active. This array is a constraint list, not an agent-access allowlist. To deny an agent all state-changing actions explicitly, use `actions: []`.

## Arguments

| Argument | Default | Definition |
|---|---|---|
| `agentId` | Required | Authenticated SDK agent ID to which this flat policy applies |
| `id` | Same as `agentId` | Stable identity for this mandate registration, lifetime and budget period |
| `actions` | `'all'` | All predefined SDK actions, or an explicit array of their names |
| `budget` | `null` / omitted | No mandate spend cap; a finite budget uses the fields below |
| `duration` | Lifetime | `'lifetime'` or one positive integer unit: `{weeks}`, `{days}`, `{hours}` or `{seconds}` |
| `expiresAt` | `null` / omitted | Absolute expiry in Unix seconds; alternative to `duration` |

Use either `duration` or `expiresAt`, not both. Four weeks means exactly 28 days of 24 hours, not four calendar-month weeks. Expiry is exclusive: at `now >= expiresAt`, new actions and broadcasts are denied.

These all mean no end date:

```ts
{agentId: 'researcher'}
{agentId: 'researcher', duration: 'lifetime'}
{agentId: 'researcher', expiresAt: null}
```

JavaScript `expiresAt: Infinity` is also accepted and normalized to `null`. Prefer omission or `null` for JSON/config files; no literal infinity number is stored. Zero is an already-expired timestamp, not unlimited.

An absolute deadline example:

```ts
{agentId: 'researcher', expiresAt: Math.floor(Date.parse('2027-01-01T00:00:00Z') / 1000)}
```

Do not recompute `Date.now() + fourWeeks` as a new absolute expiry on every restart. Use `duration: {weeks: 4}` to retain the original registered end date.

## Supported actions

Use action names, not state names. For example, `fund` is an action and `funded` is its confirmed result. The authoritative list comes from the same transition definitions used by the workflow and reference escrow adapter:

```ts
import {SDK_ACTIONS} from '@allorc/a423-sdk/mandate';
console.log(SDK_ACTIONS);
```

| Group | Actions |
|---|---|
| Agreement | `create`, `quote`, `accept` |
| Delivery and payment | `fund`, `start`, `submit`, `verify`, `release` |
| Pre-funding lifecycle | `cancel`, `decline`, `reopen`, `expire` |
| Closing negotiation | `propose_settlement`, `counter_settlement`, `accept_settlement`, `approve_cancellation`, `execute_cancellation` |
| Exceptions | `refund`, `dispute`, `resolve`, `timeout` |

A mandate can only narrow these capabilities. It cannot make a worker the requester/verifier/arbiter, permit an invalid state transition or waive another wallet's signature. Unknown/misspelled actions, hierarchy fields and duplicate entries for one agent are rejected at initialization.

Reads, job listing, receipts and **observe-only reconciliation** remain possible after mandate expiry or action restriction, subject to their normal authenticated role checks. They do not create a transaction. `resume` must reauthorize the pending operation's original action. Safe pending rejection also requires the original action's authorization; there is no generic mandate bypass.

## Budget across jobs

| Budget field | Default | Meaning |
|---|---|---|
| `chainId` | Required for a finite cap | Currency's network; positive numeric ID |
| `tokenAddress` | Required for a finite cap | ERC-20 currency whose raw units are counted |
| `total` | Omitted / `null` = unlimited | Lifetime gross commitment limit across jobs under this agent/mandate ID |
| `perTransaction` | Omitted / `null` = unlimited | Maximum principal for one funding intent |
| `daily` | Omitted / `null` = unlimited | Gross reservations for the current UTC day |

Finite amounts are canonical nonnegative raw-unit integer strings, not decimal token quantities, dollars or JavaScript floats. `'0'` is a zero budget; it does not mean unlimited. Omit the entire `budget` when all caps are unlimited. Currency fields without any finite cap are rejected to avoid ambiguity.

The same mandate's budget is shared across **all jobs and escrow deployments using its configured chain/token**, rather than resetting per job. A finite budget denies funding another currency; raw amounts from different tokens/chains are never added together without a defined conversion policy. The budget belongs to the agent identity, not to a hierarchy of account owners.

For example, total `'150'` allows a 100-unit funding and a 50-unit funding, but not two 100-unit fundings. Approval reset, allowance approval, signing retries and funding broadcasts for the same job/agreement are deduplicated into one economic reservation. SQLite performs reservation checks atomically, including concurrent requests/processes sharing the same file.

Reservations are intentionally conservative. They can remain after an approval, a later rejection, an uncertain transaction or a refund. Refunds **do not automatically replenish** the mandate budget. Operators must reconcile external outcomes before releasing reservations using protected storage tools. Budget is reserved commitment, not a claim of exact net cash expenditure.

The reference factory automatically charges escrow funding principal. Gas, AI provider invoices, ordinary wallet transfers and transactions sent outside the SDK are not automatically metered by this mandate. Custom adapters can use the generic reservation API for a known, correctly converted amount:

```ts
await app.mandates.reserveBudget({
  actor: authenticatedAgentId,
  action: 'fund',
  requestId: stableEconomicIntentId,
  amount: rawTokenAmount,
  chainId,
  tokenAddress,
});
```

Check the returned boolean before any effect; use the same ID and amount on retry. This utility does not authenticate `actor`, sign or send money. Your adapter must bind identity and atomically journal its own external effect.

`limitsFor` remains available as an **additional per-wallet spending policy**. It is now optional in the factory; omitted returns explicit unlimited (`null`) caps. When both policies are configured, both must permit the intent. `approveSigning` remains required and independent. Unlimited mandate defaults never override stricter application/signing checks.

## Lifetime, persistence and replacement

The registry records registration time, resolved expiry and a configuration fingerprint in private durable KV. Duration begins at initialization/registration. Restarting with the same agent and mandate ID reuses the original deadline and spending reservations; it cannot silently grant four more weeks or a fresh budget.

Changing settings under an existing ID fails readiness. Use an explicit new ID to renew or replace a mandate:

```ts
{agentId: 'buyer', id: 'buyer-period-2', duration: {weeks: 4}, budget: nextPeriodBudget}
```

A new ID starts a new registration and budget scope; that is an intentional trusted backend change, not an automatic agent renewal. Removing a configured entry restores the unrestricted mandate defaults for that agent in that instance. All instances enforcing a shared policy must use consistent configurations and durable stores; do not mix constrained and unconstrained instances behind the same public service unintentionally.

Inspect effective settings on the backend:

```ts
const effective = await app.mandates.get('buyer');
// effective.actions === 'all' or an action array
// effective.budget === null means no mandate cap
// effective.expiresAt === null means lifetime / logical infinity
const registered = await app.mandates.list();
```

Expiry is checked before state-changing actions and again before signing/broadcasting. The supplied operational worker also checks active execution permissions and cooperatively aborts via `AbortSignal`; your runner must honor it. An already broadcast transaction can confirm after expiry. A mandate is off-chain policy, not on-chain signature revocation: it cannot erase shared signatures, reverse payouts, cancel agreements, unlock escrow or forcibly stop an external process.

Include the actions needed for the agent's intended exits. The SDK does not automatically grant `refund`/`timeout` to an explicitly restricted list. Other appropriately authorized parties or supported contract exits may still resolve custody according to the original rules. A lifetime mandate also does not extend the independent expiry of authentication credentials.

## Custom SDK composition

```ts
import {createMandateRegistry} from '@allorc/a423-sdk/mandate';
const mandates = createMandateRegistry({
  mandates: configuredMandates,
  kv: storage.kv,
  spending: storage.spending,
});
await mandates.ready();
```

The application factory wires workflow action checks, signing/broadcast checks, durable funding reservations and worker checks automatically. Lower-level integrations must compose `mandates.authorize` with authentication/role policies and call `mandates.authorizeTransaction` in their signing authorizer; merely constructing a registry does not intercept an unrelated wallet or adapter.

No issuer/grantor/parent fields, on-chain mandate contract, public configuration API or independent audit are introduced by this feature.
