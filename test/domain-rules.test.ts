import { describe, expect, it } from 'vitest';
import {
  buildRuleDraftPrompt,
  checkRulebook,
  compileDomain,
  DomainRulesBuilder,
  DomainRulesError,
  draftRuleFromText,
  evaluateDomainAction,
  glassesZoneRules,
  isOpen,
  parseRuleDraft,
  renderDomainRules,
  verifyFingerprint,
} from '../src/index';
import type { CompileDomainInput, DomainRequest, LegacyCompileInput, Rule, Rulebook } from '../src/index';
import type { ZoneRules } from '../src/zone-rules';
import { store } from '../examples/legacy-store-0.2';
import * as grocery from '../examples/grocery-store';
import * as clinicExample from '../examples/clinic';

/** @neuroverseos/governance/spatial ZONE_TEMPLATES.retail, copied so this repo has no dependency on it. */
const RETAIL_ZONE_RULES: ZoneRules = {
  camera: 'confirm_each', microphone: 'allowed', aiDataSend: 'allowed', aiActions: 'allowed', aiRecommendations: 'non_commercial',
  locationSharing: 'allowed', aiOverlay: 'allowed', dataRetention: 'allowed', commercialAI: 'blocked', bystanderProtection: 'elevated',
};

// The 0.2 example store, through the deprecated input shape. Every 0.2 test below runs against it.
const rules = compileDomain(store);

const robot = (roleId: string, action: string, zoneId: string, facts: Record<string, unknown> = {}): DomainRequest => ({
  participant: { id: 'r-1', kind: 'robot', roleId },
  action,
  zoneId,
  facts: { peopleInZone: 0, localTime: '10:00', ...facts },
});
const person = (roleId: string, action: string, zoneId: string, extra: Partial<DomainRequest> = {}): DomainRequest => ({
  participant: { id: 'p-1', kind: 'person', roleId },
  action,
  zoneId,
  facts: { peopleInZone: 1, localTime: '10:00' },
  ...extra,
});
const ids = (d: { reasons: { ruleId: string }[] }) => d.reasons.map(r => r.ruleId);
const legacy = (patch: Partial<LegacyCompileInput>): LegacyCompileInput => ({ ...store, ...patch });

// A tiny site with no template, for rule-level tests. Two independent facts, one time fact, one enum.
const tiny = (rulesList: Array<Omit<Rule, 'source' | 'setBy'> & { setBy?: string }>, extra: Partial<CompileDomainInput> = {}): CompileDomainInput => ({
  site: { id: 't', name: 'Tiny' },
  authorities: [{ id: 'high' }, { id: 'low' }],
  actions: [{ id: 'go', kinds: ['robot'], tags: ['movement'] }, { id: 'look', kinds: ['robot'] }],
  facts: [
    { id: 'n', type: 'number', integer: true, min: 0, required: true },
    { id: 'm', type: 'number', min: 0, default: 0 },
    { id: 't', type: 'time', required: true },
    { id: 'mode', type: 'enum', values: ['a', 'b', 'c'], default: 'a' },
    { id: 'flag', type: 'boolean', default: false },
    { id: 'day', type: 'day', required: true },
  ],
  limits: [{ id: 'speed', unit: 'm/s' }],
  areas: [{ id: 'x', name: 'X' }, { id: 'y', name: 'Y', tags: ['far'] }],
  roles: [{ id: 'bot', name: 'Bot', kind: 'robot', actions: ['go', 'look'] }],
  rules: rulesList.map(r => ({ setBy: 'high', ...r, source: { kind: 'manual', ref: r.id } })),
  ...extra,
});
const tinyReq = (action = 'go', areaId = 'x', facts: Record<string, unknown> = {}): DomainRequest => ({
  participant: { id: 'b', kind: 'robot', roleId: 'bot' }, action, areaId, facts: { n: 0, t: '10:00', day: 'mon', ...facts },
});
const rule = (id: string, then: Rule['then'], patch: Partial<Rule> = {}): Omit<Rule, 'source' | 'setBy'> & { setBy?: string } =>
  ({ id, text: id, who: '*', does: '*', where: '*', then, ...patch });

describe('domain rules: compile', () => {
  it('is deterministic and resolves role inheritance', () => {
    expect(compileDomain(store).fingerprint).toBe(rules.fingerprint);
    expect(rules.roles.find(r => r.id === 'restock_robot')!.actions).toEqual(expect.arrayContaining(['enter_zone', 'move', 'scan', 'dock', 'manipulate']));
    const changed = compileDomain(legacy({ answers: { ...store.answers, robot_speed: 'careful' } }));
    expect(changed.fingerprint).not.toBe(rules.fingerprint);
  });

  it('defaults every unanswered question to the safe answer', () => {
    const d = compileDomain(legacy({ answers: {} }));
    expect(d.answers).toEqual({
      robots_near_people: 'stop', robot_speed: 'careful', robots_staff_zones: 'never', robots_restricted_zones: 'never',
      robots_after_hours: 'never', robot_scan_near_people: 'never', glasses_capture: 'blocked', robot_commands: 'nobody',
      emergency: 'stop_all', unknown_actions: 'block',
    });
    expect(d.otherwise).toBe('deny');
    expect(d.findings.filter(f => f.severity !== 'info')).toEqual([]);
  });

  it('refuses inputs it cannot govern, saying what to fix', () => {
    const bad = (patch: Partial<LegacyCompileInput>) => () => compileDomain(legacy(patch));
    expect(bad({ answers: { robot_speed: 'ludicrous' } })).toThrow(/Invalid answer "ludicrous"/);
    expect(bad({ answers: { robot_dance: 'yes' } })).toThrow(/Unknown question/);
    expect(bad({ zones: [...store.zones, store.zones[0]] })).toThrow(/declared twice/);
    expect(bad({ roles: [{ roleId: 'x', name: 'X', kind: 'robot', actions: ['camera_capture'] }] })).toThrow(/robot and cannot list "camera_capture"/);
    expect(bad({ roles: [
      { roleId: 'a', name: 'A', kind: 'robot', actions: [], inherits: 'b' },
      { roleId: 'b', name: 'B', kind: 'robot', actions: [], inherits: 'a' },
    ] })).toThrow(/loops/);
    expect(bad({ site: { ...store.site, hours: { open: '7am', close: '22:00' } } })).toThrow(DomainRulesError);
  });

  it('builder gives the same rulebook as compileDomain', () => {
    expect(grocery.builder.compile().fingerprint).toBe(grocery.rulebook.fingerprint);
    expect(compileDomain(grocery.builder.toInput()).fingerprint).toBe(grocery.rulebook.fingerprint);
    expect(grocery.builder.preview()).toContain('# Rules for Example Grocery');
  });
});

