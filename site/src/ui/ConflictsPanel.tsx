import type { Finding } from '../../../src/index';
import { Backticked } from './rule-line';

const KIND_WORDS: Record<Finding['kind'], string> = {
  'contradiction': 'Two rules at the same authority disagree',
  'authority-override': 'A lower authority tries to loosen a higher one',
  'tightening': 'A lower authority makes things stricter (fine)',
  'shadowed': 'A rule that can never change a decision',
  'duplicate': 'Two rules say the same thing',
  'limit_disagreement': 'Two limits on one thing disagree',
  'never_vs_rule': 'A rule tries to allow what a never-rule forbids',
};

export function ConflictsBadge({ findings, open, onToggle }: { findings: Finding[]; open: boolean; onToggle: () => void }) {
  const conflicts = findings.filter(f => f.severity === 'conflict').length;
  return (
    <button class="btn" aria-expanded={open} aria-controls="conflicts" onClick={onToggle}>
      Rules at odds <span class={`count${conflicts === 0 ? ' zero' : ''}`} aria-label={`${findings.length} findings, ${conflicts} conflicts`}>{findings.length}</span>
    </button>
  );
}

export function ConflictsPanel({ findings, onPick }: { findings: Finding[]; onPick: (ids: string[]) => void }) {
  return (
    <section class="panel conflicts" id="conflicts" aria-label="Rules at odds">
      <header><h2>Rules at odds</h2><span class="muted small">what the conflict check found, before anyone acts on this rulebook</span></header>
      {findings.length === 0 && <div class="empty">None. Every rule can take effect, and no rule loosens a higher authority's.</div>}
      {findings.map((f, i) => (
        <button class={`finding ${f.severity}`} key={i} onClick={() => onPick(f.ruleIds)} title="Show these rules">
          <span class="sev">{f.severity}<br /><span class="muted" style="font-weight:500;text-transform:none">{f.certainty}</span></span>
          <span><b>{KIND_WORDS[f.kind]}.</b> <span class="rule-id">{f.ruleIds.join(' · ')}</span><div class="small" style="margin-top:3px"><Backticked text={f.message} /></div></span>
        </button>
      ))}
    </section>
  );
}
