/**
 * Domain Evaluator — one request in, one decision out.
 *
 *   evaluateDomainAction(ruleSet, request) → DomainDecision
 *
 * Pure and synchronous: no clock (time comes in `facts.localTime`), no
 * network, no LLM. Every check that runs is recorded in `trace`, and the
 * decision is the strictest check: BLOCK > PAUSE > LIMIT > ALLOW.
 *
 * Two kinds of PAUSE:
 *   - approval — a person must approve this action. Re-send the same request
 *                with `facts.approvedBy` set and it goes through.
 *   - wait     — the situation must change (people leave, staff arrive).
 *                `approvedBy` does not override these.
 *
 * Call it before every robot action and every glasses action. For
 * `command_robot`, evaluate the glasses wearer's command here, then evaluate
 * the robot's resulting action as its own request — a command never
 * bypasses the robot's rules.
 */

import { captureLevel, validateTime } from './compile';
import type {
  DomainCheck,
  DomainDecision,
  DomainDecisionStatus,
  DomainRequest,
  DomainRuleSet,
  RobotAction,
} from './types';
import { GLASSES_ACTIONS, ROBOT_ACTIONS } from './types';

const SEVERITY: Record<DomainDecisionStatus, number> = { ALLOW: 0, LIMIT: 1, PAUSE: 2, BLOCK: 3 };
const MOVEMENT: readonly string[] = ['move', 'enter_zone', 'dock'] satisfies RobotAction[];