describe('domain rules: robots', () => {
  it('caps speed by site, area and people present', () => {
    expect(evaluateDomainAction(rules, robot('inventory_robot', 'move', 'aisle-3', { requestedSpeedMps: 0.8 })).status).toBe('ALLOW');
    const fast = evaluateDomainAction(rules, robot('inventory_robot', 'move', 'aisle-3', { requestedSpeedMps: 1.2 }));
    expect(fast).toMatchObject({ status: 'LIMIT', limits: { maxSpeedMps: 1.0 } });
    expect(evaluateDomainAction(rules, robot('inventory_robot', 'move', 'checkout', { requestedSpeedMps: 1 })).limits).toEqual({ maxSpeedMps: 0.3 });
    const near = evaluateDomainAction(rules, robot('inventory_robot', 'move', 'aisle-3', { peopleInZone: 2, requestedSpeedMps: 1 }));
    expect(near).toMatchObject({ status: 'LIMIT', limits: { maxSpeedMps: 0.3 } });
    expect(ids(near)).toEqual(['robots_near_people']);
  });

  it('stops near people when the answer is stop', () => {
    const strict = compileDomain(legacy({ answers: { ...store.answers, robots_near_people: 'stop' } }));
    const d = evaluateDomainAction(strict, robot('restock_robot', 'manipulate', 'aisle-3', { peopleInZone: 1 }));
    expect(d.status).toBe('PAUSE');
    expect(ids(d)).toEqual(['robots_near_people']);
  });

  it('blocks actions the role does not list, and unknown actions, areas and roles', () => {
    expect(ids(evaluateDomainAction(rules, robot('inventory_robot', 'manipulate', 'aisle-3')))).toEqual(['role_permits_action']);
    expect(ids(evaluateDomainAction(rules, robot('inventory_robot', 'open_door', 'aisle-3')))).toEqual(['unknown_action']);
    expect(ids(evaluateDomainAction(rules, robot('inventory_robot', 'move', 'roof')))).toEqual(['area_declared']);
    expect(ids(evaluateDomainAction(rules, robot('staff', 'move', 'aisle-3')))).toEqual(['role_declared']);
    const pausing = compileDomain(legacy({ answers: { ...store.answers, unknown_actions: 'pause' } }));
    expect(evaluateDomainAction(pausing, robot('inventory_robot', 'open_door', 'aisle-3')).status).toBe('PAUSE');
  });

  it('approval clears an approval pause but never a condition pause', () => {
    const restricted = robot('restock_robot', 'enter_zone', 'electrical', { requestedSpeedMps: 0.5 });
    expect(evaluateDomainAction(rules, restricted).status).toBe('PAUSE');
    expect(evaluateDomainAction(rules, { ...restricted, facts: { ...restricted.facts, approvedBy: 'dana' } }).status).toBe('ALLOW');

    const scan = robot('inventory_robot', 'scan', 'aisle-3', { peopleInZone: 2, approvedBy: 'dana' });
    expect(evaluateDomainAction(rules, scan)).toMatchObject({ status: 'PAUSE', reasons: [{ ruleId: 'robot_scan_near_people' }] });
    const back = robot('restock_robot', 'enter_zone', 'back-room', { approvedBy: 'dana', requestedSpeedMps: 0.5 });
    expect(ids(evaluateDomainAction(rules, back))).toEqual(['robots_staff_zones']);
    expect(evaluateDomainAction(rules, { ...back, facts: { ...back.facts, staffInZone: 1 } }).status).toBe('ALLOW');
  });

  it('applies opening hours, including overnight sites', () => {
    expect(ids(evaluateDomainAction(rules, robot('inventory_robot', 'move', 'aisle-3', { localTime: '23:30', requestedSpeedMps: 0.5 })))).toEqual(['robots_after_hours']);
    expect(evaluateDomainAction(rules, robot('cleaning_robot', 'move', 'aisle-3', { localTime: '23:30', requestedSpeedMps: 0.5 })).status).toBe('ALLOW');
    const overnight = compileDomain(legacy({ site: { ...store.site, hours: { open: '20:00', close: '06:00' } } }));
    expect(evaluateDomainAction(overnight, robot('inventory_robot', 'move', 'aisle-3', { localTime: '02:00', requestedSpeedMps: 0.5 })).status).toBe('ALLOW');
    expect(ids(evaluateDomainAction(overnight, robot('inventory_robot', 'move', 'aisle-3', { localTime: '12:00', requestedSpeedMps: 0.5 })))).toEqual(['robots_after_hours']);
    const always = compileDomain(legacy({ site: { ...store.site, hours: { open: '00:00', close: '00:00' } } }));
    expect(evaluateDomainAction(always, robot('inventory_robot', 'move', 'aisle-3', { localTime: '03:00', requestedSpeedMps: 0.5 })).status).toBe('ALLOW');
    expect(isOpen('02:00', { open: '20:00', close: '06:00' })).toBe(true);
    expect(isOpen('12:00', { open: '20:00', close: '06:00' })).toBe(false);
    expect(isOpen('03:00', { open: '00:00', close: '00:00' })).toBe(true);
  });

  it('stops robots in an emergency; stop_then_dock allows only docking', () => {
    const moving = evaluateDomainAction(rules, robot('inventory_robot', 'move', 'aisle-3', { emergency: true }));
    expect(moving).toMatchObject({ status: 'BLOCK', then: 'dock' });
    expect(evaluateDomainAction(rules, robot('inventory_robot', 'dock', 'aisle-3', { emergency: true, requestedSpeedMps: 0.3 })).status).toBe('ALLOW');
    const stayPut = compileDomain(legacy({ answers: { ...store.answers, emergency: 'stop_all' } }));
    const d = evaluateDomainAction(stayPut, robot('inventory_robot', 'dock', 'aisle-3', { emergency: true }));
    expect(d.status).toBe('BLOCK');
    expect(d.then).toBeUndefined();
  });

  it('records every check, who set each rule, and the rulebook that decided', () => {
    const d = evaluateDomainAction(rules, robot('inventory_robot', 'move', 'aisle-3', { peopleInZone: 2, requestedSpeedMps: 1 }));
    expect(d.trace.map(c => c.ruleId)).toEqual(['role_permits_action', 'robots_near_people', 'robot_speed']);
    expect(d.trace.map(c => c.setBy)).toEqual(['builtin', 'law-and-safety', 'law-and-safety']);
    expect(d.fingerprint).toBe(rules.fingerprint);
  });
});

