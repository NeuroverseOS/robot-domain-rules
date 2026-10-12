/**
 * Vocabulary — how rules refer to the things a site declared.
 *
 * Selectors (`who`, `does`, `where`) resolve to finite sets of IDs. Conditions
 * (`when`) are checked against validated facts. Constraints turn conditions
 * into sets the conflict check can intersect and compare exactly.
 *
 * Pure functions, no I/O.
 */

import type {
  ActionDef, AreaDef, AuthorityDef, Condition, Day, FactDef, FactValue, LimitDef, RoleDef, Rulebook, Selector,
} from './types';
import { DAYS } from './types';

/** Thrown when the input can't produce a valid rulebook. The message says what to fix. */
export class DomainRulesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DomainRulesError';
  }
}

// ─── Time ────────────────────────────────────────────────────────────────────

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Is the value a "HH:MM" 24-hour time string? */
export function isValidTime(value: unknown): value is string {
  return typeof value === 'string' && TIME.test(value);
}

export function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

/** Is "HH:MM" within opening hours? Handles overnight hours; open === close means always open. */
export function isOpen(localTime: string, hours: { open: string; close: string }): boolean {
  const t = minutesOf(localTime), open = minutesOf(hours.open), close = minutesOf(hours.close);
  if (open === close) return true;
  return open < close ? t >= open && t < close : t >= open || t < close;
}

/** from <= t < to, overnight when from > to. */
export function inWindow(t: number, from: number, to: number): boolean {
  return from < to ? t >= from && t < to : t >= from || t < to;
}

// ─── Vocabulary ──────────────────────────────────────────────────────────────

export interface Vocabulary {
  kinds: Set<string>;
  authorities: AuthorityDef[];
  actions: Map<string, ActionDef>;
  areas: Map<string, AreaDef>;
  roles: Map<string, RoleDef>;
  facts: Map<string, FactDef>;
  limits: Map<string, LimitDef>;
  tags: { actions: Set<string>; areas: Set<string>; roles: Set<string> };
}

type VocabSource = Pick<Rulebook, 'kinds' | 'authorities' | 'actions' | 'areas' | 'roles' | 'facts' | 'limits' | 'tags'>;

export function vocabularyOf(rb: VocabSource): Vocabulary {
  const byId = <T extends { id: string }>(list: T[]) => new Map(list.map(x => [x.id, x]));
  const tagsOf = (list: { tags?: string[] }[], declared: string[]) =>
    new Set([...declared, ...list.flatMap(x => x.tags ?? [])]);
  return {
    kinds: new Set(rb.kinds),
    authorities: rb.authorities,
    actions: byId(rb.actions),
    areas: byId(rb.areas),
    roles: byId(rb.roles),
    facts: byId(rb.facts),
    limits: byId(rb.limits),
    tags: {
      actions: tagsOf(rb.actions, rb.tags.actions),
      areas: tagsOf(rb.areas, rb.tags.areas),
      roles: tagsOf(rb.roles, rb.tags.roles),
    },
  };
}

/** Position in the authority order; 0 is highest. -1 if unknown. */
export function authorityRank(vocab: Vocabulary, id: string): number {
  return vocab.authorities.findIndex(a => a.id === id);
}

export function authorityName(vocab: Vocabulary, id: string): string {
  return vocab.authorities.find(a => a.id === id)?.name ?? id;
}

// ─── Selectors ───────────────────────────────────────────────────────────────

export type SelectorKind = 'who' | 'does' | 'where';

export function selectorEntries(sel: Selector): string[] {
  return (Array.isArray(sel) ? sel : [sel]).map(e => e.trim()).filter(Boolean);
}

/** Resolve a selector to the set of IDs it matches among declared things. */
export function resolveSelector(sel: Selector, kind: SelectorKind, vocab: Vocabulary): Set<string> {
  const universe = universeOf(kind, vocab);
  const entries = selectorEntries(sel);
  const positives = entries.filter(e => !e.startsWith('!'));
  const negatives = entries.filter(e => e.startsWith('!')).map(e => e.slice(1));
  let ids: Set<string>;
  if (positives.length === 0 || positives.includes('*')) ids = new Set(universe);
  else {
    ids = new Set();
    for (const p of positives) for (const id of expand(p, kind, vocab)) ids.add(id);
  }
  for (const n of negatives) for (const id of expand(n, kind, vocab)) ids.delete(id);
  return ids;
}

