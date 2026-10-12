# robot-domain-rules — specification

```
spec: robot-domain-rules/2
rulebook format string: neuroverse-domain-rules/2
```

This document is normative. It defines the rulebook, request, decision, plan, finding and approval formats, the decision algorithm, the plan algorithm, the conflict analysis, authority, and the canonical encoding another implementation must reproduce byte for byte. The words MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119. Everything stated here is checked by the cases in [`conformance/`](conformance/); an implementation conforms when it passes them all. The TypeScript package in this repository is the reference implementation.

Out of scope, and deliberately so: how a rulebook is *built* (templates, questions, plain-text drafting, the builder) is tooling of the reference implementation. The rulebook is the portable artifact; an implementation needs only to validate it, decide with it (one action or a whole plan), check it for conflicts, fingerprint it, and handle approvals. JSON Schemas for every format are in [`spec/`](spec/).

What changed in `/2` (from `/1`): the conflict analysis is exact and every certain finding carries a `witness` (§ 7), which changes the certainty of some findings and the fingerprint of rulebooks that have findings; actions may declare `effects` (§ 2), rules may condition on `history` (§ 3.4), a rulebook may carry `planRules` (§ 3.5), a request may carry `history` (§ 4), and `evaluatePlan` (§ 12) checks a whole plan. A `/1` rulebook without findings is a valid `/2` rulebook with the same fingerprint and the same decisions.

## 1. Vocabulary

Identifiers (`id` fields of actions, areas, roles, facts, limits, authorities, trusted keys) are non-empty strings with no whitespace and none of `*`, `!`, `:`. Rule IDs are non-empty strings (they may contain `:`, as `area_role_limits:<area>` does).

A **fact value** is a JSON number, string or boolean.

A **time** is `"HH:MM"`, 24-hour, zero-padded (`^([01]\d|2[0-3]):[0-5]\d$`). A **day** is one of `mon tue wed thu fri sat sun`.

## 2. Rulebook

A rulebook is one JSON object ([`spec/rulebook.schema.json`](spec/rulebook.schema.json)):

| Field | Type | Req | Meaning |
|---|---|---|---|
| `format` | `"neuroverse-domain-rules/2"` | yes | |
| `site` | `{ id, name, spatialDomainId?, hours?: { open, close } }` | yes | `hours` are times; `close` earlier than `open` means overnight. |
| `template` | string | no | The template it was built from. Informational. |
| `kinds` | string[] | yes | Participant kinds (`robot`, `person`, `agent`, …). MUST include every kind any role or action names. |
| `authorities` | `{ id, name? }[]` | yes, ≥1 | **Highest first.** Unique IDs. |
| `actions` | `{ id, name?, kinds (≥1), tags?, requires?, effects?, synonyms? }[]` | yes | `requires`: fact IDs that MUST be present when this action is requested. `effects`: what the action does to the facts when a plan is projected (§ 2.1); unused by the single-action decision. |
| `areas` | `{ id, name, tags?, allowRoles?, denyRoles?, synonyms? }[]` | yes, ≥1 | `allowRoles`/`denyRoles` are informational in a compiled rulebook: their effect is already present as never rules `area_role_limits:<area>` and `area_role_limits:<area>:deny`. |
| `roles` | `{ id, name, kind, actions, inherits?, tags?, synonyms? }[]` | yes, ≥1 | `actions` is the **full** list (inheritance already resolved). Every listed action MUST declare the role's kind in its `kinds`. |
| `facts` | `{ id, type, required?, default?, min?, max?, integer?, values?, description?, synonyms? }[]` | yes | `type` ∈ `number boolean time day enum string`. A fact MUST NOT be both `required` and have a `default`. `min/max/integer` only on numbers; `values` (≥1) required for enums. `default` MUST be valid for the type. The ID `approvedBy` is reserved and MUST NOT be declared. |
| `limits` | `{ id, name?, unit?, requestedFact?, appliesTo?, synonyms? }[]` | yes | `requestedFact` MUST name a declared `number` fact. |
| `tags` | `{ actions: string[], areas: string[], roles: string[] }` | yes | Tags rules may name even when nothing carries them yet. |
| `answers` | `{ [questionId]: string }` | yes | Informational. |
| `otherwise` | `"deny"` \| `"wait-for-approval"` | yes | What an undeclared action gets. |
| `trustedKeys` | `{ keyId, publicKey, authority?, roleId? }[]` | no | See § 9. `publicKey` is 32 bytes lowercase hex; `authority`/`roleId` MUST be declared. Declaring any key (non-empty list) switches approvals to signed-only. |
| `rules` | Rule[] | yes | § 3. IDs unique across `rules` and `planRules`. |
| `planRules` | PlanRule[] | no | § 3.5. Present only when non-empty (so a rulebook without plan rules has the same fingerprint as before `/2`). |
| `builtin` | `{ id, text }[]` | yes | MUST include `required_facts`, `area_declared`, `role_declared`, `role_permits_action`, `unknown_action`. |
| `findings` | Finding[] | yes | § 7. What the conflict check found; MAY be empty; MUST NOT be hidden. |
| `fingerprint` | 16 lowercase hex | yes | § 8, over everything above. |

