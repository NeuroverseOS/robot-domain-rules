/**
 * Export, import and the code snippet. Pure: the UI triggers the download.
 */

import { verifyFingerprint, renderDomainRules, compileDomain, type Rulebook, type DomainRequest } from '../../../src/index';
import { inputFromRulebook } from './model';

export function rulebookJson(rb: Rulebook): string {
  return JSON.stringify(rb, null, 2) + '\n';
}

export function rulebookText(rb: Rulebook): string {
  return renderDomainRules(rb);
}

export function fileStem(rb: Rulebook): string {
  return (rb.site.id || 'rulebook').replace(/[^A-Za-z0-9_-]+/g, '-');
}

export interface ImportResult {
  ok: boolean;
  /** Plain-words outcome. */
  message: string;
  rulebook?: Rulebook;
  /** True when the rulebook could be turned back into an editable input that compiles to the same fingerprint. */
  editable?: boolean;
}

/** Parse a rulebook JSON, verify its fingerprint, and say whether it can be edited here. */
export function importRulebook(text: string): ImportResult {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return { ok: false, message: 'That is not JSON.' }; }
  const rb = parsed as Rulebook;
  if (!rb || typeof rb !== 'object' || rb.format !== 'neuroverse-domain-rules/2' || !rb.site || !Array.isArray(rb.rules) || typeof rb.fingerprint !== 'string') {
    return { ok: false, message: 'That JSON is not a rulebook (expected format "neuroverse-domain-rules/2" with site, rules and a fingerprint).' };
  }
  let verified = false;
  try { verified = verifyFingerprint(rb); } catch { verified = false; }
  if (!verified) return { ok: false, message: `Fingerprint check failed: the rulebook was changed after it was compiled (claims ${rb.fingerprint}).`, rulebook: rb };
  let editable = false;
  try { editable = compileDomain(inputFromRulebook(rb)).fingerprint === rb.fingerprint; } catch { editable = false; }
  return {
    ok: true,
    editable,
    rulebook: rb,
    message: editable
      ? `Fingerprint verified (${rb.fingerprint}). Loaded ${rb.site.name}: ${rb.rules.length} rules, ${rb.findings.length} findings.`
      : `Fingerprint verified (${rb.fingerprint}), but this rulebook uses a template this switchboard does not ship, so it is loaded read-only.`,
  };
}

/** The lines a robot, a pair of glasses or an agent runs to ask this rulebook about this situation. */
export function codeSnippet(rb: Rulebook, request: DomainRequest): string {
  return [
    `import { evaluateDomainAction } from '@neuroverseos/robot-domain-rules';`,
    `import rulebook from './${fileStem(rb)}.rules.json'; // fingerprint ${rb.fingerprint}`,
    ``,
    `const decision = evaluateDomainAction(rulebook, ${JSON.stringify(request, null, 2)});`,
    ``,
    `// decision.status   → 'ALLOW' | 'LIMIT' | 'PAUSE' | 'BLOCK'`,
    `// decision.reasons  → the rules that decided, each with setBy`,
    `// decision.limits   → e.g. { maxSpeedMps: 0.3 }`,
    `// decision.trace    → every check that ran`,
  ].join('\n');
}
