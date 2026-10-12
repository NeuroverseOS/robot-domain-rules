# Changelog

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
