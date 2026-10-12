# Changelog

## 0.5.1

Test a rulebook against recorded activity before it goes live. Spec stays `robot-domain-rules/2`: § 13 is a new function over existing formats and changes no decision, finding, fingerprint or signature.

### Added

- **Backtest.** `backtest(rulebook, events, options?)`: replays a recorded log — `[{ at, request, outcome? }]` in time order — through a rulebook and reports what it *would have decided*: totals and counts by area, by role and by rule (ALLOW / LIMIT / PAUSE / BLOCK / missing facts, the five summing to the events); the rules that never fired; the rules and built-in checks that would have stalled work (PAUSE or BLOCK, most often first, with example timestamps); the findings that actually occurred (both rules matched a recorded request, by the same matching relation a witness is judged by); gaps (`unknown_action`, by action); the facts the log did not carry (by fact, via the new `missingFacts(rulebook, request)`); and, when the log records outcomes, where the rule and the record differ, without judging which is right. A rule that counts history gets the earlier events of the same participant on the same day of the log, unless the request brings its own. Pure, deterministic, no free text; every list has a defined order. `compareBacktests(baseline, proposed)` sets a current rulebook against a proposed one on the same log: newly blocked, newly allowed, other changes, and each rule's decided count before and after. SPEC.md § 13; `spec/backtest.schema.json`, `spec/backtest-report.schema.json`; `conformance/backtest.json` (13 cases, 194 in all); `compare.mjs` judges the report and the comparison deep-equal.
- **Sample week** (`examples/backtest/`): a clearly labelled synthetic week (189 events, not from a real store) at a grocery site with aisle 5, a `robotsInZone` count fact and the rule "at most two robots in aisle 5"; `backtest.ts` prints the report and the comparison with "at most three", and writes `sample-week.jsonl`.
- **Switchboard Test mode**: load the sample week (with its site) or import a JSON/JSONL log; the five-word summary, then the findings lists; "Compare with a proposed change" snapshots the rulebook as baseline, then any edit in the rulebook panel shows what would change. The log never goes in the link.
- Docs: README (engineer path step 4, operator path, roadmap: explaining *why* is out of scope), PRINCIPLES 5 "In code", RELATED-WORK row, AGENTS.md.

### Changed

- `evaluate.ts` names the facts behind a `required_facts` refusal internally (`missingFacts`); decisions, findings and fingerprints are unchanged for every existing rulebook (the 181 earlier conformance cases are byte-identical).

## 0.5.0

Whole-plan checking for AI planners, an exact conflict analysis cross-checked with Z3, a Cedar export, and a planner replay. Spec `robot-domain-rules/2`.

### Added

