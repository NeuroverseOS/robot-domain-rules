/**
 * Domain Rules — Type Definitions
 *
 * A domain is one physical site (a store, a warehouse, a clinic) where robots
 * and people wearing smart glasses work side by side. The site operator
 * declares zones and roles and answers a short set of questions. The result
 * is one rule set that governs both robots and glasses.
 *
 * Location is NOT this module's job. The spatial system (e.g. Auki's posemesh)
 * decides which zone a participant is in and passes that zone ID in. This
 * module only decides what that participant may do there.
 *
 *   posemesh: "robot-7 is in zone aisle-3, 2 people are in aisle-3"
 *        │
 *        ▼
 *   evaluateDomainAction(ruleSet, request)  →  ALLOW | LIMIT | PAUSE | BLOCK
 *                                              + the rules that decided it
 *
 * Everything here is plain data and pure functions. No clock, no network,
 * no LLM. Same rule set + same request = same decision.
 */

// ─── Participants ────────────────────────────────────────────────────────────

/** Who is acting. People are assumed to be wearing smart glasses. */
export type ParticipantKind = 'robot' | 'person';

/** Things a robot can ask to do. */
export type RobotAction =
  | 'enter_zone'   // cross into a zone
  | 'move'         // drive / navigate within a zone
  | 'manipulate'   // pick, place, open, push — any arm or tool use
  | 'scan'         // capture images / point clouds (cameras, lidar)
  | 'dock';        // go to or use a charging / docking station

/** Things the AI on a person's glasses can ask to do. */
export type GlassesAction =
  | 'camera_capture'   // take a photo or video
  | 'record_audio'     // record or transcribe audio
  | 'ai_overlay'       // show AI content in the wearer's view
  | 'share_location'   // share the wearer's position
  | 'command_robot';   // tell a robot what to do

export type DomainAction = RobotAction | GlassesAction;

export const ROBOT_ACTIONS: readonly RobotAction[] = ['enter_zone', 'move', 'manipulate', 'scan', 'dock'];
export const GLASSES_ACTIONS: readonly GlassesAction[] = ['camera_capture', 'record_audio', 'ai_overlay', 'share_location', 'command_robot'];

// ─── Zones ───────────────────────────────────────────────────────────────────

/**
 * What a zone is for. The kind decides which questions apply to it.
 *
 *   public      — open to customers and visitors (sales floor, aisles)
 *   staff_only  — staff work areas (back room, stock room)
 *   restricted  — nobody goes in without approval (electrical, pharmacy)
 *   dock        — robot charging / parking
 */
export type ZoneKind = 'public' | 'staff_only' | 'restricted' | 'dock';

export interface DomainZone {
  /** The zone ID your spatial system reports (e.g. a posemesh zone or anchor ID). */
  zoneId: string;
  /** Human-readable name ("Aisle 3", "Back room"). */
  name: string;
  kind: ZoneKind;
  /** Optional per-zone speed cap in metres per second. Tighter of this and the site cap wins. */
  maxSpeedMps?: number;
  /**
   * Only these roles (by role ID, any participant kind) may act in this zone.
   * A role must be listed itself: inheriting a listed role's actions does
   * not pass its zone permission. Omit to allow every declared role.
   */
  allowRoles?: string[];
  /** These roles (by role ID) may never act in this zone. Checked before allowRoles. */
  denyRoles?: string[];
}

// ─── Roles ───────────────────────────────────────────────────────────────────

export interface DomainRole {
  /** Role ID used in requests ("cleaning_robot", "staff", "shopper"). */
  roleId: string;
  name: string;
  kind: ParticipantKind;
  /** Actions this role may take at all. Zone and situation rules can still say no. */
  actions: DomainAction[];
  /** Inherit another role's actions (same kind only). Inheritance can only add, never remove. */
  inherits?: string;
  /** People only: counts as staff (staff zones, robot commands, staff-only camera). */
  isStaff?: boolean;
  /** Robots only: may work outside opening hours when after-hours work is limited to listed roles. */
  afterHours?: boolean;
}

// ─── Site ────────────────────────────────────────────────────────────────────

export interface DomainSite {
  /** Your ID for this site. */
  domainId: string;
  name: string;
  /** Optional: the posemesh (or other spatial system) domain ID this rule set is for. */
  spatialDomainId?: string;
  /** Opening hours, 24h "HH:MM" local time. Close may be earlier than open for overnight sites. */
  hours: { open: string; close: string };
}

// ─── Compiled policy ─────────────────────────────────────────────────────────

