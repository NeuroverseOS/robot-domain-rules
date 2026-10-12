/**
 * Domain Questions — what a site operator answers to set the rules.
 *
 * Ten plain-language questions. Each answer sets one field of the
 * DomainPolicy and produces one plain-English rule. The default answer is
 * always the safe one, so an unanswered question never loosens anything.
 *
 * To add a question: add an entry here with a `policyField` and `values`,
 * add the field to DomainPolicy in types.ts, and read it in evaluate.ts.
 */

import type { DomainPolicy } from './types';

export interface DomainAnswerOption {
  value: string;
  label: string;
  /** The rule this answer produces, in plain English. */
  rule: string;
  /** The policy values this answer sets. */
  sets: Partial<DomainPolicy>;
}

export interface DomainQuestion {
  id: string;
  /** 'robots' or 'glasses' — who the question governs. */
  governs: 'robots' | 'glasses' | 'site';
  prompt: string;
  options: DomainAnswerOption[];
  /** Index of the safe default. */
  defaultIndex: number;
}

export const DOMAIN_QUESTIONS: DomainQuestion[] = [
  {
    id: 'robots_near_people',
    governs: 'robots',
    prompt: 'When people are in the same zone as a robot, what should the robot do?',
    defaultIndex: 0,
    options: [
      { value: 'stop', label: 'Stop until they leave', rule: 'Robots stop moving while people are in their zone.', sets: { robotsNearPeople: 'stop' } },
      { value: 'slow', label: 'Slow down', rule: 'Robots slow to the near-people speed while people are in their zone.', sets: { robotsNearPeople: 'slow' } },
      { value: 'continue', label: 'Carry on at normal speed', rule: 'Robots keep normal speed when people are in their zone.', sets: { robotsNearPeople: 'continue' } },
    ],
  },
  {
    id: 'robot_speed',
    governs: 'robots',
    prompt: 'How fast may robots move?',
    defaultIndex: 0,
    options: [
      { value: 'careful', label: 'Careful (0.5 m/s, 0.2 near people)', rule: 'Robots move at most 0.5 m/s, and 0.2 m/s near people.', sets: { maxSpeedMps: 0.5, nearPeopleSpeedMps: 0.2 } },
      { value: 'walking', label: 'Walking pace (1.0 m/s, 0.3 near people)', rule: 'Robots move at most 1.0 m/s, and 0.3 m/s near people.', sets: { maxSpeedMps: 1.0, nearPeopleSpeedMps: 0.3 } },
      { value: 'brisk', label: 'Brisk (1.5 m/s, 0.5 near people)', rule: 'Robots move at most 1.5 m/s, and 0.5 m/s near people.', sets: { maxSpeedMps: 1.5, nearPeopleSpeedMps: 0.5 } },
    ],
  },
  {
    id: 'robots_staff_zones',
    governs: 'robots',
    prompt: 'May robots go into staff-only zones?',
    defaultIndex: 0,
    options: [
      { value: 'never', label: 'Never', rule: 'Robots never enter staff-only zones.', sets: { robotsInStaffZones: 'never' } },
      { value: 'when_staff_present', label: 'Only when staff are there', rule: 'Robots enter staff-only zones only while staff are in them.', sets: { robotsInStaffZones: 'when_staff_present' } },
      { value: 'allowed', label: 'Yes', rule: 'Robots may enter staff-only zones.', sets: { robotsInStaffZones: 'allowed' } },
    ],
  },
  {
    id: 'robots_restricted_zones',
    governs: 'robots',
    prompt: 'May robots go into restricted zones?',
    defaultIndex: 0,
    options: [
      { value: 'never', label: 'Never', rule: 'Robots never enter restricted zones.', sets: { robotsInRestrictedZones: 'never' } },
      { value: 'with_approval', label: 'Only when a person approves each time', rule: 'Robots enter restricted zones only with a person\'s approval each time.', sets: { robotsInRestrictedZones: 'with_approval' } },
    ],
  },
  {
    id: 'robots_after_hours',
    governs: 'robots',
    prompt: 'May robots work outside opening hours?',
    defaultIndex: 0,
    options: [
      { value: 'never', label: 'No', rule: 'Robots do not work outside opening hours.', sets: { robotsAfterHours: 'never' } },
      { value: 'listed_roles', label: 'Only robot roles marked for after-hours work', rule: 'Outside opening hours, only robot roles marked for after-hours work may work.', sets: { robotsAfterHours: 'listed_roles' } },
      { value: 'allowed', label: 'Yes', rule: 'Robots may work outside opening hours.', sets: { robotsAfterHours: 'allowed' } },
    ],
  },
  {
    id: 'robot_scan_near_people',
    governs: 'robots',
    prompt: 'May robots scan (cameras, lidar) while people are in the zone?',
    defaultIndex: 0,
    options: [
      { value: 'never', label: 'No', rule: 'Robots do not scan while people are in the zone.', sets: { robotScanNearPeople: 'never' } },
      { value: 'pause', label: 'Wait until the zone is clear', rule: 'Robot scans wait until the zone is clear of people.', sets: { robotScanNearPeople: 'pause' } },
      { value: 'allowed', label: 'Yes', rule: 'Robots may scan while people are in the zone.', sets: { robotScanNearPeople: 'allowed' } },
    ],
  },
  {
    id: 'glasses_capture',
    governs: 'glasses',
    prompt: 'May smart glasses take photos, video or audio in this site?',
    defaultIndex: 0,
    options: [
      { value: 'blocked', label: 'No', rule: 'Glasses do not capture photos, video or audio here.', sets: { glassesCapture: 'blocked' } },
      { value: 'staff_only', label: 'Staff only', rule: 'Only staff glasses may capture photos, video or audio here.', sets: { glassesCapture: 'staff_only' } },
      { value: 'confirm_each', label: 'Yes, but the wearer confirms each time', rule: 'Glasses capture only after the wearer confirms each time.', sets: { glassesCapture: 'confirm_each' } },
      { value: 'allowed', label: 'Yes', rule: 'Glasses may capture photos, video and audio here.', sets: { glassesCapture: 'allowed' } },
    ],
  },
  {
    id: 'robot_commands',
    governs: 'glasses',
    prompt: 'Who may give robots commands from their glasses?',
    defaultIndex: 0,
    options: [
      { value: 'nobody', label: 'Nobody', rule: 'Nobody commands robots from glasses.', sets: { robotCommands: 'nobody' } },
      { value: 'staff_only', label: 'Staff only', rule: 'Only staff may command robots from glasses.', sets: { robotCommands: 'staff_only' } },
      { value: 'anyone_with_approval', label: 'Anyone, with staff approval each time', rule: 'Anyone may command robots from glasses, with staff approval each time.', sets: { robotCommands: 'anyone_with_approval' } },
    ],
  },
  {
    id: 'emergency',
    governs: 'site',
    prompt: 'In an emergency, after robots stop, what should they do?',
    defaultIndex: 0,
    options: [
      { value: 'stop_all', label: 'Stay stopped', rule: 'In an emergency, all robots stop and stay stopped.', sets: { emergency: 'stop_all' } },
      { value: 'stop_then_dock', label: 'Stop, then return to dock when told', rule: 'In an emergency, all robots stop; the only thing they may do is return to dock.', sets: { emergency: 'stop_then_dock' } },
    ],
  },
  {
    id: 'unknown_actions',
    governs: 'site',
    prompt: 'If something asks to do an action no rule covers, what happens?',
    defaultIndex: 0,
    options: [
      { value: 'block', label: 'Block it', rule: 'Actions no rule covers are blocked.', sets: { unknownActions: 'block' } },
      { value: 'pause', label: 'Pause and ask a person', rule: 'Actions no rule covers wait for a person\'s approval.', sets: { unknownActions: 'pause' } },
    ],
  },
];

/** The answers every new builder starts with: the safe default for each question. */
export function defaultDomainAnswers(): Record<string, string> {
  const answers: Record<string, string> = {};
  for (const q of DOMAIN_QUESTIONS) answers[q.id] = q.options[q.defaultIndex].value;
  return answers;
}
