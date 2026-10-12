/**
 * Generates the conformance cases from this (the reference) implementation.
 *
 *   npx tsx conformance/generate.ts
 *
 * Every case states its intent by hand — the status, the rule IDs and
 * authorities in the reasons, the finding kinds, or that the rulebook must be
 * rejected — and this script refuses to write a case the implementation does
 * not meet. The parts that are then filled in from the implementation (full
 * traces, fingerprints, signatures) are reviewed in the diff. The JSON files
 * are the authority; this script is their provenance.
 *
 * Test signing keys below are TEST ONLY: fixed seeds so other implementations
 * can reproduce every signature byte for byte.
 */

import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  compileDomain, evaluateDomainAction, evaluatePlan, matchingRules, checkRulebook, validateRulebook, canonicalJson, fingerprint, requestDigest,
  publicKeyOf, signApproval, verifyApproval, signRulebook, verifyRulebookSignature,
  type CompileDomainInput, type DomainRequest, type Plan, type PlanRule, type Rule, type Rulebook, type TrustedKey, type SignedApproval,
} from '../src/index';
import { projectDecision, projectFindings, projectPlan } from './compare.mjs';
import * as grocery from '../examples/grocery-store';

const OUT = join(import.meta.dirname, '.');

// ─── Test keys (TEST ONLY) ───────────────────────────────────────────────────

const SEED_HIGH = '0001020304050607080910111213141516171819202122232425262728293031';   // TEST ONLY key for authority "high"
const SEED_LEAD = '1111111111111111111111111111111111111111111111111111111111111111';   // TEST ONLY key for role "lead"
const SEED_STRANGER = '2222222222222222222222222222222222222222222222222222222222222222'; // TEST ONLY key the rulebook does not trust
const SEED_SITE = '3333333333333333333333333333333333333333333333333333333333333333';   // TEST ONLY key that signs the rulebook itself

// ─── Base sites ──────────────────────────────────────────────────────────────

type Draft = Omit<Rule, 'source' | 'setBy'> & { setBy?: string };
const rule = (id: string, then: Rule['then'], patch: Partial<Rule> = {}): Draft => ({ id, text: id, who: '*', does: '*', where: '*', then, ...patch });

/** A small robot site: two authorities, two actions, two areas, one role, six typed facts, one limit. */
const tiny = (rules: Draft[], extra: Partial<CompileDomainInput> = {}): CompileDomainInput => ({
  site: { id: 'tiny', name: 'Tiny site' },
  authorities: [{ id: 'high' }, { id: 'low' }],
  actions: [{ id: 'go', kinds: ['robot'], tags: ['movement'] }, { id: 'look', kinds: ['robot'] }],
  facts: [
    { id: 'people', type: 'number', integer: true, min: 0, required: true },
    { id: 'load', type: 'number', min: 0, default: 0 },
    { id: 'time', type: 'time', required: true },
    { id: 'mode', type: 'enum', values: ['a', 'b', 'c'], default: 'a' },
    { id: 'alarm', type: 'boolean', default: false },
    { id: 'day', type: 'day', required: true },
    { id: 'speedAsked', type: 'number', min: 0 },
  ],
  limits: [{ id: 'speed', unit: 'm/s', requestedFact: 'speedAsked' }],
  areas: [{ id: 'floor', name: 'Floor' }, { id: 'yard', name: 'Yard', tags: ['outside'] }],
  roles: [{ id: 'bot', name: 'Bot', kind: 'robot', actions: ['go', 'look'] }],
  rules: rules.map(r => ({ setBy: 'high', ...r, source: { kind: 'manual', ref: r.id } })),
  ...extra,
});
const req = (action = 'go', areaId = 'floor', facts: Record<string, unknown> = {}, participant = { id: 'b-1', kind: 'robot', roleId: 'bot' }): DomainRequest =>
  ({ participant, action, areaId, facts: { people: 0, time: '10:00', day: 'mon', ...facts } });

/** Robots, people and an AI agent under one law. */
const shared = (rules: Draft[], extra: Partial<CompileDomainInput> = {}): CompileDomainInput => tiny(rules, {
  kinds: ['robot', 'person', 'agent'],
  actions: [{ id: 'go', kinds: ['robot'], tags: ['movement'] }, { id: 'look', kinds: ['robot', 'person', 'agent'], tags: ['sensing'] }, { id: 'plan', kinds: ['agent'] }],
  roles: [
    { id: 'bot', name: 'Bot', kind: 'robot', actions: ['go', 'look'] },
    { id: 'guard', name: 'Guard', kind: 'person', actions: ['look'], tags: ['staff'] },
    { id: 'visitor', name: 'Visitor', kind: 'person', actions: ['look'] },
    { id: 'lead', name: 'Lead', kind: 'person', actions: ['look'], tags: ['staff', 'lead'] },
    { id: 'planner', name: 'Planner', kind: 'agent', actions: ['look', 'plan'] },
  ],
  areas: [{ id: 'floor', name: 'Floor' }, { id: 'yard', name: 'Yard', tags: ['outside'] }, { id: 'office', name: 'Office', allowRoles: ['guard', 'lead'] }, { id: 'lab', name: 'Lab', denyRoles: ['planner'] }],
  ...extra,
});
const as = (kind: string, roleId: string, id = `${kind}-1`) => ({ id, kind, roleId });

// ─── Case shapes ─────────────────────────────────────────────────────────────

interface Want {
  status?: string;
  /** Plan expectations: the step statuses in order, the first violation as "ruleId@setBy#stepIndex:from", plan checks as "ruleId:status". */
  steps?: string[];
  firstViolation?: string;
  planChecks?: string[];
  /** Reasons as "ruleId" or "ruleId@setBy". */
  reasons?: string[];
  limits?: Record<string, number>;
  then?: string;
  /** Approval requests as "ruleId" or "ruleId@by". */
  asks?: string[];
  /** Findings as "kind:certainty:idA+idB". */
  findings?: string[];
  error?: true;
}

interface Spec {
  id: string;
  principle: number[];
  description: string;
  base?: string;
  input?: CompileDomainInput;
  /** A valid compiled rulebook, mutated after the fact (for error cases). */
  tamper?: (rb: Rulebook) => void;
  request?: DomainRequest;
  plan?: Plan;
  want: Want;
}

const bases: Record<string, Rulebook> = {};
const files: Record<string, unknown[]> = {};
let count = 0;

function fail(id: string, msg: string): never {
  throw new Error(`case ${id}: ${msg}`);
}

function add(file: string, s: Spec) {
  let rulebook: Rulebook | Record<string, unknown>;
  if (s.base) rulebook = bases[s.base];
  else if (s.input) rulebook = compileDomain(s.input);
  else fail(s.id, 'needs base or input');
  if (s.tamper) {
    const copy = JSON.parse(JSON.stringify(rulebook)) as Rulebook;
    s.tamper(copy);
    const { fingerprint: _f, ...body } = copy;
    rulebook = { ...body, fingerprint: fingerprint(body) };
  }
  const out: Record<string, unknown> = { id: s.id, principle: s.principle, description: s.description };
  if (s.base && !s.tamper) out.rulebookRef = `rulebooks/${s.base}.json`; else out.rulebook = rulebook;
  const w = s.want;
  if (w.error) {
    const problems = validateRulebook(rulebook);
    if (!problems.length) fail(s.id, 'expected the rulebook to be rejected');
    out.expect = { error: true, note: problems[0] };
  } else if (w.findings) {
    const got = checkRulebook(rulebook as Rulebook);
    const kinds = got.map(f => `${f.kind}:${f.certainty}:${f.ruleIds.join('+')}`).sort();
    if (JSON.stringify(kinds) !== JSON.stringify([...w.findings].sort())) fail(s.id, `findings: want ${JSON.stringify(w.findings)}, got ${JSON.stringify(kinds)}`);
    for (const f of got) {
      // Every certain finding between rules carries a witness, and the witness really matches both rules.
      const betweenRules = f.ruleIds.every(id => (rulebook as Rulebook).rules.some(r => r.id === id));
      if (f.certainty === 'certain' && betweenRules && !f.witness) fail(s.id, `finding ${f.ruleIds.join('+')} is certain but has no witness`);
      if (f.certainty === 'possible' && f.witness) fail(s.id, `finding ${f.ruleIds.join('+')} is possible but has a witness`);
      if (f.witness) {
        const hit = matchingRules(rulebook as Rulebook, f.witness);
        if (!f.ruleIds.every(id => hit.includes(id))) fail(s.id, `witness of ${f.ruleIds.join('+')} matches ${JSON.stringify(hit)}: ${JSON.stringify(f.witness)}`);
      }
    }
    out.expect = { findings: projectFindings(got) };
  } else if (s.plan) {
    out.plan = s.plan;
    const p = evaluatePlan(rulebook as Rulebook, s.plan);
    if (p.status !== w.status) fail(s.id, `plan status: want ${w.status}, got ${p.status}`);
    const steps = p.steps.map(x => x.decision.status);
    if (JSON.stringify(steps) !== JSON.stringify(w.steps ?? [])) fail(s.id, `plan steps: want ${JSON.stringify(w.steps)}, got ${JSON.stringify(steps)}`);
    const fv = p.firstViolation ? `${p.firstViolation.ruleId}@${p.firstViolation.setBy}#${p.firstViolation.stepIndex}:${p.firstViolation.from}` : undefined;
    if (fv !== w.firstViolation) fail(s.id, `plan firstViolation: want ${w.firstViolation}, got ${fv}`);
    const checks = p.planChecks.map(c => `${c.ruleId}:${c.status}`);
    if (JSON.stringify(checks) !== JSON.stringify(w.planChecks ?? [])) fail(s.id, `plan checks: want ${JSON.stringify(w.planChecks)}, got ${JSON.stringify(checks)}`);
    const asks = p.approvalRequests.map(a => (a.by ? `${a.ruleId}@${a.by}` : a.ruleId));
    if (JSON.stringify(asks) !== JSON.stringify(w.asks ?? [])) fail(s.id, `plan approvalRequests: want ${JSON.stringify(w.asks ?? [])}, got ${JSON.stringify(asks)}`);
    out.expect = { plan: projectPlan(p) };
  } else {
    if (!s.request) fail(s.id, 'needs a request');
    out.request = s.request;
    const d = evaluateDomainAction(rulebook as Rulebook, s.request);
    if (d.status !== w.status) fail(s.id, `status: want ${w.status}, got ${d.status} (${d.reasons.map(r => r.reason).join('; ')})`);
    const reasons = d.reasons.map(r => `${r.ruleId}@${r.setBy}`);
    const wantReasons = (w.reasons ?? []).map((r, i) => (r.includes('@') ? r : `${r}@${d.reasons[i]?.setBy}`));
    if (JSON.stringify(reasons) !== JSON.stringify(wantReasons)) fail(s.id, `reasons: want ${JSON.stringify(wantReasons)}, got ${JSON.stringify(reasons)}`);
    if (JSON.stringify(d.limits) !== JSON.stringify(w.limits)) fail(s.id, `limits: want ${JSON.stringify(w.limits)}, got ${JSON.stringify(d.limits)}`);
    if (d.then !== w.then) fail(s.id, `then: want ${w.then}, got ${d.then}`);
    const asks = (d.approvalRequests ?? []).map(a => (a.by ? `${a.ruleId}@${a.by}` : a.ruleId));
    if (JSON.stringify(asks) !== JSON.stringify(w.asks ?? [])) fail(s.id, `approvalRequests: want ${JSON.stringify(w.asks ?? [])}, got ${JSON.stringify(asks)}`);
    out.expect = { decision: projectDecision(d) };
  }
  (files[file] ??= []).push(out);
  count++;
}