export function evaluateDomainAction(ruleSet: DomainRuleSet, request: DomainRequest): DomainDecision {
  const { policy } = ruleSet;
  const { participant, action, facts } = request;
  const trace: DomainCheck[] = [];
  const check = (ruleId: string, status: DomainDecisionStatus, reason: string) => { trace.push({ ruleId, status, reason }); };
  const needsApproval = (ruleId: string, what: string) => {
    if (facts.approvedBy) check(ruleId, 'ALLOW', `${what} — approved by ${facts.approvedBy}.`);
    else check(ruleId, 'PAUSE', `${what} — needs a person's approval.`);
  };
  let limits: DomainDecision['limits'];
  let then: DomainDecision['then'];
  const decide = () => finish(trace, ruleSet.fingerprint, limits, then);

  validateTime(facts.localTime, 'facts.localTime');

  // 1. Zone and role must be declared.
  const zone = ruleSet.zones.find(z => z.zoneId === request.zoneId);
  if (!zone) {
    check('zone_declared', 'BLOCK', `Zone "${request.zoneId}" is not declared for ${ruleSet.site.name}.`);
    return decide();
  }
  const role = ruleSet.roles.find(r => r.roleId === participant.roleId);
  if (!role || role.kind !== participant.kind) {
    check('role_declared', 'BLOCK', `"${participant.roleId}" is not a declared ${participant.kind} role.`);
    return decide();
  }

  // 2. Actions nobody wrote a rule for.
  const known = participant.kind === 'robot'
    ? (ROBOT_ACTIONS as readonly string[]).includes(action)
    : (GLASSES_ACTIONS as readonly string[]).includes(action);
  if (!known) {
    if (policy.unknownActions === 'block') check('unknown_actions', 'BLOCK', `No rule covers "${action}" for a ${participant.kind}.`);
    else needsApproval('unknown_actions', `No rule covers "${action}" for a ${participant.kind}`);
    return decide();
  }

  // 3. The role must list the action.
  if (!(role.actions as string[]).includes(action)) {
    check('role_permits_action', 'BLOCK', `${role.name} may not ${label(action)}.`);
    return decide();
  }
  check('role_permits_action', 'ALLOW', `${role.name} may ${label(action)}.`);

  // 4. Emergency.
  if (facts.emergency) {
    if (participant.kind === 'robot') {
      if (action === 'dock' && policy.emergency === 'stop_then_dock') {
        check('emergency', 'ALLOW', 'Emergency: robots may return to dock.');
      } else {
        check('emergency_stop', 'BLOCK', 'Emergency: robots stop.');
        if (policy.emergency === 'stop_then_dock') then = 'dock';
        return decide();
      }
    } else if (action === 'command_robot') {
      check('emergency_stop', 'BLOCK', 'Emergency: nobody commands robots from glasses.');
      return decide();
    }
  }

  return participant.kind === 'robot' ? robot() : glasses();

  function robot(): DomainDecision {
    // Opening hours.
    if (!facts.emergency && !isOpen(facts.localTime, ruleSet.site.hours)) {
      if (policy.robotsAfterHours === 'never') check('robots_after_hours', 'BLOCK', `${ruleSet.site.name} is closed; robots do not work after hours.`);
      else if (policy.robotsAfterHours === 'listed_roles' && !role!.afterHours) check('robots_after_hours', 'BLOCK', `${ruleSet.site.name} is closed and ${role!.name} is not marked for after-hours work.`);
      else check('robots_after_hours', 'ALLOW', 'After-hours work is permitted for this robot.');
    }

    // Zone kind.
    if (zone!.kind === 'staff_only') {
      if (policy.robotsInStaffZones === 'never') check('robots_staff_zones', 'BLOCK', `${zone!.name} is staff-only; robots never go there.`);
      else if (policy.robotsInStaffZones === 'when_staff_present' && (facts.staffInZone ?? 0) === 0) check('robots_staff_zones', 'PAUSE', `${zone!.name} is staff-only; wait until staff are there.`);
    }
    if (zone!.kind === 'restricted') {
      if (policy.robotsInRestrictedZones === 'never') check('robots_restricted_zones', 'BLOCK', `${zone!.name} is restricted; robots never go there.`);
      else needsApproval('robots_restricted_zones', `${zone!.name} is restricted`);
    }

    // People in the zone.
    const people = facts.peopleInZone > 0;
    if (people && action === 'scan') {
      if (policy.robotScanNearPeople === 'never') check('robot_scan_near_people', 'BLOCK', `${facts.peopleInZone} people in ${zone!.name}; robots do not scan near people.`);
      else if (policy.robotScanNearPeople === 'pause') check('robot_scan_near_people', 'PAUSE', `${facts.peopleInZone} people in ${zone!.name}; wait until the zone is clear to scan.`);
    }
    if (people && policy.robotsNearPeople === 'stop' && (MOVEMENT.includes(action) || action === 'manipulate')) {
      check('robots_near_people', 'PAUSE', `${facts.peopleInZone} people in ${zone!.name}; robots stop until they leave.`);
    }

    // Speed, for movement.
    if (MOVEMENT.includes(action)) {
      let cap = policy.maxSpeedMps;
      let capRule = 'robot_speed';
      if (zone!.maxSpeedMps !== undefined && zone!.maxSpeedMps < cap) { cap = zone!.maxSpeedMps; capRule = 'zone_speed_cap'; }
      if (people && policy.robotsNearPeople === 'slow' && policy.nearPeopleSpeedMps < cap) { cap = policy.nearPeopleSpeedMps; capRule = 'robots_near_people'; }
      limits = { maxSpeedMps: cap };
      const asked = facts.requestedSpeedMps;
      if (asked === undefined) check(capRule, 'LIMIT', `Move at most ${cap} m/s in ${zone!.name}.`);
      else if (asked > cap) check(capRule, 'LIMIT', `Asked for ${asked} m/s; at most ${cap} m/s in ${zone!.name}.`);
      else check(capRule, 'ALLOW', `${asked} m/s is within the ${cap} m/s cap.`);
    }

    return decide();
  }

  function glasses(): DomainDecision {
    if (action === 'camera_capture' || action === 'record_audio') {
      const level = captureLevel(policy.glassesCapture, role!.isStaff === true);
      if (level === 'blocked') check('glasses_capture', 'BLOCK', `Glasses may not ${label(action)} here${policy.glassesCapture === 'staff_only' ? ' (staff only)' : ''}.`);
      else if (level === 'confirm_each') needsApproval('glasses_capture', `The wearer must confirm before glasses ${label(action)}`);
      else check('glasses_capture', 'ALLOW', `Glasses may ${label(action)} here.`);
    }
    if (action === 'command_robot') {
      if (!request.targetRobotId) check('robot_commands', 'BLOCK', 'Say which robot is being commanded (targetRobotId).');
      else if (policy.robotCommands === 'nobody') check('robot_commands', 'BLOCK', 'Nobody commands robots from glasses.');
      else if (policy.robotCommands === 'staff_only' && !role!.isStaff) check('robot_commands', 'BLOCK', 'Only staff may command robots.');
      else if (policy.robotCommands === 'anyone_with_approval' && !role!.isStaff) needsApproval('robot_commands', `${role!.name} commanding ${request.targetRobotId}`);
      else check('robot_commands', 'ALLOW', `Staff may command ${request.targetRobotId}; the robot's own rules still apply.`);
    }
    return decide();
  }
}

function finish(
  trace: DomainCheck[],
  fingerprint: string,
  limits: DomainDecision['limits'],
  then: DomainDecision['then'],
): DomainDecision {
  let status: DomainDecisionStatus = 'ALLOW';
  for (const c of trace) if (SEVERITY[c.status] > SEVERITY[status]) status = c.status;
  const reasons = trace.filter(c => c.status === status);
  return {
    status,
    reasons,
    ...(status === 'LIMIT' || (status === 'ALLOW' && limits) ? { limits } : {}),
    ...(then ? { then } : {}),
    trace,
    fingerprint,
  };
}

/** Is "HH:MM" within opening hours? Handles overnight hours; open === close means always open. */
export function isOpen(localTime: string, hours: { open: string; close: string }): boolean {
  const t = minutes(localTime), open = minutes(hours.open), close = minutes(hours.close);
  if (open === close) return true;
  return open < close ? t >= open && t < close : t >= open || t < close;
}

function minutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

const PHRASES: Record<string, string> = {
  enter_zone: 'enter this zone',
  move: 'move',
  manipulate: 'pick up or handle things',
  scan: 'scan',
  dock: 'dock',
  camera_capture: 'take photos or video',
  record_audio: 'record audio',
  ai_overlay: 'show AI overlays',
  share_location: 'share location',
  command_robot: 'command robots',
};

function label(action: string): string {
  return PHRASES[action] ?? action.replace(/_/g, ' ');
}
