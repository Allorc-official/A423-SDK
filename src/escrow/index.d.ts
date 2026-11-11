import type { Provider, Signer, TypedDataField, InterfaceAbi } from 'ethers';
import type { WorkflowJob, AdapterContext, AdapterResult, Transition } from '../workflow.js';
export interface EscrowConfiguration { chainId: number; contractAddress: string; tokenAddress: string }
export interface ContractTerms {
  jobId: string; payer: string; worker: string; verifier: string; arbitrator: string;
  amount: bigint; workDeadline: number; reviewDeadline: number; resolutionDeadline: number;
  timeoutWorkerBps: number; agreementHash: string;
}
export interface TransactionRecord { hash: string; raw: string; to: string; data: string; from: string }
export interface TransactionStore {
  get(id: string): Promise<TransactionRecord | null>;
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
  confirmations: number;
  validateArtifact?(context: { job: WorkflowJob; resultHash: string }): Promise<boolean>;
}
export function createEscrowAdapters(options: EscrowAdapterOptions): Record<'fund'|'start'|'submit'|'verify'|'release'|'refund'|'dispute'|'resolve'|'timeout', EscrowAdapter>;
export function createMemoryTransactionStore(): TransactionStore;
export function escrowTerms(job: WorkflowJob, config: EscrowConfiguration): ContractTerms;
export function workerConsent(job: WorkflowJob, config: EscrowConfiguration): {
  domain: { name: string; version: string; chainId: number; verifyingContract: string };
  types: Record<string, TypedDataField[]>; value: ContractTerms;
};
export const escrowTransitions: Record<string, Transition>;
export const ESCROW_ABI: InterfaceAbi;
export const ESCROW_BYTECODE: string;