describe('domain rules: required facts', () => {
  it('never treats a missing or invalid fact as permission', () => {
    const base = robot('inventory_robot', 'move', 'aisle-3', { requestedSpeedMps: 0.5 });
    expect(evaluateDomainAction(rules, base).status).toBe('ALLOW');   // absent emergency = none, absent staffInZone = 0

    const missing = evaluateDomainAction(rules, { ...base, facts: { localTime: '10:00', requestedSpeedMps: 0.5 } });
    expect(missing.status).toBe('BLOCK');
    expect(ids(missing)).toEqual(['required_facts']);
    expect(missing.reasons[0].reason).toMatch(/peopleInZone/);

    const badFacts = [
      { peopleInZone: -1 }, { peopleInZone: 1.5 }, { peopleInZone: '2' }, { peopleInZone: NaN },
      { staffInZone: -1 }, { staffInZone: 0.5 },
      { requestedSpeedMps: -1 }, { requestedSpeedMps: Infinity },
      { localTime: '9:00' }, { localTime: undefined },
      { emergency: 'no' }, { approvedBy: true }, { approvedBy: { authority: 'company' } }, { approvedBy: { id: 'x', authority: 'king' } },
    ];
    for (const patch of badFacts) {
      const d = evaluateDomainAction(rules, { ...base, facts: { ...base.facts, ...patch } });
      expect(d.status, JSON.stringify(patch)).toBe('BLOCK');
      expect(ids(d), JSON.stringify(patch)).toEqual(['required_facts']);
    }
    expect(ids(evaluateDomainAction(rules, { ...base, participant: { ...base.participant, kind: 'drone' } }))).toEqual(['required_facts']);
    expect(ids(evaluateDomainAction(rules, { ...base, participant: { ...base.participant, roleId: '' } }))).toEqual(['required_facts']);
    expect(ids(evaluateDomainAction(rules, { ...base, action: '' }))).toEqual(['required_facts']);
    expect(ids(evaluateDomainAction(rules, { ...base, zoneId: '' }))).toEqual(['required_facts']);
    expect(rules.builtin.some(b => b.id === 'required_facts')).toBe(true);
  });

  it('applies never rules and every matching rule to approved unknown actions too', () => {
    const pausing = compileDomain(legacy({ answers: { ...store.answers, unknown_actions: 'pause', robots_restricted_zones: 'never' } }));
    const approved = (zoneId: string, facts: Record<string, unknown>) => robot('inventory_robot', 'open_door', zoneId, { approvedBy: 'dana', ...facts });
    expect(evaluateDomainAction(pausing, approved('aisle-3', {})).status).toBe('ALLOW');
    expect(ids(evaluateDomainAction(pausing, approved('aisle-3', { emergency: true })))).toEqual(['emergency_stop']);
    expect(ids(evaluateDomainAction(pausing, approved('aisle-3', { localTime: '23:30' })))).toEqual(['robots_after_hours']);
    expect(ids(evaluateDomainAction(pausing, approved('electrical', {})))).toEqual(['robots_restricted_zones']);
    expect(ids(evaluateDomainAction(pausing, approved('back-room', { staffInZone: 0 })))).toEqual(['robots_staff_zones']);
    const strict = compileDomain(legacy({ answers: { ...store.answers, unknown_actions: 'pause', robots_near_people: 'stop' } }));
    expect(ids(evaluateDomainAction(strict, approved('aisle-3', { peopleInZone: 1 })))).toEqual(['robots_near_people']);
    // An unknown glasses action is not a robot command, so an emergency does not block it.
    const wave = { ...person('staff', 'wave', 'aisle-3'), facts: { peopleInZone: 1, localTime: '10:00', emergency: true, approvedBy: 'dana' } };
    expect(evaluateDomainAction(pausing, wave).status).toBe('ALLOW');
  });
});

describe('domain rules: area role limits', () => {
  it('lets an area limit which roles may act in it; inheritance does not pass area permission', () => {
    // The example store's restroom allows only cleaning_robot, staff and shopper.
    expect(ids(evaluateDomainAction(rules, robot('restock_robot', 'enter_zone', 'restroom', { requestedSpeedMps: 0.5 })))).toEqual(['area_role_limits:restroom']);
    expect(ids(evaluateDomainAction(rules, robot('inventory_robot', 'enter_zone', 'restroom', { requestedSpeedMps: 0.5 })))).toEqual(['area_role_limits:restroom']);
    expect(evaluateDomainAction(rules, robot('cleaning_robot', 'enter_zone', 'restroom', { requestedSpeedMps: 0.5 })).status).toBe('ALLOW');
    expect(evaluateDomainAction(rules, person('staff', 'ai_overlay', 'restroom')).status).toBe('ALLOW');

    const extra = compileDomain(legacy({ zones: [
      ...store.zones,
      { zoneId: 'parents-only', name: 'Parents only', kind: 'public', allowRoles: ['inventory_robot'] },
      { zoneId: 'no-staff', name: 'No staff', kind: 'public', denyRoles: ['staff'] },
    ] }));
    // restock_robot inherits inventory_robot's actions, not its area permission.
    expect(ids(evaluateDomainAction(extra, robot('restock_robot', 'move', 'parents-only', { requestedSpeedMps: 0.5 })))).toEqual(['area_role_limits:parents-only']);
    expect(evaluateDomainAction(extra, robot('inventory_robot', 'move', 'parents-only', { requestedSpeedMps: 0.5 })).status).toBe('ALLOW');
    expect(ids(evaluateDomainAction(extra, person('staff', 'ai_overlay', 'no-staff')))).toEqual(['area_role_limits:no-staff:deny']);
    expect(evaluateDomainAction(extra, person('shopper', 'ai_overlay', 'no-staff')).status).toBe('ALLOW');
    expect(renderDomainRules(extra)).toContain('only: inventory_robot');
    expect(renderDomainRules(extra)).toContain('never: staff');

    const bad = (zone: Record<string, unknown>) => () => compileDomain(legacy({ zones: [...store.zones, { zoneId: 'z', name: 'Z', kind: 'public', ...zone } as LegacyCompileInput['zones'][number]] }));
    expect(bad({ allowRoles: ['ghost'] })).toThrow(/unknown role "ghost"/);
    expect(bad({ allowRoles: ['staff'], denyRoles: ['staff'] })).toThrow(/both/);
  });
});

describe('domain rules: frozen rulebooks', () => {
  it('copies and freezes the input so later mutation cannot change a compiled rulebook', () => {
    const input = JSON.parse(JSON.stringify(store)) as LegacyCompileInput;
    const compiled = compileDomain(input);
    const before = compiled.fingerprint;
    input.site.hours.close = '23:59';
    input.zones[0].kind = 'restricted';
    input.roles[0].actions.push('manipulate');
    expect(compiled.site.hours!.close).toBe('22:00');
    expect(compiled.areas[0].tags).toEqual(['public']);
    expect(compiled.roles[0].actions).not.toContain('manipulate');
    expect(compiled.fingerprint).toBe(before);
    expect(verifyFingerprint(compiled)).toBe(true);
    expect(compileDomain(input).fingerprint).not.toBe(before);
    expect(Object.isFrozen(compiled)).toBe(true);
    expect(Object.isFrozen(compiled.site.hours)).toBe(true);
    expect(Object.isFrozen(compiled.areas[0])).toBe(true);
    expect(Object.isFrozen(compiled.roles[0].actions)).toBe(true);
    expect(Object.isFrozen(compiled.rules[0].then)).toBe(true);
    expect(() => { (compiled as { otherwise: string }).otherwise = 'wait-for-approval'; }).toThrow();
  });

  it('verifyFingerprint catches a tampered copy received as JSON', () => {
    const wire = JSON.parse(JSON.stringify(rules)) as Rulebook;
    expect(verifyFingerprint(wire)).toBe(true);
    (wire.rules.find(r => r.id === 'robot_speed')!.then as { limits: Record<string, number> }).limits.maxSpeedMps = 5;
    expect(verifyFingerprint(wire)).toBe(false);
    const again = JSON.parse(JSON.stringify(rules)) as Rulebook;
    again.fingerprint = 'abc';
    expect(verifyFingerprint(again)).toBe(false);
  });
});

