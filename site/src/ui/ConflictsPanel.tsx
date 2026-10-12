import type { Finding, Witness } from '../../../src/index';
import { Backticked } from './rule-line';

/** The witness in one line: a real request that triggers both rules. */
export function describeWitness(w: Witness): string {
  const facts = Object.entries(w.facts).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ');
  return `${w.participant.roleId} does ${w.action} in ${w.areaId}${facts ? ` with ${facts}` : ''}`;
}

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

export function ConflictsPanel({ findings, onPick, onTry }: { findings: Finding[]; onPick: (ids: string[]) => void; onTry?: (w: Witness) => void }) {
  return (
    <section class="panel conflicts" id="conflicts" aria-label="Rules at odds">
      <header><h2>Rules at odds</h2><span class="muted small">what the conflict check found, before anyone acts on this rulebook. The analysis is exact: every certain finding comes with an example request that triggers both rules.</span></header>
      {findings.length === 0 && <div class="empty">None. Every rule can take effect, and no rule loosens a higher authority's.</div>}
      {findings.map((f, i) => (
        <div class={`finding ${f.severity}`} key={i}>
          <span class="sev">{f.severity}<br /><span class="muted" style="font-weight:500;text-transform:none">{f.certainty}</span></span>
          <span>
            <b>{KIND_WORDS[f.kind]}.</b> <button class="btn small quiet" onClick={() => onPick(f.ruleIds)} title="Show these rules"><span class="rule-id">{f.ruleIds.join(' · ')}</span></button>
            <div class="small" style="margin-top:3px"><Backticked text={f.message} /></div>
            {f.witness && (
              <div class="small witness" style="margin-top:4px">
                <b>Example request that triggers both:</b> <span class="mono">{describeWitness(f.witness)}</span>
                {onTry && <> <button class="btn small quiet" onClick={() => onTry(f.witness!)} title="Set the situation to this request">try it</button></>}
              </div>
            )}
          </span>
        </div>
      ))}
    </section>
  );
}
