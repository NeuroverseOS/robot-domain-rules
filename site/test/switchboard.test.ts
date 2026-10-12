import { describe, it, expect } from 'vitest';
import { evaluateDomainAction } from '../../src/index';
import { STARTING_POINTS, freshState } from '../src/lib/starting-points';
import { compileState, findingsOf, answerQuestion, draftFromText, confirmDraft, toggleRule, inputFromRulebook } from '../src/lib/model';
import { toRequest, fromRequest, defaultSituation, reconcile } from '../src/lib/situation';
import { encodeState, decodeState, hashPayload } from '../src/lib/url-state';
import { importRulebook, rulebookJson, codeSnippet } from '../src/lib/share';
import { evaluatePlan, matchingRules } from '../../src/index';
import { planPresets, toPlan, fromPlan, defaultPlanState, reconcilePlan, parseFacts } from '../src/lib/plan';
import { describeWitness } from '../src/ui/ConflictsPanel';
import { backtest, compareBacktests } from '../../src/index';
import { parseEventLog, sampleWeek, shortAt } from '../src/lib/backtest';
import { sampleSite } from '../../examples/backtest/rulebook';

describe('starting points', () => {
  it('every starting point compiles, and the grocery seed shows the deliberate conflicts on first visit', () => {
    for (const sp of STARTING_POINTS) {
      const { rulebook, error } = compileState(freshState(sp.id));
      expect(error, sp.id).toBeNull();
      expect(rulebook, sp.id).not.toBeNull();
    }
    const kinds = findingsOf(freshState('grocery')).map(f => f.kind);
    expect(kinds).toContain('authority-override');
    expect(kinds).toContain('contradiction');
  });

  it('every scenario preset is a complete request its rulebook can decide, and the presets round-trip through the situation', () => {
    for (const sp of STARTING_POINTS) {
      const rb = compileState(freshState(sp.id)).rulebook!;
      for (const p of sp.presets) {
        const situation = fromRequest(p.request);
        const back = toRequest(situation);
        expect(back, `${sp.id}: ${p.label}`).toEqual(p.request);
        const d = evaluateDomainAction(rb, back);
        expect(['ALLOW', 'LIMIT', 'PAUSE', 'BLOCK']).toContain(d.status);
      }
    }
    const grocery = compileState(freshState('grocery')).rulebook!;
    const fire = STARTING_POINTS[0].presets.find(p => p.label.startsWith('Fire alarm: robot wants'))!;
    expect(evaluateDomainAction(grocery, fire.request).status).toBe('BLOCK');
    const approved = STARTING_POINTS[0].presets.find(p => p.label.startsWith('Manager approves'))!;
    expect(evaluateDomainAction(grocery, approved.request).status).toBe('ALLOW');
  });
});

describe('editing', () => {
  it('changing an answer regenerates its rules; a drafted rule is confirmed as the acting authority; toggling a rule changes the decision', () => {
    let state = freshState('grocery');
    const shoppers = STARTING_POINTS[0].presets.find(p => p.label === 'Shoppers arrive in aisle 3')!.request;
    expect(evaluateDomainAction(compileState(state).rulebook!, shoppers).limits).toEqual({ maxSpeedMps: 0.3 });
    state = answerQuestion(state, 'robots_near_people', 'stop');
    expect(evaluateDomainAction(compileState(state).rulebook!, shoppers).status).toBe('PAUSE');

    const draft = draftFromText(state, 'robots slow to 0.2 m/s in the entrance', 'entrance_crawl');
    expect('error' in draft).toBe(false);
    if ('error' in draft) return;
    expect(draft.draft?.where).toEqual(['entrance']);
    state = confirmDraft(state, draft);
    const rb = compileState(state).rulebook!;
    const rule = rb.rules.find(r => r.id === 'entrance_crawl')!;
    expect(rule.setBy).toBe('site-manager');
    const entrance = { participant: { id: 'r-1', kind: 'robot', roleId: 'inventory_robot' }, action: 'move', areaId: 'entrance', facts: { localTime: '09:00', day: 'mon', peopleInZone: 0, requestedSpeedMps: 1 } };
    expect(evaluateDomainAction(rb, entrance).limits).toEqual({ maxSpeedMps: 0.2 });
    state = toggleRule(state, 'entrance_crawl');
    expect(evaluateDomainAction(compileState(state).rulebook!, entrance).limits).toEqual({ maxSpeedMps: 1.0 });
  });

  it('a default situation reconciles to the rulebook after the rulebook changes', () => {
    const grocery = compileState(freshState('grocery')).rulebook!;
    const s = defaultSituation(grocery);
    expect(evaluateDomainAction(grocery, toRequest(s)).reasons.some(r => r.ruleId === 'required_facts')).toBe(false);
    const warehouse = compileState(freshState('warehouse')).rulebook!;
    const moved = reconcile(s, warehouse);
    expect(warehouse.roles.some(r => r.id === moved.participant.roleId)).toBe(true);
    expect(warehouse.areas.some(a => a.id === moved.areaId)).toBe(true);
    expect(Object.keys(moved.facts).every(k => warehouse.facts.some(f => f.id === k))).toBe(true);
  });
});

