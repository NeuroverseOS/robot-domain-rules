/**
 * Shareable state: the rulebook state and the situation, compressed
 * (deflate-raw via CompressionStream when available) and base64url-encoded
 * into the URL hash. The same payload is kept in localStorage.
 *
 * Hash format: `#s=<flag><payload>` where flag is `z` (deflated) or `p` (plain JSON).
 */

import type { RulebookState } from './model';
import type { Situation } from './situation';
import type { PlanState } from './plan';

export interface SharedState {
  v: 1;
  rulebook: RulebookState;
  situation: Situation;
  /** Plan mode (0.5) and Test mode (0.5.1). Absent in links made before they existed. A test log is never in the link. */
  mode?: 'ask' | 'plan' | 'test';
  plan?: PlanState;
}

export const STORAGE_KEY = 'robot-domain-rules.switchboard.v1';

const te = new TextEncoder();
const asBuffer = (u: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(u) as Uint8Array<ArrayBuffer>;
const td = new TextDecoder();

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

async function pipe(bytes: Uint8Array<ArrayBuffer>, stream: { readable: ReadableStream<Uint8Array>; writable: WritableStream<BufferSource> }): Promise<Uint8Array> {
  const writer = stream.writable.getWriter();
  const noop = () => undefined;
  writer.write(bytes).catch(noop);
  writer.close().catch(noop);
  const chunks: Uint8Array[] = [];
  const reader = stream.readable.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { out.set(c, offset); offset += c.length; }
  return out;
}

const hasCompression = () => typeof CompressionStream === 'function' && typeof DecompressionStream === 'function';

export async function encodeState(state: SharedState): Promise<string> {
  const json = te.encode(JSON.stringify(state));
  if (hasCompression()) {
    const packed = await pipe(asBuffer(json), new CompressionStream('deflate-raw'));
    return 'z' + toBase64Url(packed);
  }
  return 'p' + toBase64Url(json);
}

export async function decodeState(encoded: string): Promise<SharedState | null> {
  try {
    const flag = encoded[0];
    const body = fromBase64Url(encoded.slice(1));
    const json = flag === 'z'
      ? td.decode(await pipe(asBuffer(body), new DecompressionStream('deflate-raw')))
      : flag === 'p' ? td.decode(body) : null;
    if (json === null) return null;
    const parsed = JSON.parse(json) as SharedState;
    if (parsed?.v !== 1 || !parsed.rulebook?.input?.site || !parsed.situation?.participant) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function hashPayload(hash: string): string | null {
  const m = /[#&]s=([A-Za-z0-9_-]+)/.exec(hash);
  return m ? m[1] : null;
}
