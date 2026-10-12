#!/usr/bin/env node
/**
 * Runs the conformance cases against the built package (dist/), with no test
 * framework. From the repo root after `npm run build`:
 *
 *   node conformance/run-node.mjs
 *
 * Exit code 0 when every case passes. To run the cases against ANOTHER
 * implementation, copy this file and replace `impl` with calls into yours
 * (or port the loop: it is ten lines, see README.md).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCases, runCase } from './compare.mjs';
import * as core from '../dist/index.js';

const impl = {
  evaluate: core.evaluateDomainAction,
  check: core.checkRulebook,
  validate: core.validateRulebook,
  canonical: core.canonicalJson,
  fingerprint: core.fingerprint,
  requestDigest: core.requestDigest,
  verifyApproval: core.verifyApproval,
  verifyRulebookSignature: core.verifyRulebookSignature,
};

const dir = path.dirname(fileURLToPath(import.meta.url));
const all = await loadCases(fs, path, dir);
let failed = 0;
for (const { file, case: c, rulebook } of all) {
  const problem = await runCase(c, impl, rulebook);
  if (problem) { failed++; console.log(`FAIL ${file} ${c.id}\n  ${c.description}\n  ${problem}`); }
}
console.log(`${all.length - failed}/${all.length} conformance cases pass`);
process.exit(failed ? 1 : 0);