describe('domain rules: glasses', () => {
  it('limits capture to staff and commands to staff', () => {
    expect(ids(evaluateDomainAction(rules, person('shopper', 'camera_capture', 'aisle-3')))).toEqual(['glasses_capture']);
    expect(evaluateDomainAction(rules, person('staff', 'record_audio', 'aisle-3')).status).toBe('ALLOW');
    expect(evaluateDomainAction(rules, person('staff', 'command_robot', 'checkout', { targetRobotId: 'r-3' })).status).toBe('ALLOW');
    // command_robot requires the targetRobotId fact: without it the request is incomplete.
    expect(ids(evaluateDomainAction(rules, person('staff', 'command_robot', 'checkout')))).toEqual(['required_facts']);
  });

  it('needs approval for non-staff commands when the answer allows it', () => {
    const open = compileDomain(legacy({
      roles: store.roles.map(r => (r.roleId === 'shopper' ? { ...r, actions: [...r.actions, 'command_robot'] } : r)),
      answers: { ...store.answers, robot_commands: 'anyone_with_approval' },
    }));
    const ask = person('shopper', 'command_robot', 'checkout', { targetRobotId: 'r-3' });
    expect(evaluateDomainAction(open, ask).status).toBe('PAUSE');
    expect(evaluateDomainAction(open, { ...ask, facts: { ...ask.facts, approvedBy: 's-1' } }).status).toBe('ALLOW');
  });

  it('blocks robot commands during an emergency', () => {
    const d = evaluateDomainAction(rules, { ...person('staff', 'command_robot', 'checkout', { targetRobotId: 'r-3' }), facts: { peopleInZone: 1, localTime: '10:00', emergency: true } });
    expect(ids(d)).toEqual(['emergency_stop_commands']);
  });

  it('turns the rules into zone rules the glasses enforce, only ever tightening', () => {
    expect(glassesZoneRules(rules, 'aisle-3', 'shopper')).toMatchObject({ camera: 'blocked', microphone: 'blocked', locationSharing: 'blocked', aiOverlay: 'allowed' });
    expect(glassesZoneRules(rules, 'aisle-3', 'staff')).toMatchObject({ camera: 'allowed', locationSharing: 'allowed' });
    // A stricter base is never loosened by the rulebook.
    expect(glassesZoneRules(rules, 'aisle-3', 'staff', RETAIL_ZONE_RULES).camera).toBe('confirm_each');
    expect(() => glassesZoneRules(rules, 'aisle-3', 'inventory_robot')).toThrow(/person role/);
    // A manager's conditional "no audio at lunch" rule is applied as if it held: the glasses can only tighten.
    expect(glassesZoneRules(grocery.rulebook, 'back-room', 'staff').microphone).toBe('blocked');
  });
});

// ─── 0.3: generic model ──────────────────────────────────────────────────────

describe('generic rulebook: the 0.2 store decides the same way through the template', () => {
  it('gives every 0.2 demo scenario the same status as 0.2.1 did', () => {
    const r = (id: string, roleId: string) => ({ id, kind: 'robot', roleId });
    const p = (id: string, roleId: string) => ({ id, kind: 'person', roleId });
    // The 19 requests of the 0.2.1 demo and the statuses it printed (captured before this change).
    const scenarios: Array<[string, DomainRequest]> = [
      ['LIMIT', { participant: r('r-1', 'inventory_robot'), action: 'move', zoneId: 'aisle-3', facts: { peopleInZone: 0, localTime: '09:00', requestedSpeedMps: 1.2 } }],
      ['LIMIT', { participant: r('r-1', 'inventory_robot'), action: 'move', zoneId: 'aisle-3', facts: { peopleInZone: 2, localTime: '09:01', requestedSpeedMps: 1.0 } }],
      ['PAUSE', { participant: r('r-1', 'inventory_robot'), action: 'scan', zoneId: 'aisle-3', facts: { peopleInZone: 2, localTime: '09:01' } }],
      ['BLOCK', { participant: r('r-1', 'inventory_robot'), action: 'manipulate', zoneId: 'aisle-3', facts: { peopleInZone: 0, localTime: '09:05' } }],
      ['PAUSE', { participant: r('r-2', 'restock_robot'), action: 'enter_zone', zoneId: 'back-room', facts: { peopleInZone: 0, staffInZone: 0, localTime: '10:00', requestedSpeedMps: 0.8 } }],
      ['PAUSE', { participant: r('r-2', 'restock_robot'), action: 'enter_zone', zoneId: 'electrical', facts: { peopleInZone: 0, localTime: '10:30', requestedSpeedMps: 0.5 } }],
      ['ALLOW', { participant: r('r-2', 'restock_robot'), action: 'enter_zone', zoneId: 'electrical', facts: { peopleInZone: 0, localTime: '10:31', requestedSpeedMps: 0.5, approvedBy: 'manager-dana' } }],
      ['BLOCK', { participant: r('r-2', 'restock_robot'), action: 'enter_zone', zoneId: 'restroom', facts: { peopleInZone: 0, localTime: '11:00', requestedSpeedMps: 0.5 } }],
      ['ALLOW', { participant: r('r-3', 'cleaning_robot'), action: 'enter_zone', zoneId: 'restroom', facts: { peopleInZone: 0, localTime: '11:01', requestedSpeedMps: 0.5 } }],
      ['BLOCK', { participant: p('p-1', 'shopper'), action: 'camera_capture', zoneId: 'aisle-3', facts: { peopleInZone: 3, localTime: '12:00' } }],
      ['ALLOW', { participant: p('s-1', 'staff'), action: 'camera_capture', zoneId: 'aisle-3', facts: { peopleInZone: 3, localTime: '12:01' } }],
      ['ALLOW', { participant: p('s-1', 'staff'), action: 'command_robot', targetRobotId: 'r-3', zoneId: 'checkout', facts: { peopleInZone: 4, localTime: '13:00' } }],
      ['BLOCK', { participant: p('p-1', 'shopper'), action: 'command_robot', targetRobotId: 'r-3', zoneId: 'checkout', facts: { peopleInZone: 4, localTime: '13:00' } }],
      ['BLOCK', { participant: r('r-1', 'inventory_robot'), action: 'move', zoneId: 'aisle-3', facts: { peopleInZone: 6, localTime: '15:00', emergency: true } }],
      ['ALLOW', { participant: r('r-1', 'inventory_robot'), action: 'dock', zoneId: 'aisle-3', facts: { peopleInZone: 0, localTime: '15:02', emergency: true, requestedSpeedMps: 0.3 } }],
      ['BLOCK', { participant: r('r-1', 'inventory_robot'), action: 'move', zoneId: 'aisle-3', facts: { peopleInZone: 0, localTime: '23:30', requestedSpeedMps: 1.0 } }],
      ['ALLOW', { participant: r('r-3', 'cleaning_robot'), action: 'move', zoneId: 'aisle-3', facts: { peopleInZone: 0, localTime: '23:30', requestedSpeedMps: 1.0 } }],
      ['BLOCK', { participant: r('r-1', 'inventory_robot'), action: 'move', zoneId: 'loading-bay', facts: { peopleInZone: 0, localTime: '11:00' } }],
      ['BLOCK', { participant: r('r-1', 'inventory_robot'), action: 'open_door', zoneId: 'entrance', facts: { peopleInZone: 0, localTime: '11:00' } }],
    ];
    const got = scenarios.map(([, req]) => evaluateDomainAction(rules, req).status);
    expect(got).toEqual(scenarios.map(([status]) => status));
    expect(rules.template).toBe('grocery-store');
    expect(rules.rules.map(r => r.id)).toContain('zone_speed_cap:checkout');
  });
});