/** Does the selector include '*' (so it also matches actions the rulebook does not know)? */
export function selectorIsOpen(sel: Selector): boolean {
  const entries = selectorEntries(sel);
  const positives = entries.filter(e => !e.startsWith('!'));
  return positives.length === 0 || positives.includes('*');
}

/** Is this (possibly undeclared) ID excluded by name? */
export function selectorExcludesId(sel: Selector, id: string): boolean {
  return selectorEntries(sel).includes(`!${id}`);
}

function universeOf(kind: SelectorKind, vocab: Vocabulary): Iterable<string> {
  return kind === 'who' ? vocab.roles.keys() : kind === 'does' ? vocab.actions.keys() : vocab.areas.keys();
}

function expand(entry: string, kind: SelectorKind, vocab: Vocabulary): string[] {
  if (entry === '*') return [...universeOf(kind, vocab)];
  if (entry.startsWith('tag:')) {
    const tag = entry.slice(4);
    const list: { id: string; tags?: string[] }[] = kind === 'who' ? [...vocab.roles.values()] : kind === 'does' ? [...vocab.actions.values()] : [...vocab.areas.values()];
    return list.filter(x => x.tags?.includes(tag)).map(x => x.id);
  }
  if (entry.startsWith('kind:')) {
    const k = entry.slice(5);
    if (kind === 'who') return [...vocab.roles.values()].filter(r => r.kind === k).map(r => r.id);
    if (kind === 'does') return [...vocab.actions.values()].filter(a => a.kinds.includes(k)).map(a => a.id);
    return [];
  }
  return [entry];
}

/** Throws a DomainRulesError naming any ID, tag or kind the selector uses that the site did not declare. */
export function validateSelector(sel: Selector, kind: SelectorKind, vocab: Vocabulary, where: string): void {
  const entries = selectorEntries(sel);
  if (entries.length === 0) throw new DomainRulesError(`${where}: ${kind} is empty. Use "*" for everything.`);
  const noun = kind === 'who' ? 'role' : kind === 'does' ? 'action' : 'area';
  const known = kind === 'who' ? vocab.roles : kind === 'does' ? vocab.actions : vocab.areas;
  const tags = kind === 'who' ? vocab.tags.roles : kind === 'does' ? vocab.tags.actions : vocab.tags.areas;
  for (const raw of entries) {
    const e = raw.startsWith('!') ? raw.slice(1) : raw;
    if (e === '*') continue;
    if (e.startsWith('tag:')) {
      const tag = e.slice(4);
      if (!tags.has(tag)) throw new DomainRulesError(`${where}: ${kind} names ${noun} tag "${tag}", which no ${noun} carries and no template declares. Known ${noun} tags: ${[...tags].join(', ') || 'none'}.`);
      continue;
    }
    if (e.startsWith('kind:')) {
      if (kind === 'where') throw new DomainRulesError(`${where}: areas have no kind; "${e}" cannot be used in where.`);
      const k = e.slice(5);
      if (!vocab.kinds.has(k)) throw new DomainRulesError(`${where}: ${kind} names kind "${k}", which is not declared. Known kinds: ${[...vocab.kinds].join(', ')}.`);
      continue;
    }
    if (!known.has(e)) throw new DomainRulesError(`${where}: ${kind} names unknown ${noun} "${e}". Known: ${[...known.keys()].join(', ') || 'none'}.`);
  }
}

// ─── Facts ───────────────────────────────────────────────────────────────────