### 2.1 Effects

An effect is one of:

| Effect | Meaning when a plan is projected (§ 12) |
|---|---|
| `{ op: "set", fact, value }` | the fact becomes `value`; `value` MUST be valid for the fact's type |
| `{ op: "add", fact, value }` | a `number` fact goes up by `value` (finite; a whole number if the fact is `integer`) |
| `{ op: "subtract", fact, value }` | a `number` fact goes down by `value` (same constraints) |
| `{ op: "move" }` | after this step the participant is in the step's area |

`fact` MUST be a declared fact. Effects are not clamped to the fact's range: a projected value outside it makes the next step BLOCK `required_facts`.

**Validation.** An implementation MUST reject (refuse to decide with) a rulebook that violates any MUST in this document, including: unknown format; empty or duplicate authorities; a rule referencing an undeclared role, action, area, tag, kind, fact, limit or authority; a rule whose conditions on one fact can never all hold; a never rule that does not deny; a rule conditioning on a fact that is neither required nor defaulted; a `limit` outcome naming an unknown limit or a value below 0; a `wait.by` that is not an authority, a role, or `tag:<declared role tag>`; `wait.by` on a condition wait; a trusted key with a malformed public key or an undeclared authority/role; an `otherwise` outside the two values; an effect on an undeclared fact or of the wrong type; a history condition that is malformed (§ 3.4); a plan rule that is malformed or shares an ID with a rule (§ 3.5); an empty `planRules` list; a fingerprint that does not match. (Reference: `validateRulebook`; cases: every `expect.error` case.)

## 3. Rule

```json
{ "id": "no_restock_saturday_pm",
  "text": "no restock robots in aisle 3 on Saturdays between 14:00 and 16:00",
  "who": "restock_robot", "does": "*", "where": "aisle-3",
  "when": [ { "fact": "localTime", "op": "between", "from": "14:00", "to": "16:00" },
            { "fact": "day", "op": "days", "days": ["sat"] } ],
  "then": { "answer": "deny" },
  "reason": "No restocking in aisle 3 on Saturday afternoons.",
  "setBy": "site-manager",
  "source": { "kind": "text", "ref": "no restock robots in aisle 3 on Saturdays between 14:00 and 16:00" },
  "never": false }
```

| Field | Req | Meaning |
|---|---|---|
| `id`, `text` | yes | Stable ID cited in decisions; the rule in plain words. |
| `who`, `does`, `where` | yes | Selectors (§ 3.1) over roles, actions, areas. |
| `when` | no | Conditions (§ 3.2), AND-ed. Absent or empty = always. Each fact named MUST be required or have a default. |
| `history` | no | History conditions (§ 3.4), AND-ed with `when`. |
| `then` | yes | Outcome (§ 3.3). |
| `reason` | no | Shown in decisions; defaults to `text`. |
| `setBy` | yes | A declared authority ID. The level the space granted the author, whoever or whatever that is. |
| `source` | yes | `{ kind, ref }`, kind ∈ `template question declaration manual text agent system builtin`. Provenance only; it carries no weight. |
| `never` | no | `true` marks an invariant: checked before anything else, nothing overrides it. MUST have `then.answer == "deny"`. |

### 3.1 Selectors

A selector is a string or a non-empty list of strings. Each entry is one of:

| Entry | Means |
|---|---|
| `*` | everything in the universe (all roles / all actions / all areas) |
| `<id>` | that declared ID |
| `tag:<t>` | every role / action / area carrying tag `t` |
| `kind:<k>` | (`who`) every role of kind `k`; (`does`) every action listing `k` in `kinds`; (`where`) not allowed |
| `!<entry>` | remove that entry's expansion |

Resolution to a set of IDs: trim entries and drop empty ones. Positives are entries not starting with `!`; negatives the rest, without the `!`. If there are no positives, or any positive is `*`, start from the whole universe; otherwise start from the union of the positives' expansions. Then remove the expansion of every negative. Entries referring to undeclared things make the rulebook invalid. A selector is **open** when it has no positives or a positive `*`.

### 3.2 Conditions

