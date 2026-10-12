# Boundary: what this layer is, is not, and defends against

## What it is

Task- and permission-level authorization for robots, AI agents and people wearing glasses in a shared physical space. One question in — *may this participant do this action, in this area, given these facts?* — and one answer out: `ALLOW`, `LIMIT` (with the ceilings), `PAUSE` (for a person, or for the situation to change) or `BLOCK`, with the rules that decided, the authority behind each, and the fingerprint of the rulebook that was in force.

It sits between the thing that proposes an action (a planner, an agent, a wearer, a fleet manager) and the thing that executes it (a robot controller, a glasses runtime, an agent harness). It is called before the action, with facts the surrounding system already knows.

## What it is not

- **Not motion control.** It never computes a path, a velocity or a stop. A `LIMIT` is a ceiling the controller enforces; a `BLOCK` is a refusal the controller honours. How the robot slows or stops is the controller's business.
- **Not a safety system.** It is not a safety PLC, not a safety-rated stop, not a navigation stack, and it does not replace ISO 10218, ISO 3691-4, ISO 13482 or any certified safety function. Those stay in charge of physical safety and act whether or not this layer is consulted. This layer decides *permission*; a correct permission does not make an unsafe motion safe.
- **Not a sensor, a map or a clock.** It does not locate anything, count anyone, or know what time it is. Every fact arrives in the request.
- **Not a model.** No AI is inside the decision. Models may draft rules and explain decisions outside it.

## What it trusts

- **The facts in the request.** Where the participant is, how many people are there, whether an alarm is active, what time it is: the layer takes these as true. Whoever assembles the request — the spatial system, the fleet manager — is the trusted fact source.
- **The rulebook it was handed.** It checks the rulebook's structure and fingerprint, and can verify a signature with a key you pin outside the rulebook. It cannot know whether the rulebook is the one the space meant to be in force; that is deployment's job.
- **Verified approvals.** When a rulebook declares `trustedKeys`, the caller verifies an approval's Ed25519 signature *before* evaluation and passes the verified approval in. The evaluator checks that it is marked verified, bound to this request's digest and this rulebook's fingerprint, and holds what the rule names. It does not re-verify the signature (evaluation is synchronous and pure) and it does not check `issuedAt` (it has no clock) — age limits are the caller's.

## What it protects against

| Threat | Defence | Proved by |
|---|---|---|
| An action nobody wrote a rule for slips through | Unknown action, area, role or kind is a refusal, or a wait if the space chose so; never permission | `conformance/p4-*` |
| A missing or malformed fact reads as "safe" | `required_facts` BLOCK; only declared defaults are ever assumed | `conformance/p4-*` |
| A site, a staff member or a vendor loosens what law or the company set | Lower authority may only tighten; overrides are reported and have no effect | `conformance/p2-*` |
| Someone approves who may not | Approval must hold the named authority (or higher), role or tag; an undeclared authority is an invalid fact | `conformance/p2-*`, `p6-*` |
| A forged, replayed or re-used approval (once the space declares trusted keys) | Ed25519 signature under a key trusted for that authority/role; bound to the request digest and the rulebook fingerprint; unverified approvals clear nothing | `conformance/approvals.json` |
| Two rules disagree and the robot picks one in silence | Findings on every rulebook, strictest-wins at decision time, sound disjointness | `conformance/p7-*`, soundness test |
| A rulebook is altered in transit or at rest | Fingerprint over canonical JSON; optional Ed25519 rulebook signature with a pinned key | `conformance/fingerprint.json`, `approvals.json` |
| A decision cannot be audited later | Every decision cites rule IDs, authorities, the full trace and the rulebook fingerprint | `conformance/p5-*` |

## What it does not protect against

- **Lying or broken fact sources.** If the spatial system reports zero people in an aisle with three in it, the decision is wrong and this layer cannot tell. Fact integrity is upstream.
- **Compromised signing keys.** A stolen approver key signs valid approvals. Key custody, rotation and revocation are outside the rulebook (replace the key in `trustedKeys` and re-sign the rulebook).
- **A controller that ignores the decision.** Nothing here forces the robot to obey. Enforcement is the controller's; this layer only makes the right answer available and auditable.
- **Rulebook substitution with a valid signature.** If the deployment accepts any signed rulebook rather than one signed by its pinned key, a signed-but-wrong rulebook passes. Pin the rulebook signing key outside the rulebook.
- **Timing.** No expiry is enforced on approvals or rulebooks; `issuedAt` is there for the caller to check.
- **Denial of service, side channels, resource limits.** Evaluation is bounded by the rulebook size and pure, but nothing here rate-limits or isolates callers.

## Where each check belongs

| Check | Who does it | When |
|---|---|---|
| Is the robot physically safe to move? | Safety controller / PLC | Always, independently |
| Where is the participant? How many people are near? | Spatial system | Before the request is built |
| Is this rulebook the one in force? Is it unaltered? | Deployment: `validateRulebook`, `verifyFingerprint`, `verifyRulebookSignature` with a pinned key | When a rulebook is loaded |
| Is this approval genuine? | Caller: `verifyApproval` against `trustedKeys` | Before evaluation, on each approval |
| Is this approval too old? | Caller, from `issuedAt` | Before evaluation |
| May this participant do this, here, now? | This layer: `evaluateDomainAction` | Before the action |
| Did the robot actually obey? | Controller and your audit of the decision log | After |
