import { useState } from 'preact/hooks';
import { compileDomain, type Rulebook, type RuleDraft, type FactType } from '../../../src/index';
import {
  effectiveInput, type RulebookState, type StartingPointId, questionsOf, authoritiesOf, answerQuestion, draftFromText, confirmDraft,
  removeRule, toggleRule, isOperatorRule, setActingAs, setAuthorities, setOtherwise, setHours, upsertDeclared, removeDeclared,
} from '../lib/model';
import { STARTING_POINTS } from '../lib/starting-points';
import { RuleLine, AuthorityBadge, sourceLabel } from './rule-line';

interface Props {
  state: RulebookState;
  rulebook: Rulebook | null;
  error: string | null;
  highlight: string[];
  readOnly: boolean;
  onChange: (next: RulebookState) => void;
  onStart: (id: StartingPointId) => void;
  onHighlight: (ids: string[]) => void;
}

export function RulebookPanel({ state, rulebook, error, highlight, readOnly, onChange, onStart, onHighlight }: Props) {
  const authorities = authoritiesOf(state);
  const questions = questionsOf(state);
  const never = rulebook?.rules.filter(r => r.never) ?? [];
  const rules = rulebook?.rules.filter(r => !r.never) ?? [];
  const disabled = (state.input.rules ?? []).filter(r => state.disabledRuleIds.includes(r.id));

  return (
    <section class="panel" aria-labelledby="h-rulebook">
      <header><h2 id="h-rulebook"><span class="step">1</span> Rulebook</h2><span class="muted small">{rulebook ? `${rulebook.rules.length} rules` : ''}</span></header>

      <h3>Start from</h3>
      <div class="tabs" role="group" aria-label="Starting point">
        {STARTING_POINTS.map(sp => (
          <button key={sp.id} class="btn" aria-pressed={state.startingPoint === sp.id} title={sp.blurb} onClick={() => onStart(sp.id)}>{sp.name}</button>
        ))}
      </div>
      <p class="muted small">{STARTING_POINTS.find(s => s.id === state.startingPoint)?.blurb}</p>

      {readOnly && <div class="notice">This rulebook was imported with a template this switchboard does not ship, so it is read-only. Pick a starting point to edit again.</div>}
      {error && <div class="notice bad" role="alert">The rulebook does not compile: {error}</div>}

      <h3>Site</h3>
      <div class="row">
        <label class="field"><span>Name</span><input type="text" value={state.input.site.name} disabled={readOnly} onChange={e => onChange({ ...state, input: { ...state.input, site: { ...state.input.site, name: (e.target as HTMLInputElement).value } } })} /></label>
        <label class="field"><span>Opens</span><input type="time" value={state.input.site.hours?.open ?? ''} disabled={readOnly} onChange={e => onChange(setHours(state, { open: (e.target as HTMLInputElement).value || '00:00', close: state.input.site.hours?.close ?? '00:00' }))} /></label>
        <label class="field"><span>Closes</span><input type="time" value={state.input.site.hours?.close ?? ''} disabled={readOnly} onChange={e => onChange(setHours(state, { open: state.input.site.hours?.open ?? '00:00', close: (e.target as HTMLInputElement).value || '00:00' }))} /></label>
      </div>

      <h3>Authorities, highest first</h3>
      <ol class="chips" style="list-style:none;padding:0;margin:0 0 6px;counter-reset:a">
        {authorities.map((a, i) => <li key={a.id} class="chip"><b>{i + 1}.</b> {a.name ?? a.id} <span class="rule-id">{a.id}</span></li>)}
      </ol>
      {!readOnly && (
        <details class="quiet"><summary>Change the order or the names</summary>
          <AuthorityEditor state={state} onChange={onChange} />
        </details>
      )}

      {questions.length > 0 && (
        <>
          <h3>Questions (each answer makes rules)</h3>
          {questions.map(q => (
            <div class="question" key={q.id}>
              <div class="q"><span>{q.prompt}</span><AuthorityBadge id={q.setBy} authorities={authorities} /></div>
              <select value={q.current} disabled={readOnly} aria-label={q.prompt} onChange={e => onChange(answerQuestion(state, q.id, (e.target as HTMLSelectElement).value))}>
                {q.options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
          ))}
        </>
      )}

      <h3>Write a rule in plain words</h3>
      {!readOnly && <Drafter state={state} onChange={onChange} />}

      <h3>Declared things</h3>
      <Declared state={state} rulebook={rulebook} readOnly={readOnly} onChange={onChange} />

      <h3>Never (nothing overrides these)</h3>
      {rulebook && never.length === 0 && <div class="empty">No never-rules.</div>}
      {rulebook && never.map(r => <RuleRow key={r.id} rule={r} rulebook={rulebook} state={state} highlight={highlight} readOnly={readOnly} onChange={onChange} onHighlight={onHighlight} />)}

      <h3>Rules</h3>
      {rulebook && rules.length === 0 && <div class="empty">No rules yet. Answer a question or write one above.</div>}
      {rulebook && rules.map(r => <RuleRow key={r.id} rule={r} rulebook={rulebook} state={state} highlight={highlight} readOnly={readOnly} onChange={onChange} onHighlight={onHighlight} />)}
      {disabled.map(r => (
        <div class="rule off" key={r.id} data-rule-id={r.id}>
          <span class="line">{r.text}</span>
          <span class="tools">
            <button class="btn small" onClick={() => onChange(toggleRule(state, r.id))}>Switch on</button>
            <button class="btn small quiet" onClick={() => onChange(removeRule(state, r.id))} aria-label={`Delete rule ${r.id}`}>Delete</button>
          </span>
          <span class="meta"><span class="rule-id">{r.id}</span> switched off</span>
        </div>
      ))}

      {rulebook && (
        <>
          <h3>Always checked</h3>
          <ul class="small muted" style="margin:0;padding-left:18px">
            {rulebook.builtin.map(b => <li key={b.id}><span class="rule-id">{b.id}</span> — {b.text}</li>)}
          </ul>
          <p class="small muted" style="margin-top:8px">An action the rulebook does not know: {rulebook.otherwise === 'deny' ? 'no' : 'wait for approval'}.{' '}
            {!readOnly && !state.input.template && (
              <button class="btn small quiet" onClick={() => onChange(setOtherwise(state, rulebook.otherwise === 'deny' ? 'wait-for-approval' : 'deny'))}>Change</button>
            )}
          </p>
        </>
      )}
    </section>
  );
}

function RuleRow({ rule, rulebook, state, highlight, readOnly, onChange, onHighlight }: {
  rule: Rulebook['rules'][number]; rulebook: Rulebook; state: RulebookState; highlight: string[]; readOnly: boolean;
  onChange: (s: RulebookState) => void; onHighlight: (ids: string[]) => void;
}) {
  const authorities = authoritiesOf(state);
  const mine = !readOnly && isOperatorRule(state, rule.id);
  return (
    <div class={`rule${highlight.includes(rule.id) ? ' highlight' : ''}`} data-rule-id={rule.id} onClick={() => onHighlight([rule.id])}>
      <RuleLine rule={rule} rulebook={rulebook} />
      <span class="tools">
        {mine && <button class="btn small" title="Switch this rule off (it stays in the list)" onClick={e => { e.stopPropagation(); onChange(toggleRule(state, rule.id)); }}>Off</button>}
        {mine && <button class="btn small quiet" title="Delete this rule" aria-label={`Delete rule ${rule.id}`} onClick={e => { e.stopPropagation(); onChange(removeRule(state, rule.id)); }}>×</button>}
      </span>
      <span class="meta"><AuthorityBadge id={rule.setBy} authorities={authorities} /><span class="rule-id">{rule.id}</span><span>{rule.text}</span><span class="muted">({sourceLabel(rule)})</span></span>
    </div>
  );
}

function Drafter({ state, onChange }: { state: RulebookState; onChange: (s: RulebookState) => void }) {
  const [text, setText] = useState('');
  const [id, setId] = useState('');
  const [draft, setDraft] = useState<RuleDraft | { error: string } | null>(null);
  const authorities = authoritiesOf(state);
  const run = () => { if (text.trim()) setDraft(draftFromText(state, text.trim(), id.trim() || undefined)); };
  return (
    <div>
      <label class="field"><span>Try: "robots slow to 0.3 m/s in checkout", "no robots in the back room on Sundays", "shoppers may not record audio in aisle 3 between 12:00 and 13:00"</span>
        <textarea value={text} onInput={e => setText((e.target as HTMLTextAreaElement).value)} onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) run(); }} placeholder="Write the rule in your own words" />
      </label>
      <div class="row">
        <label class="field"><span>Acting as</span>
          <select value={state.actingAs} onChange={e => onChange(setActingAs(state, (e.target as HTMLSelectElement).value))}>
            {authorities.map(a => <option key={a.id} value={a.id}>{a.name ?? a.id}</option>)}
          </select>
        </label>
        <label class="field"><span>Rule ID (optional)</span><input type="text" value={id} onInput={e => setId((e.target as HTMLInputElement).value)} placeholder="from the text" /></label>
        <button class="btn primary" onClick={run} disabled={!text.trim()}>Draft</button>
      </div>
      {draft && 'error' in draft && <div class="notice bad">{draft.error}</div>}
      {draft && !('error' in draft) && (
        <div class="draft" aria-live="polite">
          {draft.draft ? (
            <>
              <div><span class="rule-id">{draft.draft.id}</span> · <AuthorityBadge id={state.actingAs} authorities={authorities} /></div>
              <div style="margin:4px 0"><DraftLine state={state} draft={draft} /></div>
              <div class="small muted">Confidence <span class="conf" aria-hidden="true"><i style={`width:${Math.round(draft.confidence * 100)}%`} /></span> {Math.round(draft.confidence * 100)}%
                {draft.unmatched.length > 0 && <> · could not place: <b>{draft.unmatched.join(' ')}</b></>}</div>
              {draft.notes.map((n, i) => <div class="small muted" key={i}>note: {n}</div>)}
              <div class="row" style="margin-top:6px">
                <button class="btn primary" onClick={() => { onChange(confirmDraft(state, draft)); setDraft(null); setText(''); setId(''); }}>Confirm as {authorities.find(a => a.id === state.actingAs)?.name ?? state.actingAs}</button>
                <button class="btn" onClick={() => setDraft(null)}>Discard</button>
              </div>
            </>
          ) : (
            <>
              <div class="notice bad">No rule could be made from that.</div>
              {draft.notes.map((n, i) => <div class="small muted" key={i}>note: {n}</div>)}
              {draft.unmatched.length > 0 && <div class="small muted">Could not place: {draft.unmatched.join(' ')}</div>}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function DraftLine({ state, draft }: { state: RulebookState; draft: RuleDraft }) {
  // Render the draft against a vocabulary-only rulebook so names resolve.
  const vocabOnly = (() => { try { return compileVocab(state); } catch { return null; } })();
  if (!vocabOnly || !draft.draft) return <span>{draft.draft?.text}</span>;
  return <RuleLine rule={draft.draft} rulebook={vocabOnly} />;
}

function compileVocab(state: RulebookState): Rulebook { return compileDomain({ ...effectiveInput(state), rules: [] }); }

function AuthorityEditor({ state, onChange }: { state: RulebookState; onChange: (s: RulebookState) => void }) {
  const list = authoritiesOf(state);
  const [text, setText] = useState(list.map(a => a.name && a.name !== a.id ? `${a.id}: ${a.name}` : a.id).join('\n'));
  const apply = () => {
    const next = text.split('\n').map(l => l.trim()).filter(Boolean).map(l => {
      const [id, ...rest] = l.split(':');
      return { id: id.trim(), name: rest.join(':').trim() || undefined };
    });
    if (next.length) onChange(setAuthorities(state, next));
  };
  return (
    <div>
      <label class="field"><span>One per line, highest first, as <code>id: Name</code>. Rules set by an authority you remove will stop the rulebook compiling until you put it back.</span>
        <textarea value={text} onInput={e => setText((e.target as HTMLTextAreaElement).value)} rows={4} />
      </label>
      <button class="btn" onClick={apply}>Apply</button>
    </div>
  );
}

function Declared({ state, rulebook, readOnly, onChange }: { state: RulebookState; rulebook: Rulebook | null; readOnly: boolean; onChange: (s: RulebookState) => void }) {
  const canRemove = (key: 'areas' | 'roles' | 'actions' | 'facts', id: string) => !readOnly && ((state.input[key] ?? []) as Array<{ id: string }>).some(x => x.id === id);
  const kinds = rulebook?.kinds ?? state.input.kinds ?? ['robot', 'person'];
  return (
    <div>
      <details open>
        <summary>Areas ({rulebook?.areas.length ?? 0})</summary>
        <div class="chips">
          {rulebook?.areas.map(a => (
            <span class="chip" key={a.id} title={a.id}>{a.name}{a.tags?.length ? <span class="muted"> · {a.tags.join(', ')}</span> : null}
              {a.allowRoles && <span class="muted"> · only {a.allowRoles.join(', ')}</span>}{a.denyRoles && <span class="muted"> · never {a.denyRoles.join(', ')}</span>}
              {canRemove('areas', a.id) && <button class="x" aria-label={`Remove area ${a.name}`} onClick={() => onChange(removeDeclared(state, 'areas', a.id))}>×</button>}
            </span>
          ))}
        </div>
        {!readOnly && <AddArea state={state} onChange={onChange} />}
      </details>
      <details>
        <summary>Roles ({rulebook?.roles.length ?? 0})</summary>
        <div class="chips">
          {rulebook?.roles.map(r => (
            <span class="chip" key={r.id} title={`${r.id}: may ${r.actions.join(', ') || 'nothing'}`}>{r.name} <span class="muted">· {r.kind}{r.tags?.length ? ` · ${r.tags.join(', ')}` : ''}</span>
              {canRemove('roles', r.id) && <button class="x" aria-label={`Remove role ${r.name}`} onClick={() => onChange(removeDeclared(state, 'roles', r.id))}>×</button>}
            </span>
          ))}
        </div>
        {!readOnly && <AddRole state={state} rulebook={rulebook} kinds={kinds} onChange={onChange} />}
      </details>
      <details>
        <summary>Actions ({rulebook?.actions.length ?? 0})</summary>
        <div class="chips">
          {rulebook?.actions.map(a => (
            <span class="chip" key={a.id} title={a.id}>{a.name ?? a.id} <span class="muted">· {a.kinds.join(', ')}{a.tags?.length ? ` · ${a.tags.join(', ')}` : ''}</span>
              {canRemove('actions', a.id) && <button class="x" aria-label={`Remove action ${a.id}`} onClick={() => onChange(removeDeclared(state, 'actions', a.id))}>×</button>}
            </span>
          ))}
        </div>
        {!readOnly && <AddAction state={state} kinds={kinds} onChange={onChange} />}
      </details>
      <details>
        <summary>Facts every request brings ({rulebook?.facts.length ?? 0})</summary>
        <div class="chips">
          {rulebook?.facts.map(f => (
            <span class="chip" key={f.id} title={f.description ?? ''}>{f.id} <span class="muted">· {f.type}{f.required ? ' · required' : f.default !== undefined ? ` · absent = ${JSON.stringify(f.default)}` : ' · optional'}</span>
              {canRemove('facts', f.id) && <button class="x" aria-label={`Remove fact ${f.id}`} onClick={() => onChange(removeDeclared(state, 'facts', f.id))}>×</button>}
            </span>
          ))}
          <span class="chip">approvedBy <span class="muted">· built in</span></span>
        </div>
        {!readOnly && <AddFact state={state} onChange={onChange} />}
      </details>
      {rulebook && rulebook.limits.length > 0 && (
        <details>
          <summary>Limits ({rulebook.limits.length})</summary>
          <div class="chips">{rulebook.limits.map(l => <span class="chip" key={l.id}>{l.name ?? l.id} <span class="muted">· {l.id}{l.unit ? ` · ${l.unit}` : ''}</span></span>)}</div>
        </details>
      )}
    </div>
  );
}

const slug = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function AddArea({ state, onChange }: { state: RulebookState; onChange: (s: RulebookState) => void }) {
  const [name, setName] = useState('');
  const [tags, setTags] = useState('');
  const add = () => {
    if (!name.trim()) return;
    onChange(upsertDeclared(state, 'areas', { id: slug(name), name: name.trim(), tags: tags.split(',').map(t => t.trim()).filter(Boolean) }));
    setName(''); setTags('');
  };
  return (
    <div class="row" style="margin-top:6px">
      <label class="field"><span>New area</span><input type="text" value={name} onInput={e => setName((e.target as HTMLInputElement).value)} placeholder="Aisle 7" /></label>
      <label class="field"><span>Tags, comma-separated</span><input type="text" value={tags} onInput={e => setTags((e.target as HTMLInputElement).value)} placeholder="public" /></label>
      <button class="btn small" onClick={add} disabled={!name.trim()}>Add area</button>
    </div>
  );
}

function AddRole({ state, rulebook, kinds, onChange }: { state: RulebookState; rulebook: Rulebook | null; kinds: string[]; onChange: (s: RulebookState) => void }) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState(kinds[0] ?? 'robot');
  const [actions, setActions] = useState<string[]>([]);
  const [tags, setTags] = useState('');
  const available = (rulebook?.actions ?? []).filter(a => a.kinds.includes(kind));
  const add = () => {
    if (!name.trim()) return;
    onChange(upsertDeclared(state, 'roles', { id: slug(name).replace(/-/g, '_'), name: name.trim(), kind, actions, tags: tags.split(',').map(t => t.trim()).filter(Boolean) }));
    setName(''); setActions([]); setTags('');
  };
  return (
    <div style="margin-top:6px">
      <div class="row">
        <label class="field"><span>New role</span><input type="text" value={name} onInput={e => setName((e.target as HTMLInputElement).value)} placeholder="Delivery robot" /></label>
        <label class="field"><span>Kind</span><select value={kind} onChange={e => { setKind((e.target as HTMLSelectElement).value); setActions([]); }}>{kinds.map(k => <option key={k}>{k}</option>)}</select></label>
        <label class="field"><span>Tags</span><input type="text" value={tags} onInput={e => setTags((e.target as HTMLInputElement).value)} placeholder="staff" /></label>
      </div>
      <div class="chips" style="margin:4px 0">
        {available.map(a => (
          <label class="chip" key={a.id}><input type="checkbox" checked={actions.includes(a.id)} onChange={e => setActions((e.target as HTMLInputElement).checked ? [...actions, a.id] : actions.filter(x => x !== a.id))} /> {a.name ?? a.id}</label>
        ))}
        {available.length === 0 && <span class="muted small">No actions for this kind yet; add an action first.</span>}
      </div>
      <button class="btn small" onClick={add} disabled={!name.trim()}>Add role</button>
    </div>
  );
}

function AddAction({ state, kinds, onChange }: { state: RulebookState; kinds: string[]; onChange: (s: RulebookState) => void }) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState(kinds[0] ?? 'robot');
  const [tags, setTags] = useState('');
  const add = () => {
    if (!name.trim()) return;
    onChange(upsertDeclared(state, 'actions', { id: slug(name).replace(/-/g, '_'), name: name.trim(), kinds: [kind], tags: tags.split(',').map(t => t.trim()).filter(Boolean) }));
    setName(''); setTags('');
  };
  return (
    <div class="row" style="margin-top:6px">
      <label class="field"><span>New action</span><input type="text" value={name} onInput={e => setName((e.target as HTMLInputElement).value)} placeholder="deliver parcel" /></label>
      <label class="field"><span>For</span><select value={kind} onChange={e => setKind((e.target as HTMLSelectElement).value)}>{kinds.map(k => <option key={k}>{k}</option>)}</select></label>
      <label class="field"><span>Tags</span><input type="text" value={tags} onInput={e => setTags((e.target as HTMLInputElement).value)} placeholder="movement" /></label>
      <button class="btn small" onClick={add} disabled={!name.trim()}>Add action</button>
    </div>
  );
}

function AddFact({ state, onChange }: { state: RulebookState; onChange: (s: RulebookState) => void }) {
  const [id, setId] = useState('');
  const [type, setType] = useState<FactType>('number');
  const [required, setRequired] = useState(true);
  const [values, setValues] = useState('');
  const add = () => {
    if (!id.trim()) return;
    const def: Parameters<typeof upsertDeclared<'facts'>>[2] = { id: id.trim(), type, required };
    if (type === 'number') { def.min = 0; }
    if (type === 'enum') { def.values = values.split(',').map(v => v.trim()).filter(Boolean); }
    if (!required) { def.default = type === 'number' ? 0 : type === 'boolean' ? false : type === 'time' ? '00:00' : type === 'day' ? 'mon' : type === 'enum' ? def.values?.[0] ?? '' : ''; }
    onChange(upsertDeclared(state, 'facts', def));
    setId(''); setValues('');
  };
  return (
    <div class="row" style="margin-top:6px">
      <label class="field"><span>New fact</span><input type="text" value={id} onInput={e => setId((e.target as HTMLInputElement).value)} placeholder="doorOpen" /></label>
      <label class="field"><span>Type</span><select value={type} onChange={e => setType((e.target as HTMLSelectElement).value as FactType)}>{(['number', 'boolean', 'time', 'day', 'enum', 'string'] as FactType[]).map(t => <option key={t}>{t}</option>)}</select></label>
      {type === 'enum' && <label class="field"><span>Values</span><input type="text" value={values} onInput={e => setValues((e.target as HTMLInputElement).value)} placeholder="open, quiet" /></label>}
      <label class="switch"><input type="checkbox" checked={required} onChange={e => setRequired((e.target as HTMLInputElement).checked)} /> <span class="small">required (else it gets a default)</span></label>
      <button class="btn small" onClick={add} disabled={!id.trim()}>Add fact</button>
    </div>
  );
}
