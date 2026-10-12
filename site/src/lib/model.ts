/**
 * The switchboard's editable rulebook: a plain CompileDomainInput plus the
 * rule IDs the viewer has switched off. Everything here is pure; the core
 * does the compiling, checking and deciding.
 */

import {
  compileDomain, checkRulebook, draftRuleFromText, DomainRulesError, templateById,
  type CompileDomainInput, type Rulebook, type Rule, type Finding, type RuleDraft,
  type TemplateQuestion, type AuthorityDef,
} from '../../../src/index';

export interface RulebookState {
  /** Which starting point this was built from (for the picker and the scenario presets). */
  startingPoint: StartingPointId;
  input: CompileDomainInput;
  /** Operator rules switched off in the switchboard (they stay in the list, greyed). */
  disabledRuleIds: string[];
  /** The authority chosen for rules written next (DomainRulesBuilder.as). */
  actingAs: string;
}

export type StartingPointId = 'grocery' | 'warehouse' | 'clinic' | 'empty';

export interface Compiled {
  rulebook: Rulebook | null;
  /** Set when the input cannot compile (a DomainRulesError, in plain words). */
  error: string | null;
}

/** Deep-clone plain JSON data (the inputs are plain data; templates are referenced by ID). */
export function cloneJson<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }

/** The input with disabled rules left out, ready for compileDomain. */
export function effectiveInput(state: RulebookState): CompileDomainInput {
  const off = new Set(state.disabledRuleIds);
  const input = cloneJson(state.input);
  input.rules = (input.rules ?? []).filter(r => !off.has(r.id));
  return input;
}

export function compileState(state: RulebookState): Compiled {
  try {
    return { rulebook: compileDomain(effectiveInput(state)), error: null };
  } catch (e) {
    return { rulebook: null, error: e instanceof Error ? e.message : String(e) };
  }
}

export function findingsOf(state: RulebookState): Finding[] {
  try { return checkRulebook(effectiveInput(state)); } catch { return []; }
}

/** The template's questions with the current answer, or none when there is no template. */
export function questionsOf(state: RulebookState): Array<TemplateQuestion & { current: string }> {
  const t = state.input.template;
  if (!t) return [];
  const template = typeof t === 'string' ? templateById(t) : t;
  return template.questions.map(q => ({ ...q, current: state.input.answers?.[q.id] ?? q.options[q.defaultIndex].value }));
}

/** The authorities in force, highest first: declared, else the template's, else "site". */
export function authoritiesOf(state: RulebookState): AuthorityDef[] {
  if (state.input.authorities?.length) return state.input.authorities;
  const t = state.input.template;
  if (t) return (typeof t === 'string' ? templateById(t) : t).authorities;
  return [{ id: 'site' }];
}

export function authorityName(authorities: AuthorityDef[], id: string): string {
  if (id === 'builtin') return 'the evaluator';
  return authorities.find(a => a.id === id)?.name ?? id;
}

/** 0 = highest. Unknown authorities (and "builtin") sort last. */
export function authorityRank(authorities: AuthorityDef[], id: string): number {
  const i = authorities.findIndex(a => a.id === id);
  return i < 0 ? authorities.length : i;
}

// ─── Edits ──────────────────────────────────────────────────────────────────

export function answerQuestion(state: RulebookState, questionId: string, value: string): RulebookState {
  return { ...state, input: { ...state.input, answers: { ...(state.input.answers ?? {}), [questionId]: value } } };
}