/** Is this value a valid value of the fact's type? Returns a problem in plain words, or null. */
export function factProblem(def: FactDef, value: unknown): string | null {
  const got = show(value);
  switch (def.type) {
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return `${def.id} must be a number, got ${got}`;
      if (def.integer && !Number.isInteger(value)) return `${def.id} must be a whole number, got ${got}`;
      if (def.min !== undefined && value < def.min) return `${def.id} must be ${def.min} or more, got ${got}`;
      if (def.max !== undefined && value > def.max) return `${def.id} must be ${def.max} or less, got ${got}`;
      return null;
    }
    case 'boolean': return typeof value === 'boolean' ? null : `${def.id} must be true or false, got ${got}`;
    case 'time': return isValidTime(value) ? null : `${def.id} must be "HH:MM" (24h), got ${got}`;
    case 'day': return typeof value === 'string' && (DAYS as readonly string[]).includes(value) ? null : `${def.id} must be one of ${DAYS.join(', ')}, got ${got}`;
    case 'enum': return typeof value === 'string' && (def.values ?? []).includes(value) ? null : `${def.id} must be one of ${(def.values ?? []).join(', ')}, got ${got}`;
    case 'string': return typeof value === 'string' && value.length > 0 ? null : `${def.id} must be a non-empty string, got ${got}`;
  }
}

export function show(v: unknown): string {
  if (v === undefined) return 'nothing';
  if (typeof v === 'number' && !Number.isFinite(v)) return String(v);
  try { return JSON.stringify(v); } catch { return String(v); }
}

/** Does a fact definition make sense on its own? */
export function validateFactDef(def: FactDef): void {
  const types: string[] = ['number', 'boolean', 'time', 'day', 'enum', 'string'];
  if (!types.includes(def.type)) throw new DomainRulesError(`Fact "${def.id}" has unknown type "${def.type}". Types: ${types.join(', ')}.`);
  if (def.type === 'enum' && (!def.values || def.values.length === 0)) throw new DomainRulesError(`Fact "${def.id}" is an enum but lists no values.`);
  if (def.type !== 'number' && (def.min !== undefined || def.max !== undefined || def.integer !== undefined)) throw new DomainRulesError(`Fact "${def.id}" is a ${def.type}; min, max and integer apply to numbers only.`);
  if (def.min !== undefined && def.max !== undefined && def.min > def.max) throw new DomainRulesError(`Fact "${def.id}" has min ${def.min} above max ${def.max}.`);
  if (def.default !== undefined) {
    const p = factProblem(def, def.default);
    if (p) throw new DomainRulesError(`Fact "${def.id}" has an invalid default: ${p}.`);
    if (def.required) throw new DomainRulesError(`Fact "${def.id}" cannot be both required and have a default.`);
  }
}

/** Facts a rule may condition on: those that are always present. */
export function factAlwaysPresent(def: FactDef): boolean {
  return def.required === true || def.default !== undefined;
}

// ─── Conditions ──────────────────────────────────────────────────────────────

const COMPARE_OPS = ['==', '!=', '>', '>=', '<', '<='] as const;

export function validateCondition(c: Condition, vocab: Vocabulary, where: string): void {
  if (!c || typeof c !== 'object' || typeof c.fact !== 'string') throw new DomainRulesError(`${where}: each condition needs a fact and an op.`);
  const def = vocab.facts.get(c.fact);
  if (!def) throw new DomainRulesError(`${where}: condition names unknown fact "${c.fact}". Known: ${[...vocab.facts.keys()].join(', ') || 'none'}.`);
  if (!factAlwaysPresent(def)) throw new DomainRulesError(`${where}: fact "${c.fact}" is optional with no default, so a rule cannot depend on it. Make it required or give it a default.`);
  const bad = (msg: string) => new DomainRulesError(`${where}: ${msg}`);
  switch (c.op) {
    case 'between': {
      if (def.type !== 'time') throw bad(`"between" works on time facts; "${c.fact}" is a ${def.type}.`);
      if (!isValidTime(c.from) || !isValidTime(c.to)) throw bad(`"between" needs "HH:MM" times, got ${show(c.from)} and ${show(c.to)}.`);
      if (c.from === c.to) throw bad(`"between ${c.from} and ${c.to}" is an empty window. To mean "always", leave the condition out.`);
      return;
    }
    case 'days': {
      if (def.type !== 'day') throw bad(`"days" works on day facts; "${c.fact}" is a ${def.type}.`);
      if (!Array.isArray(c.days) || c.days.length === 0) throw bad(`"days" needs at least one day.`);
      for (const d of c.days) if (!(DAYS as readonly string[]).includes(d)) throw bad(`"${d}" is not a day. Days: ${DAYS.join(', ')}.`);
      return;
    }
    case 'in': {
      if (!Array.isArray(c.values) || c.values.length === 0) throw bad(`"in" needs at least one value.`);
      for (const v of c.values) { const p = factProblem(def, v); if (p) throw bad(`"in" value invalid: ${p}.`); }
      return;
    }
    default: {
      if (!(COMPARE_OPS as readonly string[]).includes(c.op)) throw bad(`unknown op "${(c as { op: string }).op}". Ops: ${[...COMPARE_OPS, 'in', 'between', 'days'].join(', ')}.`);
      const p = factProblem(def, c.value);
      if (p) throw bad(`condition value invalid: ${p}.`);
      if ((def.type === 'boolean' || def.type === 'enum' || def.type === 'string' || def.type === 'day') && c.op !== '==' && c.op !== '!=') {
        throw bad(`"${c.op}" does not apply to a ${def.type} fact; use == or !=.`);
      }
    }
  }
}

