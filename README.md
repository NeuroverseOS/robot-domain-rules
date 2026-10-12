# robot-domain-rules

**Rules for robots and people wearing smart glasses in one physical site. Your spatial system says where; this says what's allowed.**

A site operator answers ten plain questions, declares zones and roles, and gets one rule set. Before every action, a robot (or a person's glasses) asks: *may I do this, here, now?* The answer is `ALLOW`, `LIMIT`, `PAUSE` or `BLOCK`, with the rules that decided it.

```
your spatial system (e.g. posemesh)          this package
─────────────────────────────────            ─────────────────────────────────────
where is robot-7?      → zone "aisle-3"  ─┐
who else is there?     → 2 people        ─┼→ evaluateDomainAction(rules, request)
what time is it?       → "14:05"         ─┘        │
                                                    ▼
                                         LIMIT · max 0.3 m/s
                                         robots_near_people: "2 people in Aisle 3…"
```

**Location is not this package's job.** Your spatial system decides which zone each participant is in and how many people are there, and passes that in. This package only decides what is allowed there. It never guesses a fact it wasn't given.

## Run it (one minute)

```bash
git clone https://github.com/NeuroverseOS/robot-domain-rules
cd robot-domain-rules
npm install
npm run demo      # prints the rules, then a day of decisions
npm test          # 15 tests
```

## Use it

```bash
npm install @neuroverseos/robot-domain-rules
```

```ts
import { compileDomain, evaluateDomainAction } from '@neuroverseos/robot-domain-rules';

const rules = compileDomain(store);                 // store = { site, zones, roles, answers } — see examples/store.ts
// rules is plain JSON: save it, version it, send it to every robot and pair of glasses.

const decision = evaluateDomainAction(rules, {
  participant: { id: 'robot-7', kind: 'robot', roleId: 'inventory_robot' },
  action: 'move',
  zoneId: 'aisle-3',                                // from your spatial system
  facts: { peopleInZone: 2, localTime: '14:05', requestedSpeedMps: 1.0 },
});

if (decision.status === 'BLOCK') stop();
if (decision.status === 'PAUSE') waitOrAskAPerson(decision.reasons);
if (decision.status === 'LIMIT') move({ maxSpeed: decision.limits!.maxSpeedMps });
log(decision);                                      // reasons + full trace + rule-set fingerprint
```

No runtime dependencies. ESM and CommonJS, with types.

## Files

| File | What it is |
|---|---|
| [`examples/store.ts`](examples/store.ts) | A complete example site: 6 zones, 3 robot roles, 2 person roles, all 10 answers. Copy it to start. |
| [`examples/demo.ts`](examples/demo.ts) | Compiles the store and runs 17 requests through a day: people arriving, a restricted room, a fire alarm, after hours. |
| [`src/types.ts`](src/types.ts) | Every type: zones, roles, actions, the request and the decision. Read this first. |
| [`src/questions.ts`](src/questions.ts) | The 10 questions, their answers, and the rule each answer produces. |
| [`src/compile.ts`](src/compile.ts) | Answers + zones + roles → rule set. Validation, inheritance, fingerprint, glasses bridge. |
| [`src/evaluate.ts`](src/evaluate.ts) | One request → one decision. Pure, about 200 lines. |
| [`src/zone-rules.ts`](src/zone-rules.ts) | The `ZoneRules` shape glasses enforce, and most-restrictive-wins merging. |
| [`test/domain-rules.test.ts`](test/domain-rules.test.ts) | Tests for every path above. |

## The model

**Participants** are robots or people (people are assumed to wear glasses).

| Robot actions | Glasses actions |
|---|---|
| `enter_zone`, `move`, `manipulate`, `scan`, `dock` | `camera_capture`, `record_audio`, `ai_overlay`, `share_location`, `command_robot` |

**Zones** have a kind: `public`, `staff_only`, `restricted` or `dock`, and an optional speed cap. Use the zone IDs your spatial system reports.

**Roles** list the actions they may take. A role can inherit another role of the same kind (inheritance only adds). Person roles can be `isStaff`; robot roles can be `afterHours`.

**The ten questions** (safe default first):

| Question | Answers |
|---|---|
| `robots_near_people` | `stop` · `slow` · `continue` |
| `robot_speed` | `careful` 0.5 m/s · `walking` 1.0 · `brisk` 1.5 (each with a lower near-people speed) |
| `robots_staff_zones` | `never` · `when_staff_present` · `allowed` |
| `robots_restricted_zones` | `never` · `with_approval` |
| `robots_after_hours` | `never` · `listed_roles` · `allowed` |
| `robot_scan_near_people` | `never` · `pause` · `allowed` |
| `glasses_capture` | `blocked` · `staff_only` · `confirm_each` · `allowed` |
| `robot_commands` | `nobody` · `staff_only` · `anyone_with_approval` |
| `emergency` | `stop_all` · `stop_then_dock` |
| `unknown_actions` | `block` · `pause` |

**Decisions.** Every check is recorded in `trace`. The decision is the strictest check: `BLOCK` > `PAUSE` > `LIMIT` > `ALLOW`. Every reason names its `ruleId`.

- `PAUSE` for **approval** (restricted zone, non-staff robot command, glasses `confirm_each`): re-send the same request with `facts.approvedBy` set and it goes through.
- `PAUSE` to **wait** (people present, no staff in a staff zone): only a change in the facts clears it. Approval does not.
- `LIMIT` carries `limits.maxSpeedMps`: the lowest of the site cap, the zone cap and the near-people cap.
- In an emergency every robot action is `BLOCK`. With `stop_then_dock`, `dock` is the one thing allowed, and blocked moves carry `then: 'dock'`.

**Fail closed.** An undeclared zone, an undeclared role, an action the role doesn't list, or an action no rule covers is blocked (or paused, if you answered `unknown_actions: pause`). Bad input to the compiler throws a `DomainRulesError` that says what to fix.

## Glasses enforce the same rules on-device

`glassesZoneRules(rules, zoneId, roleId)` turns the rule set into the `ZoneRules` a person's glasses apply in one zone. It agrees with `evaluateDomainAction`, and a stricter base passed in is never loosened (most restrictive wins).

The output has the same shape as `ZoneRules` in [`@neuroverseos/governance/spatial`](https://github.com/NeuroverseOS/Neuroverseos-governance), so it can go straight into that package's spatial engine or MentraOS adapter. That package is optional; this one does not depend on it.

## Extending it

- **New zone or role:** add it to your site file. No code change.
- **New question:** add it to `src/questions.ts` with the policy field it sets, add that field to `DomainPolicy` in `src/types.ts`, read it in `src/evaluate.ts`, and add a test. Keep the safe answer first.
- **New action:** add it to `ROBOT_ACTIONS` or `GLASSES_ACTIONS` in `src/types.ts` and give it a phrase in `src/evaluate.ts`. Until a rule mentions it, the role list is the only thing that permits it.

## What this is, and isn't, yet

| Works today, tested | Not built |
|---|---|
| Compile, validate, inherit roles, fingerprint | Zone geometry (your spatial system owns this) |
| Robot rules: zones, people, speed, hours, scanning, emergency | Signing a rule set (sign the JSON with your own key; the fingerprint only identifies it) |
| Glasses rules: capture, robot commands, role limits | Per-zone overrides of the ten answers (one answer set per site today) |
| Same input → same output; no clock, network or LLM | Live connection to any spatial system — you pass the facts in |

The fingerprint is a deterministic hash for citing which rule set decided. It is not a security signature.

## License

Apache-2.0