describe('generic rulebook: any site, any things', () => {
  it('governs a clinic declared by hand: its own actions, facts and authorities', () => {
    const rb = clinicExample.rulebook;
    expect(rb.kinds).toEqual(['robot', 'person']);
    const med = { id: 'm', kind: 'robot', roleId: 'med_robot' };
    const quiet = evaluateDomainAction(rb, { participant: med, action: 'move', areaId: 'ward-a', facts: { patient_present: false, localTime: '23:00', requestedSpeedMps: 0.3 } });
    expect(ids(quiet)).toEqual(['quiet_hours']);
    const busy = evaluateDomainAction(rb, { participant: med, action: 'deliver_meds', areaId: 'ward-a', facts: { patient_present: true, localTime: '10:00', approvedBy: { id: 'k', roleId: 'pharmacist' } } });
    expect(busy.status).toBe('PAUSE');
    expect(ids(busy)).toEqual(['robots_wait_for_patients']);
    const isolation = evaluateDomainAction(rb, { participant: { id: 'v', kind: 'person', roleId: 'visitor' }, action: 'enter', areaId: 'ward-a', facts: { patient_present: false, localTime: '10:00', ward_status: 'isolation' } });
    expect(ids(isolation)).toEqual(['no_visitors_in_isolation']);
    expect(evaluateDomainAction(rb, { participant: { id: 'v', kind: 'person', roleId: 'visitor' }, action: 'enter', areaId: 'ward-a', facts: { patient_present: false, localTime: '10:00', ward_status: 'quiet' } }).status).toBe('ALLOW');
    const badEnum = evaluateDomainAction(rb, { participant: med, action: 'move', areaId: 'ward-a', facts: { patient_present: false, localTime: '10:00', ward_status: 'party' } });
    expect(ids(badEnum)).toEqual(['required_facts']);
  });

  it('rejects undefined references and impossible conditions at compile time', () => {
    const t = (r: Partial<Rule>) => () => compileDomain(tiny([rule('r', { answer: 'deny' }, r)]));
    expect(t({ who: 'ghost' })).toThrow(/unknown role "ghost"/);
    expect(t({ does: 'tag:flying' })).toThrow(/action tag "flying"/);
    expect(t({ where: 'kind:robot' })).toThrow(/areas have no kind/);
    expect(t({ who: 'kind:drone' })).toThrow(/kind "drone"/);
    expect(t({ when: [{ fact: 'zzz', op: '==', value: 1 }] })).toThrow(/unknown fact "zzz"/);
    expect(t({ when: [{ fact: 'n', op: '==', value: 'two' }] })).toThrow(/must be a number/);
    expect(t({ when: [{ fact: 'flag', op: '>', value: true }] })).toThrow(/does not apply to a boolean/);
    expect(t({ when: [{ fact: 't', op: 'between', from: '25:00', to: '10:00' }] })).toThrow(/HH:MM/);
    expect(t({ when: [{ fact: 't', op: 'between', from: '10:00', to: '10:00' }] })).toThrow(/empty window/);
    expect(t({ when: [{ fact: 'n', op: '>', value: 5 }, { fact: 'n', op: '<', value: 3 }] })).toThrow(/can never all be true/);
    expect(t({ then: { answer: 'limit', limits: { warp: 9 } } })).toThrow(/unknown limit "warp"/);
    expect(t({ then: { answer: 'wait', for: 'approval', by: 'nobody' } })).toThrow(/not a declared authority, role, or role tag/);
    expect(t({ setBy: 'king' })).toThrow(/unknown authority "king"/);
    expect(t({ never: true, then: { answer: 'allow' } })).toThrow(/never rule must deny/);
    expect(() => compileDomain(tiny([rule('r', { answer: 'deny' }, { when: [{ fact: 'k', op: '==', value: 1 }] })], { facts: [{ id: 'k', type: 'number' }] }))).toThrow(/optional with no default/);
    expect(() => compileDomain(tiny([rule('r', { answer: 'deny' })], { template: 'spaceship' }))).toThrow(/Unknown template/);
  });

  it('evaluates every condition operator, including overnight windows and day sets', () => {
    const rb = compileDomain(tiny([
      rule('eq', { answer: 'deny' }, { when: [{ fact: 'n', op: '==', value: 3 }] }),
      rule('ne', { answer: 'deny' }, { does: 'look', when: [{ fact: 'mode', op: '!=', value: 'a' }] }),
      rule('gt', { answer: 'limit', limits: { speed: 0.5 } }, { when: [{ fact: 'n', op: '>', value: 5 }] }),
      rule('ge', { answer: 'limit', limits: { speed: 0.4 } }, { when: [{ fact: 'm', op: '>=', value: 2.5 }] }),
      rule('lt', { answer: 'wait', for: 'condition' }, { where: 'y', when: [{ fact: 'n', op: '<', value: 1 }] }),
      rule('le', { answer: 'wait', for: 'approval' }, { where: 'y', when: [{ fact: 'm', op: '<=', value: 0 }, { fact: 'n', op: '>=', value: 1 }] }),
      rule('in', { answer: 'deny' }, { when: [{ fact: 'mode', op: 'in', values: ['b', 'c'] }, { fact: 'flag', op: '==', value: true }] }),
      rule('night', { answer: 'deny' }, { does: 'look', when: [{ fact: 't', op: 'between', from: '22:00', to: '06:00' }] }),
      rule('weekend', { answer: 'deny' }, { does: 'look', when: [{ fact: 'day', op: 'days', days: ['sat', 'sun'] }] }),
    ]));
    const go = (facts: Record<string, unknown>, action = 'go', areaId = 'x') => evaluateDomainAction(rb, tinyReq(action, areaId, facts));
    expect(ids(go({ n: 3 }))).toEqual(['eq']);
    expect(go({ n: 2 }).status).toBe('ALLOW');
    expect(ids(go({ mode: 'b' }, 'look'))).toEqual(['ne']);
    expect(go({ mode: 'a' }, 'look').status).toBe('ALLOW');
    expect(go({ n: 6 })).toMatchObject({ status: 'LIMIT', limits: { speed: 0.5 } });
    expect(go({ n: 5 }).status).toBe('ALLOW');
    expect(go({ n: 6, m: 2.5 })).toMatchObject({ status: 'LIMIT', limits: { speed: 0.4 } });
    expect(ids(go({ n: 0 }, 'go', 'y'))).toEqual(['lt']);
    expect(ids(go({ n: 1, m: 0 }, 'go', 'y'))).toEqual(['le']);
    expect(go({ n: 1, m: 0.1 }, 'go', 'y').status).toBe('ALLOW');
    expect(ids(go({ mode: 'c', flag: true }))).toEqual(['in']);
    expect(go({ mode: 'c', flag: false }).status).toBe('ALLOW');
    expect(ids(go({ t: '23:30' }, 'look'))).toEqual(['night']);
    expect(ids(go({ t: '05:59' }, 'look'))).toEqual(['night']);
    expect(go({ t: '06:00' }, 'look').status).toBe('ALLOW');
    expect(go({ t: '21:59' }, 'look').status).toBe('ALLOW');
    expect(ids(go({ day: 'sun' }, 'look'))).toEqual(['weekend']);
    expect(go({ day: 'fri' }, 'look').status).toBe('ALLOW');
  });

  it('otherwise applies to unknown actions and is wait-for-approval when asked', () => {
    const waiting = compileDomain(tiny([rule('r', { answer: 'deny' }, { does: 'look' })], { otherwise: 'wait-for-approval' }));
    expect(evaluateDomainAction(waiting, tinyReq('fly')).status).toBe('PAUSE');
    expect(evaluateDomainAction(waiting, tinyReq('fly', 'x', { approvedBy: 'me' })).status).toBe('ALLOW');
    const denying = compileDomain(tiny([rule('r', { answer: 'deny' }, { does: 'look' })]));
    expect(ids(evaluateDomainAction(denying, tinyReq('fly')))).toEqual(['unknown_action']);
  });
});

