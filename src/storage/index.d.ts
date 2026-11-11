import type { WorkflowStore, WorkflowJob, Json } from '../workflow.js';
export interface TransactionRecord {hash: string;raw: string;to: string;data: string;from: string;created_at?: string;replacements?: TransactionRecord[]}
export interface TransactionStore {get(id: string): Promise<TransactionRecord | null>;create(id: string,record: TransactionRecord): Promise<boolean>;reserveNonce(scope: string,minimum: number,operationId: string): Promise<number>;list(): Promise<Array<TransactionRecord & {id: string}>>;appendReplacement(id: string,expectedHash: string,replacement: TransactionRecord): Promise<void>}
export interface Safety { blocked: boolean; checks: Array<{status: string; [key: string]: unknown}>; checked_at: string }
export interface SqliteJobStore extends WorkflowStore {
 list(options?: {actor?: string; after?: string; limit?: number}): Promise<WorkflowJob[]>;
 events(options: {actor: string; after?: number; limit?: number}): Promise<Array<{cursor: number; job_id: string; sequence: number; type: string; actor_id: string; at: string; data: Json}>>;
 getSafety(id: string): Promise<Safety | null>;
 setSafety(id: string, value: Safety): Promise<void>;
}
export interface KeyValueStore {
 get(namespace: string,id: string): Promise<any>;
 put(namespace: string,id: string,value: unknown): Promise<void>;
 create(namespace: string,id: string,value: unknown): Promise<boolean>;
 take(namespace: string,id: string): Promise<any>;
 list(namespace: string): Promise<Array<{id: string; value: any}>>;
}
export interface QueueItem {id: string; kind: string; payload: any; lease: string; attempts: number; result: any}
export interface DurableQueue {
 enqueue(input: {id: string; kind: string; payload: unknown; availableAt?: number}): Promise<boolean>;
 claim(options: {kind: string; leaseMs?: number; now?: number}): Promise<QueueItem | null>;
 heartbeat(id: string, lease: string, options?: {leaseMs?: number; now?: number}): Promise<boolean>;
 checkpoint(id: string, lease: string, result: unknown, options?: {now?: number}): Promise<boolean>;
 complete(id: string, lease: string, result: unknown, options?: {now?: number}): Promise<boolean>;
 retry(id: string, lease: string, options?: {delayMs?: number; now?: number; maxAttempts?: number}): Promise<boolean>;
 get(id: string): Promise<{id: string; kind: string; payload: unknown; status: string; attempts: number; result: unknown} | null>;
}
export interface SpendingStore {
 reserve(input: {id: string;scope: string;amount: string;perTransaction: string;daily: string;total: string;now?: number}): Promise<boolean>;
 release(id: string): Promise<void>;
}
export interface SqliteStorage {
 jobs: SqliteJobStore; transactions: TransactionStore; kv: KeyValueStore; queue: DurableQueue; spending: SpendingStore;
 resetDevelopmentData(options: {chainId: number;confirm: 'RESET_LOCAL_A423';assertChainReset(): Promise<boolean>;includeAuthority?: boolean;dryRun?: boolean}): Promise<{dryRun: boolean;counts: Record<string,number>;includeAuthority: boolean}>;
 close(): void;
}
export function createSqliteStorage(options: {filename: string;busyTimeoutMs?: number}): SqliteStorage;
