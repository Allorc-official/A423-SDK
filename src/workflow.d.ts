export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface Agreement { revision: number; terms: { [key: string]: Json }; hash: string; accepted_by: string[] }
export interface Operation { id: string; key: string; action: string; actor: string; input: Json; request_hash: string; target: string; created_at: string; observation: AdapterResult | null }
export interface AdapterResult { status: 'pending' | 'confirmed' | 'rejected'; evidence?: { [key: string]: Json }; [key: string]: Json | undefined }
export interface SettlementClaim {kind: 'work' | 'expense' | 'other';description: string;amount?: string;evidence?: string[]}
export interface SettlementProposal {version: 'a423.closing.v1';job_id: string;agreement_hash: string;escrow_version: number;worker_amount: string;payer_amount: string;expires_at: number;reason: string;claims: SettlementClaim[];closes_job: true;proposal_hash: string;proposer_id?: string;at?: string}
export interface Negotiation {status: 'open' | 'accepted' | 'disputed' | 'settled';acceptance_basis?: 'dual_wallet_signatures';origin_state: string;current: SettlementProposal;history: SettlementProposal[];accepted_by?: string;settled_at?: string}
export interface EscrowLedger {funded_amount: string;worker_paid: string;payer_refunded: string;locked_amount: string;escrow_version: number}
export interface CancellationInstruction {
 id: string;version: 'a423.cancellation_instruction.v1';purpose: 'close_job';funds_status: 'not_executed';job_id: string;subflow_id: string;agreement_hash: string;chain_id: string;escrow_contract: string;token: string;onchain_job_id: string;escrow_version: number;proposal_hash: string;expires_at: number;
 payer: {agent_id: string;address: string;amount: string};worker: {agent_id: string;address: string;amount: string};proposal: SettlementProposal;
 authorization: {scheme: 'eip712_closing_settlement_v1';payer_signature: string;worker_signature: string};
}
export interface CancellationReceipt {
 id: string;version: 'a423.cancellation_receipt.v1';status: 'confirmed';job_id: string;subflow_id: string;agreement_hash: string;outcome: string;instruction_id: string | null;prior_instruction_id: string | null;
 allocations: {worker: {address: string;amount: string};payer: {address: string;amount: string}};remaining_locked: '0';evidence: {[key: string]: Json};
}
export interface CancellationSubflow {
 id: string;kind: 'cancellation';parent_job_id: string;status: 'proposal_pending'|'proposal_rejected'|'negotiating'|'acceptance_pending'|'accepted'|'execution_pending'|'execution_failed'|'completed'|'disputed';started_at: string;updated_at: string;proposal_revision: number;instruction: CancellationInstruction | null;receipt: CancellationReceipt | null;events: Array<{sequence: number;type: string;actor_id: string;at: string;data: Json}>;accepted_at?: string;approved_by?: string[];completed_at?: string;execution_reference?: string | null;closing_action?: string;last_error?: string | null;
}
export interface CancellationApproval {expected_revision: number;proposal_hash: string;payer_signature: string;worker_signature: string}
export interface WorkflowJob {
  subflows?: CancellationSubflow[];active_subflow_id?: string | null;
  work_status?: string;negotiation?: Negotiation | null;escrow_ledger?: EscrowLedger | null;
  id: string; protocol: 'a423.workflow.v1'; version: number; state: string;
  participants: { requester: string; worker: string; verifier: string; [role: string]: string };
  metadata: Json; agreement: Agreement | null; submission: Json;
  pending: Operation | null;
  operations: Record<string, { request_hash: string; status: string; result: AdapterResult }>;
  evidence: Array<{ action: string; operation_id: string; evidence: { [key: string]: Json } }>;
  events: Array<{ sequence: number; type: string; actor_id: string; at: string; data: Json }>;
  created_at: string; updated_at: string;
}
export interface WorkflowStore {
  get(id: string): Promise<WorkflowJob | null>;
  create(job: WorkflowJob): Promise<boolean>;
  compareAndSet(id: string, expectedVersion: number, job: WorkflowJob): Promise<boolean>;
}
export interface AdapterContext { job: WorkflowJob; input: Json; operation: Operation }
export type Effect = (context: AdapterContext) => Promise<AdapterResult>;
export interface Transition { from: string[]; roles: string[]; to: string; effect?: boolean }
export interface WorkflowOptions {
  store: WorkflowStore;
  adapters?: Record<string, Effect | { execute: Effect; reconcile?: Effect }>;
  /** Return true to allow; authenticated actor ID must be supplied by your application. */
  authorize?(context: { job: WorkflowJob; action: string; actor: string; input: Json }): boolean | Promise<boolean>;
  /** Throw to reject application-specific terms. */
  validateEvidence?(context: {job: WorkflowJob;action: string;evidence: {[key: string]: Json}}): void | Promise<void>;
  validateTerms?(terms: { [key: string]: Json }): void | Promise<void>;
  /** Explicit overrides replace the full rule; application is responsible for its invariants. */
  transitions?: Record<string, Transition>;
}
export interface Workflow {
  create(input: { id?: string; participants: WorkflowJob['participants']; metadata?: Json }, actor: string): Promise<WorkflowJob>;
  get(id: string, actor: string): Promise<WorkflowJob>;
  assertSafe(id: string, actor: string): Promise<WorkflowJob>;
  act(id: string, action: string, input: Json, options: { actor: string; idempotencyKey: string }): Promise<WorkflowJob>;
  resume(id: string, actor: string): Promise<WorkflowJob>;
  reconcile(id: string, actor: string): Promise<WorkflowJob>;
  cancellation(id: string, actor: string): Promise<CancellationSubflow | null>;
  cancellationInstruction(id: string, actor: string): Promise<CancellationInstruction>;
  cancellationReceipt(id: string, actor: string): Promise<CancellationReceipt>;
  acceptCancellation(id: string,input: CancellationApproval,options: {actor: string;idempotencyKey: string;forward?: boolean}): Promise<WorkflowJob>;
  receipts(id: string, actor: string): Promise<Pick<WorkflowJob, 'protocol' | 'state' | 'agreement' | 'submission' | 'evidence' | 'events' | 'pending' | 'work_status' | 'negotiation' | 'escrow_ledger' | 'subflows' | 'active_subflow_id'> & { job_id: string }>;
}
export function hashAgreement(terms: Json): string;
export function createWorkflow(options: WorkflowOptions): Workflow;
export function createWorkflowHandler(options: {
  workflow: Workflow; authenticate(request: Request): string | null | Promise<string | null>;
  basePath?: string; maxBodyBytes?: number; forwardCancellations?: boolean; revalidateCancellationReceipt?(context: {job: WorkflowJob;receipt: CancellationReceipt;actor: string}): Promise<void>; onError?(error: unknown): void | Promise<void>;
}): (request: Request) => Promise<Response>;
export interface WorkflowClient {
  /** Supply a stable id so creation retries can be resolved with get(id). */
  create(input: Parameters<Workflow['create']>[0]): Promise<WorkflowJob>;
  get(id: string): Promise<WorkflowJob>;
  act(id: string, action: string, input: Json, options: { idempotencyKey: string }): Promise<WorkflowJob>;
  reconcile(id: string): Promise<WorkflowJob>;
  cancellation(id: string): Promise<CancellationSubflow | null>;
  cancellationInstruction(id: string): Promise<CancellationInstruction>;
  cancellationReceipt(id: string): Promise<CancellationReceipt>;
  subflows(id: string): Promise<CancellationSubflow[]>;
  acceptCancellation(id: string,input: CancellationApproval,options: {idempotencyKey: string}): Promise<WorkflowJob>;
  executeCancellation(id: string,input: {instruction_id: string;transaction_hash?: string},options: {idempotencyKey: string}): Promise<WorkflowJob>;
  receipts(id: string): ReturnType<Workflow['receipts']>;
}
export function createWorkflowClient(options: {
  baseUrl: string; headers?: HeadersInit | (() => HeadersInit | Promise<HeadersInit>);
  fetch?: typeof globalThis.fetch; timeoutMs?: number;
}): WorkflowClient;

export function getCancellationSubflow(job: WorkflowJob): CancellationSubflow | null;
export function createCancellationInstruction(job: WorkflowJob,proofs: {payer_signature: string;worker_signature: string}): CancellationInstruction;
export function validateCancellationInstruction(job: WorkflowJob,instruction: CancellationInstruction): CancellationInstruction;
export function validateCancellationReceipt(job: WorkflowJob,receipt: CancellationReceipt): CancellationReceipt;