// ─── Principle 1: the people of a space write its law ────────────────────────

function p1() {
  const f = 'p1-source.json';
  add(f, { id: 'p1-no-rules-no-invention', principle: [1], description: 'With no rules at all, a declared role doing a listed action is ALLOW on the role check alone: the engine adds no rule of its own.',
    input: tiny([]), request: req(), want: { status: 'ALLOW', reasons: ['role_permits_action@builtin'] } });
  add(f, { id: 'p1-rule-without-source-rejected', principle: [1], description: 'A rule with no source is not a rule: the rulebook is rejected.',
    input: tiny([rule('r', { answer: 'deny' })]), tamper: rb => { delete (rb.rules[0] as Partial<Rule>).source; }, want: { error: true } });
  add(f, { id: 'p1-rule-without-setby-rejected', principle: [1, 2], description: 'A rule that does not say who set it is rejected.',
    input: tiny([rule('r', { answer: 'deny' })]), tamper: rb => { delete (rb.rules[0] as Partial<Rule>).setBy; }, want: { error: true } });
  add(f, { id: 'p1-every-reason-cites-a-rule', principle: [1, 5], description: 'Every reason names a rule in the rulebook (or a builtin check) and the authority that set it; here the site\'s tighter limit, set by the lower authority.',
    input: tiny([rule('cap', { answer: 'limit', limits: { speed: 1 } }, { setBy: 'high' }), rule('site_cap', { answer: 'limit', limits: { speed: 0.5 } }, { setBy: 'low', where: 'yard' })]),
    request: req('go', 'yard'), want: { status: 'LIMIT', reasons: ['site_cap@low'], limits: { speed: 0.5 } } });
  add(f, { id: 'p1-rule-text-is-the-operators', principle: [1], description: 'A rule written from plain words (source.kind "text") decides exactly like any other rule.',
    input: tiny([{ ...rule('no_yard', { answer: 'deny' }, { where: 'yard' }), setBy: 'low', source: { kind: 'text', ref: 'no robots in the yard' } } as Rule]),
    request: req('go', 'yard'), want: { status: 'BLOCK', reasons: ['no_yard@low'] } });
}

// ─── Principle 2: authority is declared, layered, and only tightens ──────────

function p2() {
  const f = 'p2-authority.json';
  add(f, { id: 'p2-unknown-authority-rejected', principle: [2], description: 'A rule set by an authority the rulebook does not declare is rejected.',
    input: tiny([rule('r', { answer: 'deny' })]), tamper: rb => { rb.rules[0].setBy = 'king'; }, want: { error: true } });
  add(f, { id: 'p2-authorities-must-be-declared', principle: [2], description: 'A rulebook with no authorities is rejected: the order is written down, never inferred.',
    input: tiny([]), tamper: rb => { rb.authorities = []; }, want: { error: true } });
  const layered = tiny([rule('h_deny', { answer: 'deny' }, { setBy: 'high', does: 'look' }), rule('l_allow', { answer: 'allow' }, { setBy: 'low', does: 'look', where: 'yard' })]);
  add(f, { id: 'p2-lower-cannot-loosen-finding', principle: [2, 7], description: 'A lower authority allowing what a higher one denies is an authority-override finding (certain).',
    input: layered, want: { findings: ['authority-override:certain:l_allow+h_deny'] } });
  add(f, { id: 'p2-lower-cannot-loosen-decision', principle: [2], description: 'At decision time the higher deny wins; the lower allow is cited nowhere in the reasons.',
    input: layered, request: req('look', 'yard'), want: { status: 'BLOCK', reasons: ['h_deny@high'] } });
  const tight = tiny([rule('h_allow', { answer: 'allow' }, { setBy: 'high' }), rule('l_deny', { answer: 'deny' }, { setBy: 'low', where: 'yard' })]);
  add(f, { id: 'p2-lower-may-tighten-finding', principle: [2], description: 'A lower authority denying what a higher one allows is tightening: info only.',
    input: tight, want: { findings: ['tightening:certain:h_allow+l_deny'] } });
  add(f, { id: 'p2-lower-may-tighten-decision', principle: [2], description: 'The lower authority\'s stricter rule decides, and the decision says it was set by the lower authority.',
    input: tight, request: req('go', 'yard'), want: { status: 'BLOCK', reasons: ['l_deny@low'] } });
  const limits = tiny([rule('h_cap', { answer: 'limit', limits: { speed: 0.5 } }, { setBy: 'high' }), rule('l_cap', { answer: 'limit', limits: { speed: 1 } }, { setBy: 'low' })]);
  add(f, { id: 'p2-lower-looser-limit-finding', principle: [2, 7], description: 'A lower authority setting a looser value on the same limit is an authority-override.',
    input: limits, want: { findings: ['authority-override:certain:l_cap+h_cap'] } });
  add(f, { id: 'p2-lower-looser-limit-decision', principle: [2], description: 'The tighter (higher) limit applies; the looser rule is in the trace but not the reasons.',
    input: limits, request: req('go', 'floor', { speedAsked: 0.8 }), want: { status: 'LIMIT', reasons: ['h_cap@high'], limits: { speed: 0.5 } } });
  add(f, { id: 'p2-never-rule-beats-higher-allow', principle: [2], description: 'A never rule is an invariant whatever its authority: a higher authority\'s allow does not override it.',
    input: tiny([rule('h_allow', { answer: 'allow' }, { setBy: 'high' }), rule('inv', { answer: 'deny' }, { setBy: 'low', never: true, where: 'yard' })]),
    request: req('go', 'yard'), want: { status: 'BLOCK', reasons: ['inv@low'] } });

  const ask = tiny([rule('ask_high', { answer: 'wait', for: 'approval', by: 'high' }, { does: 'go', where: 'yard' })], { authorities: [{ id: 'top' }, { id: 'high' }, { id: 'low' }] });
  add(f, { id: 'p2-approval-needs-named-authority', principle: [2, 6], description: 'A wait for approval by "high" with no approval is PAUSE and asks for an approval by high.',
    input: ask, request: req('go', 'yard'), want: { status: 'PAUSE', reasons: ['ask_high'], asks: ['ask_high@high'] } });
  add(f, { id: 'p2-approval-by-named-authority', principle: [2, 6], description: 'An approval from someone holding exactly the named authority clears the wait.',
    input: ask, request: req('go', 'yard', { approvedBy: { id: 'ann', authority: 'high' } }), want: { status: 'ALLOW', reasons: ['role_permits_action', 'ask_high'] } });
  add(f, { id: 'p2-approval-by-higher-authority', principle: [2, 6], description: 'An approval from a higher authority than the one named also clears the wait.',
    input: ask, request: req('go', 'yard', { approvedBy: { id: 'tom', authority: 'top' } }), want: { status: 'ALLOW', reasons: ['role_permits_action', 'ask_high'] } });
  add(f, { id: 'p2-approval-by-lower-authority', principle: [2, 6], description: 'An approval from a lower authority does not clear the wait; the decision still asks.',
    input: ask, request: req('go', 'yard', { approvedBy: { id: 'bob', authority: 'low' } }), want: { status: 'PAUSE', reasons: ['ask_high'], asks: ['ask_high@high'] } });
  add(f, { id: 'p2-approval-without-authority', principle: [2, 6], description: 'A plain approval that names no authority does not clear a wait that names one.',
    input: ask, request: req('go', 'yard', { approvedBy: 'carl' }), want: { status: 'PAUSE', reasons: ['ask_high'], asks: ['ask_high@high'] } });
  add(f, { id: 'p2-approval-undeclared-authority-is-invalid', principle: [2, 4], description: 'An approval claiming an authority the rulebook does not declare is an invalid fact: BLOCK required_facts.',
    input: ask, request: req('go', 'yard', { approvedBy: { id: 'x', authority: 'king' } }), want: { status: 'BLOCK', reasons: ['required_facts@builtin'] } });
  const byRole = shared([rule('ask_lead', { answer: 'wait', for: 'approval', by: 'tag:lead' }, { does: 'go' }), rule('ask_guard', { answer: 'wait', for: 'approval', by: 'guard' }, { does: 'look', who: 'bot' })]);
  add(f, { id: 'p2-approval-by-role-tag', principle: [2, 6], description: 'A wait "by tag:lead" is cleared by an approver whose role carries that tag.',
    input: byRole, request: req('go', 'floor', { approvedBy: { id: 'lee', roleId: 'lead' } }), want: { status: 'ALLOW', reasons: ['role_permits_action', 'ask_lead'] } });
  add(f, { id: 'p2-approval-by-wrong-role', principle: [2, 6], description: 'An approver whose role is not the one named (and carries no such tag) does not clear the wait.',
    input: byRole, request: req('look', 'floor', { approvedBy: { id: 'vic', roleId: 'visitor' } }), want: { status: 'PAUSE', reasons: ['ask_guard'], asks: ['ask_guard@guard'] } });
  add(f, { id: 'p2-approval-by-role', principle: [2, 6], description: 'A wait "by guard" is cleared by an approver holding the guard role.',
    input: byRole, request: req('look', 'floor', { approvedBy: { id: 'gus', roleId: 'guard' } }), want: { status: 'ALLOW', reasons: ['role_permits_action', 'ask_guard'] } });
  // An AI agent as a declared authority: the lowest level, so it can only tighten.
  const agentRule = (id: string, then: Rule['then'], patch: Partial<Rule> = {}): Rule =>
    ({ ...rule(id, then, patch), setBy: 'agent', source: { kind: 'agent', ref: `planner-7: ${id}` } } as Rule);
  const levels = { authorities: [{ id: 'site-manager' }, { id: 'staff' }, { id: 'agent', name: 'AI agent' }] };
  const agentTightens = tiny([rule('manager_cap', { answer: 'limit', limits: { speed: 1 } }, { setBy: 'site-manager' }), agentRule('agent_cap', { answer: 'limit', limits: { speed: 0.4 } }, { where: 'yard' })], levels);
  add(f, { id: 'p2-agent-rule-tightens-takes-effect', principle: [1, 2], description: 'A rule written by an AI agent (source.kind "agent") at the agent authority level tightens the manager\'s cap and takes effect; the decision cites it as set by agent.',
    input: agentTightens, request: req('go', 'yard', { speedAsked: 0.8 }), want: { status: 'LIMIT', reasons: ['agent_cap@agent'], limits: { speed: 0.4 } } });
  add(f, { id: 'p2-agent-rule-tightens-finding', principle: [1, 2, 7], description: 'The agent\'s tighter cap is reported as tightening: information, not a conflict.',
    input: agentTightens, want: { findings: ['tightening:certain:manager_cap+agent_cap'] } });
  const agentLoosens = tiny([rule('manager_no_yard', { answer: 'deny' }, { setBy: 'site-manager', where: 'yard' }), agentRule('agent_allows_yard', { answer: 'allow' }, { where: 'yard' })], levels);
  add(f, { id: 'p2-agent-rule-loosens-finding', principle: [1, 2, 7], description: 'An agent-level rule that allows what the site manager denies is an authority-override.',
    input: agentLoosens, want: { findings: ['authority-override:certain:agent_allows_yard+manager_no_yard'] } });
  add(f, { id: 'p2-agent-rule-loosens-never-takes-effect', principle: [1, 2], description: 'At decision time the manager\'s deny wins; the agent\'s allow is never a reason.',
    input: agentLoosens, request: req('go', 'yard'), want: { status: 'BLOCK', reasons: ['manager_no_yard@site-manager'] } });
  const agentApproves = tiny([rule('ask_manager', { answer: 'wait', for: 'approval', by: 'site-manager' }, { setBy: 'site-manager', where: 'yard' })], levels);
  add(f, { id: 'p2-agent-approval-cannot-clear-manager-wait', principle: [2, 6], description: 'An approval from an agent-level approver does not clear a wait that requires the site manager.',
    input: agentApproves, request: req('go', 'yard', { approvedBy: { id: 'planner-7', authority: 'agent' } }), want: { status: 'PAUSE', reasons: ['ask_manager@site-manager'], asks: ['ask_manager@site-manager'] } });
  add(f, { id: 'p2-system-rule-source', principle: [1], description: 'A rule from another system (source.kind "system") is a rule like any other: its weight is its declared authority.',
    input: tiny([{ ...rule('policy_feed_no_yard', { answer: 'deny' }, { where: 'yard' }), setBy: 'staff', source: { kind: 'system', ref: 'policy-service' } } as Rule], levels), request: req('go', 'yard'), want: { status: 'BLOCK', reasons: ['policy_feed_no_yard@staff'] } });
  add(f, { id: 'p2-wait-by-unknown-rejected', principle: [2], description: 'A wait that names an approver the rulebook does not declare (not an authority, role or role tag) is rejected.',
    input: tiny([rule('ask', { answer: 'wait', for: 'approval', by: 'high' })]), tamper: rb => { (rb.rules[0].then as { by: string }).by = 'nobody'; }, want: { error: true } });
}

