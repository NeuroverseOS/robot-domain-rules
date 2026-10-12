import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { evaluateDomainAction, evaluatePlan, type Rulebook, type Witness } from '../../src/index';
import { type RulebookState, type StartingPointId, compileState, findingsOf, inputFromRulebook } from './lib/model';
import { STARTING_POINTS, freshState, startingPoint } from './lib/starting-points';
import { type Situation, toRequest, defaultSituation, reconcile, fromRequest } from './lib/situation';
import { encodeState, decodeState, hashPayload, STORAGE_KEY, type SharedState } from './lib/url-state';
import type { ImportResult } from './lib/share';
import { RulebookPanel } from './ui/RulebookPanel';
import { SituationPanel } from './ui/SituationPanel';
import { DecisionPanel } from './ui/DecisionPanel';
import { ConflictsBadge, ConflictsPanel } from './ui/ConflictsPanel';
import { PlanPanel } from './ui/PlanPanel';
import { PlanResultPanel } from './ui/PlanResultPanel';
import { type PlanState, toPlan, defaultPlanState, reconcilePlan, planPresets, fromPlan } from './lib/plan';

const GITHUB = 'https://github.com/NeuroverseOS/robot-domain-rules';
const NPM = 'https://www.npmjs.com/package/@neuroverseos/robot-domain-rules';

/** First visit: the grocery store, and the shopper's photo at the entrance (the manager said yes, the company said staff only). */
function firstVisit(): SharedState {
  const rulebook = freshState('grocery');
  const preset = startingPoint('grocery').presets.find(p => p.label.includes('glasses take a photo'));
  const compiled = compileState(rulebook).rulebook!;
  return { v: 1, rulebook, situation: preset ? fromRequest(preset.request) : defaultSituation(compiled) };
}

