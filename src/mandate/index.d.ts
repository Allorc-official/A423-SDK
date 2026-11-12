import type {WorkflowJob} from '../workflow.js';
import type {KeyValueStore,SpendingStore} from '../storage/index.js';
export type SDKAction='create'|'quote'|'accept'|'fund'|'start'|'submit'|'verify'|'release'|'refund'|'decline'|'reopen'|'cancel'|'expire'|'dispute'|'resolve'|'timeout'|'propose_settlement'|'counter_settlement'|'accept_settlement'|'approve_cancellation'|'execute_cancellation';
export const SDK_ACTIONS: readonly SDKAction[];
export type MandateDuration='lifetime'|{weeks: number}|{days: number}|{hours: number}|{seconds: number};
export interface MandateBudget {chainId?: number;tokenAddress?: string;perTransaction?: string | null;daily?: string | null;total?: string | null}
export interface Mandate {id?: string;agentId: string;actions?: 'all' | SDKAction[];budget?: MandateBudget | null;duration?: MandateDuration;/** Unix seconds. Omitted/null/Infinity means no expiry. */expiresAt?: number | null}
export interface NormalizedMandate {version: 'a423.mandate.v1';id: string;agentId: string;actions: 'all' | SDKAction[];budget: (Required<MandateBudget> & {chainId: number;tokenAddress: string}) | null;lifetime: {kind:'lifetime'}|{kind:'expires_at';expiresAt:number}|{kind:'duration';seconds:number}}
export interface EffectiveMandate extends Omit<NormalizedMandate,'id'> {id: string | null;registeredAt: number | null;expiresAt: number | null;fingerprint?: string}
export interface MandateRegistry {
 ready(): Promise<void>;
 get(agentId: string): Promise<EffectiveMandate>;
 list(): Promise<EffectiveMandate[]>;
 authorize(context: {actor: string;action: string;phase?: string}): Promise<boolean>;
 reserveBudget(context: {actor: string;action?: SDKAction;requestId: string;amount: string;chainId: number;tokenAddress: string}): Promise<boolean>;
 authorizeTransaction(context: {actor: string;step: string;job: WorkflowJob;operation: {action?: string;[key: string]: any};[key: string]: any}): Promise<boolean>;
}
export function normalizeMandate(input: Mandate): NormalizedMandate;
export function createMandateRegistry(options: {mandates?: Mandate[];kv: KeyValueStore;spending: SpendingStore;now?(): number}): MandateRegistry;
