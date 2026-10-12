/**
 * Cedar export — EXAMPLE ADAPTER, not part of the core.
 *
 *   toCedar(rulebook) → { policies, schema, notExported, droppedByAuthority }
 *
 * Turns the part of a rulebook that Cedar can say into Cedar policies and a
 * Cedar schema, so a team already on Cedar (AWS Verified Permissions, Bedrock
 * AgentCore) can carry the deny/permit subset over. It is LOSSY and says so:
 * everything it cannot express is listed in `notExported` with the rule IDs.
 *
 * Mapping
 *   roles → Role entities (principal); actions → Action entities; areas →
 *   Area entities (resource); facts → context attributes.
 *   1. Authority is resolved first: a rule reported by the conflict check as
 *      an authority-override (a lower authority trying to loosen) never
 *      takes effect, so it is not exported; it is listed in droppedByAuthority.
 *   2. Each role's action list → one `permit` (the grant the engine's
 *      role_permits_action check makes).
 *   3. deny rules, never rules included → `forbid` with the rule's selectors
 *      and conditions as a `when` clause. Cedar's forbid-wins matches
 *      strictest-wins for deny.
 *   4. allow rules → `permit`, restricted to the (role, action) pairs the
 *      role actually lists, since an allow rule never grants an action the
 *      role does not have.
 *   Facts: integer numbers → Long; other numbers → Decimal (Cedar's
 *   `decimal(...)` extension); time → Long minutes since midnight; day, enum,
 *   string → String; boolean → Boolean. `toCedarContext` turns a request's
 *   facts into that context (defaults filled in, as the engine would).
 *
 * Not exported (listed, never silently dropped)
 *   LIMIT rules (Cedar answers allow/deny, not "slower"); both kinds of WAIT
 *   (no approval or condition wait in Cedar); approvals and trusted keys;
 *   rules with history conditions; plan rules; `otherwise: wait-for-approval`
 *   (Cedar denies unknown actions, which matches `deny` only).
 *   So on a request where this rulebook says LIMIT or PAUSE, the Cedar export
 *   says allow. Where it says ALLOW or BLOCK on exported rules, Cedar agrees
 *   (test/cedar.test.ts checks this with Cedar's own engine).
 */

import { checkRulebook, resolveSelector, type Condition, type FactDef, type FactValue, type Rulebook } from '../../src/index';
import { vocabularyOf, minutesOf } from '../../src/vocabulary';

export interface CedarExport {
  /** Cedar policy set text. */
  policies: string;
  /** Cedar schema (JSON form), one empty namespace: Role, Action, Area entity types; context attributes from the facts. */
  schema: Record<string, unknown>;
  /** What could not be carried over, by rule ID, with the reason in plain words. */
  notExported: Array<{ ruleId: string; reason: string }>;
  /** Rules the conflict check says never take effect because a higher authority's rule overrides them. */
  droppedByAuthority: Array<{ ruleId: string; overriddenBy: string }>;
}

export function toCedar(rulebook: Rulebook): CedarExport {
  const vocab = vocabularyOf(rulebook);
  const notExported: CedarExport['notExported'] = [];
  const droppedByAuthority: CedarExport['droppedByAuthority'] = [];
  const lines: string[] = [];

  // 1. Authority first.
  for (const f of checkRulebook(rulebook)) {
    if (f.kind === 'authority-override') droppedByAuthority.push({ ruleId: f.ruleIds[0], overriddenBy: f.ruleIds[1] });
  }
  const dropped = new Set(droppedByAuthority.map(d => d.ruleId));

  // 2. Role grants.
  for (const role of rulebook.roles) {
    if (!role.actions.length) continue;
    lines.push(`@id("role:${role.id}")\n@setBy("builtin")\npermit(principal == Role::${str(role.id)}, action in [${role.actions.map(a => `Action::${str(a)}`).join(', ')}], resource);`);
  }

  // 3 and 4. Rules.
  for (const r of rulebook.rules) {
    if (dropped.has(r.id)) continue;
    if (r.history?.length) { notExported.push({ ruleId: r.id, reason: 'conditions on the participant\'s history; Cedar has no history' }); continue; }
    const t = r.then;
    if (t.answer === 'limit') { notExported.push({ ruleId: r.id, reason: 'a LIMIT (go ahead, slower); Cedar answers allow or deny only' }); continue; }
    if (t.answer === 'wait') { notExported.push({ ruleId: r.id, reason: t.for === 'approval' ? 'a wait for approval; Cedar has no approvals' : 'a wait for the situation to change; Cedar has no waits' }); continue; }
    const roles = resolveSelector(r.who, 'who', vocab), areas = resolveSelector(r.where, 'where', vocab);
    let actions = resolveSelector(r.does, 'does', vocab);
    if (t.answer === 'allow') {
      // An allow never grants an action the role does not list.
      const pairs = [...roles].flatMap(roleId => [...actions].filter(a => vocab.roles.get(roleId)!.actions.includes(a)).map(a => [roleId, a]));
      if (!pairs.length) { notExported.push({ ruleId: r.id, reason: 'an allow for actions none of its roles lists; it grants nothing' }); continue; }
      actions = new Set(pairs.map(([, a]) => a));
    }
    if (!roles.size || !actions.size || !areas.size) { notExported.push({ ruleId: r.id, reason: 'its selectors resolve to nothing declared' }); continue; }
    const conds: string[] = [];
    if (roles.size < vocab.roles.size) conds.push(contains('principal', 'Role', [...roles]));
    if (actions.size < vocab.actions.size) conds.push(contains('action', 'Action', [...actions]));
    if (areas.size < vocab.areas.size) conds.push(contains('resource', 'Area', [...areas]));
    for (const c of r.when ?? []) conds.push(condition(c, vocab.facts.get(c.fact)!));
    const effect = t.answer === 'deny' ? 'forbid' : 'permit';
    const note = [r.never ? '@never("true")' : '', t.answer === 'deny' && t.instead ? `@instead(${str(t.instead)})` : ''].filter(Boolean).join('\n');
    lines.push(`@id(${str(r.id)})\n@setBy(${str(r.setBy)})${note ? `\n${note}` : ''}\n${effect}(principal, action, resource)${conds.length ? ` when { ${conds.join(' && ')} }` : ''};`);
  }
  for (const r of rulebook.planRules ?? []) notExported.push({ ruleId: r.id, reason: 'a plan rule; Cedar judges one request, not a plan' });
  if (rulebook.otherwise === 'wait-for-approval') notExported.push({ ruleId: 'unknown_action', reason: 'otherwise is wait-for-approval; Cedar denies an action it has no policy for' });
  if (rulebook.trustedKeys?.length) notExported.push({ ruleId: 'trustedKeys', reason: 'signed approvals; Cedar has no approvals' });

  return { policies: lines.join('\n\n') + '\n', schema: schemaOf(rulebook), notExported, droppedByAuthority };
}

