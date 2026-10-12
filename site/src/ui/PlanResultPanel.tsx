import type { Rulebook, Plan, PlanEvaluation } from '../../../src/index';
import { STATUS_WORD, authorityName } from '../lib/model';
import { AuthorityBadge } from './rule-line';

interface Props {
  rulebook: Rulebook | null;
  plan: Plan;
  result: PlanEvaluation | null;
  selected: number;
  onSelect: (index: number) => void;
  onHighlight: (ids: string[]) => void;
}

const PLAN_WORD: Record<string, string> = {
  ALLOW: 'Every step passes.',
  LIMIT: 'Every step passes, some within limits.',
  PAUSE: 'The plan can run once the approvals below are signed and the waits clear.',
  BLOCK: 'The plan is rejected.',
};

/** Column 3 in Plan mode: the verdict, the first violation, every step on its projected facts, the plan rules, the approvals, the final facts. */
export function PlanResultPanel({ rulebook, plan, result, selected, onSelect, onHighlight }: Props) {
  const authorities = rulebook?.authorities ?? [];
  const r = result;
  const word = r ? STATUS_WORD[r.status] : null;
  const areaName = (id: string) => rulebook?.areas.find(a => a.id === id)?.name ?? id;
  const step = r?.steps[Math.min(selected, (r?.steps.length ?? 1) - 1)];
  const changed = (i: number): string[] => {
    if (!r) return [];
    const now = r.steps[i].facts, before = i === 0 ? plan.initialFacts : r.steps[i - 1].facts;
    return Object.keys(now).filter(k => k !== 'approvedBy' && JSON.stringify(now[k]) !== JSON.stringify(before[k])).map(k => `${k}=${JSON.stringify(now[k])}`);
  };

  return (
    <section class="panel" aria-labelledby="h-plan-result">
      <header><h2 id="h-plan-result"><span class="step">3</span> Verdict on the plan</h2>{r && <span class="muted small">strictest step or plan rule wins</span>}</header>
      {!r || !word ? <p class="muted">No rulebook compiles yet.</p> : (
        <>
          <div class={`status ${r.status}`} role="status" aria-live="polite">
            <span class="word">{word.word}</span>
            <span>
              <div>{PLAN_WORD[r.status]}</div>
              <div class="code">{r.status}{r.firstViolation ? ` · rejected at step ${r.firstViolation.stepIndex + 1}` : ''}</div>
            </span>
          </div>

          {r.firstViolation && (
            <div class="reason" style="margin-top:8px">
              <span class="st mini BLOCK">BLOCK</span>
              <span>
                <div><b>First violation, step {r.firstViolation.stepIndex + 1}</b> ({r.firstViolation.from === 'plan' ? 'a plan rule' : 'a rule on that step'}): {r.firstViolation.reason}</div>
                <div class="small" style="margin-top:2px"><button class="btn small quiet" onClick={() => onHighlight([r.firstViolation!.ruleId])} title="Show this rule"><span class="rule-id">{r.firstViolation.ruleId}</span></button> <AuthorityBadge id={r.firstViolation.setBy} authorities={authorities} /></div>
              </span>
            </div>
          )}

          <h3>Step by step</h3>
          <p class="small muted" style="margin-top:0">Each row is decided on the facts projected from the rows above. Nothing is projected past a refusal. Click a row for its full decision.</p>
          <table class="plan-table">
            <thead><tr><th>#</th><th>Time</th><th>Verdict</th><th>Action</th><th>Area</th><th>Changed facts</th><th>Decided by</th></tr></thead>
            <tbody>
              {r.steps.map(s => {
                const isFirst = r.firstViolation?.from === 'step' && r.firstViolation.stepIndex === s.index;
                return (
                  <tr key={s.index} class={`${s.index === selected ? 'selected' : ''} ${isFirst ? 'violation' : ''}`} onClick={() => onSelect(s.index)}>
                    <td>{s.index + 1}</td>
                    <td class="mono">{plan.clock ? String(s.facts[plan.clock] ?? '') : ''}</td>
                    <td><span class={`mini ${s.decision.status}`}>{s.decision.status}</span></td>
                    <td>{s.action}</td>
                    <td>{areaName(s.areaId)}</td>
                    <td class="mono small">{changed(s.index).join(' ') || '—'}</td>
                    <td class="small">{s.decision.reasons.map(x => x.ruleId).join(', ')}</td>
                  </tr>
                );
              })}
              {r.steps.length < plan.steps.length && (
                <tr class="muted"><td colSpan={7} class="small">{plan.steps.length - r.steps.length} later step{plan.steps.length - r.steps.length === 1 ? '' : 's'} not projected: the plan does not continue past a refusal.</td></tr>
              )}
            </tbody>
          </table>

          {step && (
            <div class="notice">
              <div class="small"><b>Step {step.index + 1}: {step.action} in {areaName(step.areaId)}</b>{plan.steps[step.index]?.note ? ` — ${plan.steps[step.index].note}` : ''}</div>
              {step.decision.reasons.map((x, i) => (
                <div class="reason" key={i}>
                  <span class={`st mini ${x.status}`}>{x.status}</span>
                  <span>
                    <div>{x.reason}</div>
                    <div class="small" style="margin-top:2px"><button class="btn small quiet" onClick={() => onHighlight([x.ruleId])} title="Show this rule"><span class="rule-id">{x.ruleId}</span></button> <AuthorityBadge id={x.setBy} authorities={authorities} /></div>
                  </span>
                </div>
              ))}
              {step.decision.limits && <div class="small">Limits: {Object.entries(step.decision.limits).map(([k, v]) => `${k} ${v}`).join(', ')}</div>}
              {step.decision.then && <div class="small">Then: {step.decision.then}</div>}
              <details class="quiet">
                <summary>The facts this step was decided on</summary>
                <pre class="code">{JSON.stringify(step.facts, null, 2)}</pre>
              </details>
              <details class="quiet">
                <summary>Full trace ({step.decision.trace.length} checks)</summary>
                <div class="trace">
                  {step.decision.trace.map((t, i) => <div key={i}><span class={`mini ${t.status}`}>{t.status}</span><span>{t.ruleId} <span class="muted">({authorityName(authorities, t.setBy)})</span> — {t.reason}</span></div>)}
                </div>
              </details>
            </div>
          )}

          <h3>Plan rules</h3>
          {r.planChecks.length === 0 && <div class="empty">This rulebook has no plan rules that bind this role.</div>}
          {r.planChecks.map((c, i) => (
            <div class="reason" key={i}>
              <span class={`st mini ${c.status}`}>{c.status}</span>
              <span>
                <div>{c.reason}{c.stepIndex !== undefined && c.status === 'BLOCK' ? ` (step ${c.stepIndex + 1})` : ''}</div>
                <div class="small" style="margin-top:2px"><button class="btn small quiet" onClick={() => onHighlight([c.ruleId])}><span class="rule-id">{c.ruleId}</span></button> <AuthorityBadge id={c.setBy} authorities={authorities} /></div>
              </span>
            </div>
          ))}

          {r.approvalRequests.length > 0 && (
            <div class="notice">
              <div class="small"><b>Approvals this plan needs before it can run.</b> One per step that waits for a person; each is bound to that step's request digest and this rulebook's fingerprint. A planner collects these up front, then re-sends the plan with the signed approvals on those steps.</div>
              <pre class="code" style="margin-top:6px">{JSON.stringify(r.approvalRequests, null, 2)}</pre>
            </div>
          )}

          <h3>Where it ends</h3>
          <p class="small">{r.status === 'BLOCK' ? `Stopped in ${areaName(r.finalArea)}.` : `In ${areaName(r.finalArea)}.`} Final facts:</p>
          <pre class="code">{JSON.stringify(r.finalFacts, null, 2)}</pre>
          <p class="fp">Plan digest {r.planDigest} · rulebook fingerprint {r.fingerprint}</p>
        </>
      )}
    </section>
  );
}