- **Whole plans.** `evaluatePlan(rulebook, plan)`: a planner proposes `{ participant, steps, initialFacts, history?, clock?, startTime?, stepDurationSeconds? }`; each step is decided with the single-action evaluator on the facts PROJECTED from the earlier steps' declared effects; the result is `{ status, steps (each with its decision and facts), planChecks, firstViolation?, approvalRequests, finalFacts, finalArea, planDigest, fingerprint }`. Nothing is projected past the first BLOCK; a PAUSE lists every approval the plan needs so a planner can collect them up front; a projected fact out of range is `required_facts`, never a clamp; a malformed plan is BLOCK, never a throw. SPEC.md § 12, `spec/plan.schema.json`, `spec/plan-evaluation.schema.json`.
- **Effects.** An action may declare `effects`: `{ op: 'set' | 'add' | 'subtract', fact, value }` or `{ op: 'move' }` (the participant is in the step's area afterwards). Validated against the declared facts. The grocery template's `enter_zone` and `dock` move, `manipulate` sets the new `carrying` fact and the new `place` action clears it; the warehouse template's `enter` and `dock` move. SPEC.md § 2.1.
- **Plan rules.** `rulebook.planRules`: `ends_in`, `ends_with`, `before` (optionally same area; the plan's `history` counts), `at_most`; each with `who`, `setBy`, `source`, `reason`; they can only reject and name the step where the plan breaks them. `DomainRulesBuilder.addPlanRule`, `validatePlanRule`. The grocery example gained `scan_before_restock` and `end_at_dock`, and a `no_carrying_through_checkout` rule. SPEC.md § 3.5.
- **History conditions.** A rule may carry `history: [{ actions, areas?, sameArea?, withinMinutes?, clock?, op, value }]` over `request.history` (`[{ action, areaId, at? }]`, caller-supplied). Windows use minute-of-day arithmetic on a declared time fact and wrap at midnight. A rule in scope that needs history and does not get it is `required_facts`. SPEC.md § 3.4.
- **Exact conflict analysis with witnesses.** `checkRulebook` is complete for the rule language: two rules are reported if and only if some request matches both, and every `certain` finding carries `witness`, a concrete request that triggers both rules (the smallest values in every overlap; SPEC.md § 7.4). Integer ranges are exact (closed on whole numbers; every-whole-number-excluded is empty). `certainty: 'possible'` now means only "a rule here has history conditions, which are not modelled"; it no longer means "partial overlap". `rulesOverlap(rulebook, idA, idB)` and `matchingRules(rulebook, request)` are exported. The switchboard's "Rules at odds" shows the witness with a "try it" button.
- **Z3 cross-check** (`test/z3-crosscheck.test.ts`, runs in `npm test`): hundreds of seeded rulebooks are encoded into the Z3 SMT solver and the checker must agree on every pair, and every witness must satisfy both formulas — 306 rulebooks, 1,836 pairs, 1,115 witnesses, ~6 s. `z3-solver` is a devDependency only.
- **Cedar export** (`adapters/cedar/`, its own package): `toCedar(rulebook) → { policies, schema, notExported, droppedByAuthority }`; authority resolved first; roles' action lists and allow rules → `permit`, deny and never rules → `forbid` with `when` clauses over `context`; LIMIT, both WAIT kinds, approvals, history and plan rules listed as not exported. Tested against `@cedar-policy/cedar-wasm` (strict validation; Cedar's decisions agree with ours on the exported subset for every example request).
- **Planner replay** (`examples/harness/plan-replay.ts`, `plans.jsonl` → `plan-decisions.jsonl`): v1 rejected at step 2, v2 pauses for one approval, Dana signs it (Ed25519, TEST ONLY key), v2 accepted. Readable transcript.
- **Switchboard Plan mode**: load a preset plan (the replay's v1 and v2 among them) or build one, step through it on projected facts, see the first violation, every step's decision, the plan rules, the approvals and where it ends. The mode and the plan travel in the link.
- Conformance: `plans.json` (19 cases) and `history.json` (14 cases); witnesses on every certain finding; `p7` gains every-shape and integer-exclusion cases; `compare.mjs` judges witnesses by validity through `impl.matches` and compares plan evaluations. 181 cases.
- Docs: SPEC.md § 2.1, § 3.4, § 3.5, § 7 (exact), § 7.4, § 7.5, § 12; PRINCIPLES.md (plans under 3, history under 4, exactness under 7); RELATED-WORK.md (whole-plan row, "layers, not competitors"); README roadmap ("rules that learn from evidence"; plan synthesis out of scope).

### Changed

- **Spec `robot-domain-rules/2`.** The exact analysis changed the certainty of some findings (`possible` → `certain` with a witness) and, through the `witness` member, the fingerprint of any rulebook that has findings. Decisions for existing rulebooks did not change. The rulebook `format` string stays `neuroverse-domain-rules/2`: every new member is optional and a rulebook without findings or plan rules keeps its fingerprint.
- Template actions now declare effects and the grocery template declares `carrying` and `place`, so rulebooks built from the templates (and the example fingerprints) changed. `inputFromRulebook` in the switchboard carries `planRules`.
- The published package adds `adapters/cedar/` (source, README, package.json) and the planner replay; still no runtime dependencies.

## 0.4.0

The release for engineers who will build their own: principles, a language-neutral spec with conformance tests, signed approvals, and a harness replay.

### Added

- **[PRINCIPLES.md](PRINCIPLES.md)** — nine principles for spaces shared by people, robots and AI, each enforced by named conformance cases. **[BOUNDARY.md](BOUNDARY.md)** — what this layer is and is not, what it trusts, the threat model, where each check belongs. **[RELATED-WORK.md](RELATED-WORK.md)** — how it compares with Cedar/AgentCore, ASIMOV, RoboGuard and Open-RMF.
- **[SPEC.md](SPEC.md)** (`robot-domain-rules/1`) — normative: every format, the decision algorithm as numbered pseudocode, the conflict analysis, authority semantics, canonical JSON and the fingerprint byte for byte, request digests, approvals. JSON Schemas (draft 2020-12) in `spec/`.
- **`conformance/`** — 144 language-neutral JSON cases grouped by principle, with shared rulebooks, Ed25519 test vectors under TEST ONLY keys, exact comparison rules (`README.md`), a framework-free runner (`run-node.mjs`) and the generator that produced them (`generate.ts`, intent stated by hand). The reference passes its own suite (`test/conformance.test.ts`).
- **Seeded soundness test** for the conflict analysis: every pair the checker calls disjoint is attacked with thousands of generated requests; none may match both rules.
- **Approvals as data, signed.** `ApprovalRequest` (returned as `decision.approvalRequests` on a PAUSE for approval: rule, required authority/role, `requestDigest`, `rulebookFingerprint`, reason), `SignedApproval`, `TrustedKey`. Ed25519 via the platform WebCrypto, no dependencies: `generateSigningKeys`, `publicKeyOf`, `signApproval`, `verifyApproval`, `signRulebook`, `verifyRulebookSignature`, `requestDigest`, `canonicalJson`. A rulebook may declare `trustedKeys`; then only an approval the caller verified (`verified: true`) and that is bound to this request's digest and this rulebook's fingerprint clears an approval wait. Without `trustedKeys` the plain `approvedBy` path still works (development only).
- **`validateRulebook(rulebook)`** — the problems, in plain words, with a rulebook received as JSON; what the spec calls rulebook validation.
- **Rules from agents and systems.** `source.kind` gains `agent` and `system`. A rule added by any author holding a declared authority goes in at that authority directly; `draftRuleFromText` / `parseRuleDraft` take `source` and `author` options and return `ready` (true when the draft has a declared authority and can be added as it is). The `grocery-store` template's authorities are now `law-and-safety` > `company` > `site-manager` > `staff` > `agent`.
- **`examples/harness/`** — `volumes-to-areas.ts` maps a semantic-volumes collection (the shape `aukilabs/domain-harness` describes; sample hand-written) onto rulebook areas, with an example-only `volumeAt`; `replay.ts` + `events.jsonl` replay an AI planner proposing tasks, poses and people counts, one signed approval and an emergency into an append-only `decisions.jsonl` and a summary. Deterministic.
- **`examples/mcp/`** — a ~100-line stdio MCP server (`may_i`, `explain_rulebook`) with its own `package.json`; the MCP SDK is a dependency there only.
- README restructured for two readers; "Where AI fits"; "Why not Cedar or OPA?". AGENTS.md leads with the principles and the conformance-case rule. The switchboard links PRINCIPLES and SPEC and shows the approval request a PAUSE returns.

### Changed

- **`engines.node` is `>=20`** (Ed25519 in WebCrypto). The core still has no runtime dependencies.
- The `grocery-store` template gained the `agent` authority, so rulebooks built from it (and the example fingerprints) changed. Decisions do not.
- The reason text of an approval that does not count under declared trusted keys says why (`… does not count here: …`). Reason texts are free-form and not part of the conformance contract.
- The published package now includes `PRINCIPLES.md`, `SPEC.md`, `BOUNDARY.md`, `RELATED-WORK.md`, `spec/` and `conformance/` (cases, runner, README); `examples/mcp` ships its source and `package.json` only.

## 0.3.1

### Added

- **The switchboard** (`site/`): a static page that builds a rulebook, sets a situation and shows the decision with the authority behind it. Three columns: start from the grocery store, the warehouse, the clinic or an empty site; answer the template questions and watch the rules change; write a rule in plain words, read the draft and confirm it as a chosen authority; switch operator rules off or delete them. Set who is asking, the action, the area, every declared fact, the emergency switch and an approval, or pick a scenario in one click. See YES / SLOWER / WAIT / NO with limits, reasons, the authority chain in declared order, the full trace and the fingerprint, next to what would happen without rules. A "Rules at odds" panel shows the conflict check live. Export the rulebook as JSON or readable text, import one (fingerprint verified), copy the code that asks it. The whole state lives in the link and in the browser; nothing leaves the page.
- Live demo on GitHub Pages: https://neuroverseos.github.io/robot-domain-rules/ (`.github/workflows/pages.yml`, built from `site/`, which imports the core from `src/`).
- README reorganised: the idea, the live demo, a screenshot, what it does in 30 seconds, install and a short example, then the detail. A repo map. AGENTS.md covers the site.

### Changed

- No core behaviour change. `package.json` `homepage` points at the live demo; `npm test` runs the core's `test/` directory only (the site has its own tests, `npm run site:test`). The published package is unchanged in content and still has no runtime dependencies; `site/` and `docs/` are not published.

## 0.3.0

### Changed

- **Generic model.** Nothing is hardcoded any more. A site declares its own kinds of participants, actions (each tagged with the kinds that may do it), areas (free tags), roles (actions, inheritance, tags), typed facts (`number`, `boolean`, `time`, `day`, `enum`, `string`; required or with a default), named limits (combined by MIN) and authorities. Every rule has one shape: `{ id, text, who, does, where, when, then, setBy, source, never? }`. `then` is `allow`, `limit`, `wait` (for approval or for a condition) or `deny` (with an optional `instead` hint). `compileDomain` and `evaluateDomainAction` keep their names.
- **Authority.** A rulebook declares an ordered list of authorities (templates default to `law-and-safety` > `company` > `site-manager` > `staff`). Every rule carries `setBy`. A lower authority may only tighten a higher one. `wait { for: 'approval', by }` names who may approve (an authority or higher, a role, or a role tag); `facts.approvedBy` may be `{ id, authority?, roleId? }` and only clears the wait if the approver holds it. Every check in a decision carries `setBy`.
- Rule IDs cited in decisions: `zone_declared` → `area_declared`, `unknown_actions` → `unknown_action`, `zone_role_limits` → `area_role_limits:<area>` (`:deny` for denyRoles), emergency glasses commands → `emergency_stop_commands`, `zone_speed_cap` → `zone_speed_cap:<zone>`. A `command_robot` request without `targetRobotId` is `required_facts`. `rulebook.policy` is gone (`answers` and `rules` carry the same information). `format` is `neuroverse-domain-rules/2`.

### Added

- **Templates** whose answers emit rules: `grocery-store` (the ten 0.2 questions, same decisions) and `warehouse` (aisle exclusivity, robots per aisle via a numeric fact, dock access). A site may pass its own `Template` or none.
- **Plain-text drafting**, deterministic: `draftRuleFromText(text, rulebook, { setBy })` matches common forms against the rulebook's own names and synonyms and returns `{ draft, confidence, unmatched, notes }`. Never adds a rule.
- **Drafting with the operator's own model**: `buildRuleDraftPrompt` and `parseRuleDraft`. No network calls in the package; the model never sets the authority.
- **Conflict detection**: `checkRulebook(input | rulebook)`, also run by `compileDomain` and returned as `rulebook.findings`. Kinds: `contradiction`, `authority-override`, `never_vs_rule`, `shadowed`, `duplicate`, `limit_disagreement`, `tightening`. Each finding has a severity, rule IDs, a certainty (`certain` / `possible`) and a plain-English message naming which rule wins and which never takes effect. Disjointness is sound: only claimed when provable. `compileDomain(input, { strict: true })` throws on conflicts.
- `renderDomainRules` now shows authorities, facts, limits, never rules, every rule as `who · does · where · when → answer` with who set it and where it came from, and the findings.
- `DomainRulesBuilder`: `fromTemplate`, `as`, `action`, `area`, `fact`, `limit`, `tags`, `authorities`, `otherwise`, `addRule`, `addRuleFromText`, `confirm`, `check`, `toInput`.
- Examples: `grocery-store.ts` (with two deliberately conflicting manager rules), `warehouse.ts`, `clinic.ts` (no template), `demo.ts` prints all three.
- 38 tests (the 20 from 0.2 ported, plus generic sites, every operator, overnight windows, each finding kind, soundness, authority, drafting, strict mode, 0.2 equivalence).

### Deprecated

- The 0.2 input shape `{ site: { domainId }, zones, roles, answers }`. Still accepted and translated through the `grocery-store` template; decides identically. Request fields `zoneId` and top-level `targetRobotId` are still accepted.

## 0.2.1

### Changed

- License is now MIT, matching Auki's open-source repos. No code changes. Versions 0.1.0 and 0.2.0 remain under Apache-2.0.

## 0.2.0

### Fixed

- Missing or invalid facts are never permission. A request without `peopleInZone`, with a bad `localTime`, a negative count, a non-number speed, or a malformed participant/zone/action now gives `BLOCK` with the new fixed rule `required_facts`, naming what is missing. Before, an absent `peopleInZone` read as an empty zone, and a bad `localTime` threw instead of deciding.
- Fundamental restrictions apply to every action. An unknown action approved under `unknown_actions: pause` now still faces the emergency, opening-hours, zone-kind, zone-role and people rules. Before, it returned early and was allowed during an emergency and after hours.

### Added

- Per-zone role limits: `allowRoles` and `denyRoles` on a zone, rule `zone_role_limits`. Checked at compile time (unknown role, role in both lists → `DomainRulesError`). Inheritance does not pass zone permission. Rendered by `renderDomainRules`.
- Compiled rule sets are deep-copied from the input and deep-frozen, so later edits to the input cannot change them and the fingerprint stays true.
- `verifyFingerprint(ruleSet)`: recompute and compare, for a rule set received as JSON.
- `isValidTime(value)` export.
- `emergency` is documented as the one fact with a default (absent = no emergency active).
- Example store gains a `restroom` zone limited to `cleaning_robot`, `staff`, `shopper`; the demo shows a restock robot blocked and the cleaning robot allowed. The example fingerprint changed accordingly.
- README describes the package as a governance core and adds "Who does what"; AGENTS.md mirrors the contract and new invariants.

## 0.1.0

- First release: `compileDomain`, `evaluateDomainAction`, `glassesZoneRules`, `renderDomainRules`, `DomainRulesBuilder`, ten operator questions, fixed site rules, deterministic fingerprint, example store and demo, 15 tests.