/** Numeric order for comparing fact values of one type. */
function ordinal(def: FactDef, v: FactValue): number {
  if (def.type === 'time') return minutesOf(v as string);
  if (def.type === 'day') return DAYS.indexOf(v as Day);
  return v as number;
}

/** Is the condition true for these validated facts? Facts are complete here. */
export function conditionHolds(c: Condition, facts: Record<string, FactValue>, vocab: Vocabulary): boolean {
  const def = vocab.facts.get(c.fact)!;
  const v = facts[c.fact];
  switch (c.op) {
    case 'between': return inWindow(minutesOf(v as string), minutesOf(c.from), minutesOf(c.to));
    case 'days': return c.days.includes(v as Day);
    case 'in': return c.values.includes(v);
    case '==': return v === c.value;
    case '!=': return v !== c.value;
    default: {
      const a = ordinal(def, v), b = ordinal(def, c.value);
      return c.op === '>' ? a > b : c.op === '>=' ? a >= b : c.op === '<' ? a < b : a <= b;
    }
  }
}

export function describeCondition(c: Condition): string {
  switch (c.op) {
    case 'between': return `${c.fact} between ${c.from} and ${c.to}`;
    case 'days': return `${c.fact} is ${c.days.join('/')}`;
    case 'in': return `${c.fact} in ${c.values.map(String).join(', ')}`;
    case '==': return `${c.fact} is ${String(c.value)}`;
    case '!=': return `${c.fact} is not ${String(c.value)}`;
    default: return `${c.fact} ${c.op} ${String(c.value)}`;
  }
}

// ─── Constraints: conditions as sets, for exact comparison ───────────────────
//
// Every condition language form maps to one of three set shapes over one fact:
//   range   — an interval with excluded points (number facts)
//   values  — a finite set, or "everything except" (boolean, enum, day, string)
//   minutes — a bitmap of the 1440 minutes in a day (time facts)
// Intersection and subset are exact for every shape, so disjointness is sound
// and implication is sound.

export type Constraint =
  | { shape: 'range'; lo: number; hi: number; loOpen: boolean; hiOpen: boolean; excluded: number[] }
  | { shape: 'finite'; values: number[] }
  | { shape: 'values'; values?: FactValue[]; excluded: FactValue[] }
  | { shape: 'minutes'; bits: boolean[] };

function universeConstraint(def: FactDef): Constraint {
  switch (def.type) {
    case 'number': return { shape: 'range', lo: def.min ?? -Infinity, hi: def.max ?? Infinity, loOpen: false, hiOpen: false, excluded: [] };
    case 'time': return { shape: 'minutes', bits: new Array(1440).fill(true) };
    case 'boolean': return { shape: 'values', values: [true, false], excluded: [] };
    case 'day': return { shape: 'values', values: [...DAYS], excluded: [] };
    case 'enum': return { shape: 'values', values: [...(def.values ?? [])], excluded: [] };
    case 'string': return { shape: 'values', excluded: [] };
  }
}

