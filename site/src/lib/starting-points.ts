/**
 * Starting points — the three repo examples and an empty site — and the
 * scenario presets for each. The grocery store keeps the example's two
 * deliberately conflicting manager rules, so the first visit shows an
 * authority-override and a contradiction finding.
 *
 * To add a scenario preset: add a { label, request } to the list for its
 * starting point. The request is exactly what evaluateDomainAction receives.
 */

import type { CompileDomainInput, DomainRequest } from '../../../src/index';
import { builder as groceryBuilder } from '../../../examples/grocery-store';
import { builder as warehouseBuilder } from '../../../examples/warehouse';
import { clinic as clinicInput } from '../../../examples/clinic';
import { cloneJson, type RulebookState, type StartingPointId } from './model';

export interface ScenarioPreset {
  label: string;
  request: DomainRequest;
}

export interface StartingPoint {
  id: StartingPointId;
  name: string;
  blurb: string;
  input: () => CompileDomainInput;
  actingAs: string;
  presets: ScenarioPreset[];
}

/** The builder keeps the Template object; the switchboard keeps its ID so the state is plain JSON (the core resolves IDs). */
function plainInput(input: CompileDomainInput): CompileDomainInput {
  const { template, ...rest } = input;
  const cloned = cloneJson(rest) as CompileDomainInput;
  if (template) cloned.template = typeof template === 'string' ? template : template.id;
  return cloned;
}

const robot = (id: string, roleId: string) => ({ id, kind: 'robot', roleId });
const person = (id: string, roleId: string) => ({ id, kind: 'person', roleId });

const groceryFacts = (localTime: string, extra: Record<string, unknown> = {}) => ({ localTime, day: 'sat', peopleInZone: 0, ...extra });
const warehouseFacts = (localTime: string, extra: Record<string, unknown> = {}) => ({ localTime, peopleInArea: 0, robotsInArea: 0, ...extra });
const clinicFacts = (localTime: string, extra: Record<string, unknown> = {}) => ({ localTime, patient_present: false, ...extra });