// ─── Principle 3: AI proposes; the space's rules decide ──────────────────────

function p3() {
  const f = 'p3-rules-decide.json';
  add(f, { id: 'p3-structure-not-prose', principle: [3], description: 'The engine applies the rule\'s structured `then`, never its prose: a rule whose text says "allowed" but whose answer is deny, denies.',
    input: tiny([rule('prose', { answer: 'deny' }, { text: 'Robots are allowed everywhere at any time.', reason: 'Robots are allowed everywhere at any time.' })]),
    request: req(), want: { status: 'BLOCK', reasons: ['prose@high'] } });
  add(f, { id: 'p3-same-input-same-answer', principle: [3, 5], description: 'Two requests that differ only in facts the rules do not mention get the same decision: nothing outside the rulebook and the request is consulted.',
    input: tiny([rule('night', { answer: 'deny' }, { when: [{ fact: 'time', op: 'between', from: '22:00', to: '06:00' }] })]),
    request: req('go', 'floor', { time: '23:00', people: 7, load: 3.5, mode: 'c', day: 'sun', extraneous: 'ignored' }), want: { status: 'BLOCK', reasons: ['night@high'] } });
  add(f, { id: 'p3-same-input-same-answer-b', principle: [3, 5], description: 'The counterpart of the previous case: outside the window, with the same irrelevant facts, ALLOW.',
    input: tiny([rule('night', { answer: 'deny' }, { when: [{ fact: 'time', op: 'between', from: '22:00', to: '06:00' }] })]),
    request: req('go', 'floor', { time: '06:00', people: 7, load: 3.5, mode: 'c', day: 'sun', extraneous: 'ignored' }), want: { status: 'ALLOW', reasons: ['role_permits_action'] } });
}

// ─── Principle 4: unknown means no ───────────────────────────────────────────

function p4() {
  const f = 'p4-unknown-and-missing.json';
  const base = 'tiny';
  const bad = (id: string, description: string, facts: Record<string, unknown>) =>
    add(f, { id, principle: [4], description, base, request: { ...req(), facts }, want: { status: 'BLOCK', reasons: ['required_facts@builtin'] } });
  bad('p4-missing-required-fact', 'A required fact that is absent is BLOCK required_facts, never a default and never permission.', { time: '10:00', day: 'mon' });
  bad('p4-fact-wrong-type', 'A required number given as a string is invalid: BLOCK.', { people: '2', time: '10:00', day: 'mon' });
  bad('p4-fact-not-integer', 'An integer fact given a fraction is invalid: BLOCK.', { people: 1.5, time: '10:00', day: 'mon' });
  bad('p4-fact-below-min', 'A number below its declared min is invalid: BLOCK.', { people: -1, time: '10:00', day: 'mon' });
  bad('p4-fact-null', 'null is not a value: BLOCK.', { people: null, time: '10:00', day: 'mon' });
  bad('p4-bad-time', 'A time that is not "HH:MM" 24h is invalid: BLOCK.', { people: 0, time: '9:00', day: 'mon' });
  bad('p4-bad-day', 'A day outside mon..sun is invalid: BLOCK.', { people: 0, time: '10:00', day: 'funday' });
  bad('p4-bad-enum', 'An enum value not in the declared list is invalid: BLOCK, even though the fact has a default.', { people: 0, time: '10:00', day: 'mon', mode: 'z' });
  bad('p4-bad-boolean', 'A boolean given as a string is invalid: BLOCK.', { people: 0, time: '10:00', day: 'mon', alarm: 'no' });
  bad('p4-optional-fact-invalid', 'An optional fact, when given, must still be valid: a negative speedAsked is BLOCK.', { people: 0, time: '10:00', day: 'mon', speedAsked: -1 });
  bad('p4-bad-approval-shape', 'approvedBy must be a non-empty string or an object with an id: true is invalid.', { people: 0, time: '10:00', day: 'mon', approvedBy: true });
  add(f, { id: 'p4-facts-missing-entirely', principle: [4], description: 'A request with no facts object at all is incomplete: BLOCK required_facts.',
    base, request: { participant: as('robot', 'bot'), action: 'go', areaId: 'floor' } as unknown as DomainRequest, want: { status: 'BLOCK', reasons: ['required_facts@builtin'] } });
  add(f, { id: 'p4-undeclared-area', principle: [4], description: 'An area the rulebook does not declare is BLOCK area_declared.',
    base, request: req('go', 'roof'), want: { status: 'BLOCK', reasons: ['area_declared@builtin'] } });
  add(f, { id: 'p4-undeclared-role', principle: [4], description: 'A role the rulebook does not declare is BLOCK role_declared.',
    base, request: req('go', 'floor', {}, as('robot', 'drone')), want: { status: 'BLOCK', reasons: ['role_declared@builtin'] } });
  add(f, { id: 'p4-role-kind-mismatch', principle: [4], description: 'A declared role claimed under the wrong kind is BLOCK role_declared.',
    base, request: req('go', 'floor', {}, { id: 'p', kind: 'person', roleId: 'bot' }), want: { status: 'BLOCK', reasons: ['required_facts@builtin'] } });
  add(f, { id: 'p4-undeclared-kind', principle: [4], description: 'A participant kind the rulebook does not declare is an incomplete request: BLOCK required_facts.',
    base, request: req('go', 'floor', {}, as('drone', 'bot')), want: { status: 'BLOCK', reasons: ['required_facts@builtin'] } });
  add(f, { id: 'p4-action-not-in-role', principle: [4], description: 'A declared action the role does not list is BLOCK role_permits_action.',
    input: tiny([], { roles: [{ id: 'bot', name: 'Bot', kind: 'robot', actions: ['go'] }] }), request: req('look'), want: { status: 'BLOCK', reasons: ['role_permits_action@builtin'] } });
  add(f, { id: 'p4-unknown-action-deny', principle: [4], description: 'An action the rulebook does not know, with otherwise "deny", is BLOCK unknown_action.',
    base, request: req('fly'), want: { status: 'BLOCK', reasons: ['unknown_action@builtin'] } });
  const waiting = tiny([rule('inv', { answer: 'deny' }, { never: true, when: [{ fact: 'alarm', op: '==', value: true }] })], { otherwise: 'wait-for-approval' });
  add(f, { id: 'p4-unknown-action-wait', principle: [4, 6], description: 'With otherwise "wait-for-approval", an unknown action is PAUSE unknown_action and asks for an approval (anyone).',
    input: waiting, request: req('fly'), want: { status: 'PAUSE', reasons: ['unknown_action@builtin'], asks: ['unknown_action'] } });
  add(f, { id: 'p4-unknown-action-approved', principle: [4, 6], description: 'An approved unknown action is ALLOW when no rule matches it.',
    input: waiting, request: req('fly', 'floor', { approvedBy: 'dana' }), want: { status: 'ALLOW', reasons: ['unknown_action@builtin'] } });
  add(f, { id: 'p4-approved-unknown-still-faces-never-rules', principle: [4, 8], description: 'An approved unknown action still faces every never rule.',
    input: waiting, request: req('fly', 'floor', { approvedBy: 'dana', alarm: true }), want: { status: 'BLOCK', reasons: ['inv@high'] } });
  add(f, { id: 'p4-action-requires-fact', principle: [4], description: 'A fact an action requires (`requires`) is required for that action even though it is optional elsewhere.',
    input: tiny([], { actions: [{ id: 'go', kinds: ['robot'], tags: ['movement'], requires: ['speedAsked'] }, { id: 'look', kinds: ['robot'] }] }),
    request: req('go'), want: { status: 'BLOCK', reasons: ['required_facts@builtin'] } });
  add(f, { id: 'p4-default-fills-in', principle: [4], description: 'Only a fact with a declared default is ever filled in: alarm absent means false, so the alarm rule does not match.',
    input: tiny([rule('alarm', { answer: 'deny' }, { when: [{ fact: 'alarm', op: '==', value: true }] })]), request: req(), want: { status: 'ALLOW', reasons: ['role_permits_action'] } });
  add(f, { id: 'p4-rule-on-optional-fact-rejected', principle: [4], description: 'A rule that conditions on an optional fact with no default is rejected: it could never be evaluated without guessing.',
    input: tiny([rule('r', { answer: 'deny' })]), tamper: rb => { rb.rules[0].when = [{ fact: 'speedAsked', op: '>', value: 1 }]; }, want: { error: true } });
  add(f, { id: 'p4-undeclared-facts-ignored', principle: [4], description: 'Facts the rulebook does not declare are ignored, not errors.',
    base, request: req('go', 'floor', { weather: 'rain' }), want: { status: 'ALLOW', reasons: ['role_permits_action'] } });
  add(f, { id: 'p4-bad-otherwise-rejected', principle: [4], description: 'A rulebook whose `otherwise` is neither deny nor wait-for-approval is rejected.',
    input: tiny([]), tamper: rb => { (rb as { otherwise: string }).otherwise = 'allow'; }, want: { error: true } });
}

