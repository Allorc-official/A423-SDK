import type { Workflow, WorkflowJob, Json } from '../workflow.js';
import type { SqliteJobStore, DurableQueue, KeyValueStore, SpendingStore } from '../storage/index.js';
export interface Task {
 id: string; type: string; description: string;
 deliverables: Array<{id: string;media_type: string;description: string}>;
 acceptance: {validator: string;version: string;criteria: {[key: string]: Json}};
 inputs?: Json;
}
export interface EvidenceCheck {status: 'valid' | 'invalid' | 'insufficient_confirmations' | 'unavailable';[key: string]: unknown}
export type Revalidator = (job: WorkflowJob,evidence: any) => Promise<EvidenceCheck>;
export interface SigningContext {job: WorkflowJob;operation: any;actor: string;step: string;to: string;data: string;phase: 'sign' | 'broadcast'}
export function validateTask(task: unknown): Task;
export function validateEscrowEvidence(evidence: unknown): {[key: string]: Json};
export function createSpendingAuthorizer(options: {spending: SpendingStore;limitsFor(context: SigningContext): Promise<{perTransaction: string;daily: string;total: string}>;authorize(context: SigningContext): Promise<boolean>}): (context: SigningContext) => Promise<boolean>;
export function runMaintenanceOnce(options: {workflow: Workflow;store: SqliteJobStore;actorFor(job: WorkflowJob): Promise<string | null>;allowExecute?: boolean;now?: number}): Promise<Array<{id: string;state?: string;pending?: boolean;error?: string}>>;
export function createExpiryAdapter(options?: {now?(): number}): {execute(context: {job: WorkflowJob}): Promise<any>;reconcile(context: {job: WorkflowJob}): Promise<any>};
export function enqueueRunningJobs(options: {store: SqliteJobStore;queue: DurableQueue}): Promise<number>;
export function runExecutionOnce(options: {workflow: Workflow;queue: DurableQueue;execute(context: {job: WorkflowJob;idempotencyKey: string;signal: AbortSignal}): Promise<{result_hash: string;[key: string]: Json}>;beforeExecute(job: WorkflowJob): Promise<boolean>;leaseMs?: number}): Promise<WorkflowJob | null>;
export function createEventStream(options: {store: SqliteJobStore;authenticate(request: Request): Promise<string | null>;pollMs?: number;maxDurationMs?: number}): (request: Request) => Promise<Response>;
export function createWebhookDispatcher(options: {queue: DurableQueue;kv: KeyValueStore;subscriptions: Array<{id: string;actor: string;url: string;after?: number}>;secretFor(id: string): Promise<string>;fetch?: typeof fetch;timeoutMs?: number}): {project(store: SqliteJobStore): Promise<void>;deliverOne(): Promise<any>};
export function watchEvidenceOnce(options: {store: SqliteJobStore;revalidate: Revalidator}): Promise<any[]>;
export function freshReceipts(options: {workflow: Workflow;id: string;actor: string;revalidate: Revalidator}): Promise<object>;
export function renderReceiptPdf(receipt: object): Promise<Uint8Array>;
export function planLegacyMigration(records: Array<{id: string;state: string}>): Array<{id: string;state: string;automatic: false;reason: string}>;
export function migrateUnfundedLegacy(options: {records: Array<{id: string;state: string}>;workflow: Workflow;actor: string;map(source: any): Promise<Parameters<Workflow['create']>[0]>}): Promise<WorkflowJob[]>;
export function createChatTools(options: {workflow: Workflow;store: SqliteJobStore;queue: DurableQueue;actor: string}): Record<string,(input: any) => Promise<WorkflowJob>>;
export function createApplicationHandler(options: {workflow: Workflow;store: SqliteJobStore;queue: DurableQueue;authenticate(request: Request): Promise<string | null>;revalidate: Revalidator;consentFor?(job: WorkflowJob): Promise<object>;settlementConsentFor?(job: WorkflowJob): Promise<object>;legacyState?(actor: string): Promise<object>;authorityHandler?(request: Request): Promise<Response>;forwardCancellations?: boolean;basePath?: string}): (request: Request) => Promise<Response>;

export function createEscrowApplication(options: {storage: import('../storage/index.js').SqliteStorage;authority: import('../authority/index.js').Authority;escrows: Array<any>;signerFor(actor: string): Promise<any>;addressFor(actor: string): Promise<string>;limitsFor(context: SigningContext): Promise<{perTransaction: string;daily: string;total: string}>;approveSigning(context: SigningContext): Promise<boolean>;validateArtifact(context: {job: WorkflowJob;resultHash: string}): Promise<boolean>;execute?(context: {job: WorkflowJob;idempotencyKey: string;signal: AbortSignal}): Promise<{result_hash: string;[key: string]: Json}>;keeperEnabled?: boolean;forwardCancellations?: boolean;allowAuthorityRequest?(request: Request): Promise<boolean>;requireIndependentArbitrator?: boolean}): {workflow: Workflow;applicationOptions: Parameters<typeof createApplicationHandler>[0];workerOptions: any;handler: (request: Request) => Promise<Response>;chatTools(actor: string): ReturnType<typeof createChatTools>};

export function freshCancellationReceipt(options: {workflow: Workflow;id: string;actor: string;revalidate: Revalidator}): Promise<import('../workflow.js').CancellationReceipt>;
