#!/usr/bin/env node
/**
 * Validates every conformance case against the JSON Schemas in spec/:
 * the inputs as written (rulebooks, requests, plans, event logs, approvals
 * that are meant to verify) and the reference outputs recomputed from the
 * built package (decisions, plan evaluations, findings, backtest reports).
 * Exit code 0 when nothing drifts. From the repo root after `npm run build`:
 *
 *   node conformance/validate-schemas.mjs
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { loadCases } from './compare.mjs';
import * as core from '../dist/index.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const specDir = path.join(dir, '..', 'spec');
const ajv = new Ajv2020({ strict: false, allErrors: true });
for (const file of fs.readdirSync(specDir).filter(f => f.endsWith('.schema.json'))) ajv.addSchema(JSON.parse(fs.readFileSync(path.join(specDir, file), 'utf8')));
const base = 'https://neuroverseos.github.io/robot-domain-rules/spec/';
const validators = {
  rulebook: ajv.getSchema(`${base}rulebook.schema.json`),
  request: ajv.getSchema(`${base}request.schema.json`),
  decision: ajv.getSchema(`${base}decision.schema.json`),
  plan: ajv.getSchema(`${base}plan.schema.json`),
  planEvaluation: ajv.getSchema(`${base}plan-evaluation.schema.json`),
  findings: ajv.getSchema(`${base}findings.schema.json`),
  backtest: ajv.getSchema(`${base}backtest.schema.json`),
  backtestReport: ajv.getSchema(`${base}backtest-report.schema.json`),
  signedApproval: ajv.getSchema(`${base}approval.schema.json#/$defs/signedApproval`),
  approvalRequest: ajv.getSchema(`${base}approval.schema.json#/$defs/approvalRequest`),
};
for (const [k, v] of Object.entries(validators)) if (!v) { console.error(`no validator for ${k}`); process.exit(2); }

let checked = 0, failed = 0, skipped = 0;
/** A case whose point is that the input is incomplete (the reference refuses it as required_facts) is not expected to fit the input schema. */
const intentionallyIncomplete = (c) => {
  const e = c.expect;
  if (e.decision) return e.decision.reasons.some(r => r.ruleId === 'required_facts');
  if (e.plan) return e.plan.firstViolation?.ruleId === 'required_facts';
  if (e.backtest) return e.backtest.rows.some(r => r.missingFacts);
  return false;
};
const check = (what, validator, value, where) => {
  checked++;
  if (validator(value)) return;
  failed++;
  console.log(`DRIFT ${where}: ${what} does not match its schema\n  ${ajv.errorsText(validator.errors, { separator: '\n  ' })}`);
};

const all = await loadCases(fs, path, dir);
for (const { file, case: c, rulebook } of all) {
  const where = `${file} ${c.id}`;
  const e = c.expect;
  if (rulebook && !e.error) check('rulebook', validators.rulebook, rulebook, where);
  const inputOk = !intentionallyIncomplete(c);
  if (!inputOk) skipped++;
  if (c.request && e.decision) {
    if (inputOk) check('request', validators.request, c.request, where);
    const d = core.evaluateDomainAction(rulebook, c.request);
    check('decision', validators.decision, d, where);
    for (const a of d.approvalRequests ?? []) check('approvalRequest', validators.approvalRequest, a, where);
  }
  if (c.request && e.requestDigest !== undefined) check('request', validators.request, c.request, where);
  if ('plan' in c && c.plan !== null && e.plan) {
    if (inputOk) check('plan', validators.plan, c.plan, where);
    check('plan evaluation', validators.planEvaluation, core.evaluatePlan(rulebook, c.plan), where);
  }
  if (e.findings) check('findings', validators.findings, core.checkRulebook(rulebook), where);
  if (c.events) {
    if (inputOk) check('backtest input', validators.backtest, { events: c.events, ...(c.options ? { options: c.options } : {}) }, where);
    check('backtest report', validators.backtestReport, core.backtest(rulebook, c.events, c.options), where);
    if (c.proposed) check('proposed rulebook', validators.rulebook, c.proposed, where);
  }
  if (c.approval && e.verify?.ok) check('signed approval', validators.signedApproval, c.approval, where);
}
for (const file of fs.readdirSync(path.join(dir, 'rulebooks'))) check('shared rulebook', validators.rulebook, JSON.parse(fs.readFileSync(path.join(dir, 'rulebooks', file), 'utf8')), `rulebooks/${file}`);
console.log(`${checked - failed}/${checked} schema validations pass across ${all.length} cases (${skipped} inputs are intentionally incomplete and were not held to the input schema; their outputs were)`);
process.exit(failed ? 1 : 0);