function conditionConstraint(c: Condition, def: FactDef): Constraint {
  if (def.type === 'time') {
    const bits = new Array<boolean>(1440).fill(false);
    const set = (pred: (t: number) => boolean) => { for (let t = 0; t < 1440; t++) bits[t] = pred(t); };
    if (c.op === 'between') { const f = minutesOf(c.from), to = minutesOf(c.to); set(t => inWindow(t, f, to)); }
    else if (c.op === 'in') { const vs = c.values.map(v => minutesOf(v as string)); set(t => vs.includes(t)); }
    else if (c.op === 'days') set(() => false);
    else { const b = minutesOf(c.value as string); set(t => compare(c.op, t, b)); }
    return { shape: 'minutes', bits };
  }
  if (def.type === 'number') {
    const int = def.integer === true;
    const base = universeConstraint(def) as Extract<Constraint, { shape: 'range' }>;
    if (c.op === 'in') return { shape: 'finite', values: c.values as number[] };
    if (c.op === 'between' || c.op === 'days') return { shape: 'finite', values: [] };
    const v = c.value as number;
    const r = { ...base, excluded: [] as number[] };
    switch (c.op) {
      case '==': return { shape: 'finite', values: [v] };
      case '!=': r.excluded = [v]; return r;
      case '>': if (int) { r.lo = Math.max(r.lo, v + 1); } else { r.lo = Math.max(r.lo, v); r.loOpen = r.lo === v; } return r;
      case '>=': r.lo = Math.max(r.lo, v); return r;
      case '<': if (int) { r.hi = Math.min(r.hi, v - 1); } else { r.hi = Math.min(r.hi, v); r.hiOpen = r.hi === v; } return r;
      case '<=': r.hi = Math.min(r.hi, v); return r;
    }
  }
  // boolean, enum, day, string
  const u = universeConstraint(def) as Extract<Constraint, { shape: 'values' }>;
  if (c.op === 'days') return { shape: 'values', values: [...c.days], excluded: [] };
  if (c.op === 'in') return { shape: 'values', values: [...c.values], excluded: [] };
  if (c.op === '==') return { shape: 'values', values: [c.value], excluded: [] };
  if (c.op === '!=') return u.values ? { shape: 'values', values: u.values.filter(v => v !== c.value), excluded: [] } : { shape: 'values', excluded: [c.value] };
  return { shape: 'values', values: [], excluded: [] };
}

function compare(op: string, a: number, b: number): boolean {
  return op === '==' ? a === b : op === '!=' ? a !== b : op === '>' ? a > b : op === '>=' ? a >= b : op === '<' ? a < b : a <= b;
}

function rangeHas(r: Extract<Constraint, { shape: 'range' }>, v: number): boolean {
  if (v < r.lo || v > r.hi) return false;
  if (v === r.lo && r.loOpen) return false;
  if (v === r.hi && r.hiOpen) return false;
  return !r.excluded.includes(v);
}

export function intersect(a: Constraint, b: Constraint): Constraint {
  if (a.shape === 'minutes' && b.shape === 'minutes') return { shape: 'minutes', bits: a.bits.map((x, i) => x && b.bits[i]) };
  if (a.shape === 'finite' && (b.shape === 'finite' || b.shape === 'range')) return { shape: 'finite', values: a.values.filter(v => b.shape === 'finite' ? b.values.includes(v) : rangeHas(b, v)) };
  if (b.shape === 'finite' && a.shape === 'range') return intersect(b, a);
  if (a.shape === 'range' && b.shape === 'range') {
    const lo = Math.max(a.lo, b.lo), hi = Math.min(a.hi, b.hi);
    const loOpen = (a.lo === lo && a.loOpen) || (b.lo === lo && b.loOpen);
    const hiOpen = (a.hi === hi && a.hiOpen) || (b.hi === hi && b.hiOpen);
    return { shape: 'range', lo, hi, loOpen, hiOpen, excluded: [...new Set([...a.excluded, ...b.excluded])] };
  }
  if (a.shape === 'values' && b.shape === 'values') {
    const excluded = [...new Set([...a.excluded, ...b.excluded])];
    if (a.values && b.values) return { shape: 'values', values: a.values.filter(v => b.values!.includes(v) && !excluded.includes(v)), excluded: [] };
    const values = (a.values ?? b.values)?.filter(v => !excluded.includes(v));
    return values ? { shape: 'values', values, excluded: [] } : { shape: 'values', excluded };
  }
  // Shapes that cannot meet (a type mismatch the validator would have refused): treat as empty.
  return { shape: 'finite', values: [] };
}

