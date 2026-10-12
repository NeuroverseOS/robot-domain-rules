/**
 * Drafting rules from plain words — deterministic, and optionally with the
 * operator's own model.
 *
 *   draftRuleFromText(text, rulebook, { setBy })   pattern-matches common forms
 *                                                 against the rulebook's own vocabulary
 *   buildRuleDraftPrompt(text, rulebook)           a prompt for the operator's model
 *   parseRuleDraft(json, rulebook, { setBy })      validates a model's JSON answer
 *
 * Both paths only PROPOSE. A draft is never added to a rulebook until the
 * operator confirms it. No network calls happen here. The authority that
 * sets a rule (`setBy`) always comes from the operator, never from the text
 * and never from the model.
 */

import type { Condition, FactValue, Outcome, Rule, Rulebook, Selector } from './types';
import { DAYS } from './types';
import { DomainRulesError, isValidTime, vocabularyOf, type Vocabulary } from './vocabulary';
import { validateRule, clone } from './compile';

export interface RuleDraft {
  /** The proposed rule, or null when the text could not be turned into one. */
  draft: Rule | null;
  /** 0..1. Below about 0.6 the operator should read the draft carefully. */
  confidence: number;
  /** Words in the text the drafter could not account for. */
  unmatched: string[];
  /** What the drafter assumed or could not do, in plain words. */
  notes: string[];
}

export interface DraftOptions {
  /** The authority that will set the rule. Required before the draft can be confirmed. */
  setBy?: string;
  /** Rule ID. Defaults to a slug of the text. */
  id?: string;
}

// ─── Deterministic drafting ──────────────────────────────────────────────────

const STOP = new Set(['the', 'a', 'an', 'in', 'on', 'at', 'to', 'of', 'for', 'into', 'their', 'its', 'from', 'and', 'is', 'are', 'be', 'with', 'while', 'when', 'if', 'during', 'any', 'all', 'every', 'by', 'please', 'must', 'should', 'they', 'it', 'that', 'this', 'there', 'here', 'area', 'areas', 'zone', 'zones', 'room', 'rooms', 'each', 'time', 'times', 'ever', 'only', 'unless', 'than', 'or', 'as', 'do', 'does', 'may', 'can', 'get', 'go']);
const KIND_WORDS: Record<string, string[]> = {
  person: ['people', 'person', 'persons', 'humans', 'human', 'wearers', 'wearer', 'everyone', 'anyone', 'anybody', 'everybody'],
  robot: ['robots', 'robot', 'bots', 'bot', 'machines', 'machine'],
};
const DAY_WORDS: Record<string, string[]> = {
  mon: ['monday', 'mondays', 'mon'], tue: ['tuesday', 'tuesdays', 'tue', 'tues'], wed: ['wednesday', 'wednesdays', 'wed'],
  thu: ['thursday', 'thursdays', 'thu', 'thurs'], fri: ['friday', 'fridays', 'fri'], sat: ['saturday', 'saturdays', 'sat'], sun: ['sunday', 'sundays', 'sun'],
};

interface Tok { raw: string; norm: string; used: boolean }

