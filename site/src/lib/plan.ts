/**
 * Plan mode: a whole plan an AI planner might propose, as editable state,
 * converted to the Plan that evaluatePlan receives. Pure; the core decides.
 * Preset plans per starting point include the planner replay's v1 and v2
 * (examples/harness/plans.jsonl), on the example's own area IDs.
 */

import type { Plan, PlanStep, Rulebook } from '../../../src/index';
import type { StartingPointId } from './model';
import { sampleValue } from './situation';

export interface PlanStepState {
  action: string;
  /** '' means "where the previous step left the participant". */
  area: string;
  /** Facts the planner expects at this step, as JSON text (an object); '' for none. */
  facts: string;
  note: string;
}

export interface PlanState {
  participant: { id: string; kind: string; roleId: string };
  initialFacts: Record<string, unknown>;
  steps: PlanStepState[];
  /** The time fact that advances, or '' for none. */
  clock: string;
  startTime: string;
  stepDurationSeconds: number;
}

export interface PlanPreset {
  label: string;
  plan: Plan;
}

/** The Plan the core receives. A step whose facts are not valid JSON gets no step facts (the editor shows the problem). */
export function toPlan(s: PlanState): Plan {
  const steps: PlanStep[] = s.steps.map(st => {
    const step: PlanStep = { action: st.action };
    if (st.area) step.area = st.area;
    const facts = parseFacts(st.facts);
    if (facts && Object.keys(facts).length) step.facts = facts;
    if (st.note) step.note = st.note;
    return step;
  });
  const plan: Plan = { participant: { ...s.participant }, initialFacts: { ...s.initialFacts }, steps };
  if (s.clock) { plan.clock = s.clock; if (s.startTime) plan.startTime = s.startTime; if (s.stepDurationSeconds > 0) plan.stepDurationSeconds = s.stepDurationSeconds; }
  return plan;
}

export function fromPlan(p: Plan): PlanState {
  return {
    participant: { ...p.participant },
    initialFacts: { ...p.initialFacts },
    steps: p.steps.map(st => ({ action: st.action, area: st.area ?? '', facts: st.facts ? JSON.stringify(st.facts) : '', note: st.note ?? '' })),
    clock: p.clock ?? '',
    startTime: p.startTime ?? '',
    stepDurationSeconds: p.stepDurationSeconds ?? 0,
  };
}

/** The step's facts as an object, or null when the text is not a JSON object. */
export function parseFacts(text: string): Record<string, unknown> | null {
  if (!text.trim()) return {};
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** A first plan for a rulebook: its first role does its first action in its first area, with every required fact at a safe value. */
export function defaultPlanState(rb: Rulebook): PlanState {
  const role = rb.roles[0];
  const initialFacts: Record<string, unknown> = {};
  for (const f of rb.facts) if (f.required) initialFacts[f.id] = sampleValue(f);
  const clock = rb.facts.find(f => f.type === 'time')?.id ?? '';
  return {
    participant: { id: role ? `${role.kind}-1` : 'robot-1', kind: role?.kind ?? 'robot', roleId: role?.id ?? '' },
    initialFacts,
    steps: [{ action: role?.actions[0] ?? '', area: rb.areas[0]?.id ?? '', facts: '', note: '' }],
    clock,
    startTime: clock ? String(initialFacts[clock] ?? '10:00') : '',
    stepDurationSeconds: 60,
  };
}

/** Keep a plan usable after the rulebook changed shape: unknown role or areas fall back, undeclared initial facts are dropped. */
export function reconcilePlan(s: PlanState, rb: Rulebook): PlanState {
  const declared = new Set(rb.facts.map(f => f.id));
  const initialFacts: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(s.initialFacts)) if (declared.has(k)) initialFacts[k] = v;
  for (const f of rb.facts) if (f.required && !(f.id in initialFacts)) initialFacts[f.id] = sampleValue(f);
  const role = rb.roles.find(r => r.id === s.participant.roleId) ?? rb.roles[0];
  const areaOk = (id: string) => id === '' || rb.areas.some(a => a.id === id);
  const steps = s.steps.map((st, i) => ({ ...st, area: areaOk(st.area) ? (i === 0 && !st.area ? rb.areas[0]?.id ?? '' : st.area) : rb.areas[0]?.id ?? '' }));
  return {
    ...s,
    participant: role ? { ...s.participant, kind: role.kind, roleId: role.id } : s.participant,
    initialFacts,
    steps: steps.length ? steps : defaultPlanState(rb).steps,
    clock: s.clock && declared.has(s.clock) ? s.clock : '',
  };
}

const robot = (id: string, roleId: string) => ({ id, kind: 'robot', roleId });

