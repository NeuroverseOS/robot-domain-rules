/**
 * Runs every case in conformance/ against this implementation (src/), so the
 * reference passes its own suite. The judging rules live in
 * conformance/compare.mjs and are written out in conformance/README.md.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  evaluateDomainAction, checkRulebook, validateRulebook, canonicalJson, fingerprint, requestDigest, verifyApproval, verifyRulebookSignature,
  type Rulebook,
} from '../src/index';
import { loadCases, runCase } from '../conformance/compare.mjs';

const impl = {
  evaluate: evaluateDomainAction,
  check: (rb: Rulebook) => checkRulebook(rb),
  validate: validateRulebook,
  canonical: canonicalJson,
  fingerprint,
  requestDigest,
  verifyApproval,
  verifyRulebookSignature,
};

const dir = path.join(__dirname, '..', 'conformance');
const all = await loadCases(fs, path, dir);

describe(`conformance (${all.length} cases)`, () => {
  for (const { file, case: c, rulebook } of all) {
    it(`${file} ${c.id} — ${c.description}`, async () => {
      expect(await runCase(c, impl, rulebook)).toBeNull();
    });
  }
});