// ─── Principle 5: every decision explains itself ─────────────────────────────

function p5() {
  const f = 'p5-explains.json';
  const site = tiny([
    rule('cap', { answer: 'limit', limits: { speed: 1 } }, { does: 'go' }),
    rule('near', { answer: 'limit', limits: { speed: 0.3 } }, { does: 'go', when: [{ fact: 'people', op: '>', value: 0 }] }),
    rule('ok_look', { answer: 'allow' }, { does: 'look' }),
    rule('no_yard_night', { answer: 'deny', instead: 'dock' }, { where: 'yard', when: [{ fact: 'time', op: 'between', from: '22:00', to: '06:00' }] }),
  ]);
  add(f, { id: 'p5-trace-in-order', principle: [5], description: 'The trace lists every check that ran, in order: builtin role check first, then matching rules in rulebook order, each with its authority.',
    input: site, request: req('go', 'floor', { people: 2, speedAsked: 1 }), want: { status: 'LIMIT', reasons: ['near@high'], limits: { speed: 0.3 } } });
  add(f, { id: 'p5-reasons-are-the-strictest', principle: [5], description: 'Reasons are exactly the checks at the strictest status; with two limit rules and one at the minimum, only that one is a reason.',
    input: site, request: req('go', 'floor', { people: 0, speedAsked: 2 }), want: { status: 'LIMIT', reasons: ['cap@high'], limits: { speed: 1 } } });
  add(f, { id: 'p5-allow-within-limit-reports-limit', principle: [5, 9], description: 'A request under every limit is ALLOW and still carries the effective limits, so the controller knows the ceiling.',
    input: site, request: req('go', 'floor', { people: 0, speedAsked: 0.5 }), want: { status: 'ALLOW', reasons: ['role_permits_action', 'cap'], limits: { speed: 1 } } });
  add(f, { id: 'p5-deny-instead', principle: [5], description: 'A deny rule\'s `instead` hint is returned as `then` when the decision is BLOCK.',
    input: site, request: req('go', 'yard', { time: '23:00' }), want: { status: 'BLOCK', reasons: ['no_yard_night@high'], then: 'dock' } });
  add(f, { id: 'p5-fingerprint-is-the-rulebooks', principle: [5], description: 'The decision carries the fingerprint of the rulebook that decided it.',
    input: site, request: req('look'), want: { status: 'ALLOW', reasons: ['role_permits_action', 'ok_look'] } });
  add(f, { id: 'p5-first-block-ends-the-trace', principle: [5], description: 'A BLOCK from a builtin shape check ends the trace: nothing after it runs.',
    input: site, request: req('go', 'nowhere'), want: { status: 'BLOCK', reasons: ['area_declared@builtin'] } });
  add(f, { id: 'p5-never-rules-end-the-trace', principle: [5, 8], description: 'When a never rule matches, the trace holds the never rules that matched and nothing else.',
    input: tiny([rule('inv', { answer: 'deny' }, { never: true, where: 'yard' }), rule('cap', { answer: 'limit', limits: { speed: 1 } })]),
    request: req('go', 'yard'), want: { status: 'BLOCK', reasons: ['inv@high'] } });
}

// ─── Principle 6: waiting has two meanings ───────────────────────────────────

function p6() {
  const f = 'p6-waiting.json';
  const site = tiny([
    rule('clear', { answer: 'wait', for: 'condition' }, { does: 'go', when: [{ fact: 'people', op: '>', value: 0 }] }),
    rule('ask', { answer: 'wait', for: 'approval' }, { does: 'look' }),
    rule('ask_and_clear', { answer: 'wait', for: 'approval' }, { does: 'go', where: 'yard' }),
    rule('no_night', { answer: 'deny' }, { when: [{ fact: 'time', op: 'between', from: '22:00', to: '06:00' }] }),
  ]);
  add(f, { id: 'p6-condition-wait', principle: [6], description: 'A condition wait is PAUSE and carries no approval request: no signature can clear it.',
    input: site, request: req('go', 'floor', { people: 1 }), want: { status: 'PAUSE', reasons: ['clear@high'] } });
  add(f, { id: 'p6-approval-never-clears-condition', principle: [6], description: 'An approval does not clear a condition wait.',
    input: site, request: req('go', 'floor', { people: 1, approvedBy: 'dana' }), want: { status: 'PAUSE', reasons: ['clear@high'] } });
  add(f, { id: 'p6-condition-clears-by-facts', principle: [6], description: 'Only a change in the facts clears a condition wait.',
    input: site, request: req('go', 'floor', { people: 0 }), want: { status: 'ALLOW', reasons: ['role_permits_action'] } });
  add(f, { id: 'p6-approval-wait-asks', principle: [6], description: 'An approval wait with no named approver is PAUSE and asks for an approval from anyone.',
    input: site, request: req('look'), want: { status: 'PAUSE', reasons: ['ask@high'], asks: ['ask'] } });
  add(f, { id: 'p6-approval-wait-cleared', principle: [6], description: 'A plain approval clears an approval wait that names nobody in particular.',
    input: site, request: req('look', 'floor', { approvedBy: 'dana' }), want: { status: 'ALLOW', reasons: ['role_permits_action', 'ask'] } });
  add(f, { id: 'p6-both-waits-approval-given', principle: [6], description: 'With an approval wait cleared and a condition wait open, the decision is PAUSE for the condition alone, with no approval request.',
    input: site, request: req('go', 'yard', { people: 1, approvedBy: 'dana' }), want: { status: 'PAUSE', reasons: ['clear@high'] } });
  add(f, { id: 'p6-both-waits-nothing-given', principle: [6], description: 'With both waits open the decision is PAUSE for both, and asks only for the approval.',
    input: site, request: req('go', 'yard', { people: 1 }), want: { status: 'PAUSE', reasons: ['clear@high', 'ask_and_clear@high'], asks: ['ask_and_clear'] } });
  add(f, { id: 'p6-deny-beats-wait', principle: [6], description: 'Strictest wins: a deny alongside a wait is BLOCK, and nothing is asked for.',
    input: site, request: req('look', 'floor', { time: '23:00' }), want: { status: 'BLOCK', reasons: ['no_night@high'] } });
}

// ─── Principle 7: conflicts are surfaced ─────────────────────────────────────

