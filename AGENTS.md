# AGENTS.md — for AI coding agents working in this repo

## What this is

A governance core for physical spaces where robots, people and AI-driven agents work together. The people who run a site declare their own vocabulary (kinds, actions, areas, roles, facts, limits, authorities), answer a template's questions and write rules in plain words; `compileDomain()` turns that into one frozen JSON rulebook, with the conflict check's findings on it; `evaluateDomainAction(rulebook, request)` answers "may this participant do this action, in this area, now?" with `ALLOW | LIMIT | PAUSE | BLOCK`, the rule IDs that decided it, who set each rule, a full trace and the rulebook's fingerprint. Pure library, no runtime dependencies.

## The contract

Request: `{ participant: { id, kind, roleId }, action, areaId, facts: { ...declared facts, approvedBy? } }`. `approvedBy` is a string or `{ id, authority?, roleId? }`. (`zoneId` and a top-level `targetRobotId` are accepted for 0.2 callers.)

Decision: `{ status, reasons: [{ ruleId, status, reason, setBy }], limits?, then?, trace, fingerprint }`. Status is the strictest check: `BLOCK` > `PAUSE` > `LIMIT` > `ALLOW`.

Order in `evaluate.ts`: request shape and declared area/role → facts, typed and complete → never rules → role lists the action (unknown action: `otherwise`) → every matching rule; limits combine by MIN.

Rule: `{ id, text, who, does, where, when?, then, reason?, source, setBy, never? }`. Selectors resolve to finite sets of declared IDs. Conditions are per-fact and AND-ed.

## Invariants — keep every one

1. **Pure and deterministic.** No `Date`, I/O, randomness, network or model in `compile.ts`, `evaluate.ts`, `check.ts` or `draft.ts`. Time is a fact.
2. **Rules are never invented by the core.** Every rule in a rulebook comes from a template, a question the operator answered, an area the operator declared, or a rule the operator wrote or confirmed. Text drafting and model drafting only PROPOSE; nothing is added until the operator confirms it.
3. **Authority is declared, never inferred.** Every rule has `setBy`, from the template question or the operator (`builder.as()`), never from text and never from a model. A lower authority may only tighten a higher one; the check names any attempt to loosen (`authority-override`). An approval clears a wait only if the approver holds what `then.by` names.
4. **Conflict analysis is sound.** Two rules are called disjoint only when it is provable (`vocabulary.ts` constraints: exact intersection and subset per fact). `certain` means one rule's conditions imply the other's; anything else that overlaps is `possible`. Compile never hides findings.
5. **Safe default first.** The first option of every question is the most restrictive; unanswered questions take it. Permissive answers emit no rule (the role list is the grant); templates emit restrictions.
6. **Fail closed.** Undeclared area, undeclared role, action not in the role → `BLOCK`. An action the rulebook does not know follows `otherwise` (deny by default).
7. **Missing facts never mean permission.** A required fact (or one the action requires) that is absent or invalid is `BLOCK required_facts`. Only a fact with a declared default is ever filled in. Rules may only condition on facts that are always present.
8. **Never rules first; nothing overrides them.** They run before anything else, including for approved unknown actions, and every matching rule applies to every action.
9. **Every decision cites rules.** Every `reasons`/`trace` entry has a `ruleId` that exists in `rulebook.rules` or `rulebook.builtin`, and a `setBy`.
10. **Strictest wins; limits take the lowest.** Approval waits are cleared by a sufficient `approvedBy`; condition waits are not.
11. **Rulebooks are frozen.** `compileDomain` deep-copies its input and deep-freezes the result. `verifyFingerprint` detects change, not tampering; the fingerprint is not a signature.
12. **Bad config throws `DomainRulesError`** (undefined references, wrong fact types, impossible conditions, missing `setBy`); a bad *request* never throws.
13. **Glasses rules only tighten.** `glassesZoneRules` reads conditional rules as if they held and merges most-restrictive-wins.
14. **Area role limits are not inherited.** `allowRoles` / `denyRoles` name roles directly; they compile to never rules `area_role_limits:<area>`.
15. **The 0.2 input shape keeps deciding identically** through the `grocery-store` template (`legacy.ts`); the equivalence test pins the 0.2.1 demo statuses.

## Files, in read order

| File | Read it for |
|---|---|
| `src/types.ts` | **First.** Every type: vocabulary, rules, findings, rulebook, request, decision. |
| `src/vocabulary.ts` | Selectors, fact validation, conditions, and the constraint sets the conflict check uses. |
| `src/compile.ts` | Input → rulebook: templates, validation, role inheritance, area never rules, `validateRule`, fingerprint, freezing. |
| `src/evaluate.ts` | One request → one decision, including approval authority. |
| `src/check.ts` | The conflict check: overlap, certainty, classification, plain-English messages. |
| `src/draft.ts` | Deterministic text drafting; model prompt and answer validation. |
| `src/templates/template.ts` | The template contract. `grocery-store.ts`, `warehouse.ts` are the two shipped. |
| `src/legacy.ts` | 0.2 input shape → 0.3 input. |
| `src/render.ts`, `src/glasses.ts`, `src/zone-rules.ts` | Plain-text rendering; the glasses bridge and its `ZoneRules` shape. |
| `src/index.ts` | Public exports and `DomainRulesBuilder`. |
| `examples/` | `grocery-store.ts`, `warehouse.ts`, `clinic.ts`, `demo.ts`, `legacy-store-0.2.ts`. |
| `test/domain-rules.test.ts` | One test per behaviour. Add here; do not add test files without being asked. |

## How to extend

- **A template:** add `src/templates/<id>.ts` exporting a `Template` (kinds, authorities, actions, facts, limits, tags, questions whose options emit rules via `rules(ctx)`; first option safe; each question names its `setBy`), register it in `src/templates/index.ts`, add an example and one test.
- **An action, area, role, fact, limit or authority:** declare it in the site input (or the template). No code change.
- **A fact type:** add it to `FactType` in `types.ts`; teach `factProblem`, `validateCondition`, `conditionHolds`, `universeConstraint` and `conditionConstraint` in `vocabulary.ts` (the constraint must support exact `intersect` and `isSubset`), `describeFact` in `render.ts`, and `matchCondition` in `draft.ts` if text should reach it. Add a test.
- **A condition operator:** add it to `Condition` in `types.ts`; validate it, evaluate it and give it an exact constraint in `vocabulary.ts`; describe it; add it to the model prompt in `draft.ts`. Add a test that proves disjointness still holds where it should.
- **A text pattern:** `draft.ts` only. Keep it deterministic and keep `unmatched` honest.

## Commands

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest run — 38 tests
npm run build       # tsup → dist/ (esm, cjs, d.ts)
npm run demo        # tsx examples/demo.ts; add -- --json to write <site>.rules.json
```

Run all four before you say a change is done.

## Do not build here

- Area geometry, localisation, people counting, identity, sensors, maps. The surrounding system owns that.
- A clock, scheduler or live feed. Facts arrive in the request.
- A model call anywhere in the core. `buildRuleDraftPrompt` / `parseRuleDraft` are the whole model surface.
- Signing, a spatial-system client, or per-area template overrides, unless asked.
