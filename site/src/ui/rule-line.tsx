import type { Rule, Rulebook, AuthorityDef } from '../../../src/index';
import { describeSelector, describeCondition } from '../../../src/index';
import { vocabularyOf } from '../../../src/vocabulary';
import { say } from '../../../src/check';
import { authorityName, authorityRank } from '../lib/model';

/** The rule as `who · does · where · when → answer`, using the core's own wording. */
export function RuleLine({ rule, rulebook }: { rule: Rule; rulebook: Rulebook }) {
  const vocab = vocabularyOf(rulebook);
  const when = rule.when?.length ? rule.when.map(describeCondition).join(' and ') : 'always';
  const answer = say(rule) + (rule.then.answer === 'deny' && rule.then.instead ? `, then ${rule.then.instead}` : '');
  return (
    <span class="line">
      {describeSelector(rule.who, 'who', vocab)} · {describeSelector(rule.does, 'does', vocab)} · {describeSelector(rule.where, 'where', vocab)} · {when}
      {' → '}<b class={`answer-${rule.then.answer}`}>{answer}</b>
    </span>
  );
}

export function AuthorityBadge({ id, authorities }: { id: string; authorities: AuthorityDef[] }) {
  const rank = id === 'builtin' ? 99 : authorityRank(authorities, id);
  return <span class={`badge auth-${Math.min(rank, 3)}`} title={`Set by ${authorityName(authorities, id)} (${id})`}>{authorityName(authorities, id)}</span>;
}

export function sourceLabel(rule: Rule): string {
  const s = rule.source;
  switch (s.kind) {
    case 'question': return `from the answer "${s.ref}"`;
    case 'template': return `from the template`;
    case 'declaration': return `from a declaration (${s.ref})`;
    case 'text': return `written as "${s.ref}"`;
    case 'manual': return 'written by hand';
    default: return s.kind;
  }
}

/** Finding messages quote rule IDs in backticks; show those as code. */
export function Backticked({ text }: { text: string }) {
  const parts = text.split('`');
  return <>{parts.map((p, i) => i % 2 ? <code key={i}>{p}</code> : p)}</>;
}
