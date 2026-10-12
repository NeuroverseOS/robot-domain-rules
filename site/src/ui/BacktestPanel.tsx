import { useState } from 'preact/hooks';
import type { BacktestComparison, BacktestEvent, BacktestReport, Rulebook } from '../../../src/index';
import { parseEventLog, SUMMARY, shortAt } from '../lib/backtest';
import { AuthorityBadge } from './rule-line';

interface Props {
  rulebook: Rulebook | null;
  events: BacktestEvent[] | null;
  /** Where the events came from, in words. */
  source: string;
  report: BacktestReport | null;
  /** The snapshot the proposed change is compared against. */
  baseline: Rulebook | null;
  comparison: BacktestComparison | null;
  onLoadSample: () => void;
  onImport: (events: BacktestEvent[], source: string) => void;
  onSnapshot: () => void;
  onDropBaseline: () => void;
  onHighlight: (ids: string[]) => void;
}

const ROWS_SHOWN = 400;

/** Columns 2–3 in Test mode: load a recorded log, read what the rulebook would have decided, compare with a proposed change. */
export function BacktestPanel({ rulebook, events, source, report, baseline, comparison, onLoadSample, onImport, onSnapshot, onDropBaseline, onHighlight }: Props) {
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const authorities = rulebook?.authorities ?? [];
  const areaName = (id: string) => rulebook?.areas.find(a => a.id === id)?.name ?? id;
  const Rule = ({ id }: { id: string }) => <button class="btn small quiet" onClick={() => onHighlight([id])} title="Show this rule"><span class="rule-id">{id}</span></button>;
  const Examples = ({ xs }: { xs: string[] }) => <span class="muted small">e.g. {xs.map(shortAt).join(', ')}</span>;

  const onFile = async (e: Event) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    const parsed = parseEventLog(await file.text());
    if (parsed.error) setNote({ ok: false, text: parsed.error });
    else {
      setNote({ ok: true, text: `Read ${parsed.events.length} events from ${file.name}${parsed.skipped ? ` (${parsed.skipped} item${parsed.skipped === 1 ? '' : 's'} without "at" and "request" skipped)` : ''}.` });
      onImport(parsed.events, file.name);
    }
    input.value = '';
  };

  return (
    <section class="panel wide" aria-labelledby="h-backtest">
      <header><h2 id="h-backtest"><span class="step">2</span> Test against recorded activity</h2><span class="muted small">before the rules go live</span></header>
      <p class="small">Replays your recorded events through these rules. It shows what the rules would have decided — not why things happened. Nothing leaves the page; the log is not kept in the link.</p>
      <div class="row">
        <button class="btn" onClick={onLoadSample} title="A synthetic week at the sample grocery site: illustrative data, not from a real store. Loading it also loads that site's rulebook.">Load the sample week</button>
        <label class="btn">Import a log (JSON or JSONL)<input type="file" accept="application/json,.json,.jsonl,.ndjson,text/plain" class="sr-only" onChange={onFile} /></label>
        {events && <span class="muted small">{events.length} events · {source}</span>}
      </div>
      {note && <div class={`notice ${note.ok ? 'ok' : 'bad'}`} role="status">{note.text}</div>}
      {!events && (
        <div class="notice small">
          A log is a JSON array (or one JSON object per line) of <code>{'{ "at": "2026-10-05T08:10", "request": { … }, "outcome"?: "happened" | "did_not_happen" | "unknown" }'}</code>, in time order. <code>request</code> is exactly what <code>evaluateDomainAction</code> receives; <code>outcome</code>, if you have it, is what the record says happened next — it is only ever reported, never used to decide.
        </div>
      )}
      {events && !rulebook && <p class="muted">No rulebook compiles yet.</p>}
      {events && report && (
        <>
          <div class="summary" role="status" aria-live="polite">
            {SUMMARY.map(s => <div class={`tile ${s.className}`} key={s.key}><b>{report.totals[s.key]}</b><span>{s.word}</span></div>)}
          </div>
          <p class="fp">{report.events} events · rulebook fingerprint {report.fingerprint}{baseline ? ` · baseline ${baseline.fingerprint}` : ''}</p>

          <div class="notice">
            {!baseline ? (
              <div class="row">
                <button class="btn" onClick={onSnapshot} title="Keep these rules as the baseline, then change a rule and see what would change">Compare with a proposed change</button>
                <span class="small muted">Snapshots the rulebook as it stands; then edit or add a rule in the rulebook panel and read what changes here.</span>
              </div>
            ) : (
              <>
                <div class="row"><b class="small">Proposed change vs baseline {baseline.fingerprint}</b><button class="btn small quiet" onClick={onDropBaseline}>Drop the baseline</button></div>
                {comparison && comparison.baseline === comparison.proposed && <p class="small muted" style="margin:6px 0 0">The rulebook is unchanged so far. Edit or add a rule in the rulebook panel.</p>}
                {comparison && comparison.baseline !== comparison.proposed && (
                  <div class="small" style="margin-top:6px">
                    <div><b>{comparison.changed}</b> of {comparison.events} decisions change: <span class="mini ALLOW">{comparison.newlyAllowed.length} newly allowed</span>, <span class="mini BLOCK">{comparison.newlyBlocked.length} newly blocked</span>, {comparison.otherChanges.length} other.</div>
                    <div class="muted">Baseline: {SUMMARY.map(s => `${comparison.totals.baseline[s.key]} ${s.word.toLowerCase()}`).join(', ')} · Proposed: {SUMMARY.map(s => `${comparison.totals.proposed[s.key]} ${s.word.toLowerCase()}`).join(', ')}</div>
                    {[...comparison.newlyAllowed, ...comparison.newlyBlocked, ...comparison.otherChanges].sort((x, y) => x.index - y.index).slice(0, 12).map(x => (
                      <div key={x.index}><span class="mono">{shortAt(x.at)}</span> <span class={`mini ${x.from}`}>{x.from}</span> → <span class={`mini ${x.to}`}>{x.to}</span> <span class="muted">was {x.before.join(', ')}; now {x.after.join(', ')}</span></div>
                    ))}
                    {comparison.changed > 12 && <div class="muted">… and {comparison.changed - 12} more</div>}
                    {comparison.byRule.some(r => r.change !== 0) && <div style="margin-top:4px">By rule: {comparison.byRule.filter(r => r.change !== 0).map(r => <span key={r.ruleId}><Rule id={r.ruleId} /> {r.baseline} → {r.proposed} </span>)}</div>}
                  </div>
                )}
              </>
            )}
          </div>

          <h3>Rules that never fired</h3>
          {report.neverFired.length === 0 ? <div class="empty">Every rule matched at least one recorded request.</div>
            : <p class="small">{report.neverFired.map(id => <span key={id}><Rule id={id} /> </span>)}<span class="muted">matched nothing in this log. That may be fine; it is worth knowing.</span></p>}

          <h3>Rules that would have stalled work</h3>
          {report.wouldStall.length === 0 && <div class="empty">Nothing would have waited or been refused.</div>}
          {report.wouldStall.map(s => (
            <div class="reason" key={`${s.ruleId}:${s.status}`}>
              <span class={`st mini ${s.status}`}>{s.count}× {s.status}</span>
              <span><Rule id={s.ruleId} /> <AuthorityBadge id={s.setBy} authorities={authorities} /> <Examples xs={s.examples} /></span>
            </div>
          ))}

          <h3>Conflicts that actually occurred</h3>
          <p class="small muted" style="margin-top:0">Findings from "Rules at odds" whose two rules both matched a recorded request.</p>
          {report.conflictsOccurred.length === 0 && <div class="empty">None of the rulebook's findings occurred in this log.</div>}
          {report.conflictsOccurred.map(c => (
            <div class="reason" key={c.ruleIds.join('+')}>
              <span class="st mini">{c.count}×</span>
              <span><b>{c.kind}</b> <span class="muted small">({c.severity})</span> <button class="btn small quiet" onClick={() => onHighlight(c.ruleIds)}><span class="rule-id">{c.ruleIds.join(' · ')}</span></button> <span class="muted small">first {shortAt(c.firstAt)}</span></span>
            </div>
          ))}

          <h3>Gaps</h3>
          {report.gaps.length === 0 ? <div class="empty">Every recorded action is one the rulebook knows.</div>
            : report.gaps.map(g => <div class="reason" key={g.action}><span class="st mini BLOCK">{g.count}×</span><span><code>{g.action}</code> — no rule covers this action <Examples xs={g.examples} /></span></div>)}

          <h3>Missing facts</h3>
          {report.missingFacts.length === 0 ? <div class="empty">The log carried every fact the rules needed.</div>
            : report.missingFacts.map(m => <div class="reason" key={m.fact}><span class="st mini missing">{m.count}×</span><span><code>{m.fact}</code> — absent or invalid, so those requests could not be decided <Examples xs={m.examples} /></span></div>)}

          <h3>The rule and the record differ</h3>
          <p class="small muted" style="margin-top:0">Where the record says it happened but the rule would have refused or made it wait, or the record says it did not happen but the rule would have allowed it. Neither is judged right.</p>
          {report.differences.length === 0 && <div class="empty">{events.some(e => e.outcome && e.outcome !== 'unknown') ? 'The rules and the record agree on every event with a recorded outcome.' : 'This log records no outcomes, so there is nothing to compare the rules with.'}</div>}
          {report.differences.slice(0, 12).map(d => (
            <div class="reason" key={d.index}>
              <span class={`st mini ${d.status}`}>{d.status}</span>
              <span><span class="mono">{shortAt(d.at)}</span> rule says {d.status} ({d.ruleIds.map(id => <span key={id}><Rule id={id} /> </span>)}); record says {d.outcome.replace(/_/g, ' ')}</span>
            </div>
          ))}
          {report.differences.length > 12 && <div class="small muted">… and {report.differences.length - 12} more (see every row below).</div>}

          <details class="quiet" style="margin-top:12px">
            <summary>Every recorded request and what the rules would have decided ({report.rows.length})</summary>
            <table class="plan-table">
              <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Area</th><th>Verdict</th><th>Decided by</th><th>Record</th></tr></thead>
              <tbody>
                {report.rows.slice(0, ROWS_SHOWN).map(r => (
                  <tr key={r.index}>
                    <td class="mono">{shortAt(r.at)}</td><td>{r.participantId} <span class="muted small">{r.roleId}</span></td><td>{r.action}</td><td>{areaName(r.areaId)}</td>
                    <td><span class={`mini ${r.status}`}>{r.missingFacts ? 'MISSING' : r.status}</span></td><td class="small">{r.ruleIds.join(', ')}</td><td class="small muted">{r.outcome ? r.outcome.replace(/_/g, ' ') : ''}</td>
                  </tr>
                ))}
                {report.rows.length > ROWS_SHOWN && <tr class="muted"><td colSpan={7} class="small">{report.rows.length - ROWS_SHOWN} more rows not shown.</td></tr>}
              </tbody>
            </table>
          </details>
        </>
      )}
    </section>
  );
}
