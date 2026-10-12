/**
 * Approvals as data, signed — and rulebooks signed.
 *
 * Ed25519 through the platform's WebCrypto (`globalThis.crypto.subtle`:
 * Node 20+, modern browsers). No dependencies. Signatures are deterministic,
 * so another implementation can reproduce every test vector exactly.
 *
 * Evaluation stays pure and synchronous: the caller verifies a signed
 * approval here (async) BEFORE evaluating, and passes the verified approval
 * in as `facts.approvedBy`. When the rulebook declares `trustedKeys`, the
 * evaluator clears an approval wait only for an approval marked
 * `verified: true` whose `requestDigest` and `rulebookFingerprint` match.
 *
 * Encodings (SPEC.md § Approvals):
 *   public key   raw Ed25519, 32 bytes, lowercase hex
 *   private key  the 32-byte seed, lowercase hex (PKCS#8 wrapping is internal)
 *   signature    64 bytes, lowercase hex
 *   signed text  UTF-8 of the canonical JSON of the object without `signature` (and without `verified`)
 */

import type { Approval, Rulebook, SignedApproval, TrustedKey } from './types';
import { canonicalJson } from './canonical';

export interface SigningKeys {
  keyId: string;
  /** Raw public key, 32 bytes as hex. Put this in the rulebook's `trustedKeys`. */
  publicKey: string;
  /** The 32-byte seed as hex. Keep it secret; for tests and examples only, see `conformance/approvals.json`. */
  privateKey: string;
}

export interface VerifyResult {
  ok: boolean;
  /** Plain words when not ok. */
  reason?: string;
  /** On success: the approval with `verified: true`, ready for `facts.approvedBy`. */
  approval?: Approval;
}

const PKCS8_PREFIX = '302e020100300506032b657004220420';
const HEX = /^[0-9a-f]+$/;

function subtle(): SubtleCrypto {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error('WebCrypto (globalThis.crypto.subtle) is not available; Node 20+ or a modern browser is needed for signatures.');
  return s;
}

