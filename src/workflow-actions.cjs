'use strict';
const DEFAULT_TRANSITIONS = {
  quote: { from: ['draft', 'quoted', 'accepted'], roles: ['requester', 'worker'], to: 'quoted' },
  accept: { from: ['quoted'], roles: ['requester', 'worker'], to: 'quoted' },
  fund: { from: ['accepted'], roles: ['requester'], to: 'funded', effect: true },
  start: { from: ['funded'], roles: ['worker'], to: 'running', effect: true },
  submit: { from: ['running'], roles: ['worker'], to: 'submitted', effect: true },
  verify: { from: ['submitted'], roles: ['verifier'], to: 'verified', effect: true },
  release: { from: ['verified'], roles: ['verifier'], to: 'paid', effect: true },
  refund: { from: ['funded', 'running'], roles: ['requester'], to: 'refunded', effect: true },
  decline: { from: ['draft', 'quoted', 'accepted'], roles: ['worker'], to: 'cancelled' },
  reopen: { from: ['cancelled'], roles: ['requester', 'worker'], to: 'draft' },
  cancel: { from: ['draft', 'quoted', 'accepted'], roles: ['requester'], to: 'cancelled' },
  expire: { from: ['draft', 'quoted', 'accepted'], roles: ['requester', 'worker'], to: 'expired', effect: true },
  dispute: { from: ['submitted', 'verified'], roles: ['requester', 'worker', 'verifier'], to: 'disputed' },
  resolve: { from: ['disputed'], roles: ['verifier'], to: 'resolved', effect: true }
};
const ESCROW_TRANSITIONS = {
  approve_cancellation: {from:['settlement_negotiation'],roles:['requester','worker'],to:'settlement_negotiation',effect:true},
  execute_cancellation: {from:['settlement_negotiation'],roles:['requester','worker'],to:'settled',effect:true},
  propose_settlement: {from:['funded','running','submitted','verified'],roles:['requester','worker'],to:'settlement_negotiation',effect:true},
  counter_settlement: {from:['settlement_negotiation'],roles:['requester','worker'],to:'settlement_negotiation',effect:true},
  accept_settlement: {from:['settlement_negotiation'],roles:['requester','worker'],to:'settled',effect:true},
  refund: {from:['funded','running','settlement_negotiation','disputed'],roles:['requester'],to:'refunded',effect:true},
  dispute: {from:['funded','running','submitted','verified','settlement_negotiation'],roles:['requester','worker','verifier'],to:'disputed',effect:true},
  resolve: {from:['disputed'],roles:['arbitrator'],to:'settled',effect:true},
  timeout: {from:['funded','running','submitted','verified','disputed','settlement_negotiation'],roles:['requester','worker','verifier','arbitrator'],to:'settled',effect:true}
};
const SDK_ACTIONS=Object.freeze(['create',...new Set([...Object.keys(DEFAULT_TRANSITIONS),...Object.keys(ESCROW_TRANSITIONS)])]);
module.exports={DEFAULT_TRANSITIONS,ESCROW_TRANSITIONS,SDK_ACTIONS};
