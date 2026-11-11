import type { Provider, Signer, TypedDataField, InterfaceAbi } from 'ethers';
import type { WorkflowJob, AdapterContext, AdapterResult, Transition } from '../workflow.js';
export interface EscrowConfiguration { chainId: number; contractAddress: string; tokenAddress: string }
export interface ContractTerms {
  jobId: string; payer: string; worker: string; verifier: string; arbitrator: string;
  amount: bigint; workDeadline: number; reviewDeadline: number; resolutionDeadline: number;
  timeoutWorkerBps: number; agreementHash: string;
}
export interface TransactionRecord { created_at?: string; replacements?: TransactionRecord[]; hash: string; raw: string; to: string; data: string; from: string }
export interface TransactionStore {
  get(id: string): Promise<TransactionRecord | null>;
  list(): Promise<Array<TransactionRecord & {id: string}>>;
  appendReplacement(id: string, expectedHash: string, replacement: TransactionRecord): Promise<void>;
  /** Atomic insert if absent; caller reads winner before broadcasting. */
  create(id: string, record: TransactionRecord): Promise<boolean>;
  /** Atomically reserve a nonce per chain/address; same operationId always returns same nonce. */
  reserveNonce(scope: string, minimum: number, operationId: string): Promise<number>;
}
export interface EscrowAdapter { execute(context: AdapterContext): Promise<AdapterResult>; reconcile(context: AdapterContext): Promise<AdapterResult> }
export interface EscrowAdapterOptions extends EscrowConfiguration {
  provider: Provider;
  /** Requires populateTransaction + offline signTransaction support; no silent wallet approval. */
  signerFor(actor: string): Promise<Signer>;
  addressFor(actor: string): Promise<string>;
  transactions: TransactionStore;
  authorizeTransaction(context: { job: WorkflowJob; operation: AdapterContext['operation']; actor: string; step: string; to: string; data: string; phase: 'sign' | 'broadcast' }): Promise<boolean>;
  confirmations: number;
  validateArtifact?(context: { job: WorkflowJob; resultHash: string }): Promise<boolean>;
}
export function createEscrowAdapters(options: EscrowAdapterOptions): Record<'fund'|'start'|'submit'|'verify'|'release'|'refund'|'dispute'|'resolve'|'timeout'|'propose_settlement'|'counter_settlement'|'accept_settlement', EscrowAdapter>;
export function createMemoryTransactionStore(): TransactionStore;
export function escrowTerms(job: WorkflowJob, config: EscrowConfiguration): ContractTerms;
export function workerConsent(job: WorkflowJob, config: EscrowConfiguration): {
  domain: { name: string; version: string; chainId: number; verifyingContract: string };
  types: Record<string, TypedDataField[]>; value: ContractTerms;
};
export const escrowTransitions: Record<string, Transition>;
export const ESCROW_ABI: InterfaceAbi;
export const ESCROW_BYTECODE: string;

export function createEscrowRegistry(configurations: EscrowAdapterOptions[]): ReturnType<typeof createEscrowAdapters>;
export function createEvidenceRevalidator(options: EscrowConfiguration & {provider: Provider;confirmations: number}): (job: WorkflowJob,evidence: any) => Promise<{status: 'valid' | 'invalid' | 'insufficient_confirmations';[key: string]: unknown}>;
export function createManagedSigner(options: {address: string;provider: Provider;signDigest(digest: string,context: any): Promise<string>;authorize(context: any): Promise<boolean>}): Signer;
export function createDelegationAuthorizer(options: {expiresAt: number;chainIds: number[];contracts: string[];selectors: string[];maxValue?: string;maxFeePerGas: string;maxGasLimit: string;now?(): number}): (context: any) => Promise<boolean>;
export function replacePendingTransaction(options: {id: string;transactions: TransactionStore;provider: Provider;signer: Signer;authorize(context: any): Promise<boolean>;maxFeePerGas: bigint;maxPriorityFeePerGas: bigint}): Promise<{hash: string;raw: string}>;
export function createFeeReplacementWorker(options: {transactions: TransactionStore;provider: Provider;signerForRecord(record: TransactionRecord): Promise<Signer>;authorize(context: any): Promise<boolean>;minAgeMs?: number;maxAttempts?: number;maxFeePerGas: bigint;maxPriorityFeePerGas: bigint}): () => Promise<any[]>;

export function createEscrowIndexer(options: {provider: Provider;chainId: number;contractAddress: string;confirmations: number;fromBlock: number;kv: import('../storage/index.js').KeyValueStore;onEvent(event: any): Promise<void>;onReorg(event: any): Promise<void>;batchSize?: number}): () => Promise<{indexed: number;through?: number}>;

export function settlementProposal(job: WorkflowJob,input: {worker_amount: string;payer_amount?: string;expected_revision: number;expires_at: number;reason: string;claims?: import('../workflow.js').SettlementClaim[]}): import('../workflow.js').SettlementProposal;
export function settlementConsent(job: WorkflowJob,configuration: EscrowConfiguration): {domain: {name: string;version: string;chainId: number;verifyingContract: string};types: Record<string,TypedDataField[]>;value: {jobId: string;agreementHash: string;escrowVersion: number;workerAmount: bigint;payerAmount: bigint;proposalHash: string;expiresAt: number}};
