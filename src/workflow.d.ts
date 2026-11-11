export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface Agreement { revision: number; terms: { [key: string]: Json }; hash: string; accepted_by: string[] }
export interface Operation { id: string; key: string; action: string; actor: string; input: Json; request_hash: string; target: string; created_at: string; observation: AdapterResult | null }
export interface AdapterResult { status: 'pending' | 'confirmed' | 'rejected'; evidence?: { [key: string]: Json }; [key: string]: Json | undefined }
export interface WorkflowJob {
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
  receipts(id: string, actor: string): Promise<Pick<WorkflowJob, 'protocol' | 'state' | 'agreement' | 'submission' | 'evidence' | 'events' | 'pending'> & { job_id: string }>;
}
export function hashAgreement(terms: Json): string;
export function createWorkflow(options: WorkflowOptions): Workflow;
export function createWorkflowHandler(options: {
  workflow: Workflow; authenticate(request: Request): string | null | Promise<string | null>;
  basePath?: string; maxBodyBytes?: number; onError?(error: unknown): void | Promise<void>;
}): (request: Request) => Promise<Response>;
export interface WorkflowClient {
  /** Supply a stable id so creation retries can be resolved with get(id). */
  create(input: Parameters<Workflow['create']>[0]): Promise<WorkflowJob>;
  get(id: string): Promise<WorkflowJob>;
  act(id: string, action: string, input: Json, options: { idempotencyKey: string }): Promise<WorkflowJob>;
  reconcile(id: string): Promise<WorkflowJob>;
  receipts(id: string): ReturnType<Workflow['receipts']>;
}
export function createWorkflowClient(options: {
  baseUrl: string; headers?: HeadersInit | (() => HeadersInit | Promise<HeadersInit>);
  fetch?: typeof globalThis.fetch; timeoutMs?: number;
}): WorkflowClient;
