# Changelog

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