export function draftRuleFromText(text: string, rulebook: Rulebook, options: DraftOptions = {}): RuleDraft {
  const vocab = vocabularyOf(rulebook);
  const notes: string[] = [];
  const toks = tokenize(text);
  const use = (i: number, n = 1) => { for (let k = i; k < i + n; k++) toks[k].used = true; };
  const timeFact = rulebook.facts.find(f => f.type === 'time' && (f.required || f.default !== undefined));
  const dayFact = rulebook.facts.find(f => f.type === 'day' && (f.required || f.default !== undefined));
  const when: Condition[] = [];
  let confidence = 1;

  // Time windows and bounds.
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i].norm;
    if ((t === 'between' || t === 'from') && isTime(toks[i + 1]?.norm) && (toks[i + 2]?.norm === 'and' || toks[i + 2]?.norm === 'to') && isTime(toks[i + 3]?.norm)) {
      if (timeFact) when.push({ fact: timeFact.id, op: 'between', from: padTime(toks[i + 1].norm), to: padTime(toks[i + 3].norm) });
      else notes.push('A time window was written but no required time fact is declared; add one (type "time").');
      use(i, 4);
    } else if ((t === 'after' || t === 'before') && isTime(toks[i + 1]?.norm)) {
      if (timeFact) when.push({ fact: timeFact.id, op: t === 'after' ? '>=' : '<', value: padTime(toks[i + 1].norm) });
      else notes.push('A time was written but no required time fact is declared; add one (type "time").');
      use(i, 2);
    }
  }
  // Days.
  const days = new Set<string>();
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i].norm;
    if (toks[i].used) continue;
    const d = Object.entries(DAY_WORDS).find(([, ws]) => ws.includes(t))?.[0];
    if (d) { days.add(d); use(i); if (toks[i - 1]?.norm === 'on') use(i - 1); }
    else if (t === 'weekends' || t === 'weekend') { days.add('sat'); days.add('sun'); use(i); if (toks[i - 1]?.norm === 'on' || toks[i - 1]?.norm === 'at') use(i - 1); }
    else if (t === 'weekdays' || t === 'weekday') { for (const d2 of ['mon', 'tue', 'wed', 'thu', 'fri']) days.add(d2); use(i); if (toks[i - 1]?.norm === 'on') use(i - 1); }
  }
  if (days.size) {
    if (dayFact) when.push({ fact: dayFact.id, op: 'days', days: DAYS.filter(d => days.has(d)) });
    else notes.push('Days were written but no required day fact is declared; add one (type "day").');
  }

  // Limits: "slow to 0.3 m/s", "at most 1 m/s", "no faster than 0.5 m/s", "max 2".
  let then: Outcome | null = null;
  let doesFromLimit: Selector | undefined;
  for (let i = 0; i < toks.length && !then; i++) {
    const w = (k: number) => toks[i + k]?.norm;
    const forms: Array<[number, boolean]> = [[1, w(0) === 'max' || w(0) === 'maximum'], [2, (w(0) === 'slow' && w(1) === 'to') || (w(0) === 'at' && w(1) === 'most') || (w(0) === 'up' && w(1) === 'to') || (w(0) === 'limited' && w(1) === 'to') || (w(0) === 'limit' && w(1) === 'to')], [3, (w(0) === 'no' || w(0) === 'not') && (w(1) === 'faster' || w(1) === 'more') && w(2) === 'than']];
    for (const [len, ok] of forms) {
      if (!ok || !isNumber(w(len))) continue;
      const value = Number(w(len));
      const unitTok = toks[i + len + 1]?.norm;
      const byUnit = rulebook.limits.find(l => l.unit && unitTok && l.unit.toLowerCase() === unitTok);
      const looksLikeUnit = !!unitTok && /^[a-z]+\/[a-z]+$|^(mph|kph|kg|lb|lbs|cm|mm|km|m|s|ms|min|h|hz|db|%)$/.test(unitTok);
      const limit = byUnit
        ?? (looksLikeUnit ? undefined : rulebook.limits.find(l => (l.synonyms ?? []).some(s => toks.some(t => !t.used && t.norm === norm(s)))))
        ?? (looksLikeUnit ? undefined : rulebook.limits.length === 1 ? rulebook.limits[0] : undefined);
      if (!limit) { notes.push(`"${toks.slice(i, i + len + 1 + (looksLikeUnit ? 1 : 0)).map(t => t.raw).join(' ')}" looks like a limit, but the rulebook declares no matching limit${looksLikeUnit ? ` (units: ${rulebook.limits.map(l => l.unit).filter(Boolean).join(', ') || 'none'})` : ''}.`); break; }
      then = { answer: 'limit', limits: { [limit.id]: value } };
      doesFromLimit = limit.appliesTo;
      use(i, len + 1 + (unitTok && limit.unit && limit.unit.toLowerCase() === unitTok ? 1 : 0));
      if (w(0) === 'slow' && toks[i - 1]?.norm === 'down') use(i - 1);
      break;
    }
  }
  // Approval: "wait for X approval", "with X approval", "need(s) X approval", "approved by X", "ask X first/before".
  let by: string | undefined;
  for (let i = 0; i < toks.length && !then; i++) {
    const t = toks[i].norm;
    const idx = (t === 'approval' || t === 'approve' || t === 'approved' || t === 'permission') ? i : -1;
    if (idx < 0) continue;
    then = { answer: 'wait', for: 'approval' };
    use(idx);
    // Who approves: the phrase right before "approval", or right after "approved by".
    const before = [idx - 2, idx - 1].filter(k => k >= 0 && !toks[k].used);
    const after = t === 'approved' && toks[idx + 1]?.norm === 'by' ? [idx + 2, idx + 3].filter(k => k < toks.length) : [];
    const span = after.length ? after : before;
    const found = matchApprover(toks, span, vocab);
    if (found) { by = found.ref; for (const k of found.used) use(k); }
    for (const k of [idx - 1, idx - 2, idx - 3]) if (k >= 0 && ['for', 'with', 'wait', 'waits', 'need', 'needs', 'require', 'requires', 'a', 'an', 'the', "person's", 'persons'].includes(toks[k].norm) && !toks[k].used) use(k);
    if (after.length && toks[idx + 1]) use(idx + 1);
    if (!found && span.some(k => toks[k] && !toks[k].used && !STOP.has(toks[k].norm))) notes.push('Could not tell who must approve; the draft accepts any approval. Set then.by to an authority, role or tag:<role tag>.');
  }
  // Wait for a condition: "wait while <condition>" / "wait until <condition>" (until = while the opposite holds).
  for (let i = 0; i < toks.length && !then; i++) {
    if ((toks[i].norm === 'wait' || toks[i].norm === 'waits') && (toks[i + 1]?.norm === 'while' || toks[i + 1]?.norm === 'until')) {
      then = { answer: 'wait', for: 'condition' };
      const until = toks[i + 1].norm === 'until';
      use(i, 2);
      const cond = matchCondition(toks, i + 2, rulebook, vocab);
      if (!cond) { notes.push(`"wait ${toks[i + 1].norm} ..." needs a condition on a declared fact (for example "while people are present"); none was recognised.`); confidence -= 0.3; break; }
      for (const k of cond.used) use(k);
      const c = until ? negate(cond.condition) : cond.condition;
      if (!c) { notes.push(`Could not express the opposite of "${toks.slice(i + 2, i + 2 + cond.used.length).map(t => t.raw).join(' ')}"; write it as "wait while ...".`); confidence -= 0.3; break; }
      when.push(c);
    }
  }
  // Conditions on facts: "when/while/if <fact> ...". Read before deny/allow so a "not" inside a condition is not read as a deny.
  for (let i = 0; i < toks.length; i++) {
    if (!['when', 'while', 'if', 'whenever'].includes(toks[i].norm) || toks[i].used) continue;
    const cond = matchCondition(toks, i + 1, rulebook, vocab);
    if (cond) { when.push(cond.condition); use(i); for (const k of cond.used) use(k); }
  }

  // Deny / allow.
  const NEG = ['no', 'not', 'never', "can't", 'cannot', "don't", "mustn't", 'forbidden', 'prohibited', 'banned', 'nobody'];
  const POS = ['may', 'can', 'allowed', 'permitted', 'ok', 'okay', 'let', 'free'];
  if (!then) {
    const neg = toks.findIndex(t => !t.used && NEG.includes(t.norm));
    if (neg >= 0) {
      then = { answer: 'deny' };
      use(neg);
      if (toks[neg - 1]?.norm === 'may' || toks[neg - 1]?.norm === 'must' || toks[neg - 1]?.norm === 'do' || toks[neg - 1]?.norm === 'are') use(neg - 1);
    } else {
      const pos = toks.findIndex(t => !t.used && POS.includes(t.norm));
      if (pos >= 0) { then = { answer: 'allow' }; use(pos); }
    }
  }
  if (!then) {
    return { draft: null, confidence: 0, unmatched: leftovers(toks), notes: [...notes, 'Could not find what the rule decides. Say "no ...", "... may ...", "... wait for ... approval", "wait while ...", or "at most N <unit>".'] };
  }

  // Who, does, where — by the rulebook's own names and synonyms, longest phrase first across all three.
  const sel = matchSelectors(toks, vocab, use, doesFromLimit === undefined);
  const who = sel.who;
  const does = doesFromLimit !== undefined ? clone(doesFromLimit) : sel.does;
  const where = sel.where;

  let whoSel: Selector, doesSel: Selector, whereSel: Selector;
  if (who.length) whoSel = who; else { whoSel = '*'; confidence -= 0.3; notes.push('No role, kind or tag was recognised; the draft applies to anyone.'); }
  if (Array.isArray(does) ? does.length : does) doesSel = does; else if (then.answer === 'deny') { doesSel = '*'; notes.push('No action was recognised; "no ..." was read as: no action at all.'); } else { doesSel = '*'; confidence -= 0.3; notes.push('No action was recognised; the draft applies to every action. Name one.'); }
  if (where.length) whereSel = where; else { whereSel = '*'; notes.push('No area was recognised; the draft applies everywhere.'); }

  const unmatched = leftovers(toks);
  confidence = Math.max(0, Math.min(1, confidence - 0.1 * unmatched.length));
  const draft: Rule = {
    id: options.id ?? slug(text),
    text,
    who: whoSel, does: doesSel, where: whereSel,
    ...(when.length ? { when } : {}),
    then: by ? { ...then, by } as Outcome : then,
    source: { kind: 'text', ref: text },
    setBy: options.setBy ?? '',
  };
  if (!options.setBy) notes.push('Say who sets this rule (setBy) before confirming it.');
  else {
    try { validateRule(draft, vocab); } catch (e) { return { draft: null, confidence: 0, unmatched, notes: [...notes, (e as Error).message] }; }
  }
  return { draft, confidence, unmatched, notes };
}

