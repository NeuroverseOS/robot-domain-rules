/**
 * Canonical JSON and the fingerprint — the two things another implementation
 * must reproduce byte for byte. Specified in SPEC.md § Canonical JSON.
 *
 *   canonicalJson: object keys sorted by UTF-16 code unit, no whitespace,
 *                  `undefined` members dropped, numbers and strings as
 *                  JSON.stringify writes them.
 *   fingerprint:   64-bit FNV-1a over the UTF-16 code units of that text,
 *                  as 16 lowercase hex digits.
 */

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Deterministic 64-bit FNV-1a fingerprint of the value's canonical JSON.
 * It identifies a rulebook; it is not a security signature (see `signRulebook`).
 */
export function fingerprint(value: unknown): string {
  const text = canonicalJson(value);
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < text.length; i++) {
    h ^= BigInt(text.charCodeAt(i));
    h = (h * prime) & mask;
  }
  return h.toString(16).padStart(16, '0');
}

/**
 * What an approval is bound to: the participant, the action and the area —
 * not the facts, which change between the request that paused and the one
 * that is re-sent with the approval. `fingerprint({ participant, action, areaId })`.
 */
export function requestDigest(request: { participant: { id: string; kind: string; roleId: string }; action: string; areaId?: string; zoneId?: string }): string {
  const p = request.participant;
  return fingerprint({ participant: { id: p.id, kind: p.kind, roleId: p.roleId }, action: request.action, areaId: request.areaId ?? request.zoneId });
}
