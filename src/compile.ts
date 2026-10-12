/**
 * Domain Compiler — site + zones + roles + answers → DomainRuleSet
 *
 * The compiler never invents rules. Every rule in the output comes from an
 * answer the operator chose, a zone or role the operator declared, or one of
 * the fixed site rules listed in SITE_RULES below.
 */

import { DOMAIN_QUESTIONS, defaultDomainAnswers } from './questions';
import type {
  CompiledDomainRule,
  DomainAction,
  DomainPolicy,
  DomainRole,
  DomainRuleSet,
  DomainSite,
  DomainZone,
} from './types';
import { GLASSES_ACTIONS, ROBOT_ACTIONS } from './types';
import { mergeRules } from './zone-rules';
import type { ZoneRules } from './zone-rules';

/** Fixed rules every domain has. Their IDs appear in decisions alongside answer rules. */
export const SITE_RULES: CompiledDomainRule[] = [
  { ruleId: 'zone_declared', text: 'Only declared zones are governed; anything in an undeclared zone is blocked.', sourceQuestion: 'site', sourceAnswer: 'fixed' },
  { ruleId: 'role_declared', text: 'Only declared roles may act; unknown roles are blocked.', sourceQuestion: 'site', sourceAnswer: 'fixed' },
  { ruleId: 'role_permits_action', text: 'A participant may only take actions its role lists.', sourceQuestion: 'site', sourceAnswer: 'fixed' },
  { ruleId: 'emergency_stop', text: 'During an emergency, robots stop and nobody commands them from glasses.', sourceQuestion: 'site', sourceAnswer: 'fixed' },
  { ruleId: 'zone_speed_cap', text: 'A zone\'s own speed cap applies when it is lower than the site cap.', sourceQuestion: 'site', sourceAnswer: 'fixed' },
];

export interface CompileDomainInput {
  site: DomainSite;
  zones: DomainZone[];
  roles: DomainRole[];
  /** Answers by question ID. Missing answers use the safe default. */
  answers?: Record<string, string>;
}

/** Thrown when the input can't produce a valid rule set. The message says what to fix. */
export class DomainRulesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DomainRulesError';
  }
}

export function compileDomain(input: CompileDomainInput): DomainRuleSet {
  validateTime(input.site.hours.open, 'site.hours.open');
  validateTime(input.site.hours.close, 'site.hours.close');
  const zones = validateZones(input.zones);
  const roles = resolveRoles(input.roles);

  const answers = { ...defaultDomainAnswers() };
  for (const [questionId, value] of Object.entries(input.answers ?? {})) {
    const question = DOMAIN_QUESTIONS.find(q => q.id === questionId);
    if (!question) throw new DomainRulesError(`Unknown question "${questionId}". Known: ${DOMAIN_QUESTIONS.map(q => q.id).join(', ')}`);
    if (!question.options.some(o => o.value === value)) {
      throw new DomainRulesError(`Invalid answer "${value}" for "${questionId}". Valid: ${question.options.map(o => o.value).join(', ')}`);
    }
    answers[questionId] = value;
  }

  const policy = {} as DomainPolicy;
  const rules: CompiledDomainRule[] = [];
  for (const question of DOMAIN_QUESTIONS) {
    const option = question.options.find(o => o.value === answers[question.id])!;
    Object.assign(policy, option.sets);
    rules.push({ ruleId: question.id, text: option.rule, sourceQuestion: question.id, sourceAnswer: option.value });
  }
  rules.push(...SITE_RULES);

  const body = { format: 'neuroverse-domain-rules/1' as const, site: input.site, zones, roles, answers, policy, rules };
  return { ...body, fingerprint: fingerprint(body) };
}

// ─── Glasses bridge ──────────────────────────────────────────────────────────

/** Least-restrictive spatial ZoneRules: the default base, so the domain rules alone decide. */
export const OPEN_ZONE_RULES: ZoneRules = {
  camera: 'allowed',
  microphone: 'allowed',
  aiDataSend: 'allowed',
  aiActions: 'allowed',
  aiRecommendations: 'allowed',
  locationSharing: 'allowed',
  aiOverlay: 'allowed',
  dataRetention: 'allowed',
  commercialAI: 'allowed',
  bystanderProtection: 'standard',
};

/**
 * The spatial ZoneRules a person's glasses should apply in one zone.
 *
 * The result is a ZoneRules object compatible with
 * `@neuroverseos/governance/spatial` (optional, not a dependency): feed it to
 * that package's spatial engine (`applyZoneToSession`) or its MentraOS adapter
 * so the glasses side is enforced on-device. It matches evaluateDomainAction:
 * capture follows the glasses_capture answer, and anything the person's role
 * doesn't list is blocked. Pass a stricter `base` (e.g. that package's
 * `ZONE_TEMPLATES.retail`) to layer other rules underneath — the result only
 * ever tightens the base (most restrictive wins).
 */
