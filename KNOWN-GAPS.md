# Known gaps

What this layer does not do yet, or does not do at all, said plainly. Each item says what happens today and whose job the rest is.

## Overlapping or nested areas

A request names one `areaId`. If your spatial system reports that a participant is inside several volumes at once (a nested "cold aisle" inside "aisle 5"), the rulebook has no notion of containment and will not combine them for you.

**Interim rule:** evaluate once per area the participant is in and take the strictest decision. Statuses order `ALLOW < LIMIT < PAUSE < BLOCK`; limits combine by the minimum per name.

```ts
import { evaluateDomainAction, type DomainDecision } from '@neuroverseos/robot-domain-rules';

const ORDER = { ALLOW: 0, LIMIT: 1, PAUSE: 2, BLOCK: 3 } as const;
function strictestAcrossAreas(rulebook, base, areaIds: string[]): DomainDecision {
  const decisions = areaIds.map(areaId => evaluateDomainAction(rulebook, { ...base, areaId }));
  const strictest = decisions.reduce((a, b) => (ORDER[b.status] > ORDER[a.status] ? b : a));
  const limits: Record<string, number> = {};
  for (const d of decisions) for (const [k, v] of Object.entries(d.limits ?? {})) limits[k] = k in limits ? Math.min(limits[k], v) : v;
  return Object.keys(limits).length && (strictest.status === 'ALLOW' || strictest.status === 'LIMIT') ? { ...strictest, limits } : strictest;
}
```

The trace of the returned decision is the strictest area's only; keep all of them if you audit. A first-class answer (area containment in the rulebook, one decision over a set of areas) is a spec change and not scheduled.

## Fact provenance and freshness

The engine trusts every fact as given and has no idea how old it is or where it came from. `request.now` is the caller's clock; a people count from two minutes ago is accepted as current. Provenance (which sensor, when, how confident) and freshness windows belong in the harness that assembles the request. The rule stands: facts come from the harness, never from the requester.

## Robot-to-robot coordination

Two robots asking at the same moment each get a decision on the facts each request carries; nothing here serialises them, reserves space, or orders traffic. That is a traffic layer's job (Open-RMF or your own). A count fact such as `robotsInZone` lets a rule say "no more than two", but keeping that count right under concurrency is the spatial system's.

## Authority is not yet bound to domain ownership or identity

`setBy` and `trustedKeys` are declared in the rulebook, and the rulebook is validated by a fingerprint and optionally a pinned signing key. Nothing ties an authority to an owner of the spatial domain, to a login, or to an organisation's identity provider; nothing lets a higher authority grant a one-off exception to a lower rule except by writing a rule. Those are deployment and product questions this layer leaves open.

## Rulebook pinning and revocation per domain

A deployment must decide which rulebook is in force for which domain, how a new one replaces it, and how an old one (or a compromised approver key) is revoked. The layer gives the pieces — fingerprint, signature with a pinned key, `trustedKeys` — not the policy or the distribution.

## No persistence, versioning or distribution

Rulebooks, decision logs, consumed-nonce sets and approvals are plain data; nothing here stores, versions, syncs or serves them. A product does that.

## Replay protection depends on the caller's set

An approval is single-use only if the caller keeps the `consumedApprovals` set it is told about (`decision.approvalsUsed`). Without it, an approval can be re-used until it expires. The engine is pure and cannot keep the set for you.

## The conflict analysis does not model history conditions

A rule with `history` conditions is reported as `possible` against anything it overlaps on facts, with no witness. Exact analysis of history windows would need a model of the caller's history; not scheduled.

## The plain-text drafter is a convenience

It handles the simple forms and refuses to guess beyond them (counts versus speeds, verbs it does not model). A real editor should use the model path (`buildRuleDraftPrompt` + `parseRuleDraft`), where the model proposes structured JSON and the validator refuses what the site did not declare.
