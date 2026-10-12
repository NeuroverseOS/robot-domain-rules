/**
 * Independent cross-check of the conflict analysis against an SMT solver.
 *
 * For a few hundred seeded, generated rulebooks, every pair of rules is put
 * to both the checker (`rulesOverlap`: exact set algebra over the declared
 * fact types) and Z3 (each rule encoded as a formula over typed variables).
 * They must agree on every pair — overlap or not — and every witness the
 * checker produces must satisfy both formulas.
 *
 * z3-solver (WASM) is a devDependency only: it is not in the published
 * package and never in the core. Runs in `npm test`; set Z3_ROUNDS to scale.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { init, type Context } from 'z3-solver';
import { compileDomain, rulesOverlap } from '../src/index';
import type { CompileDomainInput, Condition, Rule, Rulebook, Witness } from '../src/index';

type Z3Api = Awaited<ReturnType<typeof init>>;
type Ctx = Context<'crosscheck'>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Expr = any;

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
const MODES = ['a', 'b', 'c'];
const ACTIONS = ['go', 'look'], AREAS = ['x', 'y'];

const site = (rules: Array<Omit<Rule, 'source' | 'setBy'>>): CompileDomainInput => ({
  site: { id: 'z', name: 'Z' },
  authorities: [{ id: 'high' }],
  actions: [{ id: 'go', kinds: ['robot'], tags: ['movement'] }, { id: 'look', kinds: ['robot'], tags: ['sensing'] }],
  facts: [
    { id: 'n', type: 'number', integer: true, min: 0, max: 9, required: true },
    { id: 'm', type: 'number', min: 0, default: 0 },
    { id: 't', type: 'time', required: true },
    { id: 'mode', type: 'enum', values: MODES, default: 'a' },
    { id: 'flag', type: 'boolean', default: false },
    { id: 'day', type: 'day', required: true },
    { id: 'name', type: 'string', default: 'x' },
  ],
  limits: [],
  areas: [{ id: 'x', name: 'X', tags: ['near'] }, { id: 'y', name: 'Y', tags: ['far'] }],
  roles: [{ id: 'bot', name: 'Bot', kind: 'robot', actions: ['go', 'look'] }],
  rules: rules.map(r => ({ ...r, setBy: 'high', source: { kind: 'manual', ref: r.id } })),
});

const minutes = (hhmm: string) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };

let z3: Z3Api, Z3: Ctx;
beforeAll(async () => { z3 = await init(); Z3 = z3.Context('crosscheck'); }, 60_000);
afterAll(() => { /* the WASM module keeps a worker alive; vitest tears the process down */ });

/** Encode one rule as a Z3 formula over the shared variables. */
function encode(rule: Rule, rb: Rulebook, v: Record<string, Expr>): Expr {
  const parts: Expr[] = [];
  const members = (sel: Rule['does'], ids: string[], tagOf: (id: string) => string[], variable: Expr): Expr => {
    const entries = (Array.isArray(sel) ? sel : [sel]).map(e => e.trim()).filter(Boolean);
    const expand = (e: string) => e === '*' ? ids : e.startsWith('tag:') ? ids.filter(id => tagOf(id).includes(e.slice(4))) : [e];
    const positives = entries.filter(e => !e.startsWith('!')), negatives = entries.filter(e => e.startsWith('!')).map(e => e.slice(1));
    let set = positives.length === 0 || positives.includes('*') ? [...ids] : [...new Set(positives.flatMap(expand))];
    for (const neg of negatives) set = set.filter(id => !expand(neg).includes(id));
    return set.length ? Z3.Or(...set.map(id => variable.eq(ids.indexOf(id)))) : Z3.Bool.val(false);
  };
  parts.push(members(rule.does, ACTIONS, id => rb.actions.find(a => a.id === id)?.tags ?? [], v.action));
  parts.push(members(rule.where, AREAS, id => rb.areas.find(a => a.id === id)?.tags ?? [], v.area));
  for (const c of rule.when ?? []) parts.push(condition(c, v));
  return Z3.And(...parts);
}

function condition(c: Condition, v: Record<string, Expr>): Expr {
  const x = v[c.fact];
  const lit = (value: unknown): Expr | number => {
    if (c.fact === 't') return minutes(value as string);
    if (c.fact === 'day') return DAYS.indexOf(value as typeof DAYS[number]);
    if (c.fact === 'mode') return MODES.indexOf(value as string);
    if (c.fact === 'flag') return Z3.Bool.val(value as boolean);
    return value as number;
  };
  switch (c.op) {
    case 'between': {
      const f = minutes(c.from), o = minutes(c.to);
      return f < o ? Z3.And(x.ge(f), x.lt(o)) : Z3.Or(x.ge(f), x.lt(o));
    }
    case 'days': return Z3.Or(...c.days.map(d => x.eq(DAYS.indexOf(d))));
    case 'in': return Z3.Or(...c.values.map(val => x.eq(lit(val))));
    case '==': return x.eq(lit(c.value));
    case '!=': return Z3.Not(x.eq(lit(c.value)));
    case '>': return x.gt(lit(c.value));
    case '>=': return x.ge(lit(c.value));
    case '<': return x.lt(lit(c.value));
    case '<=': return x.le(lit(c.value));
  }
}

function witnessFormula(w: Witness, v: Record<string, Expr>): Expr {
  const parts: Expr[] = [v.action.eq(ACTIONS.indexOf(w.action)), v.area.eq(AREAS.indexOf(w.areaId))];
  for (const [fact, value] of Object.entries(w.facts)) {
    if (fact === 'name') continue;   // strings are not encoded (no rule here conditions on them)
    const x = v[fact];
    parts.push(fact === 't' ? x.eq(minutes(value as string)) : fact === 'day' ? x.eq(DAYS.indexOf(value as typeof DAYS[number])) : fact === 'mode' ? x.eq(MODES.indexOf(value as string)) : fact === 'flag' ? x.eq(Z3.Bool.val(value as boolean)) : x.eq(value as number));
  }
  return Z3.And(...parts);
}

