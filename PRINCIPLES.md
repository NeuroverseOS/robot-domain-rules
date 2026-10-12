# Principles: rules for spaces shared by people, robots and AI

Asimov's Three Laws are the most famous robot rulebook ever written, and his stories are mostly about how it fails: the laws are fixed inside the machine by someone who isn't in the room, ranked once for every situation, and left for the robot to interpret through words like "harm" that nobody defined. These principles start from the other end. The rules are written under authority the space itself declares — by people, systems, or agents it trusts — ranked by that declared authority, checked for conflicts before anything happens, and applied to stated facts. When no rule covers a case, the machine doesn't interpret — it stops and asks.

| Where the famous rulebook fails | Principle that answers it |
|---|---|
| Fixed inside the machine by someone not in the room | 1 — every rule carries a declared authority |
| One ranking for every situation | 2 — authority is declared, layered, and only tightens |
| Conflicts resolved silently inside the robot | 7 — conflicts are surfaced, never quietly resolved |
| Undefined words interpreted by the machine | 4 and 3 — unknown means no; AI writes and proposes, the rulebook decides |
| No one can see why | 5 — every decision explains itself |

These principles come from the NeuroVerse governance work and the Collective Vanguard model (foresight, narrative, shared prosperity), applied to a physical world machines can now read. Auki Labs has said that no single entity should own the infrastructure of the machine economy; the same holds for the rules inside it. Each principle below is enforced by conformance tests, not only stated: every "In code" line names the case files in [`conformance/`](conformance/) that another implementation must pass to claim it. The normative detail is in [SPEC.md](SPEC.md); what this layer is and is not is in [BOUNDARY.md](BOUNDARY.md).

## 1. Every rule carries a declared authority

Rules can come from anyone or anything — a person at the site, an AI agent, a company policy system, a regulation feed, another system. What gives a rule weight is never who typed it but the authority the space has granted its author. The space declares its authority levels (law and safety, the company, the site, its staff, an AI agent it trusts — an agent can be one of them), and a rule written at a level can only tighten what higher levels set. Vendors supply capability: what a robot can do, what a pair of glasses can sense, what an agent can plan. The space decides who holds authority: what is allowed here, and by whose say-so. Rules may be written in plain words and turned into a rulebook that machines apply without reinterpreting them. A rulebook with no rules in it permits exactly what the declared roles list and nothing more; the engine never adds a rule of its own, and a rule that cannot say where it came from or who set it is not a rule.

In code: every rule carries `source` (template, question, declaration, manual, text, agent or system) and `setBy`; a rulebook whose rule lacks either is rejected; with no rules, only the role's own action list speaks — [`p1-source.json`](conformance/p1-source.json); an agent-level rule that tightens takes effect, one that loosens never does, and a system-sourced rule is a rule like any other — [`p2-authority.json`](conformance/p2-authority.json).

## 2. Authority is declared, layered, and only tightens

Every rule says who set it, and the order of authorities is written down in the rulebook — law and safety above the company, the company above the site, the site above its staff, or whatever order the space declares — never inferred from who wrote first or who shouted loudest. A lower authority may only make things stricter: it can cap a speed below the company's cap, forbid an area the company allowed, demand an approval the company did not. It cannot loosen. A lower authority's rule that tries to allow what a higher one denies is reported as an override at compile time and has no effect at decision time, because the strictest answer always wins. Approvals obey the same order: a wait that names an authority is cleared only by someone holding that authority or a higher one, a wait that names a role only by that role, and an approval that claims an authority the rulebook never declared is an invalid fact, not a weak one.

In code: `setBy` on every rule, `authorities` in declared order, the `authority-override` and `tightening` findings, `wait { for: 'approval', by }` checked against the approver's authority, role or role tag — [`p2-authority.json`](conformance/p2-authority.json); signed approvals bound to a key the rulebook trusts for that authority — [`approvals.json`](conformance/approvals.json).

## 3. AI writes and proposes; the rulebook decides

AI writes rules — from a manager's sentence, a document, a policy system — at whatever authority the space granted it. AI proposes actions, plans tasks, and explains decisions. The final "may I?" check is none of those: it is a deterministic function of the rulebook and the request, answered in microseconds, the same every time, and it cannot be talked out of a rule. The same rules and the same facts give the same answer whatever model, or no model, is in the loop, and the answer follows the rule's structured outcome, never its prose. A model's draft never sets its own authority; `setBy` comes from the caller, from the level the space declared for that author.

In code: no model call and no clock in evaluation; a rule whose text says "allowed" but whose outcome is deny, denies; facts the rules do not mention change nothing — [`p3-rules-decide.json`](conformance/p3-rules-decide.json). Drafting (`draftRuleFromText`, `parseRuleDraft`) returns a draft that is `ready` only with a declared authority and ignores any `setBy` a model proposes.