| Form | Facts it applies to | True when |
|---|---|---|
| `{ fact, op: "==" \| "!=", value }` | any | strict equality / inequality of the fact value and `value` |
| `{ fact, op: ">" \| ">=" \| "<" \| "<=", value }` | number, time, day | ordinal comparison: numbers by value; times by minutes since midnight; days by position mon=0 … sun=6. MUST NOT be used on boolean, enum or string. |
| `{ fact, op: "in", values[] }` | any | the fact value is strictly equal to a member of `values` (≥1) |
| `{ fact, op: "between", from, to }` | time only | with `t`, `f`, `o` in minutes: if `f < o`: `f <= t < o`; if `f > o` (overnight): `t >= f or t < o`. `f == o` is invalid. |
| `{ fact, op: "days", days[] }` | day only | the fact is a member of `days` (≥1) |

`value`/`values` MUST be valid values of the fact's type.

### 3.3 Outcomes

| `then` | Meaning |
|---|---|
| `{ answer: "allow" }` | go ahead |
| `{ answer: "limit", limits: { <limitId>: number ≥ 0, … } }` | go ahead within these ceilings (≥1 entry) |
| `{ answer: "wait", for: "approval", by? }` | a person (or key) holding `by` must approve this request. `by` is an authority ID (that authority **or any higher one**), a role ID, or `tag:<role tag>`. Absent: anyone. |
| `{ answer: "wait", for: "condition" }` | the facts must change; no approval clears it |
| `{ answer: "deny", instead? }` | no; `instead` is a hint ("dock") surfaced as `decision.then` |

### 3.4 History conditions

```json
{ "actions": "scan", "areas": "tag:aisle", "sameArea": true, "withinMinutes": 60, "clock": "localTime", "op": ">=", "value": 5 }
```

| Field | Req | Meaning |
|---|---|---|
| `actions` | yes | Selector over actions (§ 3.1). Entries of the history whose action is in it count. |
| `areas` | no | Selector over areas. Only entries in these areas count. |
| `sameArea` | no | Only entries in the request's own area count. |
| `withinMinutes` | no | 1–1440. Only entries whose `at` is at most this many minutes before the `clock` fact count, by minute-of-day arithmetic that wraps at midnight: `(now − at + 1440) mod 1440 ≤ withinMinutes`. |
| `clock` | with `withinMinutes` | A declared `time` fact that is required or has a default: "now". MUST NOT be given without `withinMinutes`. |
| `op`, `value` | yes | `op` ∈ `== != > >= < <=`; `value` a whole number ≥ 0. The condition holds when `count op value`. |

History is what the caller supplies (§ 4); the engine keeps none. The conflict analysis does not model history conditions (§ 7.2).

### 3.5 Plan rules

A plan rule judges the shape of a whole plan (§ 12) and can only reject:

```json
{ "id": "end_at_dock", "text": "Every robot plan ends at a charging dock.", "who": "kind:robot",
  "check": { "kind": "ends_in", "areas": "tag:dock" }, "setBy": "site-manager", "source": { "kind": "manual", "ref": "end_at_dock" } }
```

| `check.kind` | Fields | The plan breaks it when… |
|---|---|---|
| `ends_in` | `areas` (selector) | the area the last step leaves the participant in is not in `areas` |
| `ends_with` | `actions` (selector) | the last step's action is not in `actions` |
| `before` | `first`, `then` (selectors), `sameArea?` | some step whose action is in `then` has no earlier step (in the plan, or in `plan.history`) whose action is in `first` — in the same area, when `sameArea` |
| `at_most` | `actions` (selector), `count` (whole number ≥ 0) | more than `count` steps have an action in `actions` |

`id`, `text`, `who`, `setBy`, `source` and `reason` are as for a rule. `who` selects roles; a plan rule applies to a plan whose participant's role it selects. IDs are unique across rules and plan rules.

## 4. Request

[`spec/request.schema.json`](spec/request.schema.json)

```json
{ "participant": { "id": "robot-7", "kind": "robot", "roleId": "inventory_robot" },
  "action": "move",
  "areaId": "aisle-3",
  "facts": { "peopleInZone": 2, "localTime": "14:05", "requestedSpeedMps": 1.0, "approvedBy": … } }
```

`zoneId` is accepted as a deprecated alias of `areaId`; a top-level `targetRobotId` is copied into `facts.targetRobotId` when that is absent. `facts` carries the declared facts by ID plus the built-in `approvedBy` (§ 9): a non-empty string (an unqualified approval) or an approval object. Undeclared facts are ignored. A request is never a reason to throw: every malformed request yields a BLOCK decision.

`history` (optional) is a list of `{ action, areaId, at? }` — what this participant did recently, as the caller reports it; `at` is a time. It is needed only when a rule in scope has history conditions (§ 6 step 3).

