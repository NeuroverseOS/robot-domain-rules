/**
 * Compiler — site vocabulary + answers + rules → Rulebook.
 *
 * The compiler never invents rules. Every rule in the output comes from a
 * template, a question the operator answered, an area the operator declared
 * (role limits), or a rule the operator wrote or confirmed. Undefined
 * references and impossible conditions are configuration errors and throw
 * `DomainRulesError`. Rules at odds with each other are findings, returned
 * on the rulebook and never hidden.
 */

import type {
  ActionDef, AreaDef, AuthorityDef, BuiltinCheck, FactDef, LimitDef, RoleDef, Rule, Rulebook, SiteDef,
} from './types';
import {
  DomainRulesError, authorityRank, constraintOn, isEmpty, isValidTime, validateCondition,
  validateFactDef, validateSelector, vocabularyOf, type Vocabulary,
} from './vocabulary';
import { checkRulebook } from './check';
import { isLegacyInput, fromLegacyInput, type LegacyCompileInput } from './legacy';
import type { Template, TemplateContext } from './templates/template';
import { templateById } from './templates/index';

export interface CompileDomainInput {
  site: SiteDef;
  /** A template ID ("grocery-store", "warehouse") or a Template object. Optional: a site can declare everything itself. */
  template?: string | Template;
  kinds?: string[];
  /** Highest first. Defaults to the template's, or a single authority "site". */
  authorities?: AuthorityDef[];
  /** Added to (or overriding, by ID) the template's. */
  actions?: ActionDef[];
  facts?: FactDef[];
  limits?: LimitDef[];
  /** Tags rules may name even when nothing declared carries them yet. */
  tags?: { actions?: string[]; areas?: string[]; roles?: string[] };
  areas: AreaDef[];
  roles: RoleDef[];
  /** Template question answers by question ID. Unanswered questions take the safe default. */
  answers?: Record<string, string>;
  /** Rules written or confirmed by the operator. Each must say who set it. */
  rules?: Rule[];
  otherwise?: 'deny' | 'wait-for-approval';
}

export interface CompileOptions {
  /** Throw a DomainRulesError when the conflict check finds a `conflict`. */
  strict?: boolean;
}

/** Checks the evaluator always runs, cited by ID in decisions. */
export const BUILTIN_CHECKS: BuiltinCheck[] = [
  { id: 'required_facts', text: 'Every fact a decision needs must be supplied and valid; a missing or invalid fact is never permission.' },
  { id: 'area_declared', text: 'Only declared areas are governed; anything in an undeclared area is blocked.' },
  { id: 'role_declared', text: 'Only declared roles may act; unknown roles are blocked.' },
  { id: 'role_permits_action', text: 'A participant may only take actions its role lists.' },
  { id: 'unknown_action', text: 'An action the rulebook does not know is denied, or waits for approval, as the rulebook says (otherwise).' },
];

export function compileDomain(input: CompileDomainInput | LegacyCompileInput, options: CompileOptions = {}): Rulebook {
  const resolved: CompileDomainInput = isLegacyInput(input) ? fromLegacyInput(input) : input;
  const body = assemble(resolved);
  const findings = checkRulebook(body);
  if (options.strict) {
    const conflicts = findings.filter(f => f.severity === 'conflict');
    if (conflicts.length) throw new DomainRulesError(`Rules at odds (${conflicts.length}):\n${conflicts.map(f => `- ${f.message}`).join('\n')}`);
  }
  const withFindings = { ...body, findings: clone(findings) };
  return deepFreeze({ ...withFindings, fingerprint: fingerprint(withFindings) });
}

type RulebookBody = Omit<Rulebook, 'fingerprint' | 'findings'>;

