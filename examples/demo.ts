#!/usr/bin/env npx tsx
/**
 * Robot + glasses domain rules — demo
 *
 * Compiles the example store's rules, prints them in plain English, then
 * runs a day of requests through the evaluator and prints each decision.
 *
 * Run:
 *   npm run demo
 *   npm run demo --json   # also write domain-rules.json
 */

import { writeFileSync } from 'fs';
import { compileDomain, evaluateDomainAction, glassesZoneRules, renderDomainRules } from '../src/index';
import type { DomainRequest } from '../src/index';
import { store } from './store';

const rules = compileDomain(store);
console.log(renderDomainRules(rules));

if (process.argv.includes('--json')) {
  writeFileSync('domain-rules.json', JSON.stringify(rules, null, 2));
  console.log('Wrote domain-rules.json\n');
}

const robot = (id: string, roleId: string) => ({ id, kind: 'robot' as const, roleId });
const person = (id: string, roleId: string) => ({ id, kind: 'person' as const, roleId });

const day: Array<[string, DomainRequest]> = [
  ['Inventory robot drives down an empty aisle at 1.2 m/s',
    { participant: robot('r-1', 'inventory_robot'), action: 'move', zoneId: 'aisle-3', facts: { peopleInZone: 0, localTime: '09:00', requestedSpeedMps: 1.2 } }],
  ['Two shoppers walk into the aisle',
    { participant: robot('r-1', 'inventory_robot'), action: 'move', zoneId: 'aisle-3', facts: { peopleInZone: 2, localTime: '09:01', requestedSpeedMps: 1.0 } }],
  ['The robot wants to scan the shelf while they are there',
    { participant: robot('r-1', 'inventory_robot'), action: 'scan', zoneId: 'aisle-3', facts: { peopleInZone: 2, localTime: '09:01' } }],
  ['Inventory robot tries to pick up a box (its role can\'t)',
    { participant: robot('r-1', 'inventory_robot'), action: 'manipulate', zoneId: 'aisle-3', facts: { peopleInZone: 0, localTime: '09:05' } }],
  ['Restock robot heads to the back room — nobody there',
    { participant: robot('r-2', 'restock_robot'), action: 'enter_zone', zoneId: 'back-room', facts: { peopleInZone: 0, staffInZone: 0, localTime: '10:00', requestedSpeedMps: 0.8 } }],
  ['Restock robot asks to enter the electrical room',
    { participant: robot('r-2', 'restock_robot'), action: 'enter_zone', zoneId: 'electrical', facts: { peopleInZone: 0, localTime: '10:30', requestedSpeedMps: 0.5 } }],
  ['…and a manager approves it',
    { participant: robot('r-2', 'restock_robot'), action: 'enter_zone', zoneId: 'electrical', facts: { peopleInZone: 0, localTime: '10:31', requestedSpeedMps: 0.5, approvedBy: 'manager-dana' } }],
  ['A shopper\'s glasses try to take a photo',
    { participant: person('p-1', 'shopper'), action: 'camera_capture', zoneId: 'aisle-3', facts: { peopleInZone: 3, localTime: '12:00' } }],
  ['A staff member\'s glasses take a photo of a damaged shelf',
    { participant: person('s-1', 'staff'), action: 'camera_capture', zoneId: 'aisle-3', facts: { peopleInZone: 3, localTime: '12:01' } }],
  ['Staff tells the cleaning robot to go to checkout',
    { participant: person('s-1', 'staff'), action: 'command_robot', targetRobotId: 'r-3', zoneId: 'checkout', facts: { peopleInZone: 4, localTime: '13:00' } }],
  ['A shopper tries to command a robot (the shopper role doesn\'t list it)',
    { participant: person('p-1', 'shopper'), action: 'command_robot', targetRobotId: 'r-3', zoneId: 'checkout', facts: { peopleInZone: 4, localTime: '13:00' } }],
  ['Fire alarm: the inventory robot wants to keep moving',
    { participant: robot('r-1', 'inventory_robot'), action: 'move', zoneId: 'aisle-3', facts: { peopleInZone: 6, localTime: '15:00', emergency: true } }],
  ['Fire alarm: it returns to dock instead',
    { participant: robot('r-1', 'inventory_robot'), action: 'dock', zoneId: 'aisle-3', facts: { peopleInZone: 0, localTime: '15:02', emergency: true, requestedSpeedMps: 0.3 } }],
  ['After closing: the inventory robot wants to work',
    { participant: robot('r-1', 'inventory_robot'), action: 'move', zoneId: 'aisle-3', facts: { peopleInZone: 0, localTime: '23:30', requestedSpeedMps: 1.0 } }],
  ['After closing: the cleaning robot (marked for after-hours) works',
    { participant: robot('r-3', 'cleaning_robot'), action: 'move', zoneId: 'aisle-3', facts: { peopleInZone: 0, localTime: '23:30', requestedSpeedMps: 1.0 } }],
  ['A robot reports a zone nobody declared',
    { participant: robot('r-1', 'inventory_robot'), action: 'move', zoneId: 'loading-bay', facts: { peopleInZone: 0, localTime: '11:00' } }],
  ['A robot asks for an action no rule covers',
    { participant: robot('r-1', 'inventory_robot'), action: 'open_door', zoneId: 'entrance', facts: { peopleInZone: 0, localTime: '11:00' } }],
];

console.log('## A day in the store\n');
for (const [what, request] of day) {
  const d = evaluateDomainAction(rules, request);
  const extra = [
    d.limits?.maxSpeedMps !== undefined ? `max ${d.limits.maxSpeedMps} m/s` : '',
    d.then ? `then ${d.then}` : '',
  ].filter(Boolean).join(', ');
  console.log(`${d.status.padEnd(5)}  ${what}${extra ? `  (${extra})` : ''}`);
  for (const r of d.reasons) console.log(`       ${r.ruleId}: ${r.reason}`);
}

console.log('\n## What a shopper\'s glasses enforce in Aisle 3\n');
const shopperGlasses = glassesZoneRules(rules, 'aisle-3', 'shopper');
console.log(`camera: ${shopperGlasses.camera}, microphone: ${shopperGlasses.microphone}`);
console.log(`\nRule set fingerprint: ${rules.fingerprint}`);