## 5. Decision

[`spec/decision.schema.json`](spec/decision.schema.json)

```json
{ "status": "LIMIT",
  "reasons": [ { "ruleId": "robots_near_people", "status": "LIMIT", "reason": "…", "setBy": "law-and-safety" } ],
  "limits": { "maxSpeedMps": 0.3 },
  "then": "dock",
  "approvalRequests": [ { "ruleId", "by"?, "requestDigest", "rulebookFingerprint", "reason", "setBy" } ],
  "trace": [ …every check that ran, in order… ],
  "fingerprint": "a8735228811c463a" }
```

Statuses, strictest last: `ALLOW < LIMIT < PAUSE < BLOCK`. A **check** is `{ ruleId, status, reason, setBy }`; `setBy` is `"builtin"` for the evaluator's own checks. `reasons` are the checks at the strictest status, in trace order. `limits` is present iff some limit rule matched and the status is ALLOW or LIMIT. `then` is present iff the status is BLOCK and a matching deny rule had `instead` (the first one, never rules first). `approvalRequests` is present iff the status is PAUSE and at least one approval wait is unmet (§ 6 step 8). `fingerprint` is the rulebook's. The `reason` texts are free-form.

## 6. The decision algorithm

Pure and synchronous: no clock, no I/O, no model. `check(id, status, reason, setBy = "builtin")` appends to the trace. "Stop" means go to step 10.

```
 0. The rulebook MUST have passed validation (§ 2). Let V be its vocabulary.

 1. Shape. Collect problems: request not an object; participant missing;
    participant.kind not a non-empty string in rulebook.kinds; participant.roleId
    not a non-empty string; areaId (or zoneId) not a non-empty string; action not a
    non-empty string; facts not an object. If any: check("required_facts", BLOCK); stop.

 2. Area. If areaId is not a declared area: check("area_declared", BLOCK); stop.
    Role. If roleId is not a declared role, or its kind != participant.kind:
    check("role_declared", BLOCK); stop.

 3. Facts. Let A = the action's definition if declared (may be absent). For each
    declared fact F:
      if request.facts[F.id] is absent (undefined):
        if F.required or F.id ∈ A.requires: problem "F.id is required"
        else if F has a default: facts[F.id] = default
        else: skip
      else if the value is not valid for F (type; number finite, integer, min, max;
        time format; day set; enum values; string non-empty): problem
      else facts[F.id] = value.
    approvedBy: absent → none. A non-empty string s → { id: s }. An object with a
    non-empty string id → copy id, authority (MUST be a declared authority), roleId
    (MUST be a declared role), verified (MUST be boolean), requestDigest,
    rulebookFingerprint, keyId, issuedAt, signature (MUST be strings); anything
    else → problem. Any other shape → problem.
    History. Let N = the rules with a non-empty `history` whose three selectors
    cover this request (the selector part of step 4). If N is non-empty:
      if request.history is absent: problem "history is required"
      else if it is not a list, or an entry is not { action, areaId, at? } with
        non-empty strings and a valid time when `at` is given, or some rule in N
        has withinMinutes and an entry lacks `at`: problem.
    If any problem: check("required_facts", BLOCK); stop.

 4. Matching. Rule R matches when:
      resolve(R.who, roles) contains role.id, and
      if A exists: resolve(R.does, actions) contains action
      else: R.does is open and R.does does not contain the entry "!<action>", and
      resolve(R.where, areas) contains area.id, and
      every condition in R.when holds for `facts` (§ 3.2), and
      every condition in R.history holds for request.history (§ 3.4; an absent
      history counts as empty only when no rule needed it, which step 3 ensures).

 5. Never rules. For each rule with never == true, in rulebook order, that matches:
    check(R.id, BLOCK, R.reason ?? R.text, R.setBy); if R.then.instead and `then`
    unset: then = R.then.instead. If any matched: stop.

 6. The action. If A is absent:
      if rulebook.otherwise == "deny": check("unknown_action", BLOCK); stop
      else: APPROVAL("unknown_action", by = none, setBy = "builtin")   (step 8)
    else if action ∉ role.actions: check("role_permits_action", BLOCK); stop
    else: check("role_permits_action", ALLOW).

 7. Matching rules. Let M = non-never rules that match, in rulebook order.
    effective = {}; for each R in M with answer "limit", for each (name, v) in
    R.then.limits: effective[name] = min(effective[name], v).
    For each R in M:
      allow:            check(R.id, ALLOW, reason, R.setBy)
      deny:             check(R.id, BLOCK, reason, R.setBy); set `then` as in step 5
      wait/condition:   check(R.id, PAUSE, reason, R.setBy)
      wait/approval:    APPROVAL(R.id, R.then.by, R.setBy)
      limit:            status = ALLOW; for each (name, v) in R.then.limits:
                          if v > effective[name]: this name is not the tightest; ignore it
                          else let asked = facts[limitDef(name).requestedFact] (absent if no requestedFact):
                            if asked is absent or asked > v: status = LIMIT
                        check(R.id, status, reason, R.setBy)

 8. APPROVAL(ruleId, by, setBy) — with digest = requestDigest(request) (§ 8.3):
      ask() = append { ruleId, by (omitted when none), requestDigest: digest,
                       rulebookFingerprint: rulebook.fingerprint, reason, setBy }
              to approvalRequests.
      if no approval: check(ruleId, PAUSE, …, setBy); ask(); return.
      if rulebook.trustedKeys is a non-empty list:
        if approval.verified != true, or approval.requestDigest != digest, or
           approval.rulebookFingerprint != rulebook.fingerprint:
          check(ruleId, PAUSE, …, setBy); ask(); return.
      sufficient =
        by is none → true
        by is a declared authority → approval.authority is set and
             rank(approval.authority) <= rank(by)   (rank 0 = highest)
        by == "tag:" + t → approval.roleId names a role whose tags include t
        otherwise (by is a role ID) → approval.roleId == by
      if sufficient: check(ruleId, ALLOW, …, setBy) else check(ruleId, PAUSE, …, setBy); ask().

 9. (nothing)

10. Finish. status = the strictest status in the trace (ALLOW if the trace is
    empty — it never is). reasons = trace entries with that status, in order.
    Include limits = effective iff effective is non-empty and status ∈ {ALLOW, LIMIT}.
    Include then iff set and status == BLOCK. Include approvalRequests iff non-empty
    and status == PAUSE. fingerprint = rulebook.fingerprint.
```