describe('sharing', () => {
  it('URL state encodes and decodes to the same state', async () => {
    const rulebook = freshState('warehouse');
    const situation = fromRequest(STARTING_POINTS[1].presets[2].request);
    const encoded = await encodeState({ v: 1, rulebook, situation });
    expect(encoded[0]).toBe('z');
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(hashPayload(`#s=${encoded}`)).toBe(encoded);
    const decoded = await decodeState(encoded);
    expect(decoded).toEqual({ v: 1, rulebook, situation });
    expect(await decodeState('zNOT-REALLY')).toBeNull();
  });

  it('export → import verifies the fingerprint and gives back an editable rulebook with the same fingerprint', () => {
    for (const sp of STARTING_POINTS) {
      const rb = compileState(freshState(sp.id)).rulebook!;
      const result = importRulebook(rulebookJson(rb));
      expect(result.ok, sp.id).toBe(true);
      expect(result.editable, sp.id).toBe(true);
      expect(compileState({ startingPoint: sp.id, input: inputFromRulebook(rb), disabledRuleIds: [], actingAs: sp.actingAs }).rulebook!.fingerprint).toBe(rb.fingerprint);
    }
    const rb = compileState(freshState('grocery')).rulebook!;
    const tampered = rulebookJson(rb).replace('"otherwise": "deny"', '"otherwise": "wait-for-approval"');
    expect(importRulebook(tampered).ok).toBe(false);
    expect(importRulebook('{').ok).toBe(false);
    expect(codeSnippet(rb, STARTING_POINTS[0].presets[0].request)).toContain('evaluateDomainAction(rulebook, {');
  });
});

describe('plan mode', () => {
  it('every preset plan round-trips through the editor state and is decided by its rulebook; the replay\'s v1 is rejected at the scan rule, v2 pauses for one approval, v2 approved passes', () => {
    for (const sp of STARTING_POINTS) {
      const rb = compileState(freshState(sp.id)).rulebook!;
      for (const p of planPresets(sp.id)) {
        expect(toPlan(fromPlan(p.plan)), `${sp.id}: ${p.label}`).toEqual(p.plan);
        const r = evaluatePlan(rb, toPlan(fromPlan(p.plan)));
        expect(['ALLOW', 'LIMIT', 'PAUSE', 'BLOCK']).toContain(r.status);
        expect(r.firstViolation?.ruleId, `${sp.id}: ${p.label} must not fail on a malformed plan`).not.toBe('required_facts');
      }
    }
    const grocery = compileState(freshState('grocery')).rulebook!;
    const [v1, v2, v2ok] = planPresets('grocery');
    const r1 = evaluatePlan(grocery, v1.plan);
    expect(r1.status).toBe('BLOCK');
    expect(r1.firstViolation).toMatchObject({ stepIndex: 1, ruleId: 'scan_before_restock', from: 'plan', setBy: 'site-manager' });
    expect(r1.steps.map(s => s.decision.status)).toEqual(['ALLOW', 'ALLOW', 'BLOCK']);
    expect(r1.steps[2].decision.reasons[0].ruleId).toBe('no_carrying_through_checkout');
    expect(r1.planChecks.map(c => `${c.ruleId}:${c.status}`)).toEqual(['scan_before_restock:BLOCK', 'end_at_dock:BLOCK']);
    const r2 = evaluatePlan(grocery, v2.plan);
    expect(r2.status).toBe('PAUSE');
    expect(r2.approvalRequests.map(a => a.ruleId)).toEqual(['robots_restricted_zones']);
    expect(r2.finalArea).toBe('dock-a');
    expect(evaluatePlan(grocery, v2ok.plan).status).toBe('ALLOW');
  });

  it('a default plan reconciles to another rulebook; step facts that are not a JSON object are ignored, not fatal', () => {
    const grocery = compileState(freshState('grocery')).rulebook!;
    const d = defaultPlanState(grocery);
    expect(evaluatePlan(grocery, toPlan(d)).firstViolation?.ruleId).not.toBe('required_facts');
    const warehouse = compileState(freshState('warehouse')).rulebook!;
    const moved = reconcilePlan(d, warehouse);
    expect(warehouse.roles.some(r => r.id === moved.participant.roleId)).toBe(true);
    expect(Object.keys(moved.initialFacts).every(k => warehouse.facts.some(f => f.id === k))).toBe(true);
    expect(parseFacts('{"a":1}')).toEqual({ a: 1 });
    expect(parseFacts('nope')).toBeNull();
    expect(parseFacts('')).toEqual({});
    expect(toPlan({ ...d, steps: [{ action: 'move', area: 'aisle-3', facts: 'nope', note: '' }] }).steps[0].facts).toBeUndefined();
  });

  it('URL state carries the mode and the plan, and older links without them still load', async () => {
    const rulebook = freshState('grocery');
    const situation = fromRequest(STARTING_POINTS[0].presets[0].request);
    const plan = fromPlan(planPresets('grocery')[0].plan);
    const encoded = await encodeState({ v: 1, rulebook, situation, mode: 'plan', plan });
    expect(await decodeState(encoded)).toEqual({ v: 1, rulebook, situation, mode: 'plan', plan });
    const old = await encodeState({ v: 1, rulebook, situation });
    expect((await decodeState(old))?.mode).toBeUndefined();
  });

  it('every finding on the grocery seed carries a witness that triggers both of its rules, in words the panel shows', () => {
    const state = freshState('grocery');
    const rb = compileState(state).rulebook!;
    const findings = findingsOf(state);
    expect(findings.length).toBeGreaterThan(0);
    for (const f of findings) {
      expect(f.certainty).toBe('certain');
      expect(f.witness).toBeDefined();
      expect(matchingRules(rb, f.witness!)).toEqual(expect.arrayContaining(f.ruleIds));
      expect(describeWitness(f.witness!)).toContain(` does ${f.witness!.action} in `);
    }
  });
});

