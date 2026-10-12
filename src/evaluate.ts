/**
 * Evaluator — one request in, one decision out.
 *
 *   evaluateDomainAction(rulebook, request) → DomainDecision
 *
 * Pure and synchronous: no clock (time is a fact), no network, no model.
 * Every check that runs is recorded in `trace`, and the decision is the
 * strictest check: BLOCK > PAUSE > LIMIT > ALLOW.
 *
 * Order (the first BLOCK ends the trace; otherwise all run):
 *   1. request shape, declared area, declared role        (required_facts, area_declared, role_declared)
 *   2. the facts the decision needs, typed and complete    (required_facts)
 *   3. never rules — nothing overrides them                (their IDs)
 *   4. the role lists the action, or the action is unknown (role_permits_action, unknown_action)
 *   5. every rule that matches; limits combine by MIN      (their IDs)
 *
 * Two kinds of PAUSE:
 *   - approval  — a person must approve this action. Re-send the same request
 *                 with `facts.approvedBy` set. If the rule names who may
 *                 approve (`by`), the approver must hold that authority (or a
 *                 higher one), that role, or that role tag.
 *   - condition — the situation must change (people leave, staff arrive).
 *                 `approvedBy` does not override these.
 *
 * Missing or invalid facts are never permission: they BLOCK with
 * `required_facts`. Never rules and every matching rule apply to every
 * action, including an approved unknown one.
 */

import type {
  Approval, DomainCheck, DomainDecision, DomainDecisionStatus, DomainRequest, FactValue, Rule, Rulebook,
} from './types';
import {
  authorityRank, conditionHolds, factProblem, resolveSelector, selectorExcludesId, selectorIsOpen, show, vocabularyOf,
  type Vocabulary,
} from './vocabulary';

const SEVERITY: Record<DomainDecisionStatus, number> = { ALLOW: 0, LIMIT: 1, PAUSE: 2, BLOCK: 3 };

