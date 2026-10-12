import type { Rulebook } from '../../../src/index';
import { type PlanState, type PlanStepState, type PlanPreset, fromPlan, parseFacts } from '../lib/plan';
import { FactControl } from './SituationPanel';

interface Props {
  plan: PlanState;
  rulebook: Rulebook | null;
  presets: PlanPreset[];
  /** The step the result panel is showing, to mark it here. */
  selected: number;
  onChange: (next: PlanState) => void;
  onSelect: (index: number) => void;
}

/** Column 2 in Plan mode: who, the facts before the first step, the clock, and the steps in order. */
export function PlanPanel({ plan, rulebook, presets, selected, onChange, onSelect }: Props) {
  const p = plan;
  const kinds = rulebook?.kinds ?? ['robot', 'person'];
  const roles = (rulebook?.roles ?? []).filter(r => r.kind === p.participant.kind);
  const role = rulebook?.roles.find(r => r.id === p.participant.roleId);
  const actions = (rulebook?.actions ?? []).filter(a => a.kinds.includes(p.participant.kind));
  const timeFacts = (rulebook?.facts ?? []).filter(f => f.type === 'time');
  const set = (patch: Partial<PlanState>) => onChange({ ...p, ...patch });
  const setStep = (i: number, patch: Partial<PlanStepState>) => set({ steps: p.steps.map((s, j) => (j === i ? { ...s, ...patch } : s)) });
  const setFact = (id: string, value: unknown) => set({ initialFacts: { ...p.initialFacts, [id]: value } });
  const dropFact = (id: string) => { const { [id]: _, ...rest } = p.initialFacts; set({ initialFacts: rest }); };
  const addStep = () => set({ steps: [...p.steps, { action: role?.actions[0] ?? actions[0]?.id ?? '', area: '', facts: '', note: '' }] });
  const removeStep = (i: number) => set({ steps: p.steps.filter((_, j) => j !== i) });
  const move = (i: number, d: -1 | 1) => { const steps = [...p.steps]; const j = i + d; if (j < 0 || j >= steps.length) return; [steps[i], steps[j]] = [steps[j], steps[i]]; set({ steps }); };
  const effectsOf = (action: string) => (rulebook?.actions.find(a => a.id === action)?.effects ?? []).map(e => e.op === 'move' ? 'moves here' : e.op === 'set' ? `${e.fact} := ${JSON.stringify(e.value)}` : `${e.fact} ${e.op === 'add' ? '+' : '−'}= ${e.value}`).join(', ');

  return (
    <section class="panel" aria-labelledby="h-plan">
      <header><h2 id="h-plan"><span class="step">2</span> Plan</h2><span class="muted small">what an AI planner proposes</span></header>
      <p class="small muted" style="margin-top:0">A plan is one participant and steps in order. Each step is decided on the facts the earlier steps leave behind: the rulebook's actions declare their effects (what they set, add, subtract, or that they move the participant). A planner writes this; the rulebook checks it.</p>

      {presets.length > 0 && (
        <>
          <h3>Preset plans</h3>
          <label class="field"><span class="sr-only">Pick a plan</span>
            <select value="" onChange={e => { const i = Number((e.target as HTMLSelectElement).value); if (!Number.isNaN(i) && presets[i]) { onChange(fromPlan(presets[i].plan)); onSelect(0); } (e.target as HTMLSelectElement).value = ''; }}>
              <option value="">Load a plan in one click…</option>
              {presets.map((x, i) => <option key={i} value={i}>{x.label}</option>)}
            </select>
          </label>
        </>
      )}

      <h3>Who is planning to act</h3>
      <div class="row">
        <label class="field"><span>Kind</span>
          <select value={p.participant.kind} onChange={e => { const kind = (e.target as HTMLSelectElement).value; const first = rulebook?.roles.find(r => r.kind === kind); set({ participant: { ...p.participant, kind, roleId: first?.id ?? '' } }); }}>
            {kinds.map(k => <option key={k}>{k}</option>)}
          </select>
        </label>
        <label class="field"><span>Role</span>
          <select value={p.participant.roleId} onChange={e => set({ participant: { ...p.participant, roleId: (e.target as HTMLSelectElement).value } })}>
            {roles.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
            {roles.length === 0 && <option value="">no roles of this kind</option>}
          </select>
        </label>
        <label class="field"><span>ID</span><input type="text" value={p.participant.id} onInput={e => set({ participant: { ...p.participant, id: (e.target as HTMLInputElement).value } })} /></label>
      </div>

      <h3>Steps, in order</h3>
      <ol class="plan-steps">
        {p.steps.map((s, i) => {
          const factsBad = parseFacts(s.facts) === null;
          const effects = effectsOf(s.action);
          return (
            <li key={i} class={i === selected ? 'selected' : ''}>
              <div class="plan-step-head">
                <button class="btn small quiet" onClick={() => onSelect(i)} title="Show this step's decision"><b>{i + 1}</b></button>
                <label class="field"><span class="sr-only">Action</span>
                  <select value={s.action} onChange={e => setStep(i, { action: (e.target as HTMLSelectElement).value })}>
                    {actions.map(a => <option key={a.id} value={a.id}>{a.name ?? a.id}{role && !role.actions.includes(a.id) ? ' (not in role)' : ''}</option>)}
                    {!actions.some(a => a.id === s.action) && s.action && <option value={s.action}>{s.action} (undeclared)</option>}
                  </select>
                </label>
                <label class="field"><span class="sr-only">Area</span>
                  <select value={s.area} onChange={e => setStep(i, { area: (e.target as HTMLSelectElement).value })}>
                    {i > 0 && <option value="">where the last move left it</option>}
                    {(rulebook?.areas ?? []).map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </select>
                </label>
                <span class="plan-step-tools">
                  <button class="btn small quiet" onClick={() => move(i, -1)} disabled={i === 0} title="Move up" aria-label="Move step up">↑</button>
                  <button class="btn small quiet" onClick={() => move(i, 1)} disabled={i === p.steps.length - 1} title="Move down" aria-label="Move step down">↓</button>
                  <button class="btn small quiet" onClick={() => removeStep(i)} disabled={p.steps.length === 1} title="Remove step" aria-label="Remove step">×</button>
                </span>
              </div>
              <div class="row plan-step-more">
                <label class="field"><span>Note</span><input type="text" value={s.note} placeholder="why this step" onInput={e => setStep(i, { note: (e.target as HTMLInputElement).value })} /></label>
                <label class="field"><span>Facts at this step (JSON){factsBad ? <em> — not a JSON object; ignored</em> : null}</span><input type="text" value={s.facts} placeholder='{"peopleInZone": 2}' onInput={e => setStep(i, { facts: (e.target as HTMLInputElement).value })} /></label>
              </div>
              {effects && <div class="small muted">after this step: {effects}</div>}
            </li>
          );
        })}
      </ol>
      <div class="row"><button class="btn" onClick={addStep}>Add a step</button></div>

      <h3>Facts before the first step</h3>
      {(rulebook?.facts ?? []).length === 0 && <div class="empty">This rulebook declares no facts.</div>}
      {(rulebook?.facts ?? []).map(f => <FactControl key={f.id} def={f} value={p.initialFacts[f.id]} onSet={v => setFact(f.id, v)} onDrop={() => dropFact(f.id)} />)}

      <h3>The clock</h3>
      <p class="small muted" style="margin-top:0">The engine has no clock. If you name a time fact, it advances per step from the start time; otherwise every step sees the time you gave above.</p>
      <div class="row">
        <label class="field"><span>Time fact that advances</span>
          <select value={p.clock} onChange={e => set({ clock: (e.target as HTMLSelectElement).value })}>
            <option value="">none</option>
            {timeFacts.map(f => <option key={f.id} value={f.id}>{f.id}</option>)}
          </select>
        </label>
        <label class="field"><span>Starts at</span><input type="time" value={p.startTime} disabled={!p.clock} onInput={e => set({ startTime: (e.target as HTMLInputElement).value })} /></label>
        <label class="field"><span>Seconds per step</span><input type="number" min={0} step={10} value={p.stepDurationSeconds} disabled={!p.clock} onInput={e => set({ stepDurationSeconds: Number((e.target as HTMLInputElement).value) || 0 })} /></label>
      </div>
    </section>
  );
}
