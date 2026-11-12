// In-memory workflow and policy example. No on-chain transactions or keys.
import {createMemoryStore} from '@allorc/a423-sdk';
import {createWorkflow} from '@allorc/a423-sdk/workflow';
import {createSettlementPolicy} from '@allorc/a423-sdk/policy';

const workflow = createWorkflow({store: createMemoryStore()});
const id = 'research-001';
await workflow.create({
  id,
  participants: {requester: 'buyer', worker: 'researcher', verifier: 'reviewer'},
}, 'buyer');

let job = await workflow.act(id, 'quote', {
  terms: {description: 'Prepare a research brief', amount_raw: '200'},
}, {actor: 'researcher', idempotencyKey: 'quote-1'});

const acceptance = {
  revision: job.agreement.revision,
  agreement_hash: job.agreement.hash,
};
await workflow.act(id, 'accept', acceptance, {
  actor: 'buyer', idempotencyKey: 'buyer-accept-1',
});
job = await workflow.act(id, 'accept', acceptance, {
  actor: 'researcher', idempotencyKey: 'worker-accept-1',
});

const plan = createSettlementPolicy().evaluate({
  cost_basis_raw: '100', budget_raw: '300', escrow_raw: '300',
});
console.log(job.state);              // accepted; no funding has occurred
console.log(plan.target_payout);     // 200: 50% gross-margin target
console.log(plan.recommended_payout);// 200: fits budget and escrow caps