Consequences worth stating: a missing or invalid fact is never permission (step 3); an approved unknown action still faces every never rule and every matching rule (steps 5–7); approvals never clear a condition wait (step 7); the strictest answer always wins, so a looser rule from a lower authority has no effect even before the conflict check names it.

## 7. Conflict analysis

`check(rulebook) → Finding[]` ([`spec/findings.schema.json`](spec/findings.schema.json)). A finding is `{ kind, severity, ruleIds: [first, second], certainty, witness?, message }` with kind ∈ `contradiction authority-override tightening shadowed duplicate limit_disagreement never_vs_rule`, severity ∈ `conflict warning info`, certainty ∈ `certain possible`. `message` is free-form and SHOULD name which rule wins and which never takes effect.

The analysis is **complete for the rule language**: two rules are reported as overlapping if and only if some request matches both. `certainty` is `certain` when the overlap was decided exactly, and then `witness` (§ 7.4) is a request that matches both rules; it is `possible` only when a rule in the pair has history conditions, which depend on what a caller supplies and are not modelled — then the overlap on facts is real, the history is unknown, and there is no witness.

### 7.1 Scope and constraints

The **scope** of a rule is `(roles, actions, areas, when)` with the three selectors resolved to ID sets. A rule whose scope has an empty set is skipped entirely. For a fact `f`, `constraint(R, f)` is the set of values of `f` for which every condition of `R` on `f` holds, intersected with the fact's universe:

| Fact type | Universe | Representation (exact) |
|---|---|---|
| number | `[min, max]` (±∞ when absent); integers only if `integer` | an interval with open/closed ends and excluded points, or a finite set (`==`, `in`). For integer facts `> v` means `>= v+1` and `< v` means `<= v-1`. |
| time | the 1440 minutes of a day | a set of minutes |
| boolean, day, enum | the finite value set | a finite subset |
| string | all non-empty strings | "everything except" a finite set, or a finite set |

For an integer fact every range is kept closed on whole numbers (`> v` becomes `≥ ⌊v⌋+1`, `< v` becomes `≤ ⌈v⌉−1`), and an integer range is empty when it is inverted or every whole number in it is excluded; a real range with `lo < hi` is never emptied by finitely many excluded points. Intersection, emptiness and subset over these representations are exact, so **overlap is decided exactly**: facts are independent, the requests matching a rule are a product of per-fact sets, and two rules can meet iff their selectors meet and every per-fact intersection is non-empty. No enumeration is needed and no size bound applies.

### 7.2 Overlap and certainty

For rules `a`, `b` (every pair `i < j` in rulebook order):