export function evaluateDomainAction(rulebook: Rulebook, request: DomainRequest): DomainDecision {
  const vocab = vocabularyOf(rulebook);
  const trace: DomainCheck[] = [];
  const check = (ruleId: string, status: DomainDecisionStatus, reason: string, setBy = 'builtin') => { trace.push({ ruleId, status, reason, setBy }); };
  let limits: Record<string, number> | undefined;
  let then: string | undefined;
  const decide = () => finish(trace, rulebook.fingerprint, limits, then);

  // 1. The request must have a shape we can govern, and name a declared area and role.
  const shape = shapeProblems(request, vocab);
  if (shape.length) {
    check('required_facts', 'BLOCK', `The request is incomplete: ${shape.join('; ')}.`);
    return decide();
  }
  const { participant, action } = request;
  const areaId = request.areaId ?? request.zoneId!;
  const area = vocab.areas.get(areaId);
  if (!area) {
    check('area_declared', 'BLOCK', `Area "${areaId}" is not declared for ${rulebook.site.name}.`);
    return decide();
  }
  const role = vocab.roles.get(participant.roleId);
  if (!role || role.kind !== participant.kind) {
    check('role_declared', 'BLOCK', `"${participant.roleId}" is not a declared ${participant.kind} role.`);
    return decide();
  }
  const actionDef = vocab.actions.get(action);

  // 2. Every fact the decision needs must be supplied and valid. Missing is never permission.
  const { problems, facts, approval } = validateFacts(rulebook, vocab, request, actionDef?.requires ?? []);
  if (problems.length) {
    check('required_facts', 'BLOCK', `Facts missing or invalid: ${problems.join('; ')}.`);
    return decide();
  }

  const matches = (r: Rule) => {
    if (!resolveSelector(r.who, 'who', vocab).has(role.id)) return false;
    if (actionDef ? !resolveSelector(r.does, 'does', vocab).has(action) : !(selectorIsOpen(r.does) && !selectorExcludesId(r.does, action))) return false;
    if (!resolveSelector(r.where, 'where', vocab).has(area.id)) return false;
    return (r.when ?? []).every(c => conditionHolds(c, facts, vocab));
  };
  const reasonOf = (r: Rule) => r.reason ?? r.text;

  // 3. Never rules. Nothing overrides them.
  let stopped = false;
  for (const r of rulebook.rules) {
    if (!r.never || !matches(r)) continue;
    check(r.id, 'BLOCK', reasonOf(r), r.setBy);
    if (r.then.answer === 'deny' && r.then.instead && !then) then = r.then.instead;
    stopped = true;
  }
  if (stopped) return decide();

  // 4. The role must list the action; an action the rulebook does not know follows `otherwise`.
  const needsApproval = (ruleId: string, what: string, by: string | undefined, setBy: string) => {
    if (!approval) { check(ruleId, 'PAUSE', `${what} — needs a person's approval${by ? ` (${by})` : ''}.`, setBy); return; }
    const short = approvalSufficient(approval, by, vocab);
    if (short) check(ruleId, 'PAUSE', `${what} — approval needs ${by}; ${approval.id} doesn't hold it (${short}).`, setBy);
    else check(ruleId, 'ALLOW', `${what} — approved by ${approval.id}.`, setBy);
  };
  if (!actionDef) {
    if (rulebook.otherwise === 'deny') {
      check('unknown_action', 'BLOCK', `No rule covers "${action}" for a ${participant.kind}.`);
      return decide();
    }
    // An approved unknown action still faces every matching rule below.
    needsApproval('unknown_action', `No rule covers "${action}" for a ${participant.kind}`, undefined, 'builtin');
  } else if (!role.actions.includes(action)) {
    check('role_permits_action', 'BLOCK', `${role.name} may not ${actionName(actionDef.name, action)}.`);
    return decide();
  } else {
    check('role_permits_action', 'ALLOW', `${role.name} may ${actionName(actionDef.name, action)}.`);
  }

  // 5. Every matching rule. Limits combine by MIN per name; the rule(s) at the minimum decide.
  const matched = rulebook.rules.filter(r => !r.never && matches(r));
  const effective: Record<string, number> = {};
  for (const r of matched) if (r.then.answer === 'limit') {
    for (const [name, v] of Object.entries(r.then.limits)) effective[name] = name in effective ? Math.min(effective[name], v) : v;
  }
  if (Object.keys(effective).length) limits = effective;

  for (const r of matched) {
    const t = r.then;
    switch (t.answer) {
      case 'allow': check(r.id, 'ALLOW', reasonOf(r), r.setBy); break;
      case 'deny': check(r.id, 'BLOCK', reasonOf(r), r.setBy); if (t.instead && !then) then = t.instead; break;
      case 'wait':
        if (t.for === 'condition') check(r.id, 'PAUSE', `${reasonOf(r)} (Wait: only a change in the facts clears this.)`, r.setBy);
        else needsApproval(r.id, reasonOf(r), t.by, r.setBy);
        break;
      case 'limit': {
        const parts: string[] = [];
        let status: DomainDecisionStatus = 'ALLOW';
        for (const [name, v] of Object.entries(t.limits)) {
          const def = vocab.limits.get(name)!;
          const unit = def.unit ? ` ${def.unit}` : '';
          if (v > effective[name]) { parts.push(`${name} ${v}${unit} is not the tightest (${effective[name]}${unit} applies)`); continue; }
          const asked = def.requestedFact ? facts[def.requestedFact] : undefined;
          if (asked === undefined) { status = 'LIMIT'; parts.push(`at most ${v}${unit} ${name}`); }
          else if ((asked as number) > v) { status = 'LIMIT'; parts.push(`asked for ${asked}${unit}; at most ${v}${unit} ${name}`); }
          else parts.push(`${asked}${unit} is within the ${v}${unit} ${name}`);
        }
        check(r.id, status, `${reasonOf(r)} (${parts.join('; ')}.)`, r.setBy);
      }
    }
  }
  return decide();
}

function finish(trace: DomainCheck[], fingerprint: string, limits: Record<string, number> | undefined, then: string | undefined): DomainDecision {
  let status: DomainDecisionStatus = 'ALLOW';
  for (const c of trace) if (SEVERITY[c.status] > SEVERITY[status]) status = c.status;
  const reasons = trace.filter(c => c.status === status);
  return {
    status,
    reasons,
    ...(limits && (status === 'LIMIT' || status === 'ALLOW') ? { limits } : {}),
    ...(then && status === 'BLOCK' ? { then } : {}),
    trace,
    fingerprint,
  };
}

// ─── Approval authority ──────────────────────────────────────────────────────