function p7() {
  const f = 'p7-conflicts.json';
  const pair = (id: string, description: string, rules: Draft[], findings: string[], extra: Partial<CompileDomainInput> = {}) =>
    add(f, { id, principle: [7], description, input: tiny(rules, extra), want: { findings } });
  pair('p7-contradiction-certain', 'An allow and a deny at the same authority where every request matching one matches the other: a certain contradiction.',
    [rule('yes', { answer: 'allow' }), rule('no', { answer: 'deny' }, { where: 'yard' })], ['contradiction:certain:yes+no']);
  pair('p7-contradiction-partial-overlap', 'Conditions on two independent facts (people == 0, load > 0) can both hold: the analysis is exact, so the contradiction is certain, with a witness request that matches both.',
    [rule('yes', { answer: 'allow' }, { when: [{ fact: 'people', op: '==', value: 0 }] }), rule('wait', { answer: 'wait', for: 'condition' }, { when: [{ fact: 'load', op: '>', value: 0 }] })], ['contradiction:certain:yes+wait']);
  pair('p7-shadowed', 'A looser rule fully covered by a stricter one at the same authority can never change a decision: shadowed.',
    [rule('big', { answer: 'deny' }), rule('small', { answer: 'wait', for: 'approval' }, { where: 'yard', when: [{ fact: 'people', op: '>', value: 2 }] })], ['shadowed:certain:small+big']);
  pair('p7-duplicate-same-scope', 'Two rules with the same scope and the same answer: duplicate.',
    [rule('a', { answer: 'deny' }, { does: 'look' }), rule('b', { answer: 'deny' }, { does: 'look' })], ['duplicate:certain:a+b']);
  pair('p7-duplicate-covered', 'A rule whose scope lies inside another with the same answer adds nothing: duplicate, narrower rule first.',
    [rule('a', { answer: 'deny' }), rule('b', { answer: 'deny' }, { does: 'look', where: 'yard' })], ['duplicate:certain:b+a']);
  pair('p7-limit-disagreement', 'Two limits on the same name whose scopes partly overlap with different values: limit_disagreement; the lower applies where both match.',
    [rule('fast', { answer: 'limit', limits: { speed: 1 } }, { where: 'floor', when: [{ fact: 'people', op: '<', value: 5 }] }), rule('slow', { answer: 'limit', limits: { speed: 0.5 } }, { when: [{ fact: 'people', op: '>', value: 2 }] })], ['limit_disagreement:certain:fast+slow']);
  pair('p7-refinement-is-not-a-finding', 'A stricter special case of a looser limit is normal layering: no finding.',
    [rule('site', { answer: 'limit', limits: { speed: 1 } }), rule('near', { answer: 'limit', limits: { speed: 0.3 } }, { when: [{ fact: 'people', op: '>', value: 0 }] })], []);
  pair('p7-restrictions-layer', 'A deny and a condition wait that overlap are one restriction on another, not a conflict: no finding.',
    [rule('deny', { answer: 'deny' }, { where: 'yard' }), rule('wait', { answer: 'wait', for: 'condition' }, { when: [{ fact: 'people', op: '>', value: 0 }] })], []);
  pair('p7-never-vs-allow', 'A rule that tries to allow what a never rule forbids: never_vs_rule, a conflict; certain, since every request matching the never rule matches the allow.',
    [rule('inv', { answer: 'deny' }, { never: true, when: [{ fact: 'alarm', op: '==', value: true }] }), rule('ok', { answer: 'allow' }, { does: 'go' })], ['never_vs_rule:certain:ok+inv']);
  pair('p7-never-and-deny-not-duplicate', 'A never rule is kept for its own sake: an ordinary deny with the same scope is not reported as a duplicate.',
    [rule('inv', { answer: 'deny' }, { never: true }), rule('no', { answer: 'deny' })], []);
  pair('p7-approval-named-vs-unnamed', 'An approval wait naming nobody is looser than one naming an approver; fully covered, it is shadowed.',
    [rule('ask_high', { answer: 'wait', for: 'approval', by: 'high' }), rule('ask_any', { answer: 'wait', for: 'approval' }, { where: 'yard' })], ['shadowed:certain:ask_any+ask_high']);
  pair('p7-touching-boundary-overlaps', 'people <= 3 and people >= 3 share the value 3: the overlap is real, certain, and the witness carries people = 3.',
    [rule('a', { answer: 'allow' }, { when: [{ fact: 'people', op: '<=', value: 3 }] }), rule('b', { answer: 'deny' }, { when: [{ fact: 'people', op: '>=', value: 3 }] })], ['contradiction:certain:a+b']);
  pair('p7-witness-on-every-shape', 'A witness is found through every constraint shape at once: an integer range, a real range, a time window, a day set, an enum and a boolean.',
    [rule('a', { answer: 'allow' }, { when: [{ fact: 'people', op: '>', value: 2 }, { fact: 'load', op: '>=', value: 1.5 }, { fact: 'time', op: 'between', from: '22:00', to: '06:00' }, { fact: 'day', op: 'days', days: ['sat', 'sun'] }] }),
     rule('b', { answer: 'deny' }, { when: [{ fact: 'people', op: '<=', value: 4 }, { fact: 'load', op: '<', value: 3 }, { fact: 'time', op: '<', value: '08:00' }, { fact: 'day', op: '!=', value: 'sat' }, { fact: 'mode', op: 'in', values: ['b', 'c'] }, { fact: 'alarm', op: '==', value: true }] })], ['contradiction:certain:a+b']);
  pair('p7-history-rule-is-possible-without-witness', 'A rule that conditions on history is not analysed: the overlap on facts is real, the certainty is "possible", and no witness is given.',
    [rule('yes', { answer: 'allow' }), rule('too_many', { answer: 'deny' }, { does: 'look', history: [{ actions: 'look', op: '>=', value: 5 }] })], ['contradiction:possible:yes+too_many']);
  // Provable disjointness: no finding, for every shape of constraint.
  const disjoint: Array<[string, string, Rule['when'], Rule['when']]> = [
    ['p7-disjoint-number-ranges', 'people < 3 and people >= 3 can never both hold: no finding.', [{ fact: 'people', op: '<', value: 3 }], [{ fact: 'people', op: '>=', value: 3 }]],
    ['p7-disjoint-integer-gap', 'For an integer fact, > 2 and < 3 can never both hold: no finding.', [{ fact: 'people', op: '>', value: 2 }], [{ fact: 'people', op: '<', value: 3 }]],
    ['p7-disjoint-eq-ne', '!= 2 and == 2 are disjoint.', [{ fact: 'people', op: '!=', value: 2 }], [{ fact: 'people', op: '==', value: 2 }]],
    ['p7-disjoint-in-sets', 'Two disjoint `in` sets are disjoint.', [{ fact: 'people', op: 'in', values: [1, 2] }], [{ fact: 'people', op: 'in', values: [3, 4] }]],
    ['p7-disjoint-time-windows', 'A window and its exact complement (overnight) are disjoint.', [{ fact: 'time', op: 'between', from: '09:00', to: '12:00' }], [{ fact: 'time', op: 'between', from: '12:00', to: '09:00' }]],
    ['p7-disjoint-time-window-vs-compare', 'An overnight window and the daytime expressed with >= and < are disjoint.', [{ fact: 'time', op: 'between', from: '22:00', to: '06:00' }], [{ fact: 'time', op: '>=', value: '06:00' }, { fact: 'time', op: '<', value: '22:00' }]],
    ['p7-disjoint-days', 'Disjoint day sets are disjoint.', [{ fact: 'day', op: 'days', days: ['sat'] }], [{ fact: 'day', op: 'days', days: ['mon', 'tue'] }]],
    ['p7-disjoint-boolean', 'true and false are disjoint.', [{ fact: 'alarm', op: '==', value: true }], [{ fact: 'alarm', op: '==', value: false }]],
    ['p7-disjoint-enum', 'Disjoint enum sets, and != vs ==, are disjoint.', [{ fact: 'mode', op: '!=', value: 'a' }], [{ fact: 'mode', op: '==', value: 'a' }]],
    ['p7-disjoint-on-one-shared-fact', 'Two rules sharing a day but disagreeing on a count are disjoint because of the count.', [{ fact: 'day', op: 'days', days: ['sat'] }, { fact: 'people', op: '>=', value: 3 }], [{ fact: 'day', op: 'days', days: ['sat'] }, { fact: 'people', op: '<', value: 3 }]],
    ['p7-disjoint-integer-all-excluded', 'An integer range whose every whole number is excluded (1..2 minus 1 and 2) is empty: no finding.', [{ fact: 'people', op: '>=', value: 1 }, { fact: 'people', op: '<=', value: 2 }, { fact: 'people', op: '!=', value: 1 }], [{ fact: 'people', op: '!=', value: 2 }]],
  ];
  pair('p7-real-gap-is-not-empty', 'A real range is never emptied by excluded points: 1 < load < 2 and load != 1.5 still meet, and the witness avoids 1.5.',
    [rule('a', { answer: 'allow' }, { when: [{ fact: 'load', op: '>', value: 1 }, { fact: 'load', op: '<', value: 2 }] }), rule('b', { answer: 'deny' }, { when: [{ fact: 'load', op: '!=', value: 1.5 }] })], ['contradiction:certain:a+b']);
  for (const [id, description, a, b] of disjoint) pair(id, description, [rule('a', { answer: 'allow' }, { when: a }), rule('b', { answer: 'deny' }, { when: b })], []);
  pair('p7-disjoint-selectors', 'Rules on different areas never meet: no finding, whatever their answers.',
    [rule('a', { answer: 'allow' }, { where: 'floor' }), rule('b', { answer: 'deny' }, { where: 'yard' })], []);
  add(f, { id: 'p7-impossible-condition-rejected', principle: [7, 4], description: 'A rule whose own conditions can never all hold (people > 5 and people < 3) is rejected.',
    input: tiny([rule('r', { answer: 'deny' })]), tamper: rb => { rb.rules[0].when = [{ fact: 'people', op: '>', value: 5 }, { fact: 'people', op: '<', value: 3 }]; }, want: { error: true } });
  add(f, { id: 'p7-grocery-example-findings', principle: [7, 2], description: 'The shipped grocery example reports the manager\'s deliberate conflicts: a tightening, an authority-override and a same-authority contradiction.',
    base: 'grocery', want: { findings: ['tightening:certain:robot_speed+checkout_speed', 'authority-override:certain:shopper_photos_entrance+glasses_capture', 'contradiction:certain:staff_audio_back_room+no_audio_back_room_lunch'] } });
}

// ─── Principle 8: one law for everyone ───────────────────────────────────────

function p8() {
  const f = 'p8-one-law.json';
  const base = 'shared';
  add(f, { id: 'p8-same-rule-robot', principle: [8], description: 'A rule on who "*" binds a robot…',
    base, request: req('look', 'yard'), want: { status: 'BLOCK', reasons: ['no_looking_outside@high'] } });
  add(f, { id: 'p8-same-rule-person', principle: [8], description: '…a person…',
    base, request: req('look', 'yard', {}, as('person', 'visitor')), want: { status: 'BLOCK', reasons: ['no_looking_outside@high'] } });
  add(f, { id: 'p8-same-rule-agent', principle: [8], description: '…and an AI agent, through the same decision path, citing the same rule.',
    base, request: req('look', 'yard', {}, as('agent', 'planner')), want: { status: 'BLOCK', reasons: ['no_looking_outside@high'] } });
  add(f, { id: 'p8-kind-selector', principle: [8], description: 'who "kind:agent" selects every role of that kind.',
    base, request: req('plan', 'floor', {}, as('agent', 'planner')), want: { status: 'PAUSE', reasons: ['agents_plan_with_approval@high'], asks: ['agents_plan_with_approval@tag:staff'] } });
  add(f, { id: 'p8-tag-selector-excludes', principle: [8], description: 'who ["kind:person", "!tag:staff"] binds a visitor but not a staff-tagged guard.',
    base, request: req('look', 'lab', {}, as('person', 'visitor')), want: { status: 'BLOCK', reasons: ['non_staff_out_of_lab@high'] } });
  add(f, { id: 'p8-tag-selector-excludes-b', principle: [8], description: 'The staff-tagged guard passes the rule the visitor hit.',
    base, request: req('look', 'lab', {}, as('person', 'guard')), want: { status: 'ALLOW', reasons: ['role_permits_action'] } });
  add(f, { id: 'p8-area-allow-roles', principle: [8], description: 'An area limited to listed roles (compiled to a never rule area_role_limits:<area>) blocks everyone else.',
    base, request: req('look', 'office'), want: { status: 'BLOCK', reasons: ['area_role_limits:office@low'] } });
  add(f, { id: 'p8-area-deny-roles', principle: [8], description: 'An area that denies a role (never rule area_role_limits:<area>:deny) blocks that role.',
    base, request: req('look', 'lab', {}, as('agent', 'planner')), want: { status: 'BLOCK', reasons: ['area_role_limits:lab:deny@low'] } });
  add(f, { id: 'p8-person-cannot-take-robot-action', principle: [8, 4], description: 'A declared action that the person\'s role does not list is BLOCK role_permits_action: the same check, whatever the kind.',
    base, request: req('go', 'floor', {}, as('person', 'guard')), want: { status: 'BLOCK', reasons: ['role_permits_action@builtin'] } });
  add(f, { id: 'p8-role-cannot-list-foreign-action', principle: [8], description: 'A rulebook where a person role lists a robot-only action is rejected.',
    base, tamper: rb => { rb.roles.find(r => r.id === 'guard')!.actions.push('go'); }, want: { error: true } });
}

// ─── Principle 9: rules say what may happen; evidence says what is true ──────

function p9() {
  const f = 'p9-boundary.json';
  const site = tiny([
    rule('alarm_stop', { answer: 'deny' }, { never: true, when: [{ fact: 'alarm', op: '==', value: true }] }),
    rule('cap', { answer: 'limit', limits: { speed: 1 } }),
  ]);
  add(f, { id: 'p9-facts-are-trusted', principle: [9], description: 'The rulebook takes the facts as given: alarm true is an emergency whatever else is true.',
    input: site, request: req('go', 'floor', { alarm: true }), want: { status: 'BLOCK', reasons: ['alarm_stop@high'] } });
  add(f, { id: 'p9-time-is-a-fact', principle: [9], description: 'There is no clock: the only time the rulebook knows is the `time` fact in the request.',
    input: tiny([rule('night', { answer: 'deny' }, { when: [{ fact: 'time', op: 'between', from: '22:00', to: '06:00' }] })]),
    request: req('go', 'floor', { time: '03:00' }), want: { status: 'BLOCK', reasons: ['night@high'] } });
  add(f, { id: 'p9-limit-is-a-ceiling-not-control', principle: [9], description: 'A LIMIT says the ceiling; the controller enforces it. The decision does not say what speed to drive.',
    input: site, request: req('go', 'floor', { speedAsked: 1.4 }), want: { status: 'LIMIT', reasons: ['cap@high'], limits: { speed: 1 } } });
}