- **overlap** iff `roles_a ∩ roles_b`, `actions_a ∩ actions_b`, `areas_a ∩ areas_b` are all non-empty and, for every fact named by either rule, `constraint(a,f) ∩ constraint(b,f)` is non-empty. No overlap → no finding. (History conditions are ignored here.)
- `implies(a, b)` iff for every fact `f` named by `b`, `constraint(a,f) ⊆ constraint(b,f)`.
- `covered(a, b)` ("every request matching a matches b") iff `roles_a ⊆ roles_b`, `actions_a ⊆ actions_b`, `areas_a ⊆ areas_b` and `implies(a, b)`.
- **certainty** = `possible` if either rule has a non-empty `history`, else `certain` (with a witness, § 7.4).

### 7.3 Classification

Strictness rank of an outcome: deny 4, wait/condition 3, wait/approval 2, limit 1, allow 0.

`sameAnswer(a, b)`: same `answer`; for waits also same `for` and same `by`; for limits the same keys with the same values.

`looser(a, b)` → `(L, S, limitName)` or none: different ranks → the lower rank is L; both limits → take the first key of `a.limits` (in its key order) that also appears in `b.limits`; none shared or equal values → none; else the larger value is L and that key is `limitName`; both approval waits with different `by` → the one without `by` is L; otherwise none.

```
if sameAnswer(a, b):
  if exactly one of a, b is a never rule: no finding
  if covered(a,b) and covered(b,a): duplicate/info, ruleIds [a, b]
  elif covered(a,b):                 duplicate/info, ruleIds [a, b]
  elif covered(b,a):                 duplicate/info, ruleIds [b, a]
  else: no finding
(L, S, name) = looser(a, b); if none: no finding.   ruleIds = [L, S] from here on.
coveredL = covered(L, S); refines = covered(S, L)
loosens = (L.then.answer == "allow") or (name != "")
if not loosens:
  if coveredL: shadowed/warning  else: no finding
elif S.never and L.then.answer == "allow":  never_vs_rule/conflict
elif rank(L.setBy) > rank(S.setBy):          authority-override/conflict   (L is the lower authority; rank 0 = highest)
elif rank(L.setBy) < rank(S.setBy):          tightening/info
else (same authority):
  if L.then.answer == "allow":  contradiction, severity conflict if S denies, else warning
  elif coveredL:                shadowed/warning
  elif refines:                 no finding          (a stricter special case: normal layering)
  else:                         limit_disagreement/info
```

An implementation MAY offer a strict mode that refuses a rulebook with any `conflict`-severity finding; the reference does (`compileDomain(input, { strict: true })`).

### 7.4 Witness

`witness` is `{ participant: { id, kind, roleId }, action, areaId, facts }`: a request that matches both rules (§ 6 step 4, selectors and conditions, ignoring never-rule stopping). An implementation MUST produce a witness on every `certain` finding between rules and MAY choose any request that matches both; the conformance cases judge a witness by validity (`conformance/README.md`). The reference chooses, deterministically: the first role, action and area in declaration order that both rules cover; for every fact either rule names, the smallest value of the intersection (the first minute of the day for a time, the first in sorted order for a finite set, the lower end of a range or the first whole number above it, `"x"`/`"x1"`/… for a string that is "everything except"); every other fact the request needs (required, or required by the action) at a sample value (the default, else the minimum / `false` / `"00:00"` / `"mon"` / the first enum value / `"x"`); `participant.id` is `<roleId>-1`.

### 7.5 Plan rules

Plan rules can only reject, so two of them never disagree. The check reports a `duplicate` (info, certain, no witness) for two plan rules with the same `check` (same kind, same resolved selectors, same `sameArea` / `count`) whose `who` selectors share a role. No other finding kind applies to plan rules, and a plan rule is never compared with a rule.

## 8. Canonical JSON, fingerprint, request digest

### 8.1 Canonical JSON

