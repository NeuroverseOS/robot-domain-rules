/**
 * Domain rules — type definitions.
 *
 * A domain is one physical site (a store, a warehouse, a clinic, a lab) where
 * robots, people and AI-driven agents work side by side. The site declares
 * its own vocabulary — the kinds of participants, the actions, the areas, the
 * roles, the facts a request must bring, the limits a rule may impose and the
 * authorities that set rules — and rules are written in one shape by whoever
 * the site grants authority: people, systems or agents. The result is one
 * rulebook that every participant asks before it acts.
 *
 * Location is NOT this module's job. The spatial system (posemesh, for
 * example) decides which area a participant is in and passes that area ID
 * in with the facts. This module only decides what is allowed there.
 *
 *   spatial system: "robot-7 is in area aisle-3; 2 people are there"
 *        │
 *        ▼
 *   evaluateDomainAction(rulebook, request) → ALLOW | LIMIT | PAUSE | BLOCK
 *                                             + the rules that decided it
 *
 * Everything here is plain data and pure functions. No clock, no network,
 * no model. Same rulebook + same request = same decision.
 */

// ─── Vocabulary: what the site declares ──────────────────────────────────────

/** A value a fact can carry. */
export type FactValue = number | string | boolean;

export type Day = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';
export const DAYS: readonly Day[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

/** Something a participant can ask to do, in the site's own words. */
export interface ActionDef {
  /** ID used in requests and rules ("move", "deliver_meds", "camera_capture"). */
  id: string;
  /** Human-readable name. Defaults to the ID with spaces. */
  name?: string;
  /** Which participant kinds may do this at all ("robot", "person", or any site-defined kind). */
  kinds: string[];
  /** Free tags rules can match ("movement", "capture"). */
  tags?: string[];
  /** Facts that must be present when this action is requested (on top of the always-required facts). */
  requires?: string[];
  /** Other words people use for it; used only by plain-text drafting. */
  synonyms?: string[];
}

/** A place the spatial system can report. */
export interface AreaDef {
  /** The area ID your spatial system reports (for example a posemesh zone or anchor ID). */
  id: string;
  name: string;
  /** Free tags rules can match ("staff-only", "restricted", "dock", "aisle"). */
  tags?: string[];
  /**
   * Only these roles (by role ID) may act in this area. A role must be listed
   * itself: inheriting a listed role's actions does not pass its area permission.
   * Compiled into a never rule `area_role_limits:<area>`.
   */
  allowRoles?: string[];
  /** These roles (by role ID) may never act in this area. */
  denyRoles?: string[];
  /** Other words people use for it; used only by plain-text drafting. */
  synonyms?: string[];
}

/** A kind of participant with a fixed list of actions it may take. */
export interface RoleDef {
  /** Role ID used in requests ("cleaning_robot", "staff", "shopper"). */
  id: string;
  name: string;
  /** The participant kind this role belongs to ("robot", "person", ...). */
  kind: string;
  /** Actions this role may take at all. Rules can still say no, slower, or wait. */
  actions: string[];
  /** Inherit another role's actions (same kind only). Inheritance only adds, never removes. */
  inherits?: string;
  /** Free tags rules can match ("staff", "after-hours", "visitor"). */
  tags?: string[];
  /** Other words people use for it; used only by plain-text drafting. */
  synonyms?: string[];
}

export type FactType = 'number' | 'boolean' | 'time' | 'day' | 'enum' | 'string';

/**
 * A fact every request must bring (or that has a default). The rulebook
 * trusts the facts it is given and never fills one in.
 */
export interface FactDef {
  id: string;
  type: FactType;
  /** The request must carry it. A missing or invalid required fact is BLOCK `required_facts`. */
  required?: boolean;
  /** Used when the request does not carry the fact. A fact with a default is never "missing". */
  default?: FactValue;
  /** number only */
  min?: number;
  max?: number;
  integer?: boolean;
  /** enum only: the allowed values. */
  values?: string[];
  description?: string;
  /** Other words people use for it; used only by plain-text drafting. */
  synonyms?: string[];
}

/** A named numeric limit rules may impose ("maxSpeedMps"). Several rules on one limit combine by MIN. */
export interface LimitDef {
  id: string;
  name?: string;
  /** Unit for rendering and text drafting ("m/s"). */
  unit?: string;
  /**
   * The request fact that carries the requested value. When present and at or
   * under the limit, the decision is ALLOW and carries the limit; when absent
   * or over it, the decision is LIMIT.
   */
  requestedFact?: string;
  /** The actions a limit normally applies to; used by plain-text drafting as the default `does`. */
  appliesTo?: Selector;
  /** Other words people use for it; used only by plain-text drafting. */
  synonyms?: string[];
}

/** Who may set rules. Listed highest first. */
export interface AuthorityDef {
  id: string;
  name?: string;
}

export interface SiteDef {
  /** Your ID for this site. */
  id: string;
  name: string;
  /** Optional: the posemesh (or other spatial system) domain ID this rulebook is for. */
  spatialDomainId?: string;
  /** Opening hours, 24h "HH:MM" local time. Close may be earlier than open for overnight sites. Optional. */
  hours?: { open: string; close: string };
}

// ─── Rules ───────────────────────────────────────────────────────────────────

/**
 * Who / does / where selector. Entries are OR-ed:
 *   '*'                 everything
 *   'inventory_robot'   an ID
 *   'tag:staff'         everything carrying that tag
 *   'kind:robot'        every role (or action) of that kind
 *   '!dock'             remove this ID, tag or kind from the selection
 * A selector with only '!' entries starts from everything. A single string
 * is the same as a one-entry list.
 */
export type Selector = '*' | string | string[];

export type CompareOp = '==' | '!=' | '>' | '>=' | '<' | '<=';

/** One condition over one fact. A rule's `when` list is AND-ed. */
export type Condition =
  | { fact: string; op: CompareOp; value: FactValue }
  | { fact: string; op: 'in'; values: FactValue[] }
  /** Time window on a `time` fact. `from` <= t < `to`; `from` later than `to` means overnight. */
  | { fact: string; op: 'between'; from: string; to: string }
  /** Day set on a `day` fact. */
  | { fact: string; op: 'days'; days: Day[] };

/** What a rule says when it matches. */
export type Outcome =
  | { answer: 'allow' }
  | { answer: 'limit'; limits: Record<string, number> }
  /**
   * `by`: who may approve — an authority ID (that authority or a higher one),
   * a role ID, or 'tag:<role tag>'. Without `by`, any approval clears the wait.
   */
  | { answer: 'wait'; for: 'approval' | 'condition'; by?: string }
  /** `instead`: a hint about what to do instead (for example "dock"). Returned as `decision.then`. */
  | { answer: 'deny'; instead?: string };

/**
 * Where a rule came from. `text`: drafted from plain words; `agent`: written
 * by an AI agent; `system`: written by another system (a policy service, a
 * regulation feed). What gives a rule weight is never its source but `setBy`:
 * the authority the space granted its author.
 */
export interface RuleSource {
  kind: 'template' | 'question' | 'declaration' | 'manual' | 'text' | 'agent' | 'system' | 'builtin';
  /** Template ID, "question:answer", "area:restroom", the original text, the agent or system ID, ... */
  ref: string;
}

/** One rule. Every rule in a rulebook has this shape, whatever produced it. */
export interface Rule {
  /** Stable ID, cited in every decision. */
  id: string;
  /** The rule in plain words. */
  text: string;
  who: Selector;
  does: Selector;
  where: Selector;
  /** Conditions over facts, AND-ed. Empty or absent = always. */
  when?: Condition[];
  then: Outcome;
  /** Plain-English reason shown in decisions. Defaults to `text`. */
  reason?: string;
  source: RuleSource;
  /** The authority that set this rule — a level the space declared (a person's, a system's or an agent's). Declared, never inferred. */
  setBy: string;
  /** An invariant: checked first, nothing overrides it. Must have `then.answer === 'deny'`. */
  never?: boolean;
}

// ─── Findings: rules at odds ─────────────────────────────────────────────────

export type FindingKind =
  | 'contradiction'        // two rules at the same authority can match the same request and give different answers
  | 'authority-override'   // a lower authority tries to loosen what a higher authority set; it never takes effect
  | 'tightening'           // a lower authority makes a higher authority's answer stricter (allowed; for information)
  | 'shadowed'             // a rule fully covered by a stricter one; it can never change a decision
  | 'duplicate'            // same scope, same answer
  | 'limit_disagreement'   // two limits on the same name overlap with different values
  | 'never_vs_rule';       // a rule tries to allow something a never rule forbids

export interface Finding {
  kind: FindingKind;
  severity: 'conflict' | 'warning' | 'info';
  ruleIds: string[];
  /**
   * 'certain': any request matching one rule matches the other (or both are unconditional).
   * 'possible': both conditions can hold at once on paper; whether they ever do depends on
   *             facts the rulebook does not control.
   * Rules that provably never match the same request produce no finding.
   */
  certainty: 'certain' | 'possible';
  message: string;
}

// ─── The rulebook ────────────────────────────────────────────────────────────

/** Checks the evaluator always runs. They have IDs so decisions can cite them. */
export interface BuiltinCheck {
  id: string;
  text: string;
}

/**
 * The complete, portable rulebook for one site. Plain JSON — store it, sign
 * it, ship it to every robot, pair of glasses and agent.
 *
 * `compileDomain` returns it deep-frozen and detached from the input.
 * `verifyFingerprint(rulebook)` recomputes the fingerprint of a copy received
 * as JSON and says whether it still matches.
 */
export interface Rulebook {
  format: 'neuroverse-domain-rules/2';
  site: SiteDef;
  /** The template this rulebook was built from, if any. */
  template?: string;
  kinds: string[];
  /** Highest first. */
  authorities: AuthorityDef[];
  actions: ActionDef[];
  areas: AreaDef[];
  /** Roles with inheritance already resolved (actions are the full set). */
  roles: RoleDef[];
  facts: FactDef[];
  limits: LimitDef[];
  /** Tags rules may name even when no declared thing carries them yet. */
  tags: { actions: string[]; areas: string[]; roles: string[] };
  /** Template question answers, by question ID. */
  answers: Record<string, string>;
  /** What happens when a request asks for an action the rulebook does not know. */
  otherwise: 'deny' | 'wait-for-approval';
  /**
   * Keys whose signed approvals count. When declared (non-empty), an approval
   * clears a wait only if it is a verified `SignedApproval` for this request
   * and this rulebook. When absent, a plain `Approval` is accepted (development only).
   */
  trustedKeys?: TrustedKey[];
  /** Every rule, never rules included (flagged `never: true`). */
  rules: Rule[];
  builtin: BuiltinCheck[];
  /** What the conflict check found. Compile never hides these. */
  findings: Finding[];
  /** Deterministic fingerprint of everything above. Cite it in logs to prove which rules decided. */
  fingerprint: string;
}

// ─── Requests and decisions ──────────────────────────────────────────────────

/**
 * Who approved an action. A plain string is accepted as an unqualified
 * approval. When the rulebook declares `trustedKeys`, only a `SignedApproval`
 * that the caller has verified (`verified: true`, see `verifyApproval`) and
 * that is bound to this request and this rulebook clears an approval wait.
 */
export interface Approval {
  id: string;
  /** The authority the approver holds, by ID. */
  authority?: string;
  /** The role the approver holds, by ID. */
  roleId?: string;
  /** Set only by `verifyApproval` after the signature checked out against a trusted key. */
  verified?: boolean;
  /** `requestDigest(request)` of the request this approval is for. */
  requestDigest?: string;
  /** The fingerprint of the rulebook the approver saw. */
  rulebookFingerprint?: string;
  /** The trusted key that signed it. */
  keyId?: string;
  issuedAt?: string;
  signature?: string;
}

/**
 * What a PAUSE for approval returns: everything a person (or their signing
 * tool) needs to produce a `SignedApproval` for exactly this request.
 */
export interface ApprovalRequest {
  /** The rule that is waiting. */
  ruleId: string;
  /** The authority (or higher), role, or `tag:<role tag>` the approver must hold. Absent: anyone. */
  by?: string;
  /** `requestDigest(request)`: binds the approval to this participant, action and area. */
  requestDigest: string;
  /** The rulebook the approver is approving under. */
  rulebookFingerprint: string;
  reason: string;
  setBy: string;
}

/** An approval as data, signed with Ed25519. See `signApproval` / `verifyApproval`. */
export interface SignedApproval {
  /** The approver's ID. */
  id: string;
  authority?: string;
  roleId?: string;
  requestDigest: string;
  rulebookFingerprint: string;
  /** ISO 8601. The evaluator has no clock; the caller decides how old is too old. */
  issuedAt: string;
  /** Which of the rulebook's `trustedKeys` signed it. */
  keyId: string;
  /** Ed25519 signature, 64 bytes as lowercase hex, over the canonical JSON of every other field. */
  signature: string;
}

/** A public key the rulebook trusts for approvals. */
export interface TrustedKey {
  keyId: string;
  /** Raw Ed25519 public key, 32 bytes as lowercase hex. */
  publicKey: string;
  /** The authority this key may approve as. A signed approval under this key must claim this authority or none. */
  authority?: string;
  /** The role this key may approve as. */
  roleId?: string;
}

export interface DomainRequest {
  participant: { id: string; kind: string; roleId: string };
  action: string;
  /** The area the participant is in (or, for an entering action, the area it wants to enter). */
  areaId?: string;
  /** @deprecated 0.2 name for `areaId`. Still accepted. */
  zoneId?: string;
  /** @deprecated 0.2 field; copied into `facts.targetRobotId` when that fact is absent. */
  targetRobotId?: string;
  /**
   * The facts the rulebook declares, plus the built-in `approvedBy` (an
   * `Approval` or a non-empty string, set when a person has approved this
   * specific action). The evaluator never guesses a fact: a required fact
   * that is missing or invalid gives BLOCK `required_facts`, never a crash
   * and never permission.
   */
  facts: Record<string, unknown>;
}

/**
 *   ALLOW — go ahead
 *   LIMIT — go ahead, within `limits`
 *   PAUSE — wait: for a person's approval, or for the situation to change
 *   BLOCK — no
 */
export type DomainDecisionStatus = 'ALLOW' | 'LIMIT' | 'PAUSE' | 'BLOCK';

export interface DomainCheck {
  ruleId: string;
  status: DomainDecisionStatus;
  /** Plain-English reason. */
  reason: string;
  /** The authority that set the rule; 'builtin' for the evaluator's own checks. */
  setBy: string;
}

export interface DomainDecision {
  status: DomainDecisionStatus;
  /** The strictest checks — the reasons for this decision. */
  reasons: DomainCheck[];
  /** Effective limits (MIN across matching limit rules), present when any limit rule matched. */
  limits?: Record<string, number>;
  /** A deny rule's `instead` hint (for example "dock"). */
  then?: string;
  /** When the status is PAUSE for approval: what to get signed, one per rule still waiting. */
  approvalRequests?: ApprovalRequest[];
  /** Every check that ran, in order. */
  trace: DomainCheck[];
  /** The rulebook that decided. */
  fingerprint: string;
}