export const STARTING_POINTS: StartingPoint[] = [
  {
    id: 'grocery',
    name: 'Grocery store',
    blurb: 'Robots on the floor; staff and shoppers wearing glasses. Two of the manager\'s rules are at odds on purpose.',
    input: () => plainInput(groceryBuilder.toInput()),
    actingAs: 'site-manager',
    presets: [
      { label: 'Robot drives down an empty aisle', request: { participant: robot('r-1', 'inventory_robot'), action: 'move', areaId: 'aisle-3', facts: groceryFacts('09:00', { requestedSpeedMps: 1.2 }) } },
      { label: 'Shoppers arrive in aisle 3', request: { participant: robot('r-1', 'inventory_robot'), action: 'move', areaId: 'aisle-3', facts: groceryFacts('09:01', { peopleInZone: 2, requestedSpeedMps: 1.0 }) } },
      { label: 'Robot wants to scan the shelf while they are there', request: { participant: robot('r-1', 'inventory_robot'), action: 'scan', areaId: 'aisle-3', facts: groceryFacts('09:01', { peopleInZone: 2 }) } },
      { label: 'Restock robot in aisle 3, Saturday afternoon', request: { participant: robot('r-2', 'restock_robot'), action: 'move', areaId: 'aisle-3', facts: groceryFacts('14:30', { requestedSpeedMps: 0.5 }) } },
      { label: 'Restock robot heads to the back room, nobody there', request: { participant: robot('r-2', 'restock_robot'), action: 'enter_zone', areaId: 'back-room', facts: groceryFacts('10:00', { staffInZone: 0, requestedSpeedMps: 0.8 }) } },
      { label: 'Robot asks to enter the electrical room', request: { participant: robot('r-2', 'restock_robot'), action: 'enter_zone', areaId: 'electrical', facts: groceryFacts('10:30', { requestedSpeedMps: 0.5 }) } },
      { label: 'Manager approves the electrical room', request: { participant: robot('r-2', 'restock_robot'), action: 'enter_zone', areaId: 'electrical', facts: groceryFacts('10:31', { requestedSpeedMps: 0.5, approvedBy: { id: 'manager-dana', authority: 'site-manager' } }) } },
      { label: 'Robot at the checkout at 1 m/s', request: { participant: robot('r-1', 'inventory_robot'), action: 'move', areaId: 'checkout', facts: groceryFacts('11:00', { requestedSpeedMps: 1.0 }) } },
      { label: 'Shopper\'s glasses take a photo at the entrance', request: { participant: person('p-1', 'shopper'), action: 'camera_capture', areaId: 'entrance', facts: groceryFacts('12:00', { peopleInZone: 3 }) } },
      { label: 'Staff record audio in the back room at lunch', request: { participant: person('s-1', 'staff'), action: 'record_audio', areaId: 'back-room', facts: groceryFacts('12:30', { peopleInZone: 1 }) } },
      { label: 'Staff tell the cleaning robot to go to checkout', request: { participant: person('s-1', 'staff'), action: 'command_robot', areaId: 'checkout', facts: groceryFacts('13:00', { peopleInZone: 4, targetRobotId: 'r-3' }) } },
      { label: 'Fire alarm: robot wants to keep moving', request: { participant: robot('r-1', 'inventory_robot'), action: 'move', areaId: 'aisle-3', facts: groceryFacts('15:00', { peopleInZone: 6, emergency: true }) } },
      { label: 'Fire alarm: robot returns to dock instead', request: { participant: robot('r-1', 'inventory_robot'), action: 'dock', areaId: 'aisle-3', facts: groceryFacts('15:02', { emergency: true, requestedSpeedMps: 0.3 }) } },
      { label: 'After closing: the cleaning robot works', request: { participant: robot('r-3', 'cleaning_robot'), action: 'move', areaId: 'aisle-3', facts: groceryFacts('23:30', { requestedSpeedMps: 1.0 }) } },
      { label: 'After closing: the inventory robot tries too', request: { participant: robot('r-1', 'inventory_robot'), action: 'move', areaId: 'aisle-3', facts: groceryFacts('23:31', { requestedSpeedMps: 1.0 }) } },
      { label: 'A robot asks for an action nobody declared', request: { participant: robot('r-1', 'inventory_robot'), action: 'open_door', areaId: 'entrance', facts: groceryFacts('11:00') } },
    ],
  },
  {
    id: 'warehouse',
    name: 'Warehouse',
    blurb: 'Forklift-style robots in aisles; pickers wearing glasses; a charging dock.',
    input: () => plainInput(warehouseBuilder.toInput()),
    actingAs: 'site-manager',
    presets: [
      { label: 'Forklift robot enters an empty aisle', request: { participant: robot('f-1', 'forklift_robot'), action: 'enter', areaId: 'aisle-a', facts: warehouseFacts('08:00', { requestedSpeedMps: 1.2 }) } },
      { label: 'A picker is in the aisle', request: { participant: robot('f-1', 'forklift_robot'), action: 'move', areaId: 'aisle-a', facts: warehouseFacts('08:05', { peopleInArea: 1 }) } },
      { label: 'Two robots already in aisle B; a third wants in', request: { participant: robot('f-3', 'forklift_robot'), action: 'enter', areaId: 'aisle-b', facts: warehouseFacts('08:10', { robotsInArea: 2 }) } },
      { label: 'Robot in aisle B at 1.2 m/s (manager cap 0.5)', request: { participant: robot('f-1', 'forklift_robot'), action: 'move', areaId: 'aisle-b', facts: warehouseFacts('08:15', { requestedSpeedMps: 1.2 }) } },
      { label: 'A picker walks into the charging dock', request: { participant: person('p-1', 'picker'), action: 'enter', areaId: 'dock-1', facts: warehouseFacts('09:00') } },
      { label: 'A supervisor approves the picker', request: { participant: person('p-1', 'picker'), action: 'enter', areaId: 'dock-1', facts: warehouseFacts('09:01', { approvedBy: { id: 'sam', roleId: 'supervisor' } }) } },
      { label: 'Another picker approves (not enough)', request: { participant: person('p-1', 'picker'), action: 'enter', areaId: 'dock-1', facts: warehouseFacts('09:02', { approvedBy: { id: 'pat', roleId: 'picker' } }) } },
      { label: 'Forklift robot tries the office', request: { participant: robot('f-1', 'forklift_robot'), action: 'enter', areaId: 'office', facts: warehouseFacts('10:00') } },
      { label: 'Alarm: robot wants to lift', request: { participant: robot('f-1', 'forklift_robot'), action: 'lift', areaId: 'aisle-a', facts: warehouseFacts('11:00', { emergency: true }) } },
    ],
  },
  {
    id: 'clinic',
    name: 'Clinic',
    blurb: 'No template. Its own actions, facts and authorities; a charge nurse tries to loosen a clinic rule.',
    input: () => plainInput(clinicInput),
    actingAs: 'charge-nurse',
    presets: [
      { label: 'Medication robot wants to deliver in Ward A', request: { participant: robot('m-1', 'med_robot'), action: 'deliver_meds', areaId: 'ward-a', facts: clinicFacts('09:00') } },
      { label: 'A nurse approves (not a pharmacist)', request: { participant: robot('m-1', 'med_robot'), action: 'deliver_meds', areaId: 'ward-a', facts: clinicFacts('09:01', { approvedBy: { id: 'nurse-lee', roleId: 'nurse' } }) } },
      { label: 'The pharmacist approves', request: { participant: robot('m-1', 'med_robot'), action: 'deliver_meds', areaId: 'ward-a', facts: clinicFacts('09:02', { approvedBy: { id: 'pharm-kim', roleId: 'pharmacist' } }) } },
      { label: 'A patient is being seen in Ward B', request: { participant: robot('m-1', 'med_robot'), action: 'enter', areaId: 'ward-b', facts: clinicFacts('10:00', { patient_present: true, requestedSpeedMps: 0.4 }) } },
      { label: 'Cleaning robot through Ward A at midnight', request: { participant: robot('c-1', 'clean_robot'), action: 'move', areaId: 'ward-a', facts: clinicFacts('00:30', { requestedSpeedMps: 0.3 }) } },
      { label: 'Visitor enters Ward B in isolation', request: { participant: person('v-1', 'visitor'), action: 'enter', areaId: 'ward-b', facts: clinicFacts('11:00', { ward_status: 'isolation' }) } },
      { label: 'Nurse takes a photo in Ward A', request: { participant: person('n-1', 'nurse'), action: 'camera_capture', areaId: 'ward-a', facts: clinicFacts('11:30') } },
      { label: 'A request without patient_present', request: { participant: robot('m-1', 'med_robot'), action: 'move', areaId: 'ward-a', facts: { localTime: '12:00' } } },
    ],
  },
  {
    id: 'empty',
    name: 'Empty',
    blurb: 'No template. One area, one role, one action (the least a rulebook needs). Add your own, then write rules.',
    input: () => ({
      site: { id: 'my-site', name: 'My site' },
      kinds: ['robot', 'person'],
      authorities: [{ id: 'law-and-safety', name: 'Law and safety' }, { id: 'site-manager', name: 'Site manager' }],
      actions: [{ id: 'move', name: 'move', kinds: ['robot'], tags: ['movement'] }],
      facts: [{ id: 'peopleInArea', type: 'number', integer: true, min: 0, required: true, description: 'People in the area.' }, { id: 'requestedSpeedMps', type: 'number', min: 0, description: 'Requested speed in m/s. Absent means "cap me".' }],
      limits: [{ id: 'maxSpeedMps', name: 'top speed', unit: 'm/s', requestedFact: 'requestedSpeedMps', appliesTo: 'tag:movement' }],
      tags: { actions: ['movement'], areas: ['public'], roles: ['staff'] },
      areas: [{ id: 'floor', name: 'Floor', tags: ['public'] }],
      roles: [{ id: 'robot', name: 'Robot', kind: 'robot', actions: ['move'] }],
      rules: [],
    }),
    actingAs: 'site-manager',
    presets: [],
  },
];

export function startingPoint(id: StartingPointId): StartingPoint {
  return STARTING_POINTS.find(s => s.id === id) ?? STARTING_POINTS[0];
}

export function freshState(id: StartingPointId): RulebookState {
  const sp = startingPoint(id);
  return { startingPoint: id, input: sp.input(), disabledRuleIds: [], actingAs: sp.actingAs };
}