describe('generic rulebook: authority', () => {
  const site = tiny([
    rule('h_deny', { answer: 'deny' }, { setBy: 'high', does: 'look' }),
    rule('l_allow', { answer: 'allow' }, { setBy: 'low', does: 'look', where: 'y' }),
    rule('ask_high', { answer: 'wait', for: 'approval', by: 'high' }, { setBy: 'high', does: 'go', where: 'y' }),
  ]);
  const rb = compileDomain(site);

  it('names a lower authority trying to loosen a higher one, and the lower rule has no effect', () => {
    const f = rb.findings.find(x => x.kind === 'authority-override')!;
    expect(f).toMatchObject({ severity: 'conflict', ruleIds: ['l_allow', 'h_deny'], certainty: 'certain' });
    expect(f.message).toContain('set by low');
    expect(f.message).toContain('set by high');
    expect(ids(evaluateDomainAction(rb, tinyReq('look', 'y')))).toEqual(['h_deny']);
    // The other way round is tightening: allowed, reported for information only.
    const t = compileDomain(tiny([rule('h_allow', { answer: 'allow' }, { setBy: 'high' }), rule('l_deny', { answer: 'deny' }, { setBy: 'low', where: 'y' })]));
    expect(t.findings.map(f => [f.kind, f.severity])).toEqual([['tightening', 'info']]);
    expect(() => compileDomain(t, { strict: true })).not.toThrow();
  });

  it('clears an approval wait only when the approver holds the authority the rule names', () => {
    const req = (approvedBy: unknown) => evaluateDomainAction(rb, tinyReq('go', 'y', { approvedBy }));
    expect(req(undefined).status).toBe('PAUSE');
    expect(req({ id: 'ann', authority: 'high' }).status).toBe('ALLOW');                         // sufficient
    const low = req({ id: 'bob', authority: 'low' });
    expect(low.status).toBe('PAUSE');                                                             // insufficient
    expect(low.reasons[0].reason).toMatch(/approval needs high; bob doesn't hold it/);
    const unqualified = req('carl');
    expect(unqualified.status).toBe('PAUSE');                                                     // plain string, rule names who
    expect(unqualified.reasons[0].reason).toMatch(/names no authority/);
    // A higher authority than the one named is fine; a role or role tag can be named instead.
    const three = compileDomain(tiny([rule('ask_mid', { answer: 'wait', for: 'approval', by: 'mid' })], { authorities: [{ id: 'high' }, { id: 'mid' }, { id: 'low' }] }));
    expect(evaluateDomainAction(three, tinyReq('go', 'x', { approvedBy: { id: 'ann', authority: 'high' } })).status).toBe('ALLOW');
    expect(evaluateDomainAction(three, tinyReq('go', 'x', { approvedBy: { id: 'bob', authority: 'low' } })).status).toBe('PAUSE');
    const byRole = compileDomain(tiny([rule('ask_bot', { answer: 'wait', for: 'approval', by: 'tag:lead' })], { roles: [{ id: 'bot', name: 'Bot', kind: 'robot', actions: ['go', 'look'] }, { id: 'lead', name: 'Lead', kind: 'person', actions: [], tags: ['lead'] }] }));
    expect(evaluateDomainAction(byRole, tinyReq('go', 'x', { approvedBy: { id: 'lee', roleId: 'lead' } })).status).toBe('ALLOW');
    expect(evaluateDomainAction(byRole, tinyReq('go', 'x', { approvedBy: { id: 'lee', roleId: 'bot' } })).status).toBe('PAUSE');
  });

  it('every check says who set the rule, and the rendering shows authorities', () => {
    const d = evaluateDomainAction(rb, tinyReq('look', 'x'));
    expect(d.reasons).toEqual([{ ruleId: 'h_deny', status: 'BLOCK', reason: 'h_deny', setBy: 'high' }]);
    const text = renderDomainRules(rb);
    expect(text).toContain('## Authorities (highest first)');
    expect(text).toContain('(set by high;');
    expect(() => compileDomain(tiny([{ ...rule('x', { answer: 'deny' }), setBy: undefined } as never]))).toThrow(/setBy is required/);
  });
});

describe('generic rulebook: rules at odds', () => {
  const kinds = (input: CompileDomainInput) => checkRulebook(input).map(f => `${f.kind}:${f.certainty}:${f.ruleIds.join('+')}`);

  it('finds a certain contradiction and a possible one at the same authority, and says who never takes effect', () => {
    const certain = tiny([rule('yes', { answer: 'allow' }), rule('no', { answer: 'deny' }, { where: 'y' })]);
    expect(kinds(certain)).toEqual(['contradiction:certain:yes+no']);
    const f = checkRulebook(certain)[0];
    expect(f.severity).toBe('conflict');
    expect(f.message).toContain('`yes` never takes effect there');
    expect(f.message).toContain('every role · every action · Y, always');
    // Conditions on two independent facts: the rulebook cannot know whether n == 0 and m > 0 ever hold at once.
    const possible = tiny([
      rule('yes', { answer: 'allow' }, { when: [{ fact: 'n', op: '==', value: 0 }] }),
      rule('wait', { answer: 'wait', for: 'condition' }, { when: [{ fact: 'm', op: '>', value: 0 }] }),
    ]);
    expect(kinds(possible)).toEqual(['contradiction:possible:yes+wait']);
    expect(checkRulebook(possible)[0].severity).toBe('warning');
    expect(checkRulebook(possible)[0].message).toMatch(/possible, not certain/);
  });

  it('finds shadowed, duplicate and limit disagreements', () => {
    expect(kinds(tiny([rule('big', { answer: 'deny' }), rule('small', { answer: 'wait', for: 'approval' }, { where: 'y', when: [{ fact: 'n', op: '>', value: 2 }] })]))).toEqual(['shadowed:certain:small+big']);
    expect(kinds(tiny([rule('a', { answer: 'deny' }, { does: 'look' }), rule('b', { answer: 'deny' }, { does: 'look' })]))).toEqual(['duplicate:certain:a+b']);
    expect(kinds(tiny([rule('a', { answer: 'deny' }), rule('b', { answer: 'deny' }, { does: 'look', where: 'y' })]))).toEqual(['duplicate:certain:b+a']);
    const limits = tiny([
      rule('fast', { answer: 'limit', limits: { speed: 1 } }, { where: 'x', when: [{ fact: 'n', op: '<', value: 5 }] }),
      rule('slow', { answer: 'limit', limits: { speed: 0.5 } }, { when: [{ fact: 'n', op: '>', value: 2 }] }),
    ]);
    expect(kinds(limits)).toEqual(['limit_disagreement:possible:fast+slow']);
    expect(checkRulebook(limits)[0].message).toContain('The lower value, 0.5, applies');
    // A stricter special case of a looser rule is layering, not a finding.
    expect(kinds(tiny([rule('site', { answer: 'limit', limits: { speed: 1 } }), rule('near', { answer: 'limit', limits: { speed: 0.3 } }, { when: [{ fact: 'n', op: '>', value: 0 }] })]))).toEqual([]);
    expect(kinds(tiny([rule('deny', { answer: 'deny' }, { where: 'y' }), rule('wait', { answer: 'wait', for: 'condition' }, { when: [{ fact: 'n', op: '>', value: 0 }] })]))).toEqual([]);
  });

  it('finds a rule that tries to allow what a never rule forbids', () => {
    const f = checkRulebook(tiny([rule('inv', { answer: 'deny' }, { never: true, when: [{ fact: 'flag', op: '==', value: true }] }), rule('ok', { answer: 'allow' }, { does: 'go' })]));
    expect(f.map(x => x.kind)).toEqual(['never_vs_rule']);
    expect(f[0].message).toContain('Nothing overrides a never rule');
  });

  it('is sound: provably disjoint rules are not reported, and the compiled rulebook carries its findings', () => {
    // Each pair is an allow and a deny on the same scope whose conditions can never both hold.
    const pairs: Array<[Rule['when'], Rule['when']]> = [
      [[{ fact: 'n', op: '<', value: 3 }], [{ fact: 'n', op: '>=', value: 3 }]],
      [[{ fact: 'n', op: '!=', value: 2 }], [{ fact: 'n', op: '==', value: 2 }]],
      [[{ fact: 'n', op: 'in', values: [1, 2] }], [{ fact: 'n', op: 'in', values: [3, 4] }]],
      [[{ fact: 't', op: 'between', from: '09:00', to: '12:00' }], [{ fact: 't', op: 'between', from: '12:00', to: '09:00' }]],
      [[{ fact: 't', op: 'between', from: '22:00', to: '06:00' }], [{ fact: 't', op: '>=', value: '06:00' }, { fact: 't', op: '<', value: '22:00' }]],
      [[{ fact: 'day', op: 'days', days: ['sat'] }], [{ fact: 'day', op: 'days', days: ['mon', 'tue'] }]],
      [[{ fact: 'flag', op: '==', value: true }], [{ fact: 'flag', op: '==', value: false }]],
      [[{ fact: 'mode', op: 'in', values: ['a'] }], [{ fact: 'mode', op: 'in', values: ['b', 'c'] }]],
      [[{ fact: 'mode', op: '!=', value: 'a' }], [{ fact: 'mode', op: '==', value: 'a' }]],
      // Integers: n > 2 and n < 3 cannot both hold.
      [[{ fact: 'n', op: '>', value: 2 }], [{ fact: 'n', op: '<', value: 3 }]],
      // Different facts, one side impossible to share: n >= 3 on sat vs n < 3 on sat.
      [[{ fact: 'day', op: 'days', days: ['sat'] }, { fact: 'n', op: '>=', value: 3 }], [{ fact: 'day', op: 'days', days: ['sat'] }, { fact: 'n', op: '<', value: 3 }]],
    ];
    for (const [whenA, whenB] of pairs) {
      expect(kinds(tiny([rule('a', { answer: 'allow' }, { when: whenA }), rule('b', { answer: 'deny' }, { when: whenB })])), JSON.stringify([whenA, whenB])).toEqual([]);
    }
    // Move one boundary and the overlap appears.
    const touching = tiny([rule('a', { answer: 'allow' }, { when: [{ fact: 'n', op: '<=', value: 3 }] }), rule('b', { answer: 'deny' }, { when: [{ fact: 'n', op: '>=', value: 3 }] })]);
    expect(kinds(touching)).toEqual(['contradiction:possible:a+b']);
    const compiled = compileDomain(touching);
    expect(compiled.findings).toEqual(checkRulebook(touching));
    expect(Object.isFrozen(compiled.findings)).toBe(true);
  });

  it('strict mode throws on a conflict, with the findings in the message', () => {
    const conflicting = tiny([rule('yes', { answer: 'allow' }), rule('no', { answer: 'deny' })]);
    expect(() => compileDomain(conflicting)).not.toThrow();
    expect(() => compileDomain(conflicting, { strict: true })).toThrow(/Rules at odds \(1\)/);
    const warningOnly = tiny([rule('yes', { answer: 'allow' }), rule('w', { answer: 'wait', for: 'approval' })]);
    expect(() => compileDomain(warningOnly, { strict: true })).not.toThrow();
  });

  it('the grocery example reports the manager\'s deliberate conflicts', () => {
    const f = grocery.rulebook.findings;
    expect(f.map(x => [x.kind, x.severity, x.ruleIds])).toEqual([
      ['tightening', 'info', ['robot_speed', 'checkout_speed']],
      ['authority-override', 'conflict', ['shopper_photos_entrance', 'glasses_capture']],
      ['contradiction', 'conflict', ['staff_audio_back_room', 'no_audio_back_room_lunch']],
    ]);
    expect(f[1].message).toContain('A lower authority can only tighten');
  });
});

describe('generic rulebook: drafting from plain words', () => {
  const rb = grocery.rulebook;
  const draft = (text: string) => draftRuleFromText(text, rb, { setBy: 'site-manager', id: 'd' });

  it('turns common forms into rules using the rulebook\'s own vocabulary, never adding them', () => {
    const a = draft('no restock robots in aisle 3 on Saturdays between 14:00 and 16:00');
    expect(a.draft).toMatchObject({ who: ['restock_robot'], does: '*', where: ['aisle-3'], then: { answer: 'deny' }, setBy: 'site-manager', source: { kind: 'text' } });
    expect(a.draft!.when).toEqual([{ fact: 'localTime', op: 'between', from: '14:00', to: '16:00' }, { fact: 'day', op: 'days', days: ['sat'] }]);
    expect(a.unmatched).toEqual([]);
    expect(a.confidence).toBe(1);

    const b = draft('robots slow to 0.3 m/s in checkout');
    expect(b.draft).toMatchObject({ who: ['kind:robot'], does: 'tag:movement', where: ['checkout'], then: { answer: 'limit', limits: { maxSpeedMps: 0.3 } } });

    const c = draft('shoppers may not take photos');
    expect(c.draft).toMatchObject({ who: ['shopper'], does: ['camera_capture'], where: '*', then: { answer: 'deny' } });

    const d = draft('robots wait for staff approval to enter the electrical room');
    expect(d.draft).toMatchObject({ who: ['kind:robot'], does: ['enter_zone'], where: ['electrical'], then: { answer: 'wait', for: 'approval', by: 'tag:staff' } });

    const e = draft('robots wait while people are present in the back room');
    expect(e.draft).toMatchObject({ where: ['back-room'], when: [{ fact: 'peopleInZone', op: '>', value: 0 }], then: { answer: 'wait', for: 'condition' } });

    const f = draft('cleaning robots may dock after 22:00 when emergency is not active');
    expect(f.draft).toMatchObject({ who: ['cleaning_robot'], does: ['dock'], then: { answer: 'allow' } });
    expect(f.draft!.when).toEqual(expect.arrayContaining([{ fact: 'localTime', op: '>=', value: '22:00' }, { fact: 'emergency', op: '==', value: false }]));

    expect(rb.rules.some(r => r.id === 'd')).toBe(false);
    // Without setBy the draft says so, and compile would refuse it.
    expect(draftRuleFromText('shoppers may not take photos', rb).notes).toContain('Say who sets this rule (setBy) before confirming it.');
  });

  it('says plainly when text cannot be turned into a rule, and lowers confidence for words it could not place', () => {
    const miss = draft('please be nice to the customers');
    expect(miss.draft).toBeNull();
    expect(miss.confidence).toBe(0);
    expect(miss.notes.join(' ')).toMatch(/Could not find what the rule decides/);
    const vague = draft('no dancing');
    expect(vague.draft).toMatchObject({ who: '*', does: '*', then: { answer: 'deny' } });
    expect(vague.unmatched).toEqual(['dancing']);
    expect(vague.confidence).toBeLessThan(0.7);
    expect(draft('robots at most 9 km/h in checkout').notes.join(' ')).toMatch(/declares no matching limit/);
  });

  it('builds a prompt for the operator\'s own model and validates its answer; the model never sets the authority', () => {
    const prompt = buildRuleDraftPrompt('no photos in the restroom', rb);
    expect(prompt).toContain('camera_capture');
    expect(prompt).toContain('restroom');
    expect(prompt).toContain('Answer with JSON only');
    const good = parseRuleDraft('```json\n{"rule":{"id":"no_photos_restroom","text":"No photos in the restroom.","who":"*","does":"camera_capture","where":"restroom","then":{"answer":"deny"},"setBy":"law-and-safety"}}\n```', rb, { setBy: 'site-manager' });
    expect(good.draft).toMatchObject({ id: 'no_photos_restroom', setBy: 'site-manager', source: { kind: 'text' } });
    expect(good.errors).toEqual(['The model tried to set "setBy"; ignored — the operator sets the authority.']);
    expect(parseRuleDraft('not json', rb, { setBy: 'site-manager' }).errors).toEqual(['The answer is not valid JSON.']);
    expect(parseRuleDraft({ error: 'there is no "laser" action' }, rb, { setBy: 'site-manager' }).errors[0]).toMatch(/no "laser" action/);
    const bad = parseRuleDraft({ rule: { id: 'x', text: 'x', who: 'martian', does: '*', where: '*', then: { answer: 'deny' } } }, rb, { setBy: 'site-manager' });
    expect(bad.draft).toBeNull();
    expect(bad.errors[0]).toMatch(/unknown role "martian"/);
    const badThen = parseRuleDraft({ rule: { id: 'x', text: 'x', who: '*', does: '*', where: '*', then: { answer: 'maybe' } } }, rb, { setBy: 'site-manager' });
    expect(badThen.errors[0]).toMatch(/then.answer must be/);
  });

  it('the builder drafts with its current authority and adds only what is confirmed', () => {
    const b = new DomainRulesBuilder({ id: 's', name: 'S', hours: { open: '08:00', close: '20:00' } })
      .fromTemplate('grocery-store')
      .area({ id: 'a', name: 'Floor', tags: ['public'] })
      .role({ id: 'bot', name: 'Bot', kind: 'robot', actions: ['move'] })
      .role({ id: 'guest', name: 'Guest', kind: 'person', actions: ['camera_capture'] });
    const d = b.as('staff').addRuleFromText('guests may not take photos', { id: 'g' });
    expect(d.draft!.setBy).toBe('staff');
    expect(b.compile().rules.some(r => r.id === 'g')).toBe(false);
    b.confirm(d);
    expect(b.compile().rules.find(r => r.id === 'g')).toMatchObject({ setBy: 'staff', source: { kind: 'text', ref: 'guests may not take photos' } });
    expect(() => b.confirm(draftRuleFromText('be nice', b.compile()))).toThrow(/no draft to confirm/);
    // The company's default answer already blocks capture, so the staff rule adds nothing — said as info, not hidden.
    expect(b.check().map(f => [f.kind, f.severity, f.ruleIds])).toEqual([['duplicate', 'info', ['g', 'glasses_capture']]]);
  });
});
