# Boundary: what this layer is, is not, and defends against

## What it is

Task- and permission-level authorization for robots, AI agents and people wearing glasses in a shared physical space. One question in — *may this participant do this action, in this area, given these facts?* — and one answer out: `ALLOW`, `LIMIT` (with the ceilings), `PAUSE` (for a person, or for the situation to change) or `BLOCK`, with the rules that decided, the authority behind each, and the fingerprint of the rulebook that was in force. The same question over a whole plan: every step checked on the facts the earlier steps leave behind, as far as the site declared what its actions do, plus the rules the site set about plans as a whole.

It sits between the thing that proposes an action (a planner, an agent, a wearer, a fleet manager) and the thing that executes it (a robot controller, a glasses runtime, an agent harness). It is called before the action, with facts the surrounding system already knows.

## What it is not

- **Not motion control.** It never computes a path, a velocity or a stop. A `LIMIT` is a ceiling the controller enforces; a `BLOCK` is a refusal the controller honours. How the robot slows or stops is the controller's business.
- **Not a safety system.** It is not a safety PLC, not a safety-rated stop, not a navigation stack, and it does not replace ISO 10218, ISO 3691-4, ISO 13482 or any certified safety function. Those stay in charge of physical safety and act whether or not this layer is consulted. This layer decides *permission*; a correct permission does not make an unsafe motion safe.
- **Not a sensor, a map or a clock.** It does not locate anything, count anyone, or know what time it is. Every fact arrives in the request.
- **Not a model.** No AI is inside the decision. Models may draft rules, propose plans and explain decisions outside it.
- **Not a planner.** It checks the plan it is handed and predicts only the declared effects; it does not search for a plan, re-order steps, or know what an action does beyond what the site wrote down.

## Integration rule #1: facts come from the harness, never from the requester

The agent, robot or wearer that asks says who it is and what it wants to do. Everything else in the request — the area, every fact, `history`, `now`, `consumedApprovals`, the `verified` flag on an approval — is assembled by the caller's trusted layer (the harness, the spatial system, the fleet manager) from its own sources. A requester that could supply its own facts could talk the rulebook into anything. [`examples/mcp/`](examples/mcp/) shows the shape: the tool takes `participant` and `action` only; the server fills in the rest from a stub harness.

## What it trusts

- **The facts in the request.** Where the participant is, how many people are there, whether an alarm is active, what time it is (`now`): the layer takes these as true. The trusted layer that assembles the request is the fact source. The same for `history` (what the participant did recently) and, in a plan, for the planner's description of the steps and the facts it expects — a plan verdict is a verdict on the plan as described; each step is asked again on the facts current when it comes up.
- **The rulebook it was handed.** It checks the rulebook's declared version, structure and fingerprint, and can verify a signature with a key you pin outside the rulebook. It cannot know whether the rulebook is the one the space meant to be in force; that is deployment's job.
- **Verified approvals.** When a rulebook declares `trustedKeys`, the caller's trusted layer verifies an approval's Ed25519 signature *before* evaluation (`verifyApproval`, or `verifyAndEvaluate` which does both) and passes the verified approval in. The evaluator checks that it is marked verified, is a `/3` approval bound to this rule, this rulebook's fingerprint, this participant, this action and this area, is within its validity window at `now`, has a nonce not in the caller's consumed set, and holds what the rule names. It does not re-verify the signature (evaluation is synchronous and pure). An approval clears only that rule's wait; every other check runs on the facts current now.

## What it protects against