export function App({ initial }: { initial: SharedState }) {
  const [rb, setRb] = useState<RulebookState>(initial.rulebook);
  const [situation, setSituation] = useState<Situation>(initial.situation);
  const [readOnly, setReadOnly] = useState<Rulebook | null>(null);
  const [highlight, setHighlight] = useState<string[]>([]);
  const [conflictsOpen, setConflictsOpen] = useState(false);
  const [shareNote, setShareNote] = useState('');
  const [mode, setMode] = useState<'ask' | 'plan'>(initial.mode ?? 'ask');
  const [plan, setPlan] = useState<PlanState | null>(initial.plan ?? null);
  const [selectedStep, setSelectedStep] = useState(0);

  const compiled = useMemo(() => readOnly ? { rulebook: readOnly, error: null } : compileState(rb), [rb, readOnly]);
  const findings = useMemo(() => readOnly ? readOnly.findings : findingsOf(rb), [rb, readOnly]);
  const request = useMemo(() => toRequest(situation), [situation]);
  const decision = useMemo(() => compiled.rulebook ? evaluateDomainAction(compiled.rulebook, request) : null, [compiled, request]);
  const presets = startingPoint(rb.startingPoint).presets;
  const planState = useMemo(() => plan ?? (compiled.rulebook ? firstPlan(rb.startingPoint, compiled.rulebook) : null), [plan, compiled, rb.startingPoint]);
  const planInput = useMemo(() => planState ? toPlan(planState) : null, [planState]);
  const planResult = useMemo(() => compiled.rulebook && planInput ? evaluatePlan(compiled.rulebook, planInput) : null, [compiled, planInput]);

  // Keep the situation valid when the rulebook changes shape.
  const lastFingerprint = useRef<string | null>(null);
  useEffect(() => {
    if (!compiled.rulebook) return;
    if (lastFingerprint.current && lastFingerprint.current !== compiled.rulebook.fingerprint) {
      setSituation(s => reconcile(s, compiled.rulebook!));
      setPlan(p => (p ? reconcilePlan(p, compiled.rulebook!) : p));
    }
    lastFingerprint.current = compiled.rulebook.fingerprint;
  }, [compiled]);

  // Persist: localStorage and the URL hash (debounced).
  useEffect(() => {
    const t = setTimeout(async () => {
      const shared: SharedState = { v: 1, rulebook: rb, situation, mode, ...(plan ? { plan } : {}) };
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(shared)); } catch { /* storage may be unavailable */ }
      try { history.replaceState(null, '', `#s=${await encodeState(shared)}`); } catch { /* ignore */ }
    }, 300);
    return () => clearTimeout(t);
  }, [rb, situation, mode, plan]);

  // Scroll a highlighted rule into view.
  useEffect(() => {
    if (!highlight.length) return;
    const el = document.querySelector(`[data-rule-id="${CSS.escape(highlight[0])}"]`);
    el?.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }, [highlight]);

  const onStart = (id: StartingPointId) => {
    const next = freshState(id);
    setReadOnly(null);
    setRb(next);
    const compiledNext = compileState(next).rulebook;
    const first = startingPoint(id).presets[0];
    setSituation(first ? fromRequest(first.request) : compiledNext ? defaultSituation(compiledNext) : situation);
    setPlan(compiledNext ? firstPlan(id, compiledNext) : null);
    setSelectedStep(0);
    setHighlight([]);
  };

  /** A finding's witness becomes the situation, in Ask mode. */
  const tryWitness = (w: Witness) => {
    setMode('ask');
    setSituation(fromRequest({ participant: w.participant, action: w.action, areaId: w.areaId, facts: { ...w.facts } }));
    setConflictsOpen(false);
  };

  const onImport = (result: ImportResult) => {
    if (!result.ok || !result.rulebook) return;
    if (result.editable) {
      setReadOnly(null);
      setRb({ startingPoint: 'empty', input: inputFromRulebook(result.rulebook), disabledRuleIds: [], actingAs: result.rulebook.authorities[result.rulebook.authorities.length - 1]?.id ?? 'site' });
    } else {
      setReadOnly(result.rulebook);
    }
    setSituation(s => reconcile(s, result.rulebook!));
    setPlan(p => (p ? reconcilePlan(p, result.rulebook!) : p));
  };

  const share = async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      setShareNote('Link copied');
    } catch {
      setShareNote('Copy the address bar to share');
    }
    setTimeout(() => setShareNote(''), 1800);
  };

  return (
    <div class="app">
      <header class="topbar">
        <h1>robot-domain-rules <span class="muted" style="font-weight:400">· the switchboard</span></h1>
        <span class="idea">AI and robots propose. The space's own rules decide — with a reason, and the authority behind it.</span>
        <nav aria-label="Links">
          <span class="seg" role="group" aria-label="Mode">
            <button class={`btn${mode === 'ask' ? ' on' : ''}`} aria-pressed={mode === 'ask'} onClick={() => setMode('ask')} title="One action: may I?">Ask</button>
            <button class={`btn${mode === 'plan' ? ' on' : ''}`} aria-pressed={mode === 'plan'} onClick={() => setMode('plan')} title="A whole plan, step by step on projected facts">Plan</button>
          </span>
          <ConflictsBadge findings={findings} open={conflictsOpen} onToggle={() => setConflictsOpen(o => !o)} />
          <button class="btn" onClick={share} title="Everything on this page is in the link">{shareNote || 'Share link'}</button>
          <a class="btn" href={`${GITHUB}/blob/main/PRINCIPLES.md`} target="_blank" rel="noopener" title="The nine principles, each enforced by conformance tests">Principles</a>
          <a class="btn" href={`${GITHUB}/blob/main/SPEC.md`} target="_blank" rel="noopener" title="The normative spec: formats, the decision algorithm, conflict analysis, signed approvals">Spec</a>
          <a class="btn" href={GITHUB} target="_blank" rel="noopener">GitHub</a>
          <a class="btn" href={NPM} target="_blank" rel="noopener">npm</a>
        </nav>
      </header>
      <div>
        {conflictsOpen && <div style="padding:14px 0 0"><ConflictsPanel findings={findings} onPick={ids => { setHighlight(ids); }} onTry={tryWitness} /></div>}
      </div>
      <main class="columns">
        <RulebookPanel state={rb} rulebook={compiled.rulebook} error={compiled.error} highlight={highlight} readOnly={readOnly !== null} onChange={next => { setReadOnly(null); setRb(next); }} onStart={onStart} onHighlight={setHighlight} />
        {mode === 'ask' ? (
          <>
            <SituationPanel situation={situation} rulebook={compiled.rulebook} presets={presets} onChange={setSituation} />
            <DecisionPanel rulebook={compiled.rulebook} situation={situation} request={request} decision={decision} findings={findings} onHighlight={setHighlight} onImport={onImport} />
          </>
        ) : planState && planInput ? (
          <>
            <PlanPanel plan={planState} rulebook={compiled.rulebook} presets={planPresets(rb.startingPoint)} selected={selectedStep} onChange={next => { setPlan(next); }} onSelect={setSelectedStep} />
            <PlanResultPanel rulebook={compiled.rulebook} plan={planInput} result={planResult} selected={selectedStep} onSelect={setSelectedStep} onHighlight={setHighlight} />
          </>
        ) : <section class="panel"><p class="muted">No rulebook compiles yet.</p></section>}
      </main>
      <footer class="foot">
        <span>Built on NeuroVerse governance thinking · MIT</span>
        <span>Runs entirely in your browser: no server, no AI calls, no tracking. The rulebook and situation live in the link and in this browser.</span>
      </footer>
    </div>
  );
}

/** The first plan for a starting point: its first preset, else a one-step default. */
function firstPlan(id: StartingPointId, rulebook: Rulebook): PlanState {
  const preset = planPresets(id)[0];
  return preset ? fromPlan(preset.plan) : defaultPlanState(rulebook);
}

/** Where the page starts: the link, else what this browser saved, else the first visit. */
export async function initialState(): Promise<SharedState> {
  const payload = hashPayload(location.hash);
  if (payload) {
    const fromUrl = await decodeState(payload);
    if (fromUrl && STARTING_POINTS.some(s => s.id === fromUrl.rulebook.startingPoint)) return fromUrl;
  }
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved) as SharedState;
      if (parsed?.v === 1 && parsed.rulebook?.input?.site && parsed.situation?.participant) return parsed;
    }
  } catch { /* fall through */ }
  return firstVisit();
}