/** Everything but the findings and the fingerprint. Exported for `checkRulebook(input)`. */
export function assemble(input: CompileDomainInput): RulebookBody {
  if (!input || typeof input !== 'object' || !input.site) throw new DomainRulesError('compileDomain needs { site, areas, roles, ... }.');
  const site = validateSite(input.site);
  const template = typeof input.template === 'string' ? templateById(input.template) : input.template;

  const kinds = new Set<string>([...(template?.kinds ?? []), ...(input.kinds ?? [])]);
  const authorities = clone(input.authorities ?? template?.authorities ?? [{ id: 'site', name: 'Site' }]);
  validateAuthorities(authorities);

  const actions = mergeById(template?.actions ?? [], input.actions ?? [], 'action');
  const facts = mergeById(template?.facts ?? [], input.facts ?? [], 'fact');
  const limits = mergeById(template?.limits ?? [], input.limits ?? [], 'limit');
  for (const a of actions) { validateId(a.id, 'action'); if (!Array.isArray(a.kinds) || a.kinds.length === 0) throw new DomainRulesError(`Action "${a.id}" must list the kinds that may do it.`); a.kinds.forEach(k => kinds.add(k)); }
  for (const f of facts) { validateId(f.id, 'fact'); validateFactDef(f); }
  if (facts.some(f => f.id === 'approvedBy')) throw new DomainRulesError('"approvedBy" is a built-in fact; do not declare it.');
  for (const l of limits) {
    validateId(l.id, 'limit');
    if (l.requestedFact !== undefined) {
      const rf = facts.find(f => f.id === l.requestedFact);
      if (!rf) throw new DomainRulesError(`Limit "${l.id}" names requestedFact "${l.requestedFact}", which is not a declared fact.`);
      if (rf.type !== 'number') throw new DomainRulesError(`Limit "${l.id}" requestedFact "${l.requestedFact}" must be a number fact.`);
    }
  }
  for (const a of actions) for (const req of a.requires ?? []) {
    if (!facts.some(f => f.id === req)) throw new DomainRulesError(`Action "${a.id}" requires unknown fact "${req}".`);
  }

  const roles = resolveRoles(input.roles ?? [], actions, kinds);
  const areas = validateAreas(input.areas ?? [], new Set(roles.map(r => r.id)));
  const tags = {
    actions: [...new Set([...(template?.tags?.actions ?? []), ...(input.tags?.actions ?? [])])],
    areas: [...new Set([...(template?.tags?.areas ?? []), ...(input.tags?.areas ?? [])])],
    roles: [...new Set([...(template?.tags?.roles ?? []), ...(input.tags?.roles ?? [])])],
  };

  const answers = resolveAnswers(template, input.answers ?? {});
  let otherwise: Rulebook['otherwise'] = input.otherwise ?? template?.otherwise ?? 'deny';

  const partial: RulebookBody = {
    format: 'neuroverse-domain-rules/2',
    site,
    ...(template ? { template: template.id } : {}),
    kinds: [...kinds],
    authorities,
    actions, areas, roles, facts, limits, tags,
    answers,
    otherwise,
    rules: [],
    builtin: clone(BUILTIN_CHECKS),
  };
  const vocab = vocabularyOf(partial);
  for (const l of limits) if (l.appliesTo !== undefined) validateSelector(l.appliesTo, 'does', vocab, `Limit "${l.id}" appliesTo`);

  // Rules, in order: template fixed rules, question rules, declaration rules, the operator's own.
  const rules: Rule[] = [];
  if (template) {
    const ctx: TemplateContext = { site, answers, roles, areas, actions, facts, limits };
    if (template.requires?.includes('hours') && !site.hours) throw new DomainRulesError(`Template "${template.id}" needs site.hours { open, close }.`);
    for (const r of template.rules?.(ctx) ?? []) rules.push({ ...r, source: { kind: 'template', ref: template.id } });
    for (const q of template.questions) {
      const option = q.options.find(o => o.value === answers[q.id])!;
      if (option.otherwise && input.otherwise === undefined) otherwise = option.otherwise;
      for (const r of option.rules?.(ctx) ?? []) rules.push({ setBy: q.setBy, ...r, source: { kind: 'question', ref: `${q.id}:${option.value}` } });
    }
    partial.otherwise = otherwise;
  }
  for (const area of areas) rules.push(...areaRoleLimitRules(area, roles, authorities));
  for (const r of input.rules ?? []) {
    if (!r || typeof r !== 'object') throw new DomainRulesError('Each rule must be an object { id, text, who, does, where, then, setBy }.');
    rules.push({ ...clone(r), source: r.source ?? { kind: 'manual', ref: r.id } });
  }

  const seen = new Set<string>();
  for (const r of rules) {
    validateRule(r, vocab);
    if (seen.has(r.id)) throw new DomainRulesError(`Rule "${r.id}" is declared twice.`);
    seen.add(r.id);
  }
  partial.rules = rules;
  return partial;
}