const PRESETS: Record<StartingPointId, PlanPreset[]> = {
  grocery: [
    {
      label: 'Planner v1: restock aisle 3, wait at the checkout (skips the scan, carries stock into the checkout, ends away from the dock)',
      plan: {
        participant: robot('r-2', 'restock_robot'), clock: 'localTime', startTime: '09:30', stepDurationSeconds: 120,
        initialFacts: { localTime: '09:30', day: 'mon', peopleInZone: 0, staffInZone: 0, emergency: false, requestedSpeedMps: 0.5 },
        steps: [
          { action: 'enter_zone', area: 'aisle-3', note: 'drive into aisle 3' },
          { action: 'manipulate', note: 'restock shelf 3B' },
          { action: 'enter_zone', area: 'checkout', note: 'go to the checkout with the leftovers' },
          { action: 'place', note: 'put the leftovers down at the till' },
        ],
      },
    },
    {
      label: 'Planner v2: scan first, restock, leftovers to the back room, fetch a part from the electrical room, dock (needs one approval)',
      plan: {
        participant: robot('r-2', 'restock_robot'), clock: 'localTime', startTime: '09:31', stepDurationSeconds: 120,
        initialFacts: { localTime: '09:31', day: 'mon', peopleInZone: 0, staffInZone: 0, emergency: false, requestedSpeedMps: 0.5 },
        steps: [
          { action: 'enter_zone', area: 'aisle-3', note: 'drive into aisle 3' },
          { action: 'scan', note: 'scan shelf 3B' },
          { action: 'manipulate', note: 'restock shelf 3B' },
          { action: 'enter_zone', area: 'back-room', facts: { staffInZone: 1 }, note: 'take the leftovers to the back room (a staff member is there)' },
          { action: 'place', note: 'put the leftovers on the stock shelf' },
          { action: 'enter_zone', area: 'electrical', note: 'fetch a part from the electrical room' },
          { action: 'dock', area: 'dock-a', note: 'return to the dock' },
        ],
      },
    },
    {
      label: 'Planner v2 with the manager\'s approval on the electrical room',
      plan: {
        participant: robot('r-2', 'restock_robot'), clock: 'localTime', startTime: '09:31', stepDurationSeconds: 120,
        initialFacts: { localTime: '09:31', day: 'mon', peopleInZone: 0, staffInZone: 0, emergency: false, requestedSpeedMps: 0.5 },
        steps: [
          { action: 'enter_zone', area: 'aisle-3', note: 'drive into aisle 3' },
          { action: 'scan', note: 'scan shelf 3B' },
          { action: 'manipulate', note: 'restock shelf 3B' },
          { action: 'enter_zone', area: 'back-room', facts: { staffInZone: 1 }, note: 'take the leftovers to the back room (a staff member is there)' },
          { action: 'place', note: 'put the leftovers on the stock shelf' },
          { action: 'enter_zone', area: 'electrical', facts: { approvedBy: { id: 'manager-dana', authority: 'site-manager' } }, note: 'fetch a part from the electrical room (Dana approved)' },
          { action: 'dock', area: 'dock-a', note: 'return to the dock' },
        ],
      },
    },
    {
      label: 'Inventory robot: scan three aisles while shoppers arrive, then dock',
      plan: {
        participant: robot('r-1', 'inventory_robot'), clock: 'localTime', startTime: '08:55', stepDurationSeconds: 180,
        initialFacts: { localTime: '08:55', day: 'sat', peopleInZone: 0, emergency: false, requestedSpeedMps: 0.8 },
        steps: [
          { action: 'enter_zone', area: 'aisle-3' },
          { action: 'scan' },
          { action: 'enter_zone', area: 'entrance', facts: { peopleInZone: 3 }, note: 'shoppers are arriving' },
          { action: 'scan', note: 'scan the entrance display while people are there' },
          { action: 'dock', area: 'dock-a' },
        ],
      },
    },
  ],
  warehouse: [
    {
      label: 'Forklift: into aisle A, lift, carry on to aisle B while a picker is there, dock',
      plan: {
        participant: robot('f-1', 'forklift_robot'), clock: 'localTime', startTime: '08:00', stepDurationSeconds: 90,
        initialFacts: { localTime: '08:00', peopleInArea: 0, robotsInArea: 0, emergency: false, requestedSpeedMps: 1.2 },
        steps: [
          { action: 'enter', area: 'aisle-a' },
          { action: 'lift' },
          { action: 'enter', area: 'aisle-b', facts: { peopleInArea: 1 }, note: 'a picker is in aisle B' },
          { action: 'dock', area: 'dock-1' },
        ],
      },
    },
    {
      label: 'Forklift: the office is off limits, then the alarm',
      plan: {
        participant: robot('f-1', 'forklift_robot'), clock: 'localTime', startTime: '10:00', stepDurationSeconds: 60,
        initialFacts: { localTime: '10:00', peopleInArea: 0, robotsInArea: 0, emergency: false, requestedSpeedMps: 1.0 },
        steps: [
          { action: 'enter', area: 'aisle-a' },
          { action: 'enter', area: 'office', note: 'a shortcut through the office' },
          { action: 'dock', area: 'dock-1', facts: { emergency: true } },
        ],
      },
    },
  ],
  clinic: [
    {
      label: 'Medication robot: Ward A delivery (pharmacist approval), Ward B while a patient is seen, back to the corridor',
      plan: {
        participant: robot('m-1', 'med_robot'), clock: 'localTime', startTime: '09:00', stepDurationSeconds: 300,
        initialFacts: { localTime: '09:00', patient_present: false, requestedSpeedMps: 0.4 },
        steps: [
          { action: 'enter', area: 'ward-a' },
          { action: 'deliver_meds', area: 'ward-a', facts: { approvedBy: { id: 'pharm-kim', roleId: 'pharmacist' } } },
          { action: 'enter', area: 'ward-b', facts: { patient_present: true }, note: 'a patient is being seen' },
          { action: 'move', area: 'corridor' },
        ],
      },
    },
    {
      label: 'Cleaning robot: through the wards at night (the clinic says no)',
      plan: {
        participant: robot('c-1', 'clean_robot'), clock: 'localTime', startTime: '23:50', stepDurationSeconds: 600,
        initialFacts: { localTime: '23:50', patient_present: false, requestedSpeedMps: 0.3 },
        steps: [
          { action: 'clean', area: 'corridor' },
          { action: 'move', area: 'ward-a' },
          { action: 'clean', area: 'ward-a' },
        ],
      },
    },
  ],
  empty: [],
};

export function planPresets(id: StartingPointId): PlanPreset[] {
  return PRESETS[id] ?? [];
}
