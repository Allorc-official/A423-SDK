import type { KeyObject } from 'node:crypto';
import type { KeyValueStore } from '../storage/index.js';
export interface Challenge {version: string;issuer: string;audience: string;id: string;agent_id: string;key_fingerprint: string;expires_at: number}
export interface Credential {credential: string;expires_at: number}
export interface Enrollment {organization: string;agentId: string;publicKey: string;scopes: string[]}
export interface Authority {
 publicKey: string;
 isActive(agentId: string): Promise<boolean>;
 registration(input: Enrollment): object;
 registerOrganization(input: {id: string;name: string;publicKey: string}): Promise<void>;
 revokeOrganization(id: string): Promise<void>;
 registerAgent(input: Enrollment & {organizationSignature: string}): Promise<void>;
 revokeAgent(id: string): Promise<void>;
 challenge(agentId: string): Promise<Challenge>;
 exchange(input: {challengeId: string;signature: string}): Promise<Credential>;
 verifyCredential(token: string, options?: {scope?: string}): Promise<{sub: string;org: string;scopes: string[];exp: number;[key: string]: unknown}>;
 pruneChallenges(): Promise<number>;
}
export function createAuthority(options: {issuer: string;audience: string;privateKey: string | KeyObject;kv: KeyValueStore;credentialTtlSeconds?: number;challengeTtlSeconds?: number;now?(): number}): Authority;
export function createCredentialAuthenticator(options: {authority: Pick<Authority,'verifyCredential'>;scope?: string}): (request: Request) => Promise<string | null>;
export function createCredentialProvider(options: {agentId: string;challenge(id: string): Promise<Challenge>;exchange(input: {challengeId: string;signature: string}): Promise<Credential>;signChallenge(bytes: Buffer): Promise<string>;refreshBeforeSeconds?: number;now?(): number}): () => Promise<string>;
export function createAuthorityHandler(options: {authority: Authority;basePath?: string;allowRequest?(request: Request): Promise<boolean>}): (request: Request) => Promise<Response>;

export function createCredentialVerifier(options: {issuer: string;audience: string;publicKey: string;isActive(payload: any): Promise<boolean>;maxTtlSeconds?: number;now?(): number}): Authority['verifyCredential'];