describe('test against recorded activity', () => {
  it('the sample week loads with its own site, compiles, and the rule under test blocks aisle-5 entries the record says happened; raising the limit to three newly allows exactly those', () => {
    const sample = sampleWeek();
    const { rulebook, error } = compileState(sample.rulebook);
    expect(error).toBeNull();
    expect(rulebook!.fingerprint).toBe(sampleSite(2).rulebook.fingerprint);
    expect(rulebook!.rules.some(r => r.id === 'aisle5_robot_limit')).toBe(true);
    const report = backtest(rulebook!, sample.events);
    expect(report.events).toBe(sample.events.length);
    expect(report.totals.ALLOW + report.totals.LIMIT + report.totals.PAUSE + report.totals.BLOCK + report.totals.missingFacts).toBe(report.events);
    expect(report.wouldStall[0]).toMatchObject({ ruleId: 'aisle5_robot_limit', status: 'BLOCK', count: 11 });
    expect(report.missingFacts.map(m => m.fact)).toEqual(['robotsInZone', 'peopleInZone']);
    expect(report.gaps).toEqual([{ action: 'open_door', count: 4, examples: ['2026-10-05T17:00', '2026-10-07T17:00', '2026-10-09T17:00'] }]);
    expect(report.neverFired).toContain('back_room_evening_approval');
    expect(report.conflictsOccurred.map(c => c.kind)).toEqual(['tightening', 'authority-override', 'contradiction']);
    expect(report.differences.filter(d => d.ruleIds.includes('aisle5_robot_limit') && d.outcome === 'happened').length).toBe(11);
    const proposed = backtest(sampleSite(3).rulebook, sample.events);
    const c = compareBacktests(report, proposed);
    expect(c.newlyAllowed.length).toBe(7);
    expect(c.newlyBlocked.length).toBe(0);
    expect(c.newlyAllowed.every(x => x.before.includes('aisle5_robot_limit'))).toBe(true);
    expect(c.byRule[0]).toEqual({ ruleId: 'aisle5_robot_limit', baseline: 11, proposed: 4, change: -7 });
  });

  it('an imported log may be a JSON array, an object with events, or JSON Lines with a header line; items without at and request are skipped, order is kept, and junk is refused', () => {
    const [a, b] = sampleWeek().events;
    expect(parseEventLog(JSON.stringify([a, b])).events).toEqual([a, b]);
    expect(parseEventLog(JSON.stringify({ events: [b, a] })).events).toEqual([b, a]);
    const jsonl = [JSON.stringify({ note: 'header' }), JSON.stringify(a), '', JSON.stringify({ ...b, outcome: 'nope' })].join('\n');
    const parsed = parseEventLog(jsonl);
    expect(parsed.skipped).toBe(1);
    expect(parsed.events).toEqual([a, { at: b.at, request: b.request }]);
    expect(parseEventLog('{').error).toBeTruthy();
    expect(parseEventLog('').error).toBeTruthy();
    expect(parseEventLog('[{"x":1}]').error).toBeTruthy();
    expect(shortAt('2026-10-05T08:10')).toBe('10-05 08:10');
    expect(shortAt('day 3')).toBe('day 3');
  });
});