// ─── Plans: a whole plan on projected facts (principles 3, 4, 5) ────────────

function plans() {
  const f = 'plans.json';
  const planRule = (id: string, check: PlanRule['check'], patch: Partial<PlanRule> = {}): PlanRule => ({ id, text: id, who: '*', check, setBy: 'high', source: { kind: 'manual', ref: id }, ...patch });
  const site = (planRules: PlanRule[] = [], rules: Draft[] = []): CompileDomainInput => tiny([
    rule('no_load_in_yard', { answer: 'deny', instead: 'drop' }, { does: 'go', where: 'yard', when: [{ fact: 'loaded', op: '==', value: true }] }),
    rule('ask_before_look', { answer: 'wait', for: 'approval', by: 'high' }, { does: 'look' }),
    ...rules,
  ], {
    actions: [
      { id: 'go', kinds: ['robot'], tags: ['movement'], effects: [{ op: 'move' }] },
      { id: 'look', kinds: ['robot'] },
      { id: 'pick', kinds: ['robot'], effects: [{ op: 'set', fact: 'loaded', value: true }, { op: 'add', fact: 'people', value: 1 }] },
      { id: 'drop', kinds: ['robot'], effects: [{ op: 'set', fact: 'loaded', value: false }] },
    ],
    facts: [
      { id: 'people', type: 'number', integer: true, min: 0, max: 2, required: true },
      { id: 'load', type: 'number', min: 0, default: 0 },
      { id: 'time', type: 'time', required: true },
      { id: 'mode', type: 'enum', values: ['a', 'b', 'c'], default: 'a' },
      { id: 'alarm', type: 'boolean', default: false },
      { id: 'day', type: 'day', required: true },
      { id: 'speedAsked', type: 'number', min: 0 },
      { id: 'loaded', type: 'boolean', default: false },
    ],
    roles: [{ id: 'bot', name: 'Bot', kind: 'robot', actions: ['go', 'look', 'pick', 'drop'] }],
    ...(planRules.length ? { planRules } : {}),
  });
  const bot = { id: 'b-1', kind: 'robot', roleId: 'bot' };
  const start = { people: 0, time: '10:00', day: 'mon' };
  const ok = { approvedBy: { id: 'ann', authority: 'high' } };
  const plan = (steps: Plan['steps'], patch: Partial<Plan> = {}): Plan => ({ participant: bot, initialFacts: start, steps, ...patch });
  const shaped = site([planRule('end_in_floor', { kind: 'ends_in', areas: 'floor' }), planRule('look_before_pick', { kind: 'before', first: 'look', then: 'pick', sameArea: true }, { setBy: 'low', who: 'bot' }), planRule('one_pick', { kind: 'at_most', actions: 'pick', count: 1 }, { setBy: 'low' }), planRule('end_with_drop_or_go', { kind: 'ends_with', actions: ['drop', 'go'] })]);

  add(f, { id: 'plan-effects-project-and-first-block-rejects', principle: [3, 4, 5], description: 'Each step is decided on facts projected by the earlier steps\' declared effects: pick sets loaded, so the move to the yard is refused at step 3 by the rule, its reason, its authority and its instead hint; nothing is projected past it.',
    input: site(), plan: plan([{ action: 'look', area: 'floor', facts: ok }, { action: 'pick' }, { action: 'go', area: 'yard' }, { action: 'drop' }]),
    want: { status: 'BLOCK', steps: ['ALLOW', 'ALLOW', 'BLOCK'], firstViolation: 'no_load_in_yard@high#2:step' } });
  add(f, { id: 'plan-accepted-with-final-facts', principle: [3, 5], description: 'A plan every step of which passes is ALLOW, with the projected facts and the area it ends in.',
    input: site(), plan: plan([{ action: 'look', area: 'floor', facts: ok }, { action: 'pick' }, { action: 'drop' }, { action: 'go', area: 'yard' }, { action: 'go', area: 'floor' }]),
    want: { status: 'ALLOW', steps: ['ALLOW', 'ALLOW', 'ALLOW', 'ALLOW', 'ALLOW'] } });
  add(f, { id: 'plan-area-defaults-to-where-the-last-move-left-it', principle: [3], description: 'A step without an area happens where the previous move left the participant; a step without a move effect does not move it.',
    input: site(), plan: plan([{ action: 'go', area: 'yard' }, { action: 'drop' }, { action: 'look', area: 'floor', facts: ok }, { action: 'drop' }]),
    want: { status: 'ALLOW', steps: ['ALLOW', 'ALLOW', 'ALLOW', 'ALLOW'] } });
  add(f, { id: 'plan-pause-collects-approvals', principle: [6, 3], description: 'A step that waits for approval is PAUSE; the plan result lists every approval request so a planner can collect them up front, and later steps are still checked.',
    input: site(), plan: plan([{ action: 'look', area: 'floor' }, { action: 'pick' }, { action: 'drop' }]),
    want: { status: 'PAUSE', steps: ['PAUSE', 'ALLOW', 'ALLOW'], asks: ['ask_before_look@high'] } });
  add(f, { id: 'plan-rules-judge-the-whole-plan', principle: [3, 5], description: 'Plan rules: ends_in, before (same area), at_most and ends_with each name the step where the plan breaks them, with the authority that set each; the first violation is the earliest by step.',
    input: shaped, plan: plan([{ action: 'pick', area: 'floor' }, { action: 'drop' }, { action: 'look', facts: ok }, { action: 'pick' }, { action: 'drop' }, { action: 'look', area: 'yard', facts: ok }]),
    want: { status: 'BLOCK', steps: ['ALLOW', 'ALLOW', 'ALLOW', 'ALLOW', 'ALLOW', 'ALLOW'], planChecks: ['end_in_floor:ALLOW', 'look_before_pick:BLOCK', 'one_pick:BLOCK', 'end_with_drop_or_go:BLOCK'], firstViolation: 'look_before_pick@low#0:plan' } });
  add(f, { id: 'plan-rules-pass', principle: [3], description: 'The same plan rules, satisfied: a look before the only pick in the same area, ending with a move onto the floor.',
    input: shaped, plan: plan([{ action: 'look', area: 'floor', facts: ok }, { action: 'pick' }, { action: 'drop' }, { action: 'go', area: 'yard' }, { action: 'go', area: 'floor' }]),
    want: { status: 'ALLOW', steps: ['ALLOW', 'ALLOW', 'ALLOW', 'ALLOW', 'ALLOW'], planChecks: ['end_in_floor:ALLOW', 'look_before_pick:ALLOW', 'one_pick:ALLOW', 'end_with_drop_or_go:ALLOW'] } });
  add(f, { id: 'plan-history-counts-for-before', principle: [3], description: 'What the participant did before the plan (plan.history) counts for a "before" plan rule.',
    input: shaped, plan: plan([{ action: 'pick', area: 'floor' }, { action: 'drop' }], { history: [{ action: 'look', areaId: 'floor' }] }),
    want: { status: 'ALLOW', steps: ['ALLOW', 'ALLOW'], planChecks: ['end_in_floor:ALLOW', 'look_before_pick:ALLOW', 'one_pick:ALLOW', 'end_with_drop_or_go:ALLOW'] } });
  add(f, { id: 'plan-rule-binds-by-role', principle: [8], description: 'A plan rule binds the roles its who selector names and no others: one on ["*", "!bot"] does not apply to the bot, so it is not even checked.',
    input: site([planRule('no_picks', { kind: 'at_most', actions: 'pick', count: 0 }, { who: ['*', '!bot'] })]), plan: plan([{ action: 'pick', area: 'floor' }, { action: 'drop' }]),
    want: { status: 'ALLOW', steps: ['ALLOW', 'ALLOW'] } });
  add(f, { id: 'plan-projected-fact-out-of-range-is-a-refusal', principle: [4], description: 'An effect that pushes a fact outside its declared range (people max 2) is not clamped: the next step is BLOCK required_facts.',
    input: site(), plan: plan([{ action: 'look', area: 'floor', facts: ok }, { action: 'pick' }, { action: 'drop' }, { action: 'pick' }, { action: 'drop' }, { action: 'pick' }], { initialFacts: { ...start, people: 1 } }),
    want: { status: 'BLOCK', steps: ['ALLOW', 'ALLOW', 'ALLOW', 'ALLOW', 'BLOCK'], firstViolation: 'required_facts@builtin#4:step' } });
  add(f, { id: 'plan-clock-advances-per-step', principle: [9, 3], description: 'With clock, startTime and stepDurationSeconds, the named time fact advances per step (whole minutes, wrapping at midnight); there is still no clock in the engine.',
    input: site([], [rule('no_night', { answer: 'deny' }, { when: [{ fact: 'time', op: 'between', from: '22:00', to: '06:00' }] })]),
    plan: plan([{ action: 'drop', area: 'floor' }, { action: 'drop' }, { action: 'drop' }], { clock: 'time', startTime: '21:58', stepDurationSeconds: 90 }),
    want: { status: 'BLOCK', steps: ['ALLOW', 'ALLOW', 'BLOCK'], firstViolation: 'no_night@high#2:step' } });
  add(f, { id: 'plan-without-steps-is-block', principle: [4], description: 'A plan with no steps is BLOCK required_facts, never a throw and never permission.',
    input: site(), plan: plan([]), want: { status: 'BLOCK', firstViolation: 'required_facts@builtin#0:plan' } });
  add(f, { id: 'plan-first-step-needs-an-area', principle: [4], description: 'The first step must say where it is; a plan that does not is BLOCK required_facts.',
    input: site(), plan: plan([{ action: 'drop' }]), want: { status: 'BLOCK', firstViolation: 'required_facts@builtin#0:plan' } });
  add(f, { id: 'plan-unknown-clock-is-block', principle: [4], description: 'A plan naming a clock that is not a declared time fact is BLOCK required_facts.',
    input: site(), plan: plan([{ action: 'drop', area: 'floor' }], { clock: 'people', startTime: '10:00' }), want: { status: 'BLOCK', firstViolation: 'required_facts@builtin#0:plan' } });
  add(f, { id: 'plan-same-plan-same-answer', principle: [3], description: 'A plan is decided by the rulebook and the plan alone: a note on a step and facts the rules do not mention change nothing.',
    input: site(), plan: plan([{ action: 'look', area: 'floor', facts: ok, note: 'anything' }, { action: 'pick' }, { action: 'go', area: 'yard', facts: { mode: 'c', weather: 'rain' } }]),
    want: { status: 'BLOCK', steps: ['ALLOW', 'ALLOW', 'BLOCK'], firstViolation: 'no_load_in_yard@high#2:step' } });
  add(f, { id: 'plan-effect-on-unknown-fact-rejected', principle: [4], description: 'An action whose effect names a fact the site did not declare makes the rulebook invalid.',
    input: site(), tamper: rb => { rb.actions.find(a => a.id === 'pick')!.effects = [{ op: 'set', fact: 'nope', value: 1 }]; }, want: { error: true } });
  add(f, { id: 'plan-effect-wrong-type-rejected', principle: [4], description: 'An add effect on a boolean fact makes the rulebook invalid.',
    input: site(), tamper: rb => { rb.actions.find(a => a.id === 'pick')!.effects = [{ op: 'add', fact: 'loaded', value: 1 }]; }, want: { error: true } });
  add(f, { id: 'plan-rule-without-setby-rejected', principle: [1, 2], description: 'A plan rule that does not say who set it is rejected, like any rule.',
    input: shaped, tamper: rb => { delete (rb.planRules![0] as Partial<PlanRule>).setBy; }, want: { error: true } });
  add(f, { id: 'plan-rule-unknown-area-rejected', principle: [4], description: 'A plan rule naming an undeclared area is rejected.',
    input: shaped, tamper: rb => { rb.planRules![0].check = { kind: 'ends_in', areas: 'roof' }; }, want: { error: true } });
  add(f, { id: 'plan-rule-duplicate-finding', principle: [7], description: 'Two plan rules that make the same check for roles in common are a duplicate finding (plan rules only reject, so they never disagree).',
    input: site([planRule('one_pick', { kind: 'at_most', actions: 'pick', count: 1 }), planRule('one_pick_again', { kind: 'at_most', actions: 'pick', count: 1 }, { setBy: 'low' })]), want: { findings: ['duplicate:certain:one_pick+one_pick_again'] } });
}

