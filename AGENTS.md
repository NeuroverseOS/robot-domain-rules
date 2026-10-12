# AGENTS.md — for AI coding agents working in this repo

## What this is

One rule set for a physical site where robots and people wearing smart glasses work together. A site operator answers ten questions and declares zones and roles; `compileDomain()` turns that into a portable JSON rule set; `evaluateDomainAction(ruleSet, request)` answers "may this participant do this action, in this zone, now?" with `ALLOW | LIMIT | PAUSE | BLOCK`, the `ruleId`s that decided it, a full `trace`, and the rule set's `fingerprint`. It is a pure library with no runtime dependencies.

## The boundary

The spatial system (e.g. posemesh) supplies the facts: which zone a participant is in, how many people are there, whether staff are present, the local time. This package never computes location, never reads a clock, never calls a network, never calls a model. If a fact is not in the request, the evaluator does not guess it.

## Files, in read order

| File | Read it for |
|---|---|
| `src/types.ts` | **First.** Every type: site, zones, roles, actions, policy, request, decision. |
| `src/questions.ts` | The ten questions, their options, the policy each option sets, the rule text each produces. Safe option first. |
| `src/compile.ts` | Input → rule set. Validation, role inheritance, `SITE_RULES`, fingerprint, `glassesZoneRules()`. |
| `src/evaluate.ts` | One request → one decision. The whole decision logic, about 200 lines. |
| `src/zone-rules.ts` | `ZoneRules` and `mergeRules` (most restrictive wins). Same shape as `@neuroverseos/governance/spatial`. |
| `src/index.ts` | Public exports and `DomainRulesBuilder`. |
| `examples/store.ts` | A complete example site. `examples/demo.ts` runs a day through it. |
| `test/domain-rules.test.ts` | One test per behavior. Add here; do not add test files without being asked. |

## The contract

Request: `{ participant: { id, kind: 'robot' | 'person', roleId }, action, zoneId, targetRobotId?, facts: { peopleInZone, localTime: 'HH:MM', staffInZone?, requestedSpeedMps?, approvedBy?, emergency? } }`

Decision: `{ status, reasons: [{ ruleId, reason }], limits?: { maxSpeedMps }, then?: 'dock', trace: [...every check...], fingerprint }`

Status is the strictest check: `BLOCK` > `PAUSE` > `LIMIT` > `ALLOW`.

## Invariants — keep every one

1. **Pure and deterministic.** Same rule set + same request → same decision. No `Date`, no I/O, no randomness, no network, no LLM in `compile.ts` or `evaluate.ts`. Ever.
2. **Safe default first.** The first option of every question is the most restrictive one, and `defaultDomainAnswers()` picks it.
3. **Fail closed.** Undeclared zone, undeclared role, action not in the role, action no rule covers → `BLOCK` (or `PAUSE` only when the operator chose `unknown_actions: pause`).
4. **Every decision cites rules.** Every reason carries a `ruleId` that exists in `ruleSet.rules`. Nothing is blocked or allowed silently.
5. **Glasses rules only tighten.** `glassesZoneRules()` merges with the base using most-restrictive-wins; it never loosens a stricter base.
6. **The compiler never invents rules.** Every rule in the output comes from an answer, a declared zone or role, or `SITE_RULES`.
7. **Bad input throws `DomainRulesError`** with a message that says what to fix.
8. **The fingerprint identifies; it does not secure.** Do not describe it as a signature.

## How to extend

- **A zone or role:** edit the site file (`examples/store.ts` or the user's own). No code change.
- **A question:** (1) add it to `DOMAIN_QUESTIONS` in `src/questions.ts`, safe option first, each option with `rule` text and `sets`; (2) add the policy field to `DomainPolicy` in `src/types.ts`; (3) read the field in `src/evaluate.ts` and push a `trace` entry with the question's id as `ruleId`; (4) update the questions table in `README.md`. Then add one test in `test/domain-rules.test.ts`.
- **An action:** add it to `ROBOT_ACTIONS` or `GLASSES_ACTIONS` in `src/types.ts`, give it a phrase in `src/evaluate.ts`. Until a rule mentions it, the role list alone permits it.

## Commands

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest run — 15 tests
npm run build       # tsup → dist/ (esm, cjs, d.ts)
npm run demo        # tsx examples/demo.ts; add --json to write domain-rules.json
```

Run all four before you say a change is done.

## Do not build here

- Zone geometry, localization, people counting, or any map. The spatial system owns that.
- A clock, scheduler, or live feed. Facts arrive in the request.
- An LLM step anywhere in compile or evaluate.
- Per-zone overrides of the ten answers, signing, or a spatial-system client, unless asked. The README's "Not built" table lists these on purpose.
