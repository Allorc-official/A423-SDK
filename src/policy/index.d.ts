import type {WorkflowJob,Json} from '../workflow.js';
import type {KeyValueStore} from '../storage/index.js';
export interface PolicyConfiguration {target_margin_bps?: number;min_margin_bps?: number;max_margin_bps?: number;require_counter?: boolean}
export interface PolicyInput {cost_basis_raw: string;budget_raw: string;escrow_raw: string;offer_raw?: string;negotiation_round?: number}
export interface PolicyEvaluation extends Required<PolicyConfiguration> {
 version: 'a423.profit_policy.v1';cost_basis_raw: string;budget_raw: string;escrow_raw: string;affordable: string;target_payout: string;min_payout: string;max_payout: string;recommended_payout: string;expected_profit: string;expected_margin_bps: string | null;viability: 'no_cost'|'below_cost'|'below_minimum'|'below_target'|'target_affordable';decision: 'refund'|'propose'|'counter'|'accept'|'owner_approval_required';requires_owner_approval: boolean;offer_issue: string | null;offer_raw: string | null;offer_profit_raw: string | null;offer_margin_bps: string | null;negotiation_round: number;
}
export interface SettlementPolicy {readonly configuration: Readonly<Required<PolicyConfiguration>>;evaluate(input: PolicyInput): PolicyEvaluation}
export type CostBasisProvider=(job: WorkflowJob)=>Promise<string>;
export interface ProfitProjection extends PolicyEvaluation {advisory: true;receipt_confirmed: boolean;projected_payout_raw: string;projected_profit_raw: string;projected_margin_bps: string | null;target_status: 'target_met'|'below_target';realized_payout_raw: string | null;realized_profit_raw: string | null;realized_margin_bps: string | null}
export interface PolicyContext {job: WorkflowJob;actor: string;action: string;input: any}
export interface ProfitServiceOptions {kv: KeyValueStore;costBasisFor: CostBasisProvider;budgetFor(job: WorkflowJob): Promise<string>;policy?: SettlementPolicy;approveException?(context: {job: WorkflowJob;actor: string;action: string;payout_raw: string;evaluation: PolicyEvaluation;proposal_hash: string | null}): Promise<{approved: boolean;approval_id?: string} | null>;canViewPrivate?(context: {job: WorkflowJob;actor: string}): Promise<boolean>}
export function createSettlementPolicy(options?: PolicyConfiguration): SettlementPolicy;
export function profitProjection(input: {evaluation: PolicyEvaluation;payout_raw: string;confirmed?: boolean}): ProfitProjection;
export function settlementPolicyPrompt(options?: {role?: 'worker'|'requester';policy?: SettlementPolicy;override?: string}): string;
export function createProfitSettlementService(options: ProfitServiceOptions): {
 evaluate(job: WorkflowJob,options?: {freeze?: boolean;offer_raw?: string}): Promise<PolicyEvaluation>;
 prepare(context: PolicyContext): Promise<Json>;
 authorize(context: PolicyContext): Promise<boolean>;
 project(job: WorkflowJob,actor: string,options?: {revalidate?(job: WorkflowJob,evidence: any): Promise<{status: string}>}): Promise<(ProfitProjection & {basis_frozen: boolean;evidence_status: string}) | {advisory: true;proposed_payout_raw: string | null;realized_payout_raw: string | null;receipt_confirmed: boolean;evidence_status: string} | null>;
 prompt(options?: {role?: 'worker'|'requester';override?: string}): string;
};