`canonical(v)`:
- array → `[` + elements joined by `,` + `]`, order kept;
- object → `{` + members joined by `,` + `}`, where members with value `undefined` are dropped and the rest are sorted by key, comparing keys as sequences of UTF-16 code units; each member is `JSON.stringify(key) + ":" + canonical(value)`;
- anything else → `JSON.stringify(value)` as ECMAScript defines it: strings with only `"`, `\`, and control characters U+0000–U+001F escaped (`\n`, `\t`, `\uXXXX`, …), non-ASCII kept literal; numbers in ECMAScript shortest round-trip form (`1`, `0.5`, `1e+21`, `1e-7`, `-0` as `0`); `true`, `false`, `null`.

No whitespace anywhere. (Cases: `conformance/fingerprint.json`.)

### 8.2 Fingerprint

`fingerprint(v)` = 64-bit FNV-1a over the **UTF-16 code units** of `canonical(v)` (so a character outside the BMP contributes two units), offset basis `0xcbf29ce484222325`, prime `0x100000001b3`, arithmetic mod 2^64, as 16 lowercase hex digits, zero-padded.

A rulebook's `fingerprint` is `fingerprint(rulebook without its fingerprint member)`. It identifies a rulebook; it is not a security measure (§ 9.4 is).

### 8.3 Request digest

`requestDigest(request)` = `fingerprint({ participant: { id, kind, roleId }, action, areaId })` where `areaId` falls back to `zoneId`. It binds an approval to *what* was asked by *whom* and *where*, and deliberately not to the facts, which change between the request that paused and the one re-sent with the approval.

## 9. Approvals

[`spec/approval.schema.json`](spec/approval.schema.json)

### 9.1 Approval request

Returned on a PAUSE for approval, one per unmet approval wait:

```json
{ "ruleId": "robots_restricted_zones", "by": "site-manager",
  "requestDigest": "a972a032bcabeaaf", "rulebookFingerprint": "96be85f891da7c40",
  "reason": "This area is restricted.", "setBy": "company" }
```

### 9.2 Signed approval

```json
{ "id": "manager-dana", "authority": "site-manager",
  "requestDigest": "a972a032bcabeaaf", "rulebookFingerprint": "96be85f891da7c40",
  "issuedAt": "2026-10-12T09:00:00Z", "keyId": "dana-2026",
  "signature": "8ab8…3006" }
```

`id`, `requestDigest`, `rulebookFingerprint`, `issuedAt`, `keyId`, `signature` are required; `authority` and `roleId` optional. The signature is Ed25519 (RFC 8032, pure, no pre-hash) over the UTF-8 bytes of `canonical(approval without "signature" and without "verified")`, encoded as 64 bytes lowercase hex. Public keys are the raw 32-byte Ed25519 key, lowercase hex. Ed25519 signatures are deterministic, so the vectors in `conformance/approvals.json` (with their TEST ONLY seeds) are reproducible exactly.

### 9.3 Verification (before evaluation)

`verifyApproval(approval, trustedKeys)` MUST: check the required fields are non-empty strings; find the trusted key with `keyId`; if the approval claims an `authority`, require the key's `authority` to equal it; if it claims a `roleId`, require the key's `roleId` to equal it; verify the signature with the key. On success it returns the approval with `verified: true`, which the caller passes as `facts.approvedBy`. It MUST NOT check `requestDigest` or `rulebookFingerprint` (the evaluator does, against the real request) and does not check `issuedAt` (no clock; age is the caller's policy).

The evaluator (§ 6 step 8) then requires, when `trustedKeys` is non-empty: `verified === true`, matching `requestDigest`, matching `rulebookFingerprint`, and sufficiency for `by`. When `trustedKeys` is absent or empty, plain approvals (`"name"` or `{ id, authority?, roleId? }`) are accepted. This is the development path; a space that wants approvals it can audit declares keys.

### 9.4 Rulebook signature

`signRulebook(rulebook, key)` → `{ keyId, fingerprint, signature }`: Ed25519 over the UTF-8 bytes of `canonical(rulebook)` — the whole rulebook, fingerprint included. `verifyRulebookSignature(rulebook, signature, publicKey)` verifies with a public key the deployment pins **outside** the rulebook; a rulebook's own `trustedKeys` are for approvals and cannot vouch for the rulebook.

## 10. Authority

The `authorities` list is a total order, highest first; `rank(id)` is the index. Every rule's `setBy` is a declared authority. The order governs three things and nothing else: which of two overlapping rules is reported as overriding versus tightening (§ 7.3); whether an approval claiming an authority satisfies a `wait.by` that names one (§ 6 step 8: equal or higher rank); and which key may sign an approval claiming an authority (§ 9.3). It does not reorder evaluation: strictest-wins makes a looser lower-authority rule ineffective without consulting rank. An authority may be held by a person, a system or an AI agent; the rulebook does not know or care which.

## 11. Versioning and conformance

This specification is `robot-domain-rules/2`. The rulebook `format` string is `neuroverse-domain-rules/2` and changes only with the rulebook's shape; `/2` of this document added optional members (`effects`, `history`, `planRules`, `witness`) and did not change it. Changes to this document that alter any decision, finding, fingerprint or signature for an existing valid rulebook bump the spec major version and come with new conformance cases; clarifications do not. (`/2` did: the exact analysis changed the certainty of some findings and, through `witness`, the fingerprint of rulebooks that have findings.) An implementation claims conformance to a spec version by passing every case in `conformance/` at that version; how to run them is in [`conformance/README.md`](conformance/README.md).

## 12. Plans

`evaluatePlan(rulebook, plan) → PlanEvaluation` ([`spec/plan.schema.json`](spec/plan.schema.json), [`spec/plan-evaluation.schema.json`](spec/plan-evaluation.schema.json)). A plan is what a planner — an AI agent, a fleet manager, a person — proposes; the rulebook checks it and does not write it. Pure and synchronous, like § 6.

```json
{ "participant": { "id": "robot-9", "kind": "robot", "roleId": "restock_robot" },
  "initialFacts": { "localTime": "09:30", "peopleInZone": 0 },
  "steps": [ { "action": "enter_zone", "area": "aisle-3" }, { "action": "scan" }, { "action": "manipulate", "facts": { "peopleInZone": 2 }, "note": "…" } ],
  "history": [ { "action": "dock", "areaId": "dock-a", "at": "09:00" } ],
  "clock": "localTime", "startTime": "09:30", "stepDurationSeconds": 120 }
