import { useMemo, useState } from 'preact/hooks';
import type { Rulebook, DomainDecision, DomainRequest, Finding } from '../../../src/index';
import { STATUS_WORD, authorityName, authorityRank } from '../lib/model';
import { ungovernedOutcome, type Situation } from '../lib/situation';
import { rulebookJson, rulebookText, fileStem, codeSnippet, importRulebook, type ImportResult } from '../lib/share';
import { AuthorityBadge, Backticked } from './rule-line';

interface Props {
  rulebook: Rulebook | null;
  situation: Situation;
  request: DomainRequest;
  decision: DomainDecision | null;
  findings: Finding[];
  onHighlight: (ids: string[]) => void;
  onImport: (result: ImportResult) => void;
}

export function DecisionPanel({ rulebook, situation, request, decision, findings, onHighlight, onImport }: Props) {
  const authorities = rulebook?.authorities ?? [];
  const word = decision ? STATUS_WORD[decision.status] : null;
  const limitDefs = rulebook?.limits ?? [];

  const chain = useMemo(() => {
    if (!decision || !rulebook) return [];
    const winners = new Set(decision.reasons.map(r => r.ruleId));
    return decision.trace
      .map(t => ({ ...t, rank: t.setBy === 'builtin' ? -1 : authorityRank(authorities, t.setBy), won: winners.has(t.ruleId) }))
      .sort((a, b) => (a.rank === -1 ? -1 : b.rank === -1 ? 1 : a.rank - b.rank));
  }, [decision, rulebook]);

  const relatedFindings = useMemo(() => {
    if (!decision) return [];
    const ids = new Set(decision.trace.map(t => t.ruleId));
    return findings.filter(f => f.ruleIds.some(id => ids.has(id)));
  }, [decision, findings]);

  return (
    <section class="panel" aria-labelledby="h-decision">
      <header><h2 id="h-decision"><span class="step">3</span> Decision</h2>{decision && <span class="muted small">strictest answer wins</span>}</header>

      <div class="compare">
        <div class="ungoverned">
          <div class="label">Without rules</div>
          <p><b>The action simply happens.</b></p>
          <p class="small muted">{ungovernedOutcome(situation, rulebook)}</p>
        </div>
        <div>
          <div class="label">With this rulebook</div>
          {decision && word ? (
            <>
              <p><b class={`mini ${decision.status}`}>{word.word}</b> — {word.sentence}</p>
              <p class="small muted">{decision.reasons.length} reason{decision.reasons.length === 1 ? '' : 's'}, {decision.trace.length} check{decision.trace.length === 1 ? '' : 's'} ran, every one with the authority behind it.</p>
            </>
          ) : <p class="muted">No rulebook compiles yet.</p>}
        </div>
      </div>

      {decision && word && (
        <>
          <div class={`status ${decision.status}`} role="status" aria-live="polite">
            <span class="word">{word.word}</span>
            <span>
              <div>{word.sentence}</div>
              <div class="code">{decision.status}{decision.then ? ` · then: ${decision.then}` : ''}</div>
            </span>
          </div>

          {decision.limits && (
            <div class="limits">
              {Object.entries(decision.limits).map(([id, v]) => {
                const def = limitDefs.find(l => l.id === id);
                return <div class="limit" key={id}><div class="small muted">{def?.name ?? id}</div><b>{v}</b> {def?.unit ?? ''}</div>;
              })}
            </div>
          )}

          <h3>Why</h3>
          <div>
            {decision.reasons.map((r, i) => (
              <div class="reason" key={i}>
                <span class={`st mini ${r.status}`}>{r.status}</span>
                <span>
                  <div>{r.reason}</div>
                  <div class="small" style="margin-top:2px"><button class="btn small quiet" onClick={() => onHighlight([r.ruleId])} title="Show this rule in the rulebook"><span class="rule-id">{r.ruleId}</span></button> <AuthorityBadge id={r.setBy} authorities={authorities} /></div>
                </span>
              </div>
            ))}
          </div>

          <h3>Authority chain</h3>
          <p class="small muted">{authorities.map(a => a.name ?? a.id).join(' > ')}. A lower authority can only tighten what a higher one set.</p>
          <ol class="chain">
            {chain.map((c, i) => (
              <li key={i}>
                <span class="rank">{c.rank === -1 ? '·' : c.rank + 1}</span>
                <span class={c.won ? 'won' : 'lost'}>
                  <AuthorityBadge id={c.setBy} authorities={authorities} /> <span class="rule-id">{c.ruleId}</span>
                  <div class="small" style="font-weight:400">{c.reason}</div>
                </span>
                <span class={`st mini ${c.status}`} style="font-family:var(--mono);font-size:11.5px;font-weight:700">{c.status}{c.won ? ' ✓' : ''}</span>
              </li>
            ))}
          </ol>
          {relatedFindings.length > 0 && (
            <div class="notice">
              {relatedFindings.map((f, i) => (
                <div key={i} class="small"><b>{f.kind}</b> ({f.certainty}): <Backticked text={f.message} /> <button class="btn small quiet" onClick={() => onHighlight(f.ruleIds)}>show rules</button></div>
              ))}
            </div>
          )}

          <details class="quiet">
            <summary>Full trace ({decision.trace.length} checks, in the order they ran)</summary>
            <div class="trace">
              {decision.trace.map((t, i) => <div key={i}><span class={`mini ${t.status}`}>{t.status}</span><span>{t.ruleId} <span class="muted">({authorityName(authorities, t.setBy)})</span> — {t.reason}</span></div>)}
            </div>
          </details>
          <p class="fp" style="margin-top:8px">Rulebook fingerprint {decision.fingerprint}</p>
        </>
      )}

      <h3>Take it with you</h3>
      <Share rulebook={rulebook} request={request} onImport={onImport} />
    </section>
  );
}

function Share({ rulebook, request, onImport }: { rulebook: Rulebook | null; request: DomainRequest; onImport: (r: ImportResult) => void }) {
  const [message, setMessage] = useState<ImportResult | null>(null);
  const [copied, setCopied] = useState(false);
  const download = (name: string, text: string, type: string) => {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = document.createElement('a');
    a.href = url; a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const onFile = async (e: Event) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    const result = importRulebook(await file.text());
    setMessage(result);
    if (result.ok) onImport(result);
    (e.target as HTMLInputElement).value = '';
  };
  const snippet = rulebook ? codeSnippet(rulebook, request) : '';
  const copy = async () => {
    try { await navigator.clipboard.writeText(snippet); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard not available; the text is selectable */ }
  };
  return (
    <div class="share">
      <div class="row">
        <button class="btn" disabled={!rulebook} onClick={() => rulebook && download(`${fileStem(rulebook)}.rules.json`, rulebookJson(rulebook), 'application/json')}>Download rulebook JSON</button>
        <button class="btn" disabled={!rulebook} onClick={() => rulebook && download(`${fileStem(rulebook)}.rules.md`, rulebookText(rulebook), 'text/markdown')}>Download readable rulebook</button>
        <label class="btn">Import rulebook JSON<input type="file" accept="application/json,.json" class="sr-only" onChange={onFile} /></label>
      </div>
      {message && <div class={`notice ${message.ok ? 'ok' : 'bad'}`} role="status">{message.message}</div>}
      <details class="quiet">
        <summary>The code to ask this rulebook about this situation</summary>
        <div class="row" style="margin:6px 0"><button class="btn small" onClick={copy} disabled={!rulebook}>{copied ? 'Copied' : 'Copy'}</button></div>
        <pre class="code">{snippet || 'No rulebook compiles yet.'}</pre>
      </details>
    </div>
  );
}