/** Why the approval is not enough, in plain words; null when it is. */
function approvalSufficient(approval: Approval, by: string | undefined, vocab: Vocabulary): string | null {
  if (!by) return null;
  const need = authorityRank(vocab, by);
  if (need >= 0) {
    if (!approval.authority) return `the approval names no authority`;
    const has = authorityRank(vocab, approval.authority);
    return has >= 0 && has <= need ? null : `${approval.authority} is below ${by}`;
  }
  if (by.startsWith('tag:')) {
    const tag = by.slice(4);
    const role = approval.roleId ? vocab.roles.get(approval.roleId) : undefined;
    return role?.tags?.includes(tag) ? null : `the approver's role is not tagged ${tag}`;
  }
  return approval.roleId === by ? null : `the approver's role is not ${by}`;
}

// ─── Request shape and facts ─────────────────────────────────────────────────

function shapeProblems(request: DomainRequest, vocab: Vocabulary): string[] {
  const problems: string[] = [];
  if (!request || typeof request !== 'object') return ['no request was given'];
  const p = request.participant;
  if (!p || typeof p !== 'object') problems.push('participant is missing');
  else {
    if (!nonEmpty(p.kind) || !vocab.kinds.has(p.kind)) problems.push(`participant.kind must be one of ${[...vocab.kinds].join(', ')}, got ${show(p.kind)}`);
    if (!nonEmpty(p.roleId)) problems.push('participant.roleId must be a non-empty string');
  }
  if (!nonEmpty(request.areaId ?? request.zoneId)) problems.push('areaId must be a non-empty string');
  if (!nonEmpty(request.action)) problems.push('action must be a non-empty string');
  if (!request.facts || typeof request.facts !== 'object') problems.push('facts are missing');
  return problems;
}

function validateFacts(rulebook: Rulebook, vocab: Vocabulary, request: DomainRequest, alsoRequired: string[]):
  { problems: string[]; facts: Record<string, FactValue>; approval: Approval | null } {
  const problems: string[] = [];
  const facts: Record<string, FactValue> = {};
  const given: Record<string, unknown> = { ...request.facts };
  if (request.targetRobotId !== undefined && given.targetRobotId === undefined) given.targetRobotId = request.targetRobotId;
  for (const def of rulebook.facts) {
    const v = given[def.id];
    if (v === undefined) {
      if (def.required || alsoRequired.includes(def.id)) problems.push(`${def.id} is required (${describeType(def)}), got nothing`);
      else if (def.default !== undefined) facts[def.id] = def.default;
      continue;
    }
    const p = factProblem(def, v);
    if (p) problems.push(p); else facts[def.id] = v as FactValue;
  }
  let approval: Approval | null = null;
  const a = given.approvedBy;
  if (a !== undefined) {
    if (nonEmpty(a)) approval = { id: a };
    else if (a && typeof a === 'object' && nonEmpty((a as Approval).id)) {
      const o = a as Approval;
      approval = { id: o.id };
      if (o.authority !== undefined) {
        if (authorityRank(vocab, String(o.authority)) < 0) problems.push(`approvedBy.authority "${String(o.authority)}" is not a declared authority`);
        else approval.authority = o.authority;
      }
      if (o.roleId !== undefined) {
        if (!vocab.roles.has(String(o.roleId))) problems.push(`approvedBy.roleId "${String(o.roleId)}" is not a declared role`);
        else approval.roleId = o.roleId;
      }
    } else problems.push(`approvedBy must be a non-empty string or { id, authority?, roleId? } when given, got ${show(a)}`);
  }
  return { problems, facts, approval };
}

function describeType(def: Rulebook['facts'][number]): string {
  switch (def.type) {
    case 'number': return `${def.integer ? 'a whole number' : 'a number'}${def.min !== undefined ? `, ${def.min} or more` : ''}${def.max !== undefined ? `, ${def.max} or less` : ''}`;
    case 'time': return '"HH:MM"';
    case 'enum': return `one of ${(def.values ?? []).join(', ')}`;
    case 'day': return 'mon..sun';
    case 'boolean': return 'true or false';
    case 'string': return 'a non-empty string';
  }
}

function nonEmpty(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

export function actionName(name: string | undefined, id: string): string {
  return name ?? id.replace(/_/g, ' ');
}