export function glassesZoneRules(
  ruleSet: DomainRuleSet,
  zoneId: string,
  roleId: string,
  base: ZoneRules = OPEN_ZONE_RULES,
): ZoneRules {
  const zone = ruleSet.zones.find(z => z.zoneId === zoneId);
  if (!zone) throw new DomainRulesError(`Zone "${zoneId}" is not declared in this rule set.`);
  const role = ruleSet.roles.find(r => r.roleId === roleId);
  if (!role || role.kind !== 'person') throw new DomainRulesError(`"${roleId}" is not a declared person role.`);

  const may = (a: DomainAction) => role.actions.includes(a);
  const capture = captureLevel(ruleSet.policy.glassesCapture, role.isStaff === true);
  const overlay: ZoneRules = {
    ...base,
    camera: may('camera_capture') ? capture : 'blocked',
    microphone: may('record_audio') ? capture : 'blocked',
    aiOverlay: may('ai_overlay') ? base.aiOverlay : 'blocked',
    locationSharing: may('share_location') ? base.locationSharing : 'blocked',
  };
  return mergeRules(base, overlay);
}

export function captureLevel(policy: DomainPolicy['glassesCapture'], isStaff: boolean): 'allowed' | 'confirm_each' | 'blocked' {
  switch (policy) {
    case 'blocked': return 'blocked';
    case 'staff_only': return isStaff ? 'allowed' : 'blocked';
    case 'confirm_each': return 'confirm_each';
    case 'allowed': return 'allowed';
  }
}

// ─── Plain-English rendering ─────────────────────────────────────────────────

/** The whole rule set as Markdown a site operator (or an agent) can read. */
export function renderDomainRules(ruleSet: DomainRuleSet): string {
  const lines: string[] = [];
  lines.push(`# Rules for ${ruleSet.site.name}`, '');
  lines.push(`Open ${ruleSet.site.hours.open}–${ruleSet.site.hours.close}. Rule set fingerprint \`${ruleSet.fingerprint}\`.`, '');
  lines.push('## Zones', '');
  for (const z of ruleSet.zones) {
    lines.push(`- **${z.name}** (\`${z.zoneId}\`) — ${z.kind.replace('_', '-')}${z.maxSpeedMps !== undefined ? `, max ${z.maxSpeedMps} m/s` : ''}`);
  }
  lines.push('', '## Roles', '');
  for (const r of ruleSet.roles) {
    const flags = [r.isStaff ? 'staff' : '', r.afterHours ? 'after-hours' : ''].filter(Boolean).join(', ');
    lines.push(`- **${r.name}** (\`${r.roleId}\`, ${r.kind}${flags ? `, ${flags}` : ''}) — may: ${r.actions.join(', ')}`);
  }
  lines.push('', '## Rules', '');
  for (const rule of ruleSet.rules) lines.push(`- \`${rule.ruleId}\` — ${rule.text}`);
  lines.push('');
  return lines.join('\n');
}

// ─── Validation ──────────────────────────────────────────────────────────────

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export function validateTime(value: string, field: string): void {
  if (!TIME.test(value)) throw new DomainRulesError(`${field} must be "HH:MM" (24h), got "${value}".`);
}

function validateZones(zones: DomainZone[]): DomainZone[] {
  if (zones.length === 0) throw new DomainRulesError('Declare at least one zone.');
  const seen = new Set<string>();
  for (const z of zones) {
    if (seen.has(z.zoneId)) throw new DomainRulesError(`Zone "${z.zoneId}" is declared twice.`);
    seen.add(z.zoneId);
    if (z.maxSpeedMps !== undefined && !(z.maxSpeedMps >= 0)) throw new DomainRulesError(`Zone "${z.zoneId}" maxSpeedMps must be 0 or more.`);
  }
  return zones.map(z => ({ ...z }));
}

/** Resolve inheritance so every role carries its full action list. */
function resolveRoles(roles: DomainRole[]): DomainRole[] {
  const byId = new Map<string, DomainRole>();
  for (const r of roles) {
    if (byId.has(r.roleId)) throw new DomainRulesError(`Role "${r.roleId}" is declared twice.`);
    byId.set(r.roleId, r);
  }

  const resolved = new Map<string, DomainAction[]>();
  const resolve = (roleId: string, chain: string[]): DomainAction[] => {
    const done = resolved.get(roleId);
    if (done) return done;
    if (chain.includes(roleId)) throw new DomainRulesError(`Role inheritance loops: ${[...chain, roleId].join(' → ')}`);
    const role = byId.get(roleId)!;
    const allowed: readonly DomainAction[] = role.kind === 'robot' ? ROBOT_ACTIONS : GLASSES_ACTIONS;
    for (const a of role.actions) {
      if (!allowed.includes(a)) {
        throw new DomainRulesError(`Role "${roleId}" is a ${role.kind} and cannot list "${a}". ${role.kind} actions: ${allowed.join(', ')}`);
      }
    }
    let actions = [...role.actions];
    if (role.inherits) {
      const parent = byId.get(role.inherits);
      if (!parent) throw new DomainRulesError(`Role "${roleId}" inherits unknown role "${role.inherits}".`);
      if (parent.kind !== role.kind) throw new DomainRulesError(`Role "${roleId}" (${role.kind}) cannot inherit "${parent.roleId}" (${parent.kind}).`);
      actions = [...new Set([...resolve(parent.roleId, [...chain, roleId]), ...actions])];
    }
    resolved.set(roleId, actions);
    return actions;
  };

  return roles.map(r => ({ ...r, actions: resolve(r.roleId, []) }));
}

// ─── Fingerprint ─────────────────────────────────────────────────────────────

/**
 * Deterministic 64-bit FNV-1a fingerprint of the rule set's canonical JSON.
 * It identifies a rule set; it is not a security signature. To prove a rule
 * set wasn't tampered with, sign the JSON with your own key.
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
