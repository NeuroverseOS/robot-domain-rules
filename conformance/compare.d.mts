/** Types for compare.mjs (kept in plain JavaScript so any Node can load it). */
export interface ConformanceCase {
  id: string;
  principle: number[];
  description: string;
  rulebook?: unknown;
  rulebookRef?: string;
  request?: unknown;
  value?: unknown;
  approval?: unknown;
  trustedKeys?: unknown;
  signature?: unknown;
  publicKey?: string;
  expect: Record<string, unknown>;
}
export interface LoadedCase { file: string; case: ConformanceCase; rulebook: unknown }
export interface Impl {
  evaluate: (rulebook: never, request: never) => unknown;
  check: (rulebook: never) => unknown;
  validate: (rulebook: unknown) => string[];
  canonical: (value: unknown) => string;
  fingerprint: (value: unknown) => string;
  requestDigest: (request: never) => string;
  verifyApproval: (approval: unknown, keys: never) => Promise<{ ok: boolean; reason?: string }>;
  verifyRulebookSignature: (rulebook: never, signature: never, publicKey: string) => Promise<boolean>;
}
export function projectDecision(d: unknown): unknown;
export function projectFindings(findings: unknown): unknown;
export function deepEqual(a: unknown, b: unknown): boolean;
export function runCase(c: ConformanceCase, impl: Impl, rulebook: unknown): Promise<string | null>;
export function loadCases(fs: unknown, path: unknown, dir: string): Promise<LoadedCase[]>;
