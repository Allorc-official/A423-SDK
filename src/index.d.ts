/** Experimental A423 workflow, not a finalized interoperable protocol. Node.js 22+. */
export const PROTOCOL_VERSION: 'a423.experimental.v1';
export type JobState = 'offered' | 'accepted' | 'submitted' | 'settlement_pending' | 'completed';
export interface Price { amount_minor: number; currency: string }
export interface OfferInput { worker_id: string; title: string; description: string; price: Price }
export interface SubmissionInput { deliverable: string }
export interface SettlementResult { status: 'settled' | 'not_configured'; reference: string | null }
export interface JobEvent {
  id: string; sequence: number; type: JobState; actor_id: string;
  at: string; data: { deliverable?: string; settlement?: SettlementResult };
}
export interface Job extends OfferInput {
  protocol: typeof PROTOCOL_VERSION;
  id: string; version: number; state: JobState; requester_id: string;
  request_hash: string; deliverable: string | null; settlement: SettlementResult | null;
  created_at: string; updated_at: string; events: JobEvent[];
}
export interface Receipts { job_id: string; state: JobState; settlement: SettlementResult | null; events: JobEvent[] }
/** All writes must be atomic across instances. Jobs and events are saved together. */
export interface StateStore {
  get(id: string): Promise<Job | null>;
  /** Atomically insert only if absent. Return true iff inserted. */
  create(job: Job): Promise<boolean>;
  /** Atomically replace only if version matches. Return true iff replaced. */
  compareAndSet(id: string, expectedVersion: number, job: Job): Promise<boolean>;
}
export interface SettlementAdapter {
  /** MUST persistently deduplicate idempotencyKey and return the same reference on retry. */
  settle(input: { job: Job; idempotencyKey: string }): Promise<{ reference: string }>;
}
export interface HandlerOptions {
  store: StateStore;
  /** Return the authenticated actor's agent ID, or null to reject. Never trust a caller-supplied ID alone. */
  authenticate(request: Request): Promise<string | null> | string | null;
  settlement?: SettlementAdapter;
  /** Default /api/a423; no trailing slash. */
  basePath?: string;
  /** Default 65536; max 1048576. Enforced while streaming, not just through Content-Length. */
  maxBodyBytes?: number;
  /** Receives internal errors for your server logs. Errors are not exposed in HTTP responses. */
  onError?(error: unknown): void | Promise<void>;
}
export class A423Error extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status?: number);
}
/** Development/testing only. Does not persist across processes, restarts or serverless instances. */
export function createMemoryStore(): StateStore;
export function createA423Handler(options: HandlerOptions): (request: Request) => Promise<Response>;
export interface ClientOptions {
  /** Full API root, e.g. https://example.com/api/a423. */
  baseUrl: string;
  headers?: HeadersInit | (() => HeadersInit | Promise<HeadersInit>);
  fetch?: typeof globalThis.fetch;
  /** Default 30000. No implicit retries. */
  timeoutMs?: number;
}
export interface A423Client {
  offer(input: OfferInput, options: { idempotencyKey: string }): Promise<Job>;
  getJob(id: string): Promise<Job>;
  accept(id: string): Promise<Job>;
  submit(id: string, input: SubmissionInput): Promise<Job>;
  approve(id: string): Promise<Job>;
  receipts(id: string): Promise<Receipts>;
}
export function createA423Client(options: ClientOptions): A423Client;