/** Throws a DomainRulesError naming anything in the rule the site did not declare, or any impossible condition. */
export function validateRule(r: Rule, vocab: Vocabulary): void {
  if (typeof r.id !== 'string' || r.id.length === 0) throw new DomainRulesError('A rule needs a non-empty id.');
  const where = `Rule "${r.id}"`;
  if (typeof r.text !== 'string' || r.text.length === 0) throw new DomainRulesError(`${where}: text (the rule in plain words) is required.`);
  if (typeof r.setBy !== 'string' || r.setBy.length === 0) throw new DomainRulesError(`${where}: setBy is required — say which authority set this rule. Known: ${vocab.authorities.map(a => a.id).join(', ')}.`);
  if (authorityRank(vocab, r.setBy) < 0) throw new DomainRulesError(`${where}: setBy names unknown authority "${r.setBy}". Known: ${vocab.authorities.map(a => a.id).join(', ')}.`);
  validateSelector(r.who, 'who', vocab, where);
  validateSelector(r.does, 'does', vocab, where);
  validateSelector(r.where, 'where', vocab, where);
  if (r.when !== undefined) {
    if (!Array.isArray(r.when)) throw new DomainRulesError(`${where}: when must be a list of conditions.`);
    for (const c of r.when) validateCondition(c, vocab, where);
    for (const factId of new Set(r.when.map(c => c.fact))) {
      // Conditions on one fact must leave something possible.
      if (isEmpty(constraintOn(r.when, factId, vocab))) throw new DomainRulesError(`${where}: its conditions on "${factId}" can never all be true at once.`);
    }
  }
  const t = r.then;
  if (!t || typeof t !== 'object') throw new DomainRulesError(`${where}: then is required (allow, limit, wait or deny).`);
  switch (t.answer) {
    case 'allow': break;
    case 'deny': if (t.instead !== undefined && (typeof t.instead !== 'string' || !t.instead)) throw new DomainRulesError(`${where}: deny.instead must be a non-empty string.`); break;
    case 'wait': {
      if (t.for !== 'approval' && t.for !== 'condition') throw new DomainRulesError(`${where}: wait.for must be "approval" or "condition".`);
      if (t.by !== undefined) {
        if (t.for !== 'approval') throw new DomainRulesError(`${where}: wait.by applies to approval waits only.`);
        if (authorityRank(vocab, t.by) < 0 && !vocab.roles.has(t.by) && !(t.by.startsWith('tag:') && vocab.tags.roles.has(t.by.slice(4)))) {
          throw new DomainRulesError(`${where}: wait.by "${t.by}" is not a declared authority, role, or role tag (tag:<role tag>).`);
        }
      }
      break;
    }
    case 'limit': {
      if (!t.limits || typeof t.limits !== 'object' || Object.keys(t.limits).length === 0) throw new DomainRulesError(`${where}: limit needs { limits: { <limit id>: number } }.`);
      for (const [name, v] of Object.entries(t.limits)) {
        if (!vocab.limits.has(name)) throw new DomainRulesError(`${where}: limit names unknown limit "${name}". Known: ${[...vocab.limits.keys()].join(', ') || 'none'}.`);
        if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new DomainRulesError(`${where}: limit "${name}" must be a number, 0 or more.`);
      }
      break;
    }
    default: throw new DomainRulesError(`${where}: then.answer must be allow, limit, wait or deny, got ${JSON.stringify((t as { answer?: unknown }).answer)}.`);
  }
  if (r.never && t.answer !== 'deny') throw new DomainRulesError(`${where}: a never rule must deny.`);
  if (!r.source || typeof r.source !== 'object' || !r.source.kind) throw new DomainRulesError(`${where}: source { kind, ref } is required.`);
}

/**
 * Does the rulebook's fingerprint still match its contents? Use it on a
 * rulebook received as JSON before trusting it. It catches accidental change
 * in transit; it is not a signature (see `fingerprint`).
 */
export function verifyFingerprint(rulebook: Rulebook): boolean {
  if (!rulebook || typeof rulebook !== 'object') return false;
  const { fingerprint: claimed, ...body } = rulebook;
  return typeof claimed === 'string' && fingerprint(body) === claimed;
}

// ─── Validation ──────────────────────────────────────────────────────────────

function validateSite(site: SiteDef): SiteDef {
  const s = clone(site) as SiteDef & { domainId?: string };
  if (!s.id && s.domainId) { s.id = s.domainId; delete s.domainId; }
  if (typeof s.id !== 'string' || !s.id) throw new DomainRulesError('site.id is required.');
  if (typeof s.name !== 'string' || !s.name) throw new DomainRulesError('site.name is required.');
  if (s.hours !== undefined) {
    if (!isValidTime(s.hours?.open)) throw new DomainRulesError(`site.hours.open must be "HH:MM" (24h), got "${s.hours?.open}".`);
    if (!isValidTime(s.hours?.close)) throw new DomainRulesError(`site.hours.close must be "HH:MM" (24h), got "${s.hours?.close}".`);
  }
  return s;
}