/** A request's facts as a Cedar context: defaults filled in, times as minutes, non-integer numbers as decimal(). */
export function toCedarContext(rulebook: Rulebook, facts: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of rulebook.facts) {
    const v = facts[f.id] !== undefined ? facts[f.id] : f.default;
    if (v === undefined) continue;
    out[f.id] = f.type === 'time' ? minutesOf(v as string) : f.type === 'number' && !f.integer ? { __extn: { fn: 'decimal', arg: decimalText(v as number) } } : v;
  }
  return out;
}

/** The Cedar entities a request needs: the three it names, with no attributes (everything is in the context). */
export function toCedarEntities(request: { participant: { roleId: string }; action: string; areaId?: string }): Array<{ uid: { type: string; id: string }; attrs: Record<string, never>; parents: never[] }> {
  return [
    { uid: { type: 'Role', id: request.participant.roleId }, attrs: {}, parents: [] },
    { uid: { type: 'Action', id: request.action }, attrs: {}, parents: [] },
    { uid: { type: 'Area', id: request.areaId ?? '' }, attrs: {}, parents: [] },
  ];
}

function schemaOf(rb: Rulebook): Record<string, unknown> {
  const attributes: Record<string, unknown> = {};
  for (const f of rb.facts) attributes[f.id] = { ...cedarType(f), required: f.required === true || f.default !== undefined };
  const context = { type: 'Record', attributes };
  const actions: Record<string, unknown> = {};
  for (const a of rb.actions) actions[a.id] = { appliesTo: { principalTypes: ['Role'], resourceTypes: ['Area'], context } };
  return {
    '': {
      entityTypes: {
        Role: { shape: { type: 'Record', attributes: {} } },
        Area: { shape: { type: 'Record', attributes: {} } },
      },
      actions,
    },
  };
}

function cedarType(f: FactDef): Record<string, unknown> {
  switch (f.type) {
    case 'number': return f.integer ? { type: 'Long' } : { type: 'Extension', name: 'decimal' };
    case 'time': return { type: 'Long' };
    case 'boolean': return { type: 'Boolean' };
    default: return { type: 'String' };
  }
}

function condition(c: Condition, def: FactDef): string {
  const x = `context.${def.id}`;
  const dec = def.type === 'number' && !def.integer;
  const lit = (v: FactValue): string => def.type === 'time' ? String(minutesOf(v as string)) : dec ? `decimal(${str(decimalText(v as number))})` : typeof v === 'string' ? str(v) : String(v);
  switch (c.op) {
    case 'between': {
      const f = minutesOf(c.from), o = minutesOf(c.to);
      return f < o ? `(${x} >= ${f} && ${x} < ${o})` : `(${x} >= ${f} || ${x} < ${o})`;
    }
    case 'days': return `[${c.days.map(d => str(d)).join(', ')}].contains(${x})`;
    case 'in': return `[${c.values.map(lit).join(', ')}].contains(${x})`;
    case '==': return `${x} == ${lit(c.value)}`;
    case '!=': return `${x} != ${lit(c.value)}`;
    default: {
      if (dec) {
        const fn = c.op === '<' ? 'lessThan' : c.op === '<=' ? 'lessThanOrEqual' : c.op === '>' ? 'greaterThan' : 'greaterThanOrEqual';
        return `${x}.${fn}(${lit(c.value)})`;
      }
      return `${x} ${c.op} ${lit(c.value)}`;   // numbers and times (minutes); the validator refuses ordinal compares on other types
    }
  }
}

function contains(variable: string, type: string, ids: string[]): string {
  return ids.length === 1 ? `${variable} == ${type}::${str(ids[0])}` : `[${ids.map(id => `${type}::${str(id)}`).join(', ')}].contains(${variable})`;
}

function decimalText(v: number): string {
  // Cedar decimals carry up to four places; the rule language's numbers are compared exactly, so more than that cannot be carried over.
  const s = v.toFixed(4).replace(/0+$/, '').replace(/\.$/, '.0');
  return s.includes('.') ? s : `${s}.0`;
}

function str(s: string): string {
  return JSON.stringify(s);
}