## 4. Unknown means no. A missing fact is never a yes

An area the rulebook does not declare, a role it does not know, an action the role does not list, a participant of a kind nobody declared: each is a refusal that names itself, never a default to permission. A fact a decision needs that is absent, of the wrong type, out of range or null is the same refusal, `required_facts`, with the fact named. The engine fills in nothing it was not told — only a fact with a declared default is ever assumed, and a rule may not depend on a fact that could be missing. An action the rulebook has never heard of is denied, or if the space chose so, waits for a person; even then an approved unknown action still faces every invariant the space declared.

In code: `required_facts`, `area_declared`, `role_declared`, `role_permits_action`, `unknown_action`, `otherwise`, `requires` on actions, defaults — [`p4-unknown-and-missing.json`](conformance/p4-unknown-and-missing.json).

## 5. Every decision explains itself

A decision is not a verdict; it is a verdict with its working. It names every rule that decided it and the authority that set each one, lists every check that ran in the order it ran, carries the effective limits even when the request was within them, carries a deny rule's "do this instead" hint, and carries the fingerprint of the exact rulebook that decided, so a log line can be checked against the rules in force at that moment. A decision that cannot say why is not a decision this layer produces.

In code: `reasons`, `trace`, `setBy` on every check, `limits`, `then`, `fingerprint`; the canonical JSON and hash another implementation must reproduce byte for byte — [`p5-explains.json`](conformance/p5-explains.json), [`fingerprint.json`](conformance/fingerprint.json).

## 6. Waiting has two meanings, and humans stay in the loop

"Wait" can mean *a person must say yes* or *the situation must change*, and the two are never confused. An approval wait returns exactly what needs signing — the rule, the required authority, a digest of the request, the rulebook's fingerprint — and is cleared by an approval from someone holding what the rule names, for that request, under that rulebook. A condition wait — people in the aisle, no staff in the back room — is cleared only by the facts changing, and no approval, however senior, overrides it. A space can choose that every approval be signed by a key it trusts; then an unsigned or unverified approval clears nothing.

In code: `wait { for: 'approval', by? }` versus `wait { for: 'condition' }`, `approvalRequests` on a PAUSE, `requestDigest`, `trustedKeys` and `verified` — [`p6-waiting.json`](conformance/p6-waiting.json), [`approvals.json`](conformance/approvals.json).

## 7. Conflicts are surfaced, never quietly resolved

Two rules that can both match a request and answer differently are reported before any robot moves: a contradiction at the same authority, an override from a lower one, a rule a never rule makes pointless, a rule fully shadowed by a stricter one, two limits that disagree, a plain duplicate. Each finding names the rules, says which one wins and which never takes effect, and says whether the overlap is certain or only possible. The analysis is sound in one direction: two rules are called disjoint only when it is provable from their declared scopes and typed conditions. When the engine cannot prove they never meet, it says "possible" rather than staying silent. A rulebook never hides its findings; a space may refuse to compile with any conflict outstanding.

In code: `checkRulebook`, the seven finding kinds and two certainties, provable disjointness over numbers, integers, times, days, enums and booleans, and the seeded soundness test (any pair the checker calls disjoint is attacked with thousands of generated requests) — [`p7-conflicts.json`](conformance/p7-conflicts.json), [`test/domain-rules.test.ts`](test/domain-rules.test.ts).

## 8. One law for everyone in the space

A robot on the floor, a person wearing glasses, and an AI agent planning a task are participants of different kinds under one rulebook, deciding through one path. The same rule, written once, binds all three; selectors pick by role, by kind or by tag, and a rule that excludes staff excludes staff whether they are human or not. An area that admits only listed roles admits only those roles. There is no second rulebook for machines and no side door for agents.

In code: participant `kinds`, `kind:` and `tag:` selectors with `!` exclusions, `area_role_limits:<area>` never rules, one `evaluate` for every kind, and the glasses bridge that only tightens — [`p8-one-law.json`](conformance/p8-one-law.json).

## 9. Rules say what may happen; evidence says what is true; people choose

This layer answers one question — *may we?* — and nothing else. It trusts the facts it is given: it does not count people, locate robots, read clocks or sensors, and it does not judge whether the spatial system is lying. It returns a ceiling, not a trajectory; a wait, not a stop command; a refusal, not a brake. Physical safety stays with certified controllers and the standards that govern them. The space's declared authorities choose the rules, the named approvers grant the approvals, and people own the consequences; this layer makes sure every one of those choices is visible and applied the same way every time.

In code: facts are taken as given, time is a fact, a LIMIT is reported for the controller to enforce — [`p9-boundary.json`](conformance/p9-boundary.json); the threat model and what is deliberately out of scope — [BOUNDARY.md](BOUNDARY.md).

---

Posemesh-style spatial systems say *where*; these principles say *what's allowed there*.
