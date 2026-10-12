import { describe, expect, it } from 'vitest';
import {
  compileDomain,
  DomainRulesBuilder,
  DomainRulesError,
  evaluateDomainAction,
  glassesZoneRules,
  isOpen,
  renderDomainRules,
  verifyFingerprint,
} from '../src/index';
import type { CompileDomainInput, DomainRequest } from '../src/index';
import { store } from '../examples/store';
import type { ZoneRules } from '../src/zone-rules';

/** @neuroverseos/governance/spatial ZONE_TEMPLATES.retail, copied so this repo has no dependency on it. */
const RETAIL_ZONE_RULES: ZoneRules = {
  camera: 'confirm_each',
  microphone: 'allowed',
  aiDataSend: 'allowed',
  aiActions: 'allowed',
  aiRecommendations: 'non_commercial',
  locationSharing: 'allowed',
  aiOverlay: 'allowed',
  dataRetention: 'allowed',
  commercialAI: 'blocked',
  bystanderProtection: 'elevated',
};

const rules = compileDomain(store);

const robot = (roleId: string, action: string, zoneId: string, facts: Partial<DomainRequest['facts']> = {}): DomainRequest => ({
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

describe('domain rules: compile', () => {
  it('is deterministic and resolves role inheritance', () => {
    expect(compileDomain(store).fingerprint).toBe(rules.fingerprint);
    expect(rules.roles.find(r => r.roleId === 'restock_robot')!.actions).toEqual(
      expect.arrayContaining(['enter_zone', 'move', 'scan', 'dock', 'manipulate']),
    );
    const changed = compileDomain({ ...store, answers: { ...store.answers, robot_speed: 'careful' } });
    expect(changed.fingerprint).not.toBe(rules.fingerprint);
  });

  it('defaults every unanswered question to the safe answer', () => {
    const d = compileDomain({ ...store, answers: {} });
    expect(d.policy).toMatchObject({
      robotsNearPeople: 'stop', maxSpeedMps: 0.5, robotsInStaffZones: 'never', robotsInRestrictedZones: 'never',
      robotsAfterHours: 'never', robotScanNearPeople: 'never', glassesCapture: 'blocked', robotCommands: 'nobody',
      emergency: 'stop_all', unknownActions: 'block',
    });
  });

  it('refuses inputs it cannot govern, saying what to fix', () => {
    const bad = (patch: Partial<CompileDomainInput>) => () => compileDomain({ ...store, ...patch });
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

  it('builder gives the same rule set as compileDomain', () => {
    const b = new DomainRulesBuilder(store.site);
    store.zones.forEach(z => b.zone(z));
    store.roles.forEach(r => b.role(r));
    Object.entries(store.answers!).forEach(([q, v]) => b.answer(q, v));
    expect(b.compile().fingerprint).toBe(rules.fingerprint);
    expect(b.preview()).toContain('# Rules for Example Grocery');
  });
});

describe('domain rules: robots', () => {
  it('caps speed by site, zone and people present', () => {
    expect(evaluateDomainAction(rules, robot('inventory_robot', 'move', 'aisle-3', { requestedSpeedMps: 0.8 })).status).toBe('ALLOW');
    const fast = evaluateDomainAction(rules, robot('inventory_robot', 'move', 'aisle-3', { requestedSpeedMps: 1.2 }));
    expect(fast).toMatchObject({ status: 'LIMIT', limits: { maxSpeedMps: 1.0 } });
    expect(evaluateDomainAction(rules, robot('inventory_robot', 'move', 'checkout', { requestedSpeedMps: 1 })).limits).toEqual({ maxSpeedMps: 0.3 });
    const near = evaluateDomainAction(rules, robot('inventory_robot', 'move', 'aisle-3', { peopleInZone: 2, requestedSpeedMps: 1 }));
    expect(near).toMatchObject({ status: 'LIMIT', limits: { maxSpeedMps: 0.3 } });
    expect(ids(near)).toEqual(['robots_near_people']);
  });

  it('stops near people when the answer is stop', () => {
    const strict = compileDomain({ ...store, answers: { ...store.answers, robots_near_people: 'stop' } });
    const d = evaluateDomainAction(strict, robot('restock_robot', 'manipulate', 'aisle-3', { peopleInZone: 1 }));
    expect(d.status).toBe('PAUSE');
    expect(ids(d)).toEqual(['robots_near_people']);
  });

  it('blocks actions the role does not list, and unknown actions, zones and roles', () => {
    expect(ids(evaluateDomainAction(rules, robot('inventory_robot', 'manipulate', 'aisle-3')))).toEqual(['role_permits_action']);
    expect(ids(evaluateDomainAction(rules, robot('inventory_robot', 'open_door', 'aisle-3')))).toEqual(['unknown_actions']);
    expect(ids(evaluateDomainAction(rules, robot('inventory_robot', 'move', 'roof')))).toEqual(['zone_declared']);
    expect(ids(evaluateDomainAction(rules, robot('staff', 'move', 'aisle-3')))).toEqual(['role_declared']);
    const pausing = compileDomain({ ...store, answers: { ...store.answers, unknown_actions: 'pause' } });
    expect(evaluateDomainAction(pausing, robot('inventory_robot', 'open_door', 'aisle-3')).status).toBe('PAUSE');
  });

  it('approval clears an approval pause but never a wait pause', () => {
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
    expect(isOpen('02:00', { open: '20:00', close: '06:00' })).toBe(true);
    expect(isOpen('12:00', { open: '20:00', close: '06:00' })).toBe(false);
    expect(isOpen('03:00', { open: '00:00', close: '00:00' })).toBe(true);
  });

  it('stops robots in an emergency; stop_then_dock allows only docking', () => {
    const moving = evaluateDomainAction(rules, robot('inventory_robot', 'move', 'aisle-3', { emergency: true }));
    expect(moving).toMatchObject({ status: 'BLOCK', then: 'dock' });
    expect(evaluateDomainAction(rules, robot('inventory_robot', 'dock', 'aisle-3', { emergency: true, requestedSpeedMps: 0.3 })).status).toBe('ALLOW');
    const stayPut = compileDomain({ ...store, answers: { ...store.answers, emergency: 'stop_all' } });
    const d = evaluateDomainAction(stayPut, robot('inventory_robot', 'dock', 'aisle-3', { emergency: true }));
    expect(d.status).toBe('BLOCK');
    expect(d.then).toBeUndefined();
  });

  it('records every check and the rule set that decided', () => {
    const d = evaluateDomainAction(rules, robot('inventory_robot', 'move', 'aisle-3', { peopleInZone: 2, requestedSpeedMps: 1 }));
    expect(d.trace.map(c => c.ruleId)).toEqual(['role_permits_action', 'robots_near_people']);
    expect(d.fingerprint).toBe(rules.fingerprint);
  });
});

describe('domain rules: required facts', () => {
  it('never treats a missing or invalid fact as permission', () => {
    const base = robot('inventory_robot', 'move', 'aisle-3', { requestedSpeedMps: 0.5 });
    expect(evaluateDomainAction(rules, base).status).toBe('ALLOW');   // absent emergency = none, absent staffInZone = 0

    const missing = evaluateDomainAction(rules, { ...base, facts: { localTime: '10:00', requestedSpeedMps: 0.5 } as any });
    expect(missing.status).toBe('BLOCK');
    expect(ids(missing)).toEqual(['required_facts']);
    expect(missing.reasons[0].reason).toMatch(/peopleInZone/);

    const badFacts = [
      { peopleInZone: -1 }, { peopleInZone: 1.5 }, { peopleInZone: '2' }, { peopleInZone: NaN },
      { staffInZone: -1 }, { staffInZone: 0.5 },
      { requestedSpeedMps: -1 }, { requestedSpeedMps: Infinity },
      { localTime: '9:00' }, { localTime: undefined },
      { emergency: 'no' }, { approvedBy: true },
    ];
    for (const patch of badFacts) {
      const d = evaluateDomainAction(rules, { ...base, facts: { ...base.facts, ...patch } as any });
      expect(d.status, JSON.stringify(patch)).toBe('BLOCK');
      expect(ids(d), JSON.stringify(patch)).toEqual(['required_facts']);
    }
    expect(ids(evaluateDomainAction(rules, { ...base, participant: { ...base.participant, kind: 'drone' as any } }))).toEqual(['required_facts']);
    expect(ids(evaluateDomainAction(rules, { ...base, participant: { ...base.participant, roleId: '' } }))).toEqual(['required_facts']);
    expect(ids(evaluateDomainAction(rules, { ...base, action: '' }))).toEqual(['required_facts']);
    expect(ids(evaluateDomainAction(rules, { ...base, zoneId: '' }))).toEqual(['required_facts']);
    expect(rules.rules.some(r => r.ruleId === 'required_facts')).toBe(true);
  });

  it('applies emergency, hours, zone and people rules to approved unknown actions too', () => {
    const pausing = compileDomain({ ...store, answers: { ...store.answers, unknown_actions: 'pause', robots_restricted_zones: 'never' } });
    const approved = (zoneId: string, facts: Partial<DomainRequest['facts']>) =>
      robot('inventory_robot', 'open_door', zoneId, { approvedBy: 'dana', ...facts });
    expect(evaluateDomainAction(pausing, approved('aisle-3', {})).status).toBe('ALLOW');
    expect(ids(evaluateDomainAction(pausing, approved('aisle-3', { emergency: true })))).toEqual(['emergency_stop']);
    expect(ids(evaluateDomainAction(pausing, approved('aisle-3', { localTime: '23:30' })))).toEqual(['robots_after_hours']);
    expect(ids(evaluateDomainAction(pausing, approved('electrical', {})))).toEqual(['robots_restricted_zones']);
    expect(ids(evaluateDomainAction(pausing, approved('back-room', { staffInZone: 0 })))).toEqual(['robots_staff_zones']);
    const strict = compileDomain({ ...store, answers: { ...store.answers, unknown_actions: 'pause', robots_near_people: 'stop' } });
    expect(ids(evaluateDomainAction(strict, approved('aisle-3', { peopleInZone: 1 })))).toEqual(['robots_near_people']);
    // An unknown glasses action is not a robot command, so an emergency does not block it.
    const wave = { ...person('staff', 'wave', 'aisle-3'), facts: { peopleInZone: 1, localTime: '10:00', emergency: true, approvedBy: 'dana' } };
    expect(evaluateDomainAction(pausing, wave).status).toBe('ALLOW');
  });
});

describe('domain rules: zone role limits', () => {
  it('lets a zone limit which roles may act in it; inheritance does not pass zone permission', () => {
    // The example store's restroom allows only cleaning_robot, staff and shopper.
    expect(ids(evaluateDomainAction(rules, robot('restock_robot', 'enter_zone', 'restroom', { requestedSpeedMps: 0.5 })))).toEqual(['zone_role_limits']);
    expect(ids(evaluateDomainAction(rules, robot('inventory_robot', 'enter_zone', 'restroom', { requestedSpeedMps: 0.5 })))).toEqual(['zone_role_limits']);
    expect(evaluateDomainAction(rules, robot('cleaning_robot', 'enter_zone', 'restroom', { requestedSpeedMps: 0.5 })).status).toBe('ALLOW');
    expect(evaluateDomainAction(rules, person('staff', 'ai_overlay', 'restroom')).status).toBe('ALLOW');

    const extra = compileDomain({ ...store, zones: [
      ...store.zones,
      { zoneId: 'parents-only', name: 'Parents only', kind: 'public', allowRoles: ['inventory_robot'] },
      { zoneId: 'no-staff', name: 'No staff', kind: 'public', denyRoles: ['staff'] },
    ] });
    // restock_robot inherits inventory_robot's actions, not its zone permission.
    expect(ids(evaluateDomainAction(extra, robot('restock_robot', 'move', 'parents-only', { requestedSpeedMps: 0.5 })))).toEqual(['zone_role_limits']);
    expect(evaluateDomainAction(extra, robot('inventory_robot', 'move', 'parents-only', { requestedSpeedMps: 0.5 })).status).toBe('ALLOW');
    expect(ids(evaluateDomainAction(extra, person('staff', 'ai_overlay', 'no-staff')))).toEqual(['zone_role_limits']);
    expect(evaluateDomainAction(extra, person('shopper', 'ai_overlay', 'no-staff')).status).toBe('ALLOW');
    expect(renderDomainRules(extra)).toContain('only: inventory_robot');
    expect(renderDomainRules(extra)).toContain('never: staff');

    const bad = (zone: Record<string, unknown>) => () => compileDomain({ ...store, zones: [...store.zones, { zoneId: 'z', name: 'Z', kind: 'public', ...zone } as any] });
    expect(bad({ allowRoles: ['ghost'] })).toThrow(/unknown role "ghost"/);
    expect(bad({ allowRoles: ['staff'], denyRoles: ['staff'] })).toThrow(/both/);
  });
});

describe('domain rules: frozen rule sets', () => {
  it('copies and freezes the input so later mutation cannot change a compiled rule set', () => {
    const input = JSON.parse(JSON.stringify(store)) as CompileDomainInput;
    const compiled = compileDomain(input);
    const before = compiled.fingerprint;
    input.site.hours.close = '23:59';
    input.zones[0].kind = 'restricted';
    input.roles[0].actions.push('manipulate');
    expect(compiled.site.hours.close).toBe('22:00');
    expect(compiled.zones[0].kind).toBe('public');
    expect(compiled.roles[0].actions).not.toContain('manipulate');
    expect(compiled.fingerprint).toBe(before);
    expect(verifyFingerprint(compiled)).toBe(true);
    expect(compileDomain(input).fingerprint).not.toBe(before);
    expect(Object.isFrozen(compiled)).toBe(true);
    expect(Object.isFrozen(compiled.site.hours)).toBe(true);
    expect(Object.isFrozen(compiled.zones[0])).toBe(true);
    expect(Object.isFrozen(compiled.roles[0].actions)).toBe(true);
    expect(() => { (compiled as any).policy.maxSpeedMps = 99; }).toThrow();
  });

  it('verifyFingerprint catches a tampered copy received as JSON', () => {
    const wire = JSON.parse(JSON.stringify(rules));
    expect(verifyFingerprint(wire)).toBe(true);
    wire.policy.maxSpeedMps = 5;
    expect(verifyFingerprint(wire)).toBe(false);
    wire.policy.maxSpeedMps = rules.policy.maxSpeedMps;
    wire.fingerprint = 'abc';
    expect(verifyFingerprint(wire)).toBe(false);
  });
});

describe('domain rules: glasses', () => {
  it('limits capture to staff and commands to staff', () => {
    expect(ids(evaluateDomainAction(rules, person('shopper', 'camera_capture', 'aisle-3')))).toEqual(['glasses_capture']);
    expect(evaluateDomainAction(rules, person('staff', 'record_audio', 'aisle-3')).status).toBe('ALLOW');
    expect(evaluateDomainAction(rules, person('staff', 'command_robot', 'checkout', { targetRobotId: 'r-3' })).status).toBe('ALLOW');
    expect(ids(evaluateDomainAction(rules, person('staff', 'command_robot', 'checkout')))).toEqual(['robot_commands']);
  });

  it('needs approval for non-staff commands when the answer allows it', () => {
    const open = compileDomain({
      ...store,
      roles: store.roles.map(r => (r.roleId === 'shopper' ? { ...r, actions: [...r.actions, 'command_robot' as const] } : r)),
      answers: { ...store.answers, robot_commands: 'anyone_with_approval' },
    });
    const ask = person('shopper', 'command_robot', 'checkout', { targetRobotId: 'r-3' });
    expect(evaluateDomainAction(open, ask).status).toBe('PAUSE');
    expect(evaluateDomainAction(open, { ...ask, facts: { ...ask.facts, approvedBy: 's-1' } }).status).toBe('ALLOW');
  });

  it('blocks robot commands during an emergency', () => {
    const d = evaluateDomainAction(rules, { ...person('staff', 'command_robot', 'checkout', { targetRobotId: 'r-3' }), facts: { peopleInZone: 1, localTime: '10:00', emergency: true } });
    expect(ids(d)).toEqual(['emergency_stop']);
  });

  it('turns the rules into zone rules the glasses enforce, only ever tightening', () => {
    expect(glassesZoneRules(rules, 'aisle-3', 'shopper')).toMatchObject({ camera: 'blocked', microphone: 'blocked', locationSharing: 'blocked', aiOverlay: 'allowed' });
    expect(glassesZoneRules(rules, 'aisle-3', 'staff')).toMatchObject({ camera: 'allowed', locationSharing: 'allowed' });
    // A stricter base is never loosened by the domain.
    expect(glassesZoneRules(rules, 'aisle-3', 'staff', RETAIL_ZONE_RULES).camera).toBe('confirm_each');
    expect(() => glassesZoneRules(rules, 'aisle-3', 'inventory_robot')).toThrow(/person role/);
  });
});