function validateAuthorities(list: AuthorityDef[]): void {
  if (!Array.isArray(list) || list.length === 0) throw new DomainRulesError('Declare at least one authority (highest first).');
  const seen = new Set<string>();
  for (const a of list) {
    validateId(a.id, 'authority');
    if (seen.has(a.id)) throw new DomainRulesError(`Authority "${a.id}" is declared twice.`);
    seen.add(a.id);
  }
}

function validateId(id: unknown, what: string): void {
  if (typeof id !== 'string' || id.length === 0) throw new DomainRulesError(`Every ${what} needs a non-empty id.`);
  if (/[*!:]/.test(id) || /\s/.test(id)) throw new DomainRulesError(`${what} id "${id}" may not contain spaces, "*", "!" or ":".`);
}

function mergeById<T extends { id: string }>(base: T[], extra: T[], what: string): T[] {
  const out = new Map<string, T>();
  for (const x of base) out.set(x.id, clone(x));
  const seen = new Set<string>();
  for (const x of extra) {
    if (!x || typeof x !== 'object') throw new DomainRulesError(`Each ${what} must be an object with an id.`);
    if (seen.has(x.id)) throw new DomainRulesError(`${what} "${x.id}" is declared twice.`);
    seen.add(x.id);
    out.set(x.id, clone(x));
  }
  return [...out.values()];
}

function validateAreas(areas: AreaDef[], roleIds: Set<string>): AreaDef[] {
  if (areas.length === 0) throw new DomainRulesError('Declare at least one area.');
  const seen = new Set<string>();
  for (const a of areas) {
    validateId(a.id, 'area');
    if (seen.has(a.id)) throw new DomainRulesError(`Area "${a.id}" is declared twice.`);
    seen.add(a.id);
    if (typeof a.name !== 'string' || !a.name) throw new DomainRulesError(`Area "${a.id}" needs a name.`);
    for (const [field, list] of [['allowRoles', a.allowRoles], ['denyRoles', a.denyRoles]] as const) {
      if (list === undefined) continue;
      if (!Array.isArray(list)) throw new DomainRulesError(`Area "${a.id}" ${field} must be a list of role IDs.`);
      for (const roleId of list) if (!roleIds.has(roleId)) throw new DomainRulesError(`Area "${a.id}" ${field} names unknown role "${roleId}". Known: ${[...roleIds].join(', ')}`);
    }
    const both = (a.allowRoles ?? []).filter(r => a.denyRoles?.includes(r));
    if (both.length) throw new DomainRulesError(`Area "${a.id}" lists ${both.map(r => `"${r}"`).join(', ')} in both allowRoles and denyRoles.`);
  }
  return areas.map(a => clone(a));
}

/** Resolve inheritance so every role carries its full action list; check kinds and actions. */
function resolveRoles(roles: RoleDef[], actions: ActionDef[], kinds: Set<string>): RoleDef[] {
  if (roles.length === 0) throw new DomainRulesError('Declare at least one role.');
  const byId = new Map<string, RoleDef>();
  for (const r of roles) {
    validateId(r.id, 'role');
    if (byId.has(r.id)) throw new DomainRulesError(`Role "${r.id}" is declared twice.`);
    if (typeof r.kind !== 'string' || !r.kind) throw new DomainRulesError(`Role "${r.id}" needs a kind.`);
    if (typeof r.name !== 'string' || !r.name) throw new DomainRulesError(`Role "${r.id}" needs a name.`);
    kinds.add(r.kind);
    byId.set(r.id, r);
  }
  const actionById = new Map(actions.map(a => [a.id, a]));
  const resolved = new Map<string, string[]>();
  const resolve = (roleId: string, chain: string[]): string[] => {
    const done = resolved.get(roleId);
    if (done) return done;
    if (chain.includes(roleId)) throw new DomainRulesError(`Role inheritance loops: ${[...chain, roleId].join(' → ')}`);
    const role = byId.get(roleId)!;
    if (!Array.isArray(role.actions)) throw new DomainRulesError(`Role "${roleId}" needs an actions list (may be empty).`);
    for (const a of role.actions) {
      const def = actionById.get(a);
      if (!def) throw new DomainRulesError(`Role "${roleId}" lists unknown action "${a}". Known: ${[...actionById.keys()].join(', ')}`);
      if (!def.kinds.includes(role.kind)) {
        const ok = actions.filter(x => x.kinds.includes(role.kind)).map(x => x.id);
        throw new DomainRulesError(`Role "${roleId}" is a ${role.kind} and cannot list "${a}". ${role.kind} actions: ${ok.join(', ') || 'none'}`);
      }
    }
    let list = [...role.actions];
    if (role.inherits) {
      const parent = byId.get(role.inherits);
      if (!parent) throw new DomainRulesError(`Role "${roleId}" inherits unknown role "${role.inherits}".`);
      if (parent.kind !== role.kind) throw new DomainRulesError(`Role "${roleId}" (${role.kind}) cannot inherit "${parent.id}" (${parent.kind}).`);
      list = [...new Set([...resolve(parent.id, [...chain, roleId]), ...list])];
    }
    resolved.set(roleId, list);
    return list;
  };
  return roles.map(r => ({ ...clone(r), actions: resolve(r.id, []) }));
}

