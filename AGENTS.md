# AGENTS.md — for AI coding agents working in this repo

## The invariants you must keep

[PRINCIPLES.md](PRINCIPLES.md) is the contract. Each principle is enforced by conformance cases, and any change that breaks one is a bug, not a redesign. In one line each:

1. **Every rule carries a declared authority.** `source` and `setBy` on every rule; the engine invents nothing; a rule from an agent or a system is weighed by `setBy`, never by who wrote it.
2. **Authority is declared, layered, and only tightens.** `authorities` highest first; a lower level can only tighten; `authority-override` is named and has no effect; approvals must hold what `wait.by` names.
3. **AI writes and proposes; the rulebook decides.** No model and no clock in `evaluate.ts`, `check.ts`, `compile.ts`; the structured `then` decides, never prose; a draft's `setBy` comes from the caller, never from the model.
4. **Unknown means no; a missing fact is never a yes.** `required_facts`, `area_declared`, `role_declared`, `role_permits_action`, `unknown_action`; only declared defaults are filled in.
5. **Every decision explains itself.** `reasons`, `trace`, `setBy`, `limits`, `then`, `fingerprint`; canonical JSON and the FNV-1a fingerprint are reproduced byte for byte.
6. **Waiting has two meanings.** Approval waits return `approvalRequests` and are cleared by a sufficient approval; condition waits are cleared only by facts; with `trustedKeys` declared, only a `verified` signed approval bound to the request digest and the rulebook fingerprint counts.
7. **Conflicts are surfaced, never quietly resolved.** Seven finding kinds, two certainties; disjointness is claimed only when provable; compile never hides findings.
8. **One law for everyone.** Robots, people and agents through one `evaluate`; selectors by ID, kind, tag and exclusion; area role limits as never rules.
9. **Rules say what may happen; evidence says what is true.** Facts are trusted; this is not a safety system ([BOUNDARY.md](BOUNDARY.md)).

Plus the mechanical ones: rulebooks are deep-frozen and detached from their input; bad config throws `DomainRulesError`, a bad request never throws; the glasses bridge only tightens; the 0.2 input shape keeps deciding identically (`legacy.ts`).

## Any behaviour change needs a conformance case

If a change alters what `evaluate`, `check`, `validateRulebook`, `fingerprint`, `requestDigest` or the approval functions return for any input, it needs a case in [`conformance/`](conformance/) — that is how other implementations learn about it. Add it to `conformance/generate.ts` in the function for its principle, stating the intent by hand (status, reason rule IDs with authorities, finding kinds, or `error`); run `npx tsx conformance/generate.ts` (it refuses to write a case the implementation does not meet); read the JSON diff; run `npm test`. Update [SPEC.md](SPEC.md) in the same change. A change that alters a decision, finding, fingerprint or signature for an existing valid rulebook is a spec major bump (SPEC.md § 11).

## The contract, briefly

Request: `{ participant: { id, kind, roleId }, action, areaId, facts: { ...declared facts, approvedBy? } }`. `approvedBy` is a string, `{ id, authority?, roleId? }`, or a verified signed approval.

Decision: `{ status, reasons, limits?, then?, approvalRequests?, trace, fingerprint }`. Strictest wins: `BLOCK` > `PAUSE` > `LIMIT` > `ALLOW`. The exact algorithm is SPEC.md § 6.

Rule: `{ id, text, who, does, where, when?, then, reason?, source, setBy, never? }`. `source.kind` ∈ template, question, declaration, manual, text, agent, system, builtin.

## Files, in read order

| File | Read it for |
|---|---|
| `src/types.ts` | **First.** Every type. |
| `src/vocabulary.ts` | Selectors, fact validation, conditions, and the exact constraint sets the conflict check uses. |
| `src/compile.ts` | Input → rulebook: templates, validation, role inheritance, area never rules, `validateRule`, `validateRulebook`, freezing. |
| `src/canonical.ts` | Canonical JSON, `fingerprint`, `requestDigest` — what other languages reproduce. |
| `src/evaluate.ts` | One request → one decision, including approval sufficiency and binding. |
| `src/check.ts` | The conflict check: overlap, certainty, classification, plain-English messages. |
| `src/approvals.ts` | Ed25519 via WebCrypto: sign/verify approvals and rulebooks. Zero dependencies. |
| `src/draft.ts` | Deterministic text drafting; model prompt and answer validation. |
| `src/templates/template.ts` | The template contract. `grocery-store.ts`, `warehouse.ts` are the two shipped. |
| `src/legacy.ts`, `src/render.ts`, `src/glasses.ts`, `src/zone-rules.ts` | 0.2 input shape; rendering; the glasses bridge. |
| `src/index.ts` | Public exports and `DomainRulesBuilder`. |
| `conformance/` | The cases, `compare.mjs` (the judging rules), `run-node.mjs`, `generate.ts`. |
| `test/domain-rules.test.ts` | One test per behaviour, plus the seeded soundness test. `test/conformance.test.ts` runs every case. Do not add test files without being asked. |
| `examples/` | Sites, `demo.ts`, `harness/` (volumes adapter + replay), `mcp/` (its own package). |
| `site/` | The switchboard. See below. |

## How to extend

- **A template:** `src/templates/<id>.ts` exporting a `Template` (first option of every question is the safe one; each question names its `setBy`), registered in `src/templates/index.ts`, with an example and one test.
- **An action, area, role, fact, limit, authority or trusted key:** declare it in the site input. No code change.
- **A fact type or condition operator:** `types.ts`, then `vocabulary.ts` (`factProblem`, `validateCondition`, `conditionHolds`, and a constraint with exact `intersect` and `isSubset`), `render.ts`, `draft.ts`; SPEC.md § 3.2 and § 7.1; conformance cases proving disjointness still holds where it should.
- **A text pattern:** `draft.ts` only. Deterministic; keep `unmatched` honest.

## The switchboard (`site/`)

Static Vite + Preact + TypeScript; live at https://neuroverseos.github.io/robot-domain-rules/ via `.github/workflows/pages.yml`. It imports the core from `../src` (never `dist/` or npm) and the example builders from `examples/`, runs entirely in the browser (no backend, no model call, no analytics; state in the URL hash and localStorage), and never changes the core's meaning: it only calls public functions. A UI need is not a reason to change `src/`. Pure logic in `site/src/lib/`, panels in `site/src/ui/`, tests of the pure logic in `site/test/`. Scenario presets live in `site/src/lib/starting-points.ts`.

## Commands

```bash
npm install
npm run typecheck        # tsc --noEmit (src, examples except mcp, test, conformance/generate.ts)
npm test                 # vitest run --dir test — core tests + every conformance case
npm run build            # tsup → dist/
node conformance/run-node.mjs      # the cases against dist/, no framework
npm run demo             # tsx examples/demo.ts; add -- --json to write <site>.rules.json
npx tsx examples/harness/replay.ts
cd site && npm install && npm run typecheck && npm test && npm run build
cd examples/mcp && npm install && npm run typecheck
```

Run typecheck, test, build and the conformance runner before you say a change is done; the site's three if you touched `site/` or anything it imports.

## Do not build here

- Area geometry, localisation, people counting, identity, sensors, maps. The surrounding system owns that (`examples/harness/volumeAt` is an example helper, not a feature).
- A clock, scheduler or live feed. Facts arrive in the request; `issuedAt` is for the caller.
- A model call anywhere in the core. `buildRuleDraftPrompt` / `parseRuleDraft` are the whole model surface.
- A key store, expiry policy, or HTTP service. Key custody and age limits are the deployment's.
