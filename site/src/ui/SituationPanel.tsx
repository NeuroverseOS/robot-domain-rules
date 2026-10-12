import { useState } from 'preact/hooks';
import type { Rulebook, FactDef, DomainRequest } from '../../../src/index';
import { DAYS } from '../../../src/index';
import { type Situation, sliderRange, sampleValue, fromRequest } from '../lib/situation';
import type { ScenarioPreset } from '../lib/starting-points';

interface Props {
  situation: Situation;
  rulebook: Rulebook | null;
  presets: ScenarioPreset[];
  onChange: (next: Situation) => void;
}

export function SituationPanel({ situation, rulebook, presets, onChange }: Props) {
  const s = situation;
  const kinds = rulebook?.kinds ?? ['robot', 'person'];
  const roles = (rulebook?.roles ?? []).filter(r => r.kind === s.participant.kind);
  const role = rulebook?.roles.find(r => r.id === s.participant.roleId);
  const actions = (rulebook?.actions ?? []).filter(a => a.kinds.includes(s.participant.kind));
  const knownAction = actions.some(a => a.id === s.action);
  const [customAction, setCustomAction] = useState(!knownAction && s.action !== '');
  const set = (patch: Partial<Situation>) => onChange({ ...s, ...patch });
  const setFact = (id: string, value: unknown) => set({ facts: { ...s.facts, [id]: value } });
  const dropFact = (id: string) => { const { [id]: _, ...rest } = s.facts; set({ facts: rest }); };
  const facts = rulebook?.facts ?? [];
  const emergency = facts.find(f => f.id === 'emergency' && f.type === 'boolean');
  const otherFacts = facts.filter(f => f !== emergency);

  return (
    <section class="panel" aria-labelledby="h-situation">
      <header><h2 id="h-situation"><span class="step">2</span> Situation</h2></header>

      {presets.length > 0 && (
        <>
          <h3>Scenarios</h3>
          <label class="field"><span class="sr-only">Pick a scenario</span>
            <select value="" onChange={e => { const i = Number((e.target as HTMLSelectElement).value); if (!Number.isNaN(i) && presets[i]) applyPreset(presets[i].request); (e.target as HTMLSelectElement).value = ''; }}>
              <option value="">Set the situation in one click…</option>
              {presets.map((p, i) => <option key={i} value={i}>{p.label}</option>)}
            </select>
          </label>
        </>
      )}

      <h3>Who is asking</h3>
      <div class="row">
        <label class="field"><span>Kind</span>
          <select value={s.participant.kind} onChange={e => { const kind = (e.target as HTMLSelectElement).value; const first = rulebook?.roles.find(r => r.kind === kind); set({ participant: { ...s.participant, kind, roleId: first?.id ?? '' }, action: first?.actions[0] ?? s.action }); }}>
            {kinds.map(k => <option key={k}>{k}</option>)}
          </select>
        </label>
        <label class="field"><span>Role</span>
          <select value={s.participant.roleId} onChange={e => { const roleId = (e.target as HTMLSelectElement).value; const r = rulebook?.roles.find(x => x.id === roleId); set({ participant: { ...s.participant, roleId }, action: r && !r.actions.includes(s.action) && !customAction ? r.actions[0] ?? s.action : s.action }); }}>
            {roles.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
            {roles.length === 0 && <option value="">no roles of this kind</option>}
          </select>
        </label>
        <label class="field"><span>ID</span><input type="text" value={s.participant.id} onInput={e => set({ participant: { ...s.participant, id: (e.target as HTMLInputElement).value } })} /></label>
      </div>

      <h3>Wants to</h3>
      <div class="row">
        <label class="field"><span>Action {role && !customAction && s.action && !role.actions.includes(s.action) ? <em>(not in this role's list)</em> : null}</span>
          {customAction ? (
            <input type="text" value={s.action} onInput={e => set({ action: (e.target as HTMLInputElement).value })} placeholder="an action nobody declared" />
          ) : (
            <select value={s.action} onChange={e => set({ action: (e.target as HTMLSelectElement).value })}>
              {actions.map(a => <option key={a.id} value={a.id}>{a.name ?? a.id}{role && !role.actions.includes(a.id) ? ' (not in role)' : ''}</option>)}
            </select>
          )}
        </label>
        <label class="switch" style="align-self:end;margin-bottom:8px"><input type="checkbox" checked={customAction} onChange={e => { const on = (e.target as HTMLInputElement).checked; setCustomAction(on); if (!on) set({ action: role?.actions[0] ?? actions[0]?.id ?? '' }); }} /> <span class="small">something undeclared</span></label>
      </div>
      <label class="field"><span>In area</span>
        <select value={s.areaId} onChange={e => set({ areaId: (e.target as HTMLSelectElement).value })}>
          {(rulebook?.areas ?? []).map(a => <option key={a.id} value={a.id}>{a.name}{a.tags?.length ? ` (${a.tags.join(', ')})` : ''}</option>)}
        </select>
      </label>

      <h3>Facts the spatial system reports</h3>
      {emergency && (
        <label class="switch danger" style="margin-bottom:10px">
          <input type="checkbox" checked={s.facts.emergency === true} onChange={e => setFact('emergency', (e.target as HTMLInputElement).checked)} />
          <b>Emergency</b> <span class="muted small">(absent means {JSON.stringify(emergency.default ?? false)})</span>
        </label>
      )}
      {otherFacts.length === 0 && <div class="empty">This rulebook declares no facts.</div>}
      {otherFacts.map(f => <FactControl key={f.id} def={f} value={s.facts[f.id]} onSet={v => setFact(f.id, v)} onDrop={() => dropFact(f.id)} />)}

      <h3>Approval</h3>
      <div class="row">
        <label class="switch"><input type="checkbox" checked={s.approval !== null} onChange={e => set({ approval: (e.target as HTMLInputElement).checked ? { id: 'manager-dana', holds: 'authority', value: rulebook?.authorities[0]?.id ?? '' } : null })} /> <span>A person approved this</span></label>
      </div>
      {s.approval && (
        <div class="row" style="margin-top:6px">
          <label class="field"><span>Approved by (ID)</span><input type="text" value={s.approval.id} onInput={e => set({ approval: { ...s.approval!, id: (e.target as HTMLInputElement).value } })} /></label>
          <label class="field"><span>Holding</span>
            <select value={`${s.approval.holds}:${s.approval.value}`} onChange={e => { const [holds, ...rest] = (e.target as HTMLSelectElement).value.split(':'); set({ approval: { ...s.approval!, holds: holds as 'authority' | 'role' | 'none', value: rest.join(':') } }); }}>
              <option value="none:">nothing in particular</option>
              <optgroup label="an authority">{(rulebook?.authorities ?? []).map(a => <option key={a.id} value={`authority:${a.id}`}>{a.name ?? a.id}</option>)}</optgroup>
              <optgroup label="a role">{(rulebook?.roles ?? []).map(r => <option key={r.id} value={`role:${r.id}`}>{r.name}</option>)}</optgroup>
            </select>
          </label>
        </div>
      )}
    </section>
  );

  function applyPreset(request: DomainRequest) {
    const next = fromRequest(request);
    setCustomAction(!(rulebook?.actions ?? []).some(a => a.id === next.action));
    onChange(next);
  }
}

function FactControl({ def, value, onSet, onDrop }: { def: FactDef; value: unknown; onSet: (v: unknown) => void; onDrop: () => void }) {
  const present = value !== undefined;
  const optional = !def.required;
  const label = (
    <span>{def.id} <span class="muted">· {def.type}{def.required ? ', required' : def.default !== undefined ? `, absent means ${JSON.stringify(def.default)}` : ', optional'}</span>
      {optional && <> · <label class="switch" style="display:inline-flex;vertical-align:middle"><input type="checkbox" checked={present} onChange={e => (e.target as HTMLInputElement).checked ? onSet(sampleValue(def)) : onDrop()} /> <span class="small">{present ? 'in the request' : 'left out'}</span></label></>}
    </span>
  );
  if (optional && !present) return <div class="field">{label}</div>;
  const v = value ?? sampleValue(def);
  switch (def.type) {
    case 'number': {
      const r = sliderRange(def);
      const n = typeof v === 'number' ? v : Number(v) || 0;
      return (
        <div class="field">{label}
          <div class="range">
            <input type="range" min={r.min} max={r.max} step={r.step} value={n} aria-label={def.id} onInput={e => onSet(Number((e.target as HTMLInputElement).value))} />
            <input type="number" min={def.min} max={def.max} step={r.step} value={n} aria-label={`${def.id} value`} onInput={e => { const x = (e.target as HTMLInputElement).value; onSet(x === '' ? '' : Number(x)); }} />
          </div>
        </div>
      );
    }
    case 'boolean':
      return <div class="field">{label}<label class="switch"><input type="checkbox" checked={v === true} onChange={e => onSet((e.target as HTMLInputElement).checked)} /> <span class="small">{v === true ? 'true' : 'false'}</span></label></div>;
    case 'time':
      return <label class="field">{label}<input type="time" value={String(v)} onInput={e => onSet((e.target as HTMLInputElement).value)} /></label>;
    case 'day':
      return <label class="field">{label}<select value={String(v)} onChange={e => onSet((e.target as HTMLSelectElement).value)}>{DAYS.map(d => <option key={d} value={d}>{d}</option>)}</select></label>;
    case 'enum':
      return <label class="field">{label}<select value={String(v)} onChange={e => onSet((e.target as HTMLSelectElement).value)}>{(def.values ?? []).map(x => <option key={x} value={x}>{x}</option>)}</select></label>;
    default:
      return <label class="field">{label}<input type="text" value={String(v)} onInput={e => onSet((e.target as HTMLInputElement).value)} /></label>;
  }
}
