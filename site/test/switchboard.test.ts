import { describe, it, expect } from 'vitest';
import { evaluateDomainAction } from '../../src/index';
import { STARTING_POINTS, freshState } from '../src/lib/starting-points';
import { compileState, findingsOf, answerQuestion, draftFromText, confirmDraft, toggleRule, inputFromRulebook } from '../src/lib/model';
import { toRequest, fromRequest, defaultSituation, reconcile } from '../src/lib/situation';
import { encodeState, decodeState, hashPayload } from '../src/lib/url-state';
import { importRulebook, rulebookJson, codeSnippet } from '../src/lib/share';

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