export function isEmpty(c: Constraint): boolean {
  switch (c.shape) {
    case 'minutes': return !c.bits.some(Boolean);
    case 'finite': return c.values.length === 0;
    case 'values': return c.values !== undefined && c.values.length === 0;
    case 'range': {
      if (c.lo > c.hi) return true;
      if (c.lo === c.hi) return c.loOpen || c.hiOpen || c.excluded.includes(c.lo);
      return false;
    }
  }
}

/** Is every value of `a` also in `b`? Exact; returns false only when it is not a subset (or cannot be shown to be). */
export function isSubset(a: Constraint, b: Constraint): boolean {
  if (isEmpty(a)) return true;
  if (a.shape === 'minutes' && b.shape === 'minutes') return a.bits.every((x, i) => !x || b.bits[i]);
  if (a.shape === 'finite') return a.values.every(v => b.shape === 'finite' ? b.values.includes(v) : b.shape === 'range' ? rangeHas(b, v) : false);
  if (a.shape === 'range' && b.shape === 'range') {
    if (a.lo < b.lo || a.hi > b.hi) return false;
    if (a.lo === b.lo && b.loOpen && !a.loOpen) return false;
    if (a.hi === b.hi && b.hiOpen && !a.hiOpen) return false;
    return b.excluded.every(v => !rangeHas(a, v));
  }
  if (a.shape === 'values' && b.shape === 'values') {
    if (a.values) return a.values.every(v => b.values ? b.values.includes(v) : !b.excluded.includes(v));
    if (b.values) return false;
    return b.excluded.every(v => a.excluded.includes(v));
  }
  return false;
}

/** The constraint a rule's conditions put on one fact (AND of all its conditions on that fact). */
export function constraintOn(conditions: Condition[], factId: string, vocab: Vocabulary): Constraint {
  const def = vocab.facts.get(factId)!;
  let c = universeConstraint(def);
  for (const cond of conditions) if (cond.fact === factId) c = intersect(c, conditionConstraint(cond, def));
  return c;
}

export function describeConstraint(c: Constraint, def: FactDef): string {
  switch (c.shape) {
    case 'finite': return `${def.id} in ${c.values.join(', ')}`;
    case 'range': {
      const parts: string[] = [];
      if (c.lo !== -Infinity) parts.push(`${c.loOpen ? '>' : '>='} ${c.lo}`);
      if (c.hi !== Infinity) parts.push(`${c.hiOpen ? '<' : '<='} ${c.hi}`);
      if (c.excluded.length) parts.push(`not ${c.excluded.join(', ')}`);
      return parts.length ? `${def.id} ${parts.join(' and ')}` : `any ${def.id}`;
    }
    case 'values': return c.values ? `${def.id} in ${c.values.map(String).join(', ')}` : c.excluded.length ? `${def.id} not ${c.excluded.map(String).join(', ')}` : `any ${def.id}`;
    case 'minutes': {
      const windows: string[] = [];
      let start = -1;
      for (let t = 0; t <= 1440; t++) {
        const on = t < 1440 && c.bits[t];
        if (on && start < 0) start = t;
        if (!on && start >= 0) { windows.push(`${hhmm(start)}–${hhmm(t)}`); start = -1; }
      }
      return windows.length === 1 && windows[0] === '00:00–24:00' ? `any ${def.id}` : `${def.id} in ${windows.join(', ')}`;
    }
  }
}

function hhmm(t: number): string {
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}