function resolveAnswers(template: Template | undefined, given: Record<string, string>): Record<string, string> {
  const answers: Record<string, string> = {};
  if (!template) {
    const keys = Object.keys(given);
    if (keys.length) throw new DomainRulesError(`Answers were given (${keys.join(', ')}) but no template was chosen. Questions belong to templates.`);
    return answers;
  }
  for (const q of template.questions) answers[q.id] = q.options[q.defaultIndex].value;
  for (const [questionId, value] of Object.entries(given)) {
    const question = template.questions.find(q => q.id === questionId);
    if (!question) throw new DomainRulesError(`Unknown question "${questionId}". Known: ${template.questions.map(q => q.id).join(', ')}`);
    if (!question.options.some(o => o.value === value)) throw new DomainRulesError(`Invalid answer "${value}" for "${questionId}". Valid: ${question.options.map(o => o.value).join(', ')}`);
    answers[questionId] = value;
  }
  return answers;
}

/** An area's allowRoles / denyRoles, as never rules. Set by the lowest-ranked authority that declares areas: the site itself. */
function areaRoleLimitRules(area: AreaDef, roles: RoleDef[], authorities: AuthorityDef[]): Rule[] {
  const setBy = declarationAuthority(authorities);
  const out: Rule[] = [];
  const names = (ids: string[]) => ids.map(id => roles.find(r => r.id === id)?.name ?? id).join(', ');
  if (area.denyRoles?.length) {
    out.push({
      id: `area_role_limits:${area.id}:deny`, never: true, setBy,
      text: `${names(area.denyRoles)} may never act in ${area.name}.`,
      who: area.denyRoles, does: '*', where: area.id, then: { answer: 'deny' },
      reason: `${names(area.denyRoles)} may never act in ${area.name}.`,
      source: { kind: 'declaration', ref: `area:${area.id}.denyRoles` },
    });
  }
  if (area.allowRoles) {
    const others = roles.map(r => r.id).filter(id => !area.allowRoles!.includes(id));
    if (others.length) {
      out.push({
        id: `area_role_limits:${area.id}`, never: true, setBy,
        text: `${area.name} is limited to: ${area.allowRoles.join(', ')}.`,
        who: others, does: '*', where: area.id,
        then: { answer: 'deny' },
        reason: `${area.name} is limited to: ${area.allowRoles.join(', ')}.`,
        source: { kind: 'declaration', ref: `area:${area.id}.allowRoles` },
      });
    }
  }
  return out;
}

/** Area declarations are the site's own: the authority named "site-manager" if declared, else the lowest. */
export function declarationAuthority(authorities: AuthorityDef[]): string {
  return authorities.find(a => a.id === 'site-manager')?.id ?? authorities[authorities.length - 1].id;
}

// ─── Copying and freezing ────────────────────────────────────────────────────

/** Deep copy of plain data (objects, arrays, primitives). */
export function clone<T>(value: T): T {
  if (Array.isArray(value)) return value.map(clone) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) if (v !== undefined) out[k] = clone(v);
    return out as T;
  }
  return value;
}

/** Freeze an object and everything inside it. */
export function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
  }
  return value;
}

// ─── Fingerprint ─────────────────────────────────────────────────────────────

/**
 * Deterministic 64-bit FNV-1a fingerprint of the rulebook's canonical JSON.
 * It identifies a rulebook; it is not a security signature. To prove a
 * rulebook wasn't tampered with, sign the JSON with your own key.
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

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