// ─── History: what the participant did recently (principles 4, 9) ───────────

function history() {
  const f = 'history.json';
  const site = tiny([
    rule('five_looks_an_hour', { answer: 'deny' }, { does: 'look', history: [{ actions: 'look', withinMinutes: 60, clock: 'time', op: '>=', value: 5 }] }),
    rule('not_right_after_go', { answer: 'wait', for: 'condition' }, { does: 'look', history: [{ actions: 'go', sameArea: true, withinMinutes: 10, clock: 'time', op: '>=', value: 1 }] }),
    rule('three_yard_visits', { answer: 'wait', for: 'approval' }, { does: 'go', where: 'yard', history: [{ actions: 'go', areas: 'yard', op: '>=', value: 3 }] }),
  ]);
  const looks = (n: number, from = 9 * 60) => Array.from({ length: n }, (_, i) => ({ action: 'look', areaId: 'floor', at: `${String(Math.floor((from + i) / 60)).padStart(2, '0')}:${String((from + i) % 60).padStart(2, '0')}` }));
  const h = (id: string, principle: number[], description: string, request: DomainRequest, want: Want) => add(f, { id, principle, description, input: site, request, want });
  h('history-under-the-count-allows', [4, 9], 'Four looks in the hour: the rule needs five, so ALLOW.', { ...req('look'), history: looks(4) }, { status: 'ALLOW', reasons: ['role_permits_action'] });
  h('history-at-the-count-denies', [4, 9], 'Five looks in the hour before the time fact: the rule matches and denies.', { ...req('look'), history: looks(5) }, { status: 'BLOCK', reasons: ['five_looks_an_hour@high'] });
  h('history-outside-the-window-does-not-count', [9], 'Only entries within the window before the clock fact count: at 10:05 the 09:00 look is out, four remain, ALLOW.', { ...req('look', 'floor', { time: '10:05' }), history: looks(5) }, { status: 'ALLOW', reasons: ['role_permits_action'] });
  h('history-window-wraps-midnight', [9], 'The window is minute-of-day arithmetic that wraps: a go at 23:55 is eight minutes before 00:03.', { ...req('look', 'floor', { time: '00:03' }), history: [{ action: 'go', areaId: 'floor', at: '23:55' }] }, { status: 'PAUSE', reasons: ['not_right_after_go@high'] });
  h('history-same-area-only', [9], 'sameArea counts only entries in the request\'s own area: the go was in the yard, so no wait.', { ...req('look', 'floor', { time: '00:03' }), history: [{ action: 'go', areaId: 'yard', at: '23:55' }] }, { status: 'ALLOW', reasons: ['role_permits_action'] });
  h('history-areas-selector-without-window', [9], 'A history condition without a window needs no times: three earlier goes into the yard make the next one wait for approval.', { ...req('go', 'yard'), history: [{ action: 'go', areaId: 'yard' }, { action: 'go', areaId: 'yard' }, { action: 'go', areaId: 'floor' }, { action: 'go', areaId: 'yard' }] }, { status: 'PAUSE', reasons: ['three_yard_visits@high'], asks: ['three_yard_visits'] });
  h('history-missing-is-required-facts', [4], 'A rule in scope that counts history, with no history supplied, is BLOCK required_facts: the engine keeps no history and never guesses.', req('look'), { status: 'BLOCK', reasons: ['required_facts@builtin'] });
  h('history-entry-without-time-is-required-facts', [4], 'When a rule in scope uses a window, an entry without "at" is incomplete: BLOCK required_facts.', { ...req('look'), history: [{ action: 'look', areaId: 'floor' }] }, { status: 'BLOCK', reasons: ['required_facts@builtin'] });
  h('history-malformed-entry-is-required-facts', [4], 'An entry that is not { action, areaId, at? } is invalid: BLOCK required_facts.', { ...req('look'), history: [{ action: 'look' } as unknown as { action: string; areaId: string }] }, { status: 'BLOCK', reasons: ['required_facts@builtin'] });
  h('history-not-needed-out-of-scope', [4], 'A request no history rule reaches (go on the floor) needs no history at all.', req('go'), { status: 'ALLOW', reasons: ['role_permits_action'] });
  h('history-empty-list-is-history', [4], 'An empty list is a history (nothing happened): the count is zero.', { ...req('look'), history: [] }, { status: 'ALLOW', reasons: ['role_permits_action'] });
  add(f, { id: 'history-unknown-action-rejected', principle: [4], description: 'A history condition naming an undeclared action makes the rulebook invalid.',
    input: site, tamper: rb => { rb.rules[0].history = [{ actions: 'fly', op: '>=', value: 1 }]; }, want: { error: true } });
  add(f, { id: 'history-window-without-clock-rejected', principle: [4, 9], description: 'A window without a clock fact is rejected: the engine has no clock of its own.',
    input: site, tamper: rb => { rb.rules[0].history = [{ actions: 'look', withinMinutes: 60, op: '>=', value: 5 }]; }, want: { error: true } });
  add(f, { id: 'history-clock-must-be-time-fact', principle: [4], description: 'A clock that is not a declared time fact is rejected.',
    input: site, tamper: rb => { rb.rules[0].history = [{ actions: 'look', withinMinutes: 60, clock: 'people', op: '>=', value: 5 }]; }, want: { error: true } });
}

// ─── Canonical JSON and the fingerprint ──────────────────────────────────────

function fingerprintCases() {
  const f = 'fingerprint.json';
  const vec = (id: string, description: string, value: unknown, canonical: string) => {
    const got = canonicalJson(value);
    if (got !== canonical) fail(id, `canonical: want ${canonical}, got ${got}`);
    (files[f] ??= []).push({ id, principle: [5], description, value, expect: { canonical, fingerprint: fingerprint(value) } });
    count++;
  };
  vec('fp-empty-object', 'The empty object.', {}, '{}');
  vec('fp-empty-array', 'The empty array.', [], '[]');
  vec('fp-keys-sorted', 'Object keys are sorted by UTF-16 code unit; no whitespace.', { b: 1, a: 2, B: 3, _: 4 }, '{"B":3,"_":4,"a":2,"b":1}');
  vec('fp-nested', 'Sorting applies at every depth; arrays keep their order.', { z: [{ y: 1, x: [3, 2, 1] }, 'a'], a: { c: null, b: true } }, '{"a":{"b":true,"c":null},"z":[{"x":[3,2,1],"y":1},"a"]}');
  vec('fp-numbers', 'Numbers as JavaScript JSON.stringify writes them: no trailing zeros, exponent form past 1e21, -0 as 0.', { a: 1.0, b: 0.5, c: 1e21, d: -0, e: 123456789012345680000, f: 0.000001, g: 1e-7 }, '{"a":1,"b":0.5,"c":1e+21,"d":0,"e":123456789012345680000,"f":0.000001,"g":1e-7}');
  vec('fp-strings', 'Strings as JSON.stringify writes them: only ", \\, control characters escaped; non-ASCII kept literal; the hash runs over UTF-16 code units (an emoji is two).', { s: 'a"b\\c\n\t\u0001 é ∑ 🤖' }, '{"s":"a\\"b\\\\c\\n\\t\\u0001 é ∑ 🤖"}');
  vec('fp-null-and-booleans', 'null, true, false.', [null, true, false], '[null,true,false]');
  const g = bases.grocery;
  const { fingerprint: claimed, ...body } = g;
  vec('fp-grocery-rulebook', 'The shipped grocery example rulebook (everything but its fingerprint) hashes to its fingerprint.', body, canonicalJson(body));
  if (fingerprint(body) !== claimed) fail('fp-grocery-rulebook', 'fingerprint mismatch');
  const r = req('go', 'yard', { people: 9 });
  (files[f] ??= []).push({ id: 'fp-request-digest', principle: [5, 6], description: 'requestDigest is the fingerprint of { participant: { id, kind, roleId }, action, areaId } — never the facts.', request: r, expect: { requestDigest: requestDigest(r) } });
  if (requestDigest(r) !== fingerprint({ participant: r.participant, action: 'go', areaId: 'yard' })) fail('fp-request-digest', 'digest definition');
  count++;
}

// ─── Approvals: signed, verified, bound ──────────────────────────────────────