/** Draft a rule from plain words against the vocabulary as it stands (rules left out, so a half-written one cannot block drafting). */
export function draftFromText(state: RulebookState, text: string, id?: string): RuleDraft | { error: string } {
  try {
    const vocabulary = compileDomain({ ...effectiveInput(state), rules: [] });
    return draftRuleFromText(text, vocabulary, { setBy: state.actingAs, id: id || undefined });
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

export function confirmDraft(state: RulebookState, draft: RuleDraft): RulebookState {
  if (!draft.draft) throw new DomainRulesError('There is no draft to confirm.');
  const rule: Rule = { ...draft.draft, setBy: state.actingAs };
  const rules = (state.input.rules ?? []).filter(r => r.id !== rule.id);
  return { ...state, input: { ...state.input, rules: [...rules, rule] } };
}

export function removeRule(state: RulebookState, ruleId: string): RulebookState {
  return {
    ...state,
    input: { ...state.input, rules: (state.input.rules ?? []).filter(r => r.id !== ruleId) },
    disabledRuleIds: state.disabledRuleIds.filter(id => id !== ruleId),
  };
}

export function toggleRule(state: RulebookState, ruleId: string): RulebookState {
  const off = new Set(state.disabledRuleIds);
  if (off.has(ruleId)) off.delete(ruleId); else off.add(ruleId);
  return { ...state, disabledRuleIds: [...off] };
}

/** Is this a rule the operator wrote (and so may switch off or delete here)? */
export function isOperatorRule(state: RulebookState, ruleId: string): boolean {
  return (state.input.rules ?? []).some(r => r.id === ruleId);
}

export function setActingAs(state: RulebookState, authority: string): RulebookState {
  return { ...state, actingAs: authority };
}

export function setAuthorities(state: RulebookState, list: AuthorityDef[]): RulebookState {
  return { ...state, input: { ...state.input, authorities: list } };
}

export function setOtherwise(state: RulebookState, value: 'deny' | 'wait-for-approval'): RulebookState {
  return { ...state, input: { ...state.input, otherwise: value } };
}

export function setHours(state: RulebookState, hours: { open: string; close: string } | undefined): RulebookState {
  return { ...state, input: { ...state.input, site: { ...state.input.site, hours } } };
}

type ListKey = 'areas' | 'roles' | 'actions' | 'facts' | 'limits';

/** Add (or replace by ID) a declared thing. */
export function upsertDeclared<K extends ListKey>(state: RulebookState, key: K, item: NonNullable<CompileDomainInput[K]>[number]): RulebookState {
  const list = ((state.input[key] ?? []) as Array<{ id: string }>).filter(x => x.id !== item.id);
  return { ...state, input: { ...state.input, [key]: [...list, item] } };
}

export function removeDeclared(state: RulebookState, key: ListKey, id: string): RulebookState {
  const list = ((state.input[key] ?? []) as Array<{ id: string }>).filter(x => x.id !== id);
  return { ...state, input: { ...state.input, [key]: list } };
}

/** Turn a compiled rulebook back into an editable input: rules written here (manual, text, agent, system) are kept; everything else is regenerated by compile. */
export function inputFromRulebook(rb: Rulebook): CompileDomainInput {
  const operatorRules = rb.rules.filter(r => r.source.kind === 'manual' || r.source.kind === 'text' || r.source.kind === 'agent' || r.source.kind === 'system');
  const input: CompileDomainInput = {
    site: cloneJson(rb.site),
    kinds: [...rb.kinds],
    authorities: cloneJson(rb.authorities),
    actions: cloneJson(rb.actions),
    facts: cloneJson(rb.facts),
    limits: cloneJson(rb.limits),
    tags: cloneJson(rb.tags),
    areas: cloneJson(rb.areas),
    roles: cloneJson(rb.roles),
    answers: cloneJson(rb.answers),
    rules: cloneJson(operatorRules),
    otherwise: rb.otherwise,
  };
  if (rb.template) input.template = rb.template;
  return input;
}

/** A readable "who · does · where · when → answer" line needs the compiled vocabulary; the UI uses render helpers from the core for that. */
export const STATUS_WORD: Record<string, { word: string; sentence: string }> = {
  ALLOW: { word: 'YES', sentence: 'Go ahead.' },
  LIMIT: { word: 'SLOWER', sentence: 'Go ahead, within these limits.' },
  PAUSE: { word: 'WAIT', sentence: 'Wait: for a person, or for the situation to change.' },
  BLOCK: { word: 'NO', sentence: 'This does not happen.' },
};