// ─── Matching helpers ────────────────────────────────────────────────────────

/** The opposite of a simple condition, where it can be written exactly; null otherwise. */
function negate(c: Condition): Condition | null {
  switch (c.op) {
    case '==': return { fact: c.fact, op: '!=', value: c.value };
    case '!=': return { fact: c.fact, op: '==', value: c.value };
    case '>': return { fact: c.fact, op: '<=', value: c.value };
    case '>=': return { fact: c.fact, op: '<', value: c.value };
    case '<': return { fact: c.fact, op: '>=', value: c.value };
    case '<=': return { fact: c.fact, op: '>', value: c.value };
    default: return null;
  }
}

function tokenize(text: string): Tok[] {
  return text
    .replace(/[“”"()\[\],;!?]/g, ' ')
    .replace(/(\d)\s*m\/s/gi, '$1 m/s')
    .split(/\s+/)
    .filter(Boolean)
    .map(raw => ({ raw, norm: norm(raw), used: false }));
}

function norm(w: string): string {
  const x = w.toLowerCase().replace(/\.$/, '').replace(/^'|'$/g, '');
  return x;
}

/** Singular, lowercase, hyphens and underscores as spaces. */
function stem(w: string): string {
  let x = w.toLowerCase().replace(/[-_]/g, ' ');
  if (x.length > 3 && x.endsWith('ies')) x = `${x.slice(0, -3)}y`;
  else if (x.length > 3 && x.endsWith('s') && !x.endsWith('ss')) x = x.slice(0, -1);
  return x;
}

function isTime(t: string | undefined): boolean {
  return !!t && /^\d{1,2}:\d{2}$/.test(t) && isValidTime(padTime(t));
}
function padTime(t: string): string { return t.length === 4 ? `0${t}` : t; }
function isNumber(t: string | undefined): boolean { return !!t && /^\d+(\.\d+)?$/.test(t); }

function leftovers(toks: Tok[]): string[] {
  return toks.filter(t => !t.used && !STOP.has(t.norm)).map(t => t.raw);
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 48) || 'rule';
}

interface Phrase { words: string[]; ref: string }

function phrasesFor(kind: 'who' | 'does' | 'where', vocab: Vocabulary): Phrase[] {
  const out: Phrase[] = [];
  const add = (ref: string, ...texts: (string | undefined)[]) => { for (const t of texts) if (t) out.push({ words: t.split(/[\s_-]+/).map(stem).filter(Boolean), ref }); };
  if (kind === 'who') {
    for (const r of vocab.roles.values()) add(r.id, r.id, r.name, ...(r.synonyms ?? []));
    for (const k of vocab.kinds) add(`kind:${k}`, k, ...(KIND_WORDS[k] ?? []));
    for (const t of vocab.tags.roles) if (!vocab.roles.has(t)) add(`tag:${t}`, t);
    add('*', 'everyone', 'anyone', 'anybody', 'everybody', 'everything');
  } else if (kind === 'does') {
    for (const a of vocab.actions.values()) add(a.id, a.id, a.name, ...(a.synonyms ?? []));
    for (const t of vocab.tags.actions) add(`tag:${t}`, t);
  } else {
    for (const a of vocab.areas.values()) add(a.id, a.id, a.name, ...(a.synonyms ?? []));
    for (const t of vocab.tags.areas) add(`tag:${t}`, `${t} areas`, `${t} area`, `${t} zones`, `${t} zone`, `${t} rooms`, t);
    add('*', 'everywhere', 'anywhere');
  }
  return out.sort((a, b) => b.words.length - a.words.length);
}

function matchSelectors(toks: Tok[], vocab: Vocabulary, use: (i: number, n?: number) => void, matchActions: boolean): { who: string[]; does: string[]; where: string[] } {
  const kinds: Array<'who' | 'does' | 'where'> = matchActions ? ['who', 'does', 'where'] : ['who', 'where'];
  const phrases = kinds.flatMap(kind => phrasesFor(kind, vocab).map(p => ({ ...p, kind })));
  phrases.sort((a, b) => b.words.length - a.words.length);
  const found = { who: [] as string[], does: [] as string[], where: [] as string[] };
  for (const p of phrases) {
    for (let i = 0; i + p.words.length <= toks.length; i++) {
      if (!p.words.every((w, k) => !toks[i + k].used && stem(toks[i + k].norm) === w)) continue;
      if (!found[p.kind].includes(p.ref)) found[p.kind].push(p.ref);
      use(i, p.words.length);
      // "in the X" / "the X": consume the article and preposition before an area.
      if (p.kind === 'where' && toks[i - 1]?.norm === 'the' && !toks[i - 1].used) { use(i - 1); if (['in', 'at', 'into', 'inside', 'near'].includes(toks[i - 2]?.norm ?? '') && !toks[i - 2].used) use(i - 2); }
      else if (p.kind === 'where' && ['in', 'at', 'into', 'inside'].includes(toks[i - 1]?.norm ?? '') && !toks[i - 1].used) use(i - 1);
    }
  }
  for (const k of kinds) if (found[k].includes('*')) found[k] = ['*'];
  return found;
}

function matchApprover(toks: Tok[], span: number[], vocab: Vocabulary): { ref: string; used: number[] } | null {
  for (const k of span) {
    const t = toks[k];
    if (!t || t.used) continue;
    const s = stem(t.norm);
    const tag = [...vocab.tags.roles].find(x => stem(x) === s);
    if (tag) return { ref: `tag:${tag}`, used: [k] };
    const role = [...vocab.roles.values()].find(r => stem(r.id) === s || stem(r.name) === s || (r.synonyms ?? []).some(y => stem(y) === s));
    if (role) return { ref: role.id, used: [k] };
    const auth = vocab.authorities.find(a => stem(a.id) === s || stem(a.name ?? '') === s || (a.name ?? '').toLowerCase().split(/\s+/).map(stem).pop() === s);
    if (auth) return { ref: auth.id, used: [k] };
  }
  return null;
}

function matchCondition(toks: Tok[], start: number, rulebook: Rulebook, vocab: Vocabulary): { condition: Condition; used: number[] } | null {
  const facts = rulebook.facts.filter(f => f.required || f.default !== undefined);
  const phrases: Array<{ words: string[]; fact: typeof facts[number] }> = [];
  for (const f of facts) for (const t of [f.id, ...(f.synonyms ?? [])]) phrases.push({ words: t.replace(/([a-z])([A-Z])/g, '$1 $2').split(/[\s_-]+/).map(stem), fact: f });
  phrases.sort((a, b) => b.words.length - a.words.length);
  let negated = false;
  let i = start;
  const used: number[] = [];
  if (toks[i]?.norm === 'no' || toks[i]?.norm === 'not') { negated = true; used.push(i); i++; }
  if (toks[i]?.norm === 'the' || toks[i]?.norm === 'a') { used.push(i); i++; }
  const hit = phrases.find(p => p.words.every((w, k) => toks[i + k] && !toks[i + k].used && stem(toks[i + k].norm) === w));
  if (!hit) return null;
  for (let k = 0; k < hit.words.length; k++) used.push(i + k);
  i += hit.words.length;
  const f = hit.fact;
  const w = (k: number) => toks[i + k]?.norm;
  const skip = (n: number) => { for (let k = 0; k < n; k++) used.push(i + k); i += n; };
  if (['is', 'are', 'be'].includes(w(0) ?? '')) skip(1);
  if (f.type === 'boolean') {
    if (w(0) === 'not' || w(0) === 'false' || w(0) === 'off') { skip(1); negated = !negated; }
    else if (w(0) === 'true' || w(0) === 'on' || w(0) === 'active') skip(1);
    return { condition: { fact: f.id, op: '==', value: !negated }, used };
  }
  if (f.type === 'number') {
    if (negated) return { condition: { fact: f.id, op: '==', value: 0 }, used };
    if (w(0) === 'present' || w(0) === 'around' || w(0) === 'nearby') { skip(1); return { condition: { fact: f.id, op: '>', value: 0 }, used }; }
    const ops: Array<[string[], Condition['op']]> = [[['over', 'above', 'more', 'exceeds', '>'], '>'], [['under', 'below', 'fewer', 'less', '<'], '<'], [['at', 'least'], '>='], [['at', 'most'], '<='], [['>='], '>='], [['<='], '<='], [['==', '=', 'equals', 'exactly'], '==']];
    for (const [words, op] of ops) {
      const seq = words.length === 2 ? [w(0), w(1)] : [w(0)];
      if (words.length === 2 ? seq[0] === words[0] && seq[1] === words[1] : words.includes(seq[0] ?? '')) {
        skip(words.length);
        if (w(0) === 'than') skip(1);
        if (!isNumber(w(0))) return null;
        const value = Number(w(0)); skip(1);
        return { condition: { fact: f.id, op: op as '>' | '<' | '>=' | '<=' | '==', value }, used };
      }
    }
    if (isNumber(w(0))) { const value = Number(w(0)); skip(1); return { condition: { fact: f.id, op: '==', value }, used }; }
    return null;
  }
  if (f.type === 'enum' || f.type === 'string' || f.type === 'day') {
    const v = w(0);
    if (!v) return null;
    const value: FactValue = f.type === 'enum' ? (f.values ?? []).find(x => stem(x) === stem(v)) ?? v : v;
    skip(1);
    return { condition: { fact: f.id, op: negated ? '!=' : '==', value }, used };
  }
  return null;
}

// ─── Drafting with the operator's own model ──────────────────────────────────

/** A prompt the operator sends to their own model. The answer is validated by `parseRuleDraft`. No network call here. */
export function buildRuleDraftPrompt(text: string, rulebook: Rulebook): string {
  const list = <T>(xs: T[], f: (x: T) => string) => xs.length ? xs.map(x => `  - ${f(x)}`).join('\n') : '  (none)';
  return [
    'You turn one plain-language rule for a physical site into one JSON rule. Use ONLY the vocabulary below. Do not invent roles, actions, areas, facts, limits or tags.',
    '',
    `Site: ${rulebook.site.name}`,
    'Roles (id — name, kind, tags):',
    list(rulebook.roles, r => `${r.id} — ${r.name}, ${r.kind}${r.tags?.length ? `, tags: ${r.tags.join(', ')}` : ''}`),
    'Actions (id — name, kinds, tags):',
    list(rulebook.actions, a => `${a.id} — ${a.name ?? a.id}, ${a.kinds.join('/')}${a.tags?.length ? `, tags: ${a.tags.join(', ')}` : ''}`),
    'Areas (id — name, tags):',
    list(rulebook.areas, a => `${a.id} — ${a.name}${a.tags?.length ? `, tags: ${a.tags.join(', ')}` : ''}`),
    'Facts a rule may condition on (id — type):',
    list(rulebook.facts.filter(f => f.required || f.default !== undefined), f => `${f.id} — ${f.type}${f.type === 'enum' ? ` (${(f.values ?? []).join(', ')})` : ''}`),
    'Limits (id — unit):',
    list(rulebook.limits, l => `${l.id}${l.unit ? ` — ${l.unit}` : ''}`),
    `Kinds: ${rulebook.kinds.join(', ')}`,
    `Role tags: ${rulebook.tags.roles.join(', ') || 'none'}. Action tags: ${rulebook.tags.actions.join(', ') || 'none'}. Area tags: ${rulebook.tags.areas.join(', ') || 'none'}.`,
    '',
    'Rule shape (JSON):',
    '{ "rule": { "id": "<snake_case>", "text": "<the rule in plain words>",',
    '  "who": <selector>, "does": <selector>, "where": <selector>,',
    '  "when": [ <condition>, ... ]  (optional; AND-ed),',
    '  "then": {"answer":"allow"} | {"answer":"deny"} | {"answer":"wait","for":"approval"|"condition","by"?:"<authority|role|tag:roletag>"} | {"answer":"limit","limits":{"<limit id>": <number>}},',
    '  "reason": "<one sentence shown in decisions>" } }',
    'Selector: "*" | "<id>" | "tag:<tag>" | "kind:<kind>" | a list of those; prefix "!" to exclude.',
    'Condition: {"fact","op":"=="|"!="|">"|">="|"<"|"<=","value"} | {"fact","op":"in","values":[...]} | {"fact","op":"between","from":"HH:MM","to":"HH:MM"} | {"fact","op":"days","days":["mon",...]}',
    'Do not include "setBy" or "source"; the operator sets those.',
    'If the text cannot be expressed with this vocabulary, answer {"error": "<what is missing, in plain words>"}.',
    'Answer with JSON only.',
    '',
    `Text: ${JSON.stringify(text)}`,
  ].join('\n');
}

export interface ParsedDraft {
  draft: Rule | null;
  errors: string[];
}

/** Validate a model's JSON answer into a draft. `setBy` comes from the operator; anything the model says about it is ignored. */
export function parseRuleDraft(json: string | object, rulebook: Rulebook, options: DraftOptions & { text?: string } = {}): ParsedDraft {
  let parsed: unknown;
  if (typeof json === 'string') {
    const cleaned = json.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    try { parsed = JSON.parse(cleaned); } catch { return { draft: null, errors: ['The answer is not valid JSON.'] }; }
  } else parsed = json;
  if (!parsed || typeof parsed !== 'object') return { draft: null, errors: ['The answer is not a JSON object.'] };
  const obj = parsed as { error?: unknown; rule?: unknown };
  if (typeof obj.error === 'string') return { draft: null, errors: [`The model could not express it: ${obj.error}`] };
  const raw = (obj.rule && typeof obj.rule === 'object' ? obj.rule : parsed) as Record<string, unknown>;
  const errors: string[] = [];
  if (raw.setBy !== undefined) errors.push('The model tried to set "setBy"; ignored — the operator sets the authority.');
  const text = options.text ?? (typeof raw.text === 'string' ? raw.text : '');
  const draft = {
    ...clone(raw),
    id: options.id ?? (typeof raw.id === 'string' && raw.id ? raw.id : slug(text || 'rule')),
    text: typeof raw.text === 'string' && raw.text ? raw.text : text,
    source: { kind: 'text', ref: text || '(model draft)' },
    setBy: options.setBy ?? '',
  } as Rule;
  if (!options.setBy) errors.push('Say who sets this rule (setBy) before confirming it.');
  else {
    try { validateRule(draft, vocabularyOf(rulebook)); } catch (e) { return { draft: null, errors: [...errors, e instanceof DomainRulesError ? e.message : String(e)] }; }
  }
  return { draft, errors };
}