function fromHex(hex: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function toHex(bytes: ArrayBuffer | Uint8Array): string {
  return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Is this a lowercase hex string of exactly `bytes` bytes? */
export function isHexBytes(value: unknown, bytes: number): value is string {
  return typeof value === 'string' && value.length === bytes * 2 && HEX.test(value);
}

async function importPrivate(seedHex: string): Promise<CryptoKey> {
  if (!isHexBytes(seedHex, 32)) throw new Error('A private key is the 32-byte Ed25519 seed as lowercase hex.');
  return subtle().importKey('pkcs8', fromHex(PKCS8_PREFIX + seedHex), { name: 'Ed25519' }, false, ['sign']);
}

async function importPublic(hex: string): Promise<CryptoKey> {
  if (!isHexBytes(hex, 32)) throw new Error('A public key is the raw 32-byte Ed25519 key as lowercase hex.');
  return subtle().importKey('raw', fromHex(hex), { name: 'Ed25519' }, false, ['verify']);
}

/** The bytes that get signed: canonical JSON of everything but `signature` and `verified`. */
export function signedText(value: Record<string, unknown>): string {
  const { signature: _s, verified: _v, ...rest } = value;
  return canonicalJson(rest);
}

/** A fresh Ed25519 key pair. A helper for examples and tests; production keys live in your own key management. */
export async function generateSigningKeys(keyId: string): Promise<SigningKeys> {
  const pair = await subtle().generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']) as unknown as { publicKey: CryptoKey; privateKey: CryptoKey };
  const pkcs8 = toHex(await subtle().exportKey('pkcs8', pair.privateKey));
  return { keyId, publicKey: toHex(await subtle().exportKey('raw', pair.publicKey)), privateKey: pkcs8.slice(PKCS8_PREFIX.length) };
}

/** The public key for a seed, so a test key can be stated as a seed alone. */
export async function publicKeyOf(privateKey: string): Promise<string> {
  const key = await subtle().importKey('pkcs8', fromHex(PKCS8_PREFIX + privateKey), { name: 'Ed25519' }, true, ['sign']);
  const jwk = await subtle().exportKey('jwk', key);
  return toHex(Uint8Array.from(atob((jwk.x as string).replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)));
}

async function sign(text: string, privateKey: string): Promise<string> {
  return toHex(await subtle().sign('Ed25519', await importPrivate(privateKey), new TextEncoder().encode(text)));
}

async function verify(text: string, signature: string, publicKey: string): Promise<boolean> {
  if (!isHexBytes(signature, 64)) return false;
  return subtle().verify('Ed25519', await importPublic(publicKey), fromHex(signature), new TextEncoder().encode(text));
}

/** Sign an approval. `issuedAt` is whatever clock the approver's tool has; the core never reads one. */
export async function signApproval(approval: Omit<SignedApproval, 'signature' | 'keyId'>, keys: Pick<SigningKeys, 'keyId' | 'privateKey'>): Promise<SignedApproval> {
  const body: Omit<SignedApproval, 'signature'> = { ...approval, keyId: keys.keyId };
  return { ...body, signature: await sign(signedText(body as unknown as Record<string, unknown>), keys.privateKey) };
}

/**
 * Verify a signed approval against the rulebook's trusted keys (or a list of
 * them). Checks: shape, a trusted key with that keyId, the signature, and that
 * the approval claims no authority or role the key is not trusted for.
 * It does NOT check the request digest or the rulebook fingerprint — the
 * evaluator does that against the actual request — and it does not check
 * `issuedAt`: the core has no clock, so age is the caller's decision.
 */
export async function verifyApproval(approval: unknown, trusted: Rulebook | TrustedKey[]): Promise<VerifyResult> {
  const keys = Array.isArray(trusted) ? trusted : trusted.trustedKeys ?? [];
  const a = approval as SignedApproval;
  if (!a || typeof a !== 'object') return { ok: false, reason: 'the approval is not an object' };
  for (const field of ['id', 'requestDigest', 'rulebookFingerprint', 'issuedAt', 'keyId', 'signature'] as const) {
    if (typeof a[field] !== 'string' || a[field].length === 0) return { ok: false, reason: `the approval has no ${field}` };
  }
  const key = keys.find(k => k.keyId === a.keyId);
  if (!key) return { ok: false, reason: `key "${a.keyId}" is not a trusted key` };
  if (a.authority !== undefined && key.authority !== a.authority) return { ok: false, reason: `key "${a.keyId}" is not trusted to approve as authority "${a.authority}"` };
  if (a.roleId !== undefined && key.roleId !== a.roleId) return { ok: false, reason: `key "${a.keyId}" is not trusted to approve as role "${a.roleId}"` };
  if (!(await verify(signedText(a as unknown as Record<string, unknown>), a.signature, key.publicKey))) return { ok: false, reason: 'the signature does not verify' };
  const { signature: _s, verified: _v, ...rest } = a as SignedApproval & { verified?: boolean };
  return { ok: true, approval: { ...rest, signature: a.signature, verified: true } };
}

export interface RulebookSignature {
  keyId: string;
  /** The fingerprint that was signed, for the record. The signature covers the whole rulebook, not just this. */
  fingerprint: string;
  signature: string;
}

/** Sign a compiled rulebook: Ed25519 over the canonical JSON of the whole rulebook (fingerprint included). */
export async function signRulebook(rulebook: Rulebook, keys: Pick<SigningKeys, 'keyId' | 'privateKey'>): Promise<RulebookSignature> {
  return { keyId: keys.keyId, fingerprint: rulebook.fingerprint, signature: await sign(canonicalJson(rulebook), keys.privateKey) };
}

/**
 * Verify a rulebook's signature with a public key you trust from outside the
 * rulebook (pinned in your deployment). The rulebook's own `trustedKeys` are
 * for approvals; a rulebook cannot vouch for itself.
 */
export async function verifyRulebookSignature(rulebook: Rulebook, signature: RulebookSignature | string, publicKey: string): Promise<boolean> {
  const sig = typeof signature === 'string' ? signature : signature.signature;
  if (!rulebook || typeof rulebook !== 'object') return false;
  return verify(canonicalJson(rulebook), sig, publicKey);
}