/** The answers, turned into the structured policy the evaluator reads. */
export interface DomainPolicy {
  /** What robots do when people are in their zone. */
  robotsNearPeople: 'stop' | 'slow' | 'continue';
  /** Site-wide robot speed cap, m/s. */
  maxSpeedMps: number;
  /** Speed cap when people are in the zone and robotsNearPeople is 'slow', m/s. */
  nearPeopleSpeedMps: number;
  /** Robots in staff-only zones. */
  robotsInStaffZones: 'never' | 'when_staff_present' | 'allowed';
  /** Robots in restricted zones. */
  robotsInRestrictedZones: 'never' | 'with_approval';
  /** Robots outside opening hours. */
  robotsAfterHours: 'never' | 'listed_roles' | 'allowed';
  /** Robot scanning while people are in the zone. */
  robotScanNearPeople: 'never' | 'pause' | 'allowed';
  /** Glasses camera / audio in the domain. */
  glassesCapture: 'blocked' | 'staff_only' | 'confirm_each' | 'allowed';
  /** Who may command robots from their glasses. */
  robotCommands: 'nobody' | 'staff_only' | 'anyone_with_approval';
  /** What happens in an emergency. Robots always stop; this says what comes after. */
  emergency: 'stop_all' | 'stop_then_dock';
  /** Actions no rule covers. */
  unknownActions: 'block' | 'pause';
}

export interface CompiledDomainRule {
  /** Stable rule ID, cited in every decision. */
  ruleId: string;
  /** The rule in plain English. */
  text: string;
  /** Which question produced it ('site' for zone/role declarations). */
  sourceQuestion: string;
  sourceAnswer: string;
}

/**
 * The complete, portable rule set for one domain. Plain JSON — store it, sign it, ship it.
 *
 * `compileDomain` returns it deep-frozen and detached from the input: editing
 * the input afterwards changes nothing here, and editing this object throws.
 * `verifyFingerprint(ruleSet)` recomputes the fingerprint of a copy received
 * as JSON and says whether it still matches.
 */
export interface DomainRuleSet {
  format: 'neuroverse-domain-rules/1';
  site: DomainSite;
  zones: DomainZone[];
  /** Roles with inheritance already resolved (actions are the full set). */
  roles: DomainRole[];
  answers: Record<string, string>;
  policy: DomainPolicy;
  rules: CompiledDomainRule[];
  /** Deterministic fingerprint of everything above. Cite it in logs to prove which rules decided. */
  fingerprint: string;
}

// ─── Requests and decisions ──────────────────────────────────────────────────

/**
 * Live facts your system supplies with each request. The evaluator never
 * guesses them: a required fact that is missing or invalid gives BLOCK with
 * rule `required_facts`, never a crash and never permission. Absent optional
 * facts take the conservative reading noted on each field.
 */
export interface DomainFacts {
  /** People (not robots) currently in the zone, as your spatial system reports. Required; a whole number, 0 or more. */
  peopleInZone: number;
  /** Staff currently in the zone. A whole number, 0 or more. Absent means 0 (the conservative reading). */
  staffInZone?: number;
  /** Local time as "HH:MM" (24h). Required: the evaluator has no clock. */
  localTime: string;
  /** Requested speed for move / enter_zone / dock, m/s, 0 or more. Absent means "cap me". */
  requestedSpeedMps?: number;
  /**
   * True while a site emergency is active. This is the one fact with a
   * default: absent means no emergency is active. A site's emergency signal
   * is an explicit event your system raises; the evaluator cannot infer one.
   */
  emergency?: boolean;
  /** Set when a human has approved this specific action (the answer to an earlier PAUSE). Non-empty. */
  approvedBy?: string;
}

export interface DomainRequest {
  participant: { id: string; kind: ParticipantKind; roleId: string };
  action: DomainAction | string;
  /** The zone the participant is in (or, for enter_zone, the zone it wants to enter). */
  zoneId: string;
  /** For command_robot: the robot being commanded. */
  targetRobotId?: string;
  facts: DomainFacts;
}

/**
 *   ALLOW — go ahead
 *   LIMIT — go ahead, within `limits` (e.g. a lower speed)
 *   PAUSE — wait: needs a human's approval, or for the situation to change
 *   BLOCK — no
 */
export type DomainDecisionStatus = 'ALLOW' | 'LIMIT' | 'PAUSE' | 'BLOCK';

export interface DomainCheck {
  ruleId: string;
  status: DomainDecisionStatus;
  /** Plain-English reason. */
  reason: string;
}

export interface DomainDecision {
  status: DomainDecisionStatus;
  /** The strictest checks — the reasons for this decision. */
  reasons: DomainCheck[];
  /** Present when status is LIMIT. */
  limits?: { maxSpeedMps?: number };
  /** For emergencies with stop_then_dock: what the robot should do next. */
  then?: 'dock';
  /** Every check that ran, in order. */
  trace: DomainCheck[];
  /** The rule set that decided. */
  fingerprint: string;
}
