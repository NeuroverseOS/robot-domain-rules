/**
 * The situation: who is asking, what, where, and every fact. Converts to
 * and from the DomainRequest that evaluateDomainAction receives.
 */

import type { DomainRequest, FactDef, Rulebook } from '../../../src/index';

export interface Approval {
  id: string;
  /** 'authority' | 'role' | 'none' — what the approver holds. */
  holds: 'authority' | 'role' | 'none';
  value: string;
}

export interface Situation {
  participant: { id: string; kind: string; roleId: string };
  action: string;
  areaId: string;
  /** Facts the request carries. A fact absent here is absent from the request. */
  facts: Record<string, unknown>;
  approval: Approval | null;
}

export function toRequest(s: Situation): DomainRequest {
  const facts: Record<string, unknown> = { ...s.facts };
  if (s.approval && s.approval.id.trim()) {
    const a = s.approval;
    facts.approvedBy = a.holds === 'authority' ? { id: a.id, authority: a.value }
      : a.holds === 'role' ? { id: a.id, roleId: a.value }
      : { id: a.id };
  }
  return { participant: { ...s.participant }, action: s.action, areaId: s.areaId, facts };
}

export function fromRequest(r: DomainRequest): Situation {
  const { approvedBy, ...facts } = r.facts ?? {};
  let approval: Approval | null = null;
  if (typeof approvedBy === 'string') approval = { id: approvedBy, holds: 'none', value: '' };
  else if (approvedBy && typeof approvedBy === 'object') {
    const a = approvedBy as { id?: string; authority?: string; roleId?: string };
    approval = a.authority ? { id: a.id ?? '', holds: 'authority', value: a.authority }
      : a.roleId ? { id: a.id ?? '', holds: 'role', value: a.roleId }
      : { id: a.id ?? '', holds: 'none', value: '' };
  }
  return {
    participant: { id: r.participant.id, kind: r.participant.kind, roleId: r.participant.roleId },
    action: r.action,
    areaId: r.areaId ?? r.zoneId ?? '',
    facts,
    approval,
  };
}

/** A sensible first situation for a rulebook: its first role, that role's first action, its first area, every required fact at a safe value. */
export function defaultSituation(rb: Rulebook): Situation {
  const role = rb.roles[0];
  const facts: Record<string, unknown> = {};
  for (const f of rb.facts) if (f.required) facts[f.id] = sampleValue(f);
  return {
    participant: { id: role ? `${role.kind}-1` : 'robot-1', kind: role?.kind ?? 'robot', roleId: role?.id ?? '' },
    action: role?.actions[0] ?? '',
    areaId: rb.areas[0]?.id ?? '',
    facts,
    approval: null,
  };
}

export function sampleValue(f: FactDef): unknown {
  if (f.default !== undefined) return f.default;
  switch (f.type) {
    case 'number': return f.min ?? 0;
    case 'boolean': return false;
    case 'time': return '10:00';
    case 'day': return 'mon';
    case 'enum': return f.values?.[0] ?? '';
    default: return '';
  }
}

/**
 * Keep a situation usable after the rulebook changed: a role or area that no
 * longer exists falls back to the first one; facts no longer declared are dropped.
 */
export function reconcile(s: Situation, rb: Rulebook): Situation {
  const declaredFacts = new Set(rb.facts.map(f => f.id));
  const facts: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(s.facts)) if (declaredFacts.has(k)) facts[k] = v;
  for (const f of rb.facts) if (f.required && !(f.id in facts)) facts[f.id] = sampleValue(f);
  const role = rb.roles.find(r => r.id === s.participant.roleId) ?? rb.roles[0];
  const area = rb.areas.find(a => a.id === s.areaId) ?? rb.areas[0];
  return {
    ...s,
    participant: role ? { ...s.participant, kind: role.kind, roleId: role.id } : s.participant,
    areaId: area?.id ?? s.areaId,
    facts,
  };
}

/** A range for number sliders: the declared min/max, or a guess by name. */
export function sliderRange(f: FactDef): { min: number; max: number; step: number } {
  const min = f.min ?? 0;
  if (f.max !== undefined) return { min, max: f.max, step: f.integer ? 1 : 0.1 };
  if (/speed/i.test(f.id)) return { min, max: 3, step: 0.1 };
  return { min, max: f.integer ? 12 : 10, step: f.integer ? 1 : 0.1 };
}

/** What happens to this request if nothing governs it: it simply happens, as asked. */
export function ungovernedOutcome(s: Situation, rb: Rulebook | null): string {
  const action = rb?.actions.find(a => a.id === s.action);
  const area = rb?.areas.find(a => a.id === s.areaId);
  const role = rb?.roles.find(r => r.id === s.participant.roleId);
  const who = role ? `${role.name} ${s.participant.id}` : s.participant.id || 'the participant';
  const does = action?.name ?? (s.action.replace(/_/g, ' ') || 'act');
  const where = area?.name ?? (s.areaId || 'wherever it is');
  const speed = typeof s.facts.requestedSpeedMps === 'number' ? ` at ${s.facts.requestedSpeedMps} m/s` : '';
  return `${who} ${does === 'move' ? 'moves' : `does "${does}"`} in ${where}${speed}. Nobody is asked, nothing is recorded, no limit applies.`;
}