describe('conflict analysis cross-checked with Z3: the checker and an SMT solver agree on every pair', () => {
  it('overlap or not, on every generated pair; and every witness satisfies both rules', async () => {
    let seed = 0x5a3c2026;
    const rnd = () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
    const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
    const hhmm = () => `${String(int(0, 23)).padStart(2, '0')}:${String(pick([0, 15, 30, 45])).padStart(2, '0')}`;
    const cond = (): Condition => {
      switch (int(0, 8)) {
        case 0: return { fact: 'n', op: pick(['==', '!=', '>', '>=', '<', '<='] as const), value: int(0, 9) };
        case 1: return { fact: 'n', op: 'in', values: [int(0, 9), int(0, 9), int(0, 9)] };
        case 2: return { fact: 'm', op: pick(['>', '>=', '<', '<=', '!=', '=='] as const), value: int(0, 8) / 2 };
        case 3: return { fact: 't', op: 'between', from: hhmm(), to: hhmm() };
        case 4: return { fact: 't', op: pick(['>=', '<', '>', '<=', '==', '!='] as const), value: hhmm() };
        case 5: return { fact: 'day', op: 'days', days: [pick(DAYS), pick(DAYS)] };
        case 6: return pick([true, false]) ? { fact: 'mode', op: pick(['==', '!='] as const), value: pick(MODES) } : { fact: 'mode', op: 'in', values: [pick(MODES), pick(MODES)] };
        case 7: return { fact: 'day', op: pick(['==', '!='] as const), value: pick(DAYS) };
        default: return { fact: 'flag', op: '==', value: pick([true, false]) };
      }
    };
    const selector = (ids: string[], tags: string[]): Rule['does'] => {
      const r = rnd();
      if (r < 0.3) return '*';
      if (r < 0.5) return [pick(ids)];
      if (r < 0.7) return [`tag:${pick(tags)}`];
      if (r < 0.85) return ['*', `!${pick(ids)}`];
      return [pick(ids), pick(ids)];
    };
    const randomRule = (id: string): Omit<Rule, 'source' | 'setBy'> => ({
      id, text: id, who: '*', does: selector(ACTIONS, ['movement', 'sensing']), where: selector(AREAS, ['near', 'far']),
      when: Array.from({ length: int(0, 3) }, cond), then: { answer: 'deny' },
    });

    const v: Record<string, Expr> = {
      action: Z3.Int.const('action'), area: Z3.Int.const('area'),
      n: Z3.Int.const('n'), m: Z3.Real.const('m'), t: Z3.Int.const('t'), mode: Z3.Int.const('mode'), flag: Z3.Bool.const('flag'), day: Z3.Int.const('day'),
    };
    const domain = Z3.And(
      v.action.ge(0), v.action.le(ACTIONS.length - 1), v.area.ge(0), v.area.le(AREAS.length - 1),
      v.n.ge(0), v.n.le(9), v.m.ge(0), v.t.ge(0), v.t.le(1439), v.mode.ge(0), v.mode.le(MODES.length - 1), v.day.ge(0), v.day.le(6),
    );
    const solver = new Z3.Solver();
    solver.add(domain);

    const rounds = Number(process.env.Z3_ROUNDS ?? 400);
    const RULES = 4;
    let rulebooks = 0, pairs = 0, overlaps = 0, witnesses = 0;
    const started = Date.now();
    for (let round = 0; round < rounds; round++) {
      let rb: Rulebook;
      try { rb = compileDomain(site(Array.from({ length: RULES }, (_, i) => randomRule(`r${i}`)))); } catch { continue; }   // impossible conditions are refused at compile time
      rulebooks++;
      const formulas = rb.rules.map(r => encode(r, rb, v));
      for (let i = 0; i < rb.rules.length; i++) for (let j = i + 1; j < rb.rules.length; j++) {
        pairs++;
        const ours = rulesOverlap(rb, rb.rules[i].id, rb.rules[j].id);
        solver.push();
        solver.add(formulas[i], formulas[j]);
        const z3Says = (await solver.check()) === 'sat';
        solver.pop();
        expect(ours !== null, `checker and Z3 disagree on ${rb.rules[i].id}+${rb.rules[j].id} (checker: ${ours ? 'overlap' : 'disjoint'}, Z3: ${z3Says ? 'sat' : 'unsat'}): ${JSON.stringify([rb.rules[i], rb.rules[j]])}`).toBe(z3Says);
        if (!ours) continue;
        overlaps++;
        expect(ours.certainty).toBe('certain');
        solver.push();
        solver.add(formulas[i], formulas[j], witnessFormula(ours.witness, v));
        const witnessOk = (await solver.check()) === 'sat';
        solver.pop();
        expect(witnessOk, `witness does not satisfy both rules in Z3: ${JSON.stringify({ rules: [rb.rules[i], rb.rules[j]], witness: ours.witness })}`).toBe(true);
        witnesses++;
      }
    }
    const seconds = (Date.now() - started) / 1000;
    console.log(`z3 cross-check: ${rulebooks} rulebooks, ${pairs} pairs (${overlaps} overlapping, ${pairs - overlaps} disjoint), ${witnesses} witnesses, ${seconds.toFixed(1)} s`);
    expect(rulebooks).toBeGreaterThan(rounds * 0.5);
    expect(overlaps).toBeGreaterThan(100);
    expect(pairs - overlaps).toBeGreaterThan(100);
  }, 120_000);
});