async function approvals() {
  const f = 'approvals.json';
  const pubHigh = await publicKeyOf(SEED_HIGH), pubLead = await publicKeyOf(SEED_LEAD), pubStranger = await publicKeyOf(SEED_STRANGER), pubSite = await publicKeyOf(SEED_SITE);
  const keys: TrustedKey[] = [{ keyId: 'test-high', publicKey: pubHigh, authority: 'high' }, { keyId: 'test-lead', publicKey: pubLead, roleId: 'lead' }];
  const signedInput = shared([
    rule('ask_high', { answer: 'wait', for: 'approval', by: 'high' }, { does: 'go', where: 'yard' }),
    rule('ask_lead', { answer: 'wait', for: 'approval', by: 'tag:lead' }, { does: 'look', who: 'bot' }),
  ], { trustedKeys: keys });
  const rb = compileDomain(signedInput);
  bases.signed = rb;
  writeFileSync(join(OUT, 'rulebooks', 'signed.json'), JSON.stringify(rb, null, 2) + '\n');
  const unsignedInput = shared([rule('ask_high', { answer: 'wait', for: 'approval', by: 'high' }, { does: 'go', where: 'yard' })]);
  const request = req('go', 'yard');
  const digest = requestDigest(request);
  const issuedAt = '2026-10-12T09:00:00Z';
  const highApproval = await signApproval({ id: 'ann', authority: 'high', requestDigest: digest, rulebookFingerprint: rb.fingerprint, issuedAt }, { keyId: 'test-high', privateKey: SEED_HIGH });
  const leadApproval = await signApproval({ id: 'lee', roleId: 'lead', requestDigest: requestDigest(req('look', 'floor')), rulebookFingerprint: rb.fingerprint, issuedAt }, { keyId: 'test-lead', privateKey: SEED_LEAD });
  const forged = await signApproval({ id: 'mallory', authority: 'high', requestDigest: digest, rulebookFingerprint: rb.fingerprint, issuedAt }, { keyId: 'test-high', privateKey: SEED_STRANGER });
  const strangerKey = await signApproval({ id: 'mallory', authority: 'high', requestDigest: digest, rulebookFingerprint: rb.fingerprint, issuedAt }, { keyId: 'test-stranger', privateKey: SEED_STRANGER });
  const overclaim = await signApproval({ id: 'lee', authority: 'high', requestDigest: digest, rulebookFingerprint: rb.fingerprint, issuedAt }, { keyId: 'test-lead', privateKey: SEED_LEAD });
  const otherRequest = await signApproval({ id: 'ann', authority: 'high', requestDigest: requestDigest(req('go', 'floor')), rulebookFingerprint: rb.fingerprint, issuedAt }, { keyId: 'test-high', privateKey: SEED_HIGH });
  const otherRulebook = await signApproval({ id: 'ann', authority: 'high', requestDigest: digest, rulebookFingerprint: '0000000000000000', issuedAt }, { keyId: 'test-high', privateKey: SEED_HIGH });

  const vec = async (id: string, description: string, approval: unknown, ok: boolean, principle = [2, 6]) => {
    const r = await verifyApproval(approval, keys);
    if (r.ok !== ok) fail(id, `verify: want ${ok}, got ${r.ok} (${r.reason})`);
    (files[f] ??= []).push({ id, principle, description, approval, trustedKeys: keys, expect: { verify: { ok }, ...(r.reason ? { note: r.reason } : {}) } });
    count++;
  };
  (files[f] ??= []).push({ id: 'approvals-test-keys', principle: [2, 6], description: 'TEST ONLY keys: the seeds used to produce every signature in this file, so another implementation can reproduce them. Never use them for anything real.',
    testKeys: [
      { keyId: 'test-high', privateKey: SEED_HIGH, publicKey: pubHigh, note: 'TEST ONLY — trusted for authority high' },
      { keyId: 'test-lead', privateKey: SEED_LEAD, publicKey: pubLead, note: 'TEST ONLY — trusted for role lead' },
      { keyId: 'test-stranger', privateKey: SEED_STRANGER, publicKey: pubStranger, note: 'TEST ONLY — not trusted by the rulebook' },
      { keyId: 'test-site', privateKey: SEED_SITE, publicKey: pubSite, note: 'TEST ONLY — signs the rulebook itself' },
    ],
    expect: { canonical: canonicalJson({ b: 1, a: 'x' }), fingerprint: fingerprint({ b: 1, a: 'x' }) }, value: { b: 1, a: 'x' } });
  count++;
  await vec('approvals-verify-ok', 'A well-formed approval signed by a trusted key, claiming the authority that key is trusted for, verifies.', highApproval, true);
  await vec('approvals-verify-role-ok', 'An approval signed by a key trusted for a role, claiming that role, verifies.', leadApproval, true);
  await vec('approvals-verify-forged', 'A signature made with a different private key under a trusted keyId does not verify.', forged, false);
  await vec('approvals-verify-untrusted-key', 'A keyId the rulebook does not trust does not verify.', strangerKey, false);
  await vec('approvals-verify-overclaim', 'A key trusted for a role cannot sign an approval that claims an authority.', overclaim, false);
  await vec('approvals-verify-tampered-field', 'Changing any signed field (here the approver id) breaks the signature.', { ...highApproval, id: 'bob' }, false);
  await vec('approvals-verify-missing-field', 'An approval with no issuedAt is malformed.', (() => { const { issuedAt: _i, ...rest } = highApproval; return rest; })(), false);
  await vec('approvals-verify-bad-signature-encoding', 'A signature that is not 64 bytes of hex does not verify.', { ...highApproval, signature: 'zz' }, false);

  const dec = (id: string, description: string, approvedBy: unknown, want: Want, r: DomainRequest = request) =>
    add(f, { id, principle: [2, 6], description, base: 'signed', request: { ...r, facts: { ...r.facts, ...(approvedBy === undefined ? {} : { approvedBy }) } }, want });
  dec('approvals-pause-asks-with-digest', 'With trusted keys declared, an approval wait returns an approval request carrying the request digest and the rulebook fingerprint to sign.', undefined, { status: 'PAUSE', reasons: ['ask_high@high'], asks: ['ask_high@high'] });
  dec('approvals-verified-clears', 'A verified signed approval bound to this request and this rulebook clears the wait.', { ...highApproval, verified: true }, { status: 'ALLOW', reasons: ['role_permits_action', 'ask_high'] });
  dec('approvals-unverified-does-not-clear', 'The same signed approval without `verified: true` (the caller never verified it) does not clear the wait.', highApproval, { status: 'PAUSE', reasons: ['ask_high@high'], asks: ['ask_high@high'] });
  dec('approvals-plain-does-not-clear-when-keys-declared', 'With trusted keys declared, a plain { id, authority } approval no longer clears anything.', { id: 'ann', authority: 'high' }, { status: 'PAUSE', reasons: ['ask_high@high'], asks: ['ask_high@high'] });
  dec('approvals-other-request-does-not-clear', 'A verified approval for a different request (digest mismatch) does not clear this one.', { ...otherRequest, verified: true }, { status: 'PAUSE', reasons: ['ask_high@high'], asks: ['ask_high@high'] });
  dec('approvals-other-rulebook-does-not-clear', 'A verified approval given under another rulebook (fingerprint mismatch) does not clear the wait.', { ...otherRulebook, verified: true }, { status: 'PAUSE', reasons: ['ask_high@high'], asks: ['ask_high@high'] });
  dec('approvals-verified-but-insufficient', 'A verified approval still has to hold what the rule names: a lead\'s approval does not clear a wait by "high".', { ...leadApproval, verified: true, requestDigest: digest }, { status: 'PAUSE', reasons: ['ask_high@high'], asks: ['ask_high@high'] });
  dec('approvals-verified-role-clears', 'A verified approval by role tag clears a wait that names that tag.', { ...leadApproval, verified: true }, { status: 'ALLOW', reasons: ['role_permits_action', 'ask_lead'] }, req('look', 'floor'));
  add(f, { id: 'approvals-plain-ok-without-keys', principle: [2, 6], description: 'Back-compat, development only: with no trusted keys declared, a plain { id, authority } approval clears the wait.',
    input: unsignedInput, request: { ...request, facts: { ...request.facts, approvedBy: { id: 'ann', authority: 'high' } } }, want: { status: 'ALLOW', reasons: ['role_permits_action', 'ask_high'] } });
  add(f, { id: 'approvals-bad-trusted-key-rejected', principle: [2], description: 'A trusted key whose publicKey is not 32 bytes of hex makes the rulebook invalid.',
    base: 'signed', tamper: rb => { rb.trustedKeys![0].publicKey = 'abc'; }, want: { error: true } });
  add(f, { id: 'approvals-trusted-key-unknown-authority-rejected', principle: [2], description: 'A trusted key naming an authority the rulebook does not declare makes the rulebook invalid.',
    base: 'signed', tamper: rb => { rb.trustedKeys![0].authority = 'king'; }, want: { error: true } });

  const sig = await signRulebook(rb, { keyId: 'test-site', privateKey: SEED_SITE });
  if (!(await verifyRulebookSignature(rb, sig, pubSite))) fail('approvals-rulebook-signature', 'does not verify');
  (files[f] ??= []).push({ id: 'approvals-rulebook-signature-ok', principle: [5], description: 'A rulebook signature (Ed25519 over the canonical JSON of the whole rulebook, fingerprint included) verifies with the pinned public key.', rulebookRef: 'rulebooks/signed.json', signature: sig, publicKey: pubSite, expect: { rulebookSignature: { ok: true } } });
  const tampered = JSON.parse(JSON.stringify(rb)) as Rulebook;
  (tampered as { otherwise: string }).otherwise = 'wait-for-approval';
  if (await verifyRulebookSignature(tampered, sig, pubSite)) fail('approvals-rulebook-signature-tampered', 'verified a tampered rulebook');
  (files[f] ??= []).push({ id: 'approvals-rulebook-signature-tampered', principle: [5], description: 'A rulebook changed after signing (here `otherwise`) fails the signature, whatever its fingerprint says.', rulebook: tampered, signature: sig, publicKey: pubSite, expect: { rulebookSignature: { ok: false } } });
  (files[f] ??= []).push({ id: 'approvals-rulebook-signature-wrong-key', principle: [5], description: 'The right rulebook and signature under the wrong public key fail.', rulebookRef: 'rulebooks/signed.json', signature: sig, publicKey: pubStranger, expect: { rulebookSignature: { ok: false } } });
  count += 3;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  mkdirSync(join(OUT, 'rulebooks'), { recursive: true });
  bases.tiny = compileDomain(tiny([]));
  bases.shared = compileDomain(shared([
    rule('no_looking_outside', { answer: 'deny' }, { does: 'look', where: 'yard' }),
    rule('agents_plan_with_approval', { answer: 'wait', for: 'approval', by: 'tag:staff' }, { who: 'kind:agent', does: 'plan' }),
    rule('non_staff_out_of_lab', { answer: 'deny' }, { who: ['kind:person', '!tag:staff'], where: 'lab' }),
  ]));
  bases.grocery = grocery.rulebook;
  for (const [name, rb] of Object.entries(bases)) writeFileSync(join(OUT, 'rulebooks', `${name}.json`), JSON.stringify(rb, null, 2) + '\n');

  p1(); p2(); p3(); p4(); p5(); p6(); p7(); p8(); p9();
  plans(); history();
  fingerprintCases();
  await approvals();

  for (const [file, cases] of Object.entries(files)) writeFileSync(join(OUT, file), JSON.stringify(cases, null, 2) + '\n');
  console.log(`wrote ${count} cases in ${Object.keys(files).length} files`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