| Threat | Defence | Proved by |
|---|---|---|
| An action nobody wrote a rule for slips through | Unknown action, area, role or kind is a refusal, or a wait if the space chose so; never permission | `conformance/p4-*` |
| A missing or malformed fact reads as "safe" | `required_facts` BLOCK; only declared defaults are ever assumed | `conformance/p4-*` |
| A site, a staff member or a vendor loosens what law or the company set | Lower authority may only tighten; overrides are reported and have no effect | `conformance/p2-*` |
| Someone approves who may not | Approval must hold the named authority (or higher), role or tag; an undeclared authority is an invalid fact | `conformance/p2-*`, `p6-*` |
| A forged approval (once the space declares trusted keys) | Ed25519 signature under a key trusted for that authority/role; unverified approvals clear nothing | `conformance/approvals.json` (`verify-forged`, `verify-untrusted-key`, `verify-overclaim`, `unverified-does-not-clear`) |
| An approval re-used for another rule, participant, action, area or rulebook | The approval names all five; any mismatch and it does not apply | `approvals-other-*`, `approvals-other-rulebook-does-not-clear` |
| An approval used after it should have lapsed | Required `expiresAt`, checked against the caller-supplied `now`; `issuedAt` in the future is refused too | `approvals-expired-is-refused`, `approvals-not-yet-valid-is-refused` |
| An approval replayed within its window | Single-use `nonce`; the caller passes the nonces it has acted on (`consumedApprovals`) and is told which were used (`approvalsUsed`). **Holds only if the caller keeps that set** (KNOWN-GAPS.md) | `approvals-replayed-is-refused` |
| An approval used to override the facts | An approval clears only its rule's wait; a condition wait, a deny or a never rule on the current facts still decides | `approvals-facts-changed-condition-wait-still-holds`, `approvals-current-never-rule-still-blocks`, `approvals-current-deny-still-blocks`, `p6-approval-never-clears-condition` |
| A `/2` rulebook, fingerprint or approval read as if it were `/3` | Every artifact declares its version; older ones are refused by name with the migration, never reinterpreted | `conformance/versions.json`, `approvals-verify-v2-approval-refused`, `approvals-v2-approval-does-not-clear` |
| Two rules disagree and the robot picks one in silence | Findings on every rulebook, strictest-wins at decision time, exact overlap on reachable requests, Z3-cross-checked | `conformance/p7-*`, Z3 cross-check |
| A rulebook is altered in transit or at rest | SHA-256 fingerprint over RFC 8785 canonical JSON; optional Ed25519 rulebook signature with a pinned key | `conformance/fingerprint.json`, `approvals.json` |
| A decision cannot be audited later | Every decision cites rule IDs, authorities, the full trace and the rulebook fingerprint | `conformance/p5-*` |
| A plan that "teleports": a step in an area the plan never moved to | `plan_area_continuity` refuses the step | `conformance/plans.json` |

## What it does not protect against

- **Lying or broken fact sources.** If the spatial system reports zero people in an aisle with three in it, the decision is wrong and this layer cannot tell. Fact integrity is upstream.
- **Compromised signing keys.** A stolen approver key signs valid approvals. Key custody, rotation and revocation are outside the rulebook (replace the key in `trustedKeys` and re-sign the rulebook).
- **A trusted layer that sets `verified: true` itself, or lets the requester supply facts.** The evaluator cannot tell. Only `verifyApproval` should set the flag, and only the harness should build requests.
- **A controller that ignores the decision.** Nothing here forces the robot to obey. Enforcement is the controller's; this layer only makes the right answer available and auditable.
- **Rulebook substitution with a valid signature.** If the deployment accepts any signed rulebook rather than one signed by its pinned key, a signed-but-wrong rulebook passes. Pin the rulebook signing key outside the rulebook.
- **A wrong clock.** Approval windows are judged against the `now` the caller supplies. No expiry is enforced on rulebooks themselves.
- **Denial of service, side channels, resource limits.** Evaluation is bounded by the rulebook size and pure, but nothing here rate-limits or isolates callers.

## Where each check belongs

| Check | Who does it | When |
|---|---|---|
| Is the robot physically safe to move? | Safety controller / PLC | Always, independently |
| Where is the participant? How many people are near? | Spatial system | Before the request is built |
| Is this rulebook the one in force? Is it unaltered? | Deployment: `validateRulebook`, `verifyFingerprint`, `verifyRulebookSignature` with a pinned key | When a rulebook is loaded |
| Is this approval genuine? | Caller's trusted layer: `verifyApproval` against `trustedKeys` (or `verifyAndEvaluate`) | Before evaluation, on each approval |
| Is this approval still valid, and unused? | This layer, from the caller's `now` and `consumedApprovals`; the caller records `approvalsUsed` | At evaluation; after acting |
| What did this participant do recently? What time is it? | Caller: `request.history`, `request.now` | Before evaluation |
| May this participant do this, here, now? | This layer: `evaluateDomainAction` | Before the action |
| May this whole plan run, step by step? | This layer: `evaluatePlan` | Before the first step; then each step again with `evaluateDomainAction` as it comes up, on real facts |
| Did the robot actually obey? | Controller and your audit of the decision log | After |