```

| Field | Req | Meaning |
|---|---|---|
| `participant` | yes | As in a request. |
| `initialFacts` | yes | The facts before the first step; undeclared facts are ignored, as in a request. |
| `steps` | yes, ≥1 | `{ action, area?, facts?, note? }`. The first step MUST have `area`. `facts` are laid over the projected facts for that step only, and persist into the projection after it. `note` is carried into the result. |
| `history` | no | What the participant did before the plan; seeds each step's history and counts for `before` plan rules. |
| `clock` | no | A declared `time` fact that advances. |
| `startTime`, `stepDurationSeconds` | no | With `clock`: step *i* sees `clock = startTime + ⌊i · stepDurationSeconds / 60⌋` minutes, mod 1440. |

```
 0. Shape. If the plan is not an object, has no participant, no steps, no initialFacts,
    a step without an action, a first step without an area, a clock that is not a
    declared time fact, a startTime that is not a time, or a history that is not a
    list: status BLOCK, firstViolation { stepIndex 0, ruleId "required_facts",
    setBy "builtin", from "plan" }, no steps, no planChecks; stop.

 1. Areas, as described. here = steps[0].area. For each step i:
      areas[i] = step.area ?? here
      if the step's action is declared and has a `move` effect: here = areas[i]
      after[i] = here

 2. Plan rules. For each plan rule whose `who` selects the participant's role
    (a role that is undeclared, or of another kind, is left to step 3), in order,
    a PlanRuleCheck { ruleId, status, reason, setBy, stepIndex? }:
      ends_in:   ALLOW iff after[n-1] ∈ resolve(areas); else BLOCK at n-1
      ends_with: ALLOW iff steps[n-1].action ∈ resolve(actions); else BLOCK at n-1
      before:    for each step i with action ∈ resolve(then): some entry of
                 plan.history, or some step j < i, has action ∈ resolve(first)
                 (and area == areas[i] when sameArea); the first i that fails
                 → BLOCK at i; none → ALLOW
      at_most:   BLOCK at the (count+1)-th step with action ∈ resolve(actions); else ALLOW

 3. Steps. facts = initialFacts; history = plan.history ?? []. For each step i:
      if clock and startTime: facts[clock] = startTime + ⌊i · stepDurationSeconds / 60⌋ min (mod 1440)
      stepFacts = facts ⊕ step.facts
      decision = evaluate(rulebook, { participant, action: step.action, areaId: areas[i],
                                      facts: stepFacts, history })             (§ 6)
      record { index: i, action, areaId: areas[i], facts: stepFacts, decision, note? }
      add each of decision.approvalRequests not already present (same ruleId and
        requestDigest) to approvalRequests
      if decision.status == BLOCK: facts = stepFacts; stop projecting
      facts = stepFacts with the action's effects applied, in order: set → the
        value; add/subtract → from the current value, or the fact's default when
        the current value is not a number, or left untouched when neither exists
      history += { action, areaId: areas[i], at: stepFacts[clock] if it is a string }

 4. Finish. status = the strictest of every plan check and every recorded step
    decision. firstViolation = among the first recorded step with status BLOCK
    (from "step", its first reason) and every plan check with status BLOCK (from
    "plan", at its stepIndex), the one with the smallest stepIndex; at equal
    index the step's. finalFacts = facts. finalArea = the last recorded step's
    areaId if its decision is BLOCK, else after[last recorded index].
    planDigest = fingerprint(plan) (§ 8.2). fingerprint = rulebook.fingerprint.
```

Consequences: nothing is projected past a refusal (the steps list is cut at the first BLOCK); a PAUSE does not stop projection, so a planner sees every approval the plan needs; the plan is judged on the effects the site declared and the facts the planner supplied, nothing else; approvals are bound per step, by that step's request digest, exactly as for a single request.
