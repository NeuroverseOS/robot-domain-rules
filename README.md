# robot-domain-rules

**AI and robots propose. The space's own rules decide — with a reason, and the authority behind it.**

**[▶ Try it live](https://neuroverseos.github.io/robot-domain-rules/)** — build a rulebook, set a situation, see the decision. Runs in your browser; nothing leaves the page.

[![The switchboard: rulebook, situation, decision](docs/switchboard.jpg)](https://neuroverseos.github.io/robot-domain-rules/)

A governance core for physical spaces where robots, people and AI-driven agents work together. The people who run a space turn their answers and plain-language rules into one rulebook. Before any robot, pair of glasses or AI agent acts, it asks the rulebook and gets **yes / slower / wait / no**, with the reason and who set the rule. Pure TypeScript, no runtime dependencies, no clock, no network, no model inside.

## What it does in 30 seconds

```
template ──► answer questions ──► write rules in plain words ──► check for conflicts ──► compile ──► every participant asks
 (optional)   each answer emits    "no restock robots in        rules at odds are      one JSON     evaluateDomainAction(
              rules                 aisle 3 on Saturdays"        named, never hidden    rulebook       rulebook, request)
```

1. **Start from a template or from nothing.** A template brings default actions, facts, limits, authorities and a short set of questions. Or declare everything yourself: your own kinds of participants, actions (`deliver_meds`), facts (`patient_present`), authorities.
2. **Answer questions.** Each answer emits rules. The first option is always the safe one.
3. **Write rules in plain words.** `draftRuleFromText("robots slow to 0.3 m/s in checkout")` matches against your rulebook's own vocabulary and returns a draft, a confidence and the words it could not place. You read it, then confirm it. Nothing is added on its own. (Or hand the text to your own model with `buildRuleDraftPrompt` and validate its answer with `parseRuleDraft`.)
4. **Check for conflicts.** Two rules that can match the same request but answer differently; a rule that can never take effect; a lower authority trying to loosen a higher one. Every finding says which rule wins.
5. **Compile.** One frozen JSON rulebook with a fingerprint. Save it, version it, ship it.
6. **Every participant asks.** `ALLOW`, `LIMIT` (with the limits), `PAUSE` (for approval, or for the situation to change) or `BLOCK`, with the rules that decided, who set them, and a full trace.

Every rule says who set it. A lower authority can only make things stricter. Approvals count only from someone holding the authority the rule names.

## Install and use

```bash
npm install @neuroverseos/robot-domain-rules
```

```ts
import { DomainRulesBuilder, evaluateDomainAction } from '@neuroverseos/robot-domain-rules';

const builder = new DomainRulesBuilder({ id: 'store-1', name: 'Store 1', hours: { open: '07:00', close: '22:00' } })
  .fromTemplate('grocery-store')
  .area({ id: 'aisle-3', name: 'Aisle 3', tags: ['public'] })          // IDs your spatial system reports
  .role({ id: 'inventory_robot', name: 'Inventory robot', kind: 'robot', actions: ['enter_zone', 'move', 'scan', 'dock'] })
  .answer('robots_near_people', 'slow')
  .answer('robot_speed', 'walking')
  .as('site-manager');                                                  // who sets the rules you add next
builder.confirm(builder.addRuleFromText('robots slow to 0.3 m/s in aisle 3'));
const rulebook = builder.compile();                                    // frozen JSON; rulebook.findings lists rules at odds

const decision = evaluateDomainAction(rulebook, {
  participant: { id: 'robot-7', kind: 'robot', roleId: 'inventory_robot' },
  action: 'move', areaId: 'aisle-3',                                   // area from your spatial system
  facts: { peopleInZone: 2, localTime: '14:05', requestedSpeedMps: 1.0 },
});
// decision.status  → 'LIMIT'; decision.limits → { maxSpeedMps: 0.3 }
// decision.reasons → [{ ruleId: 'robots_near_people', status: 'LIMIT', setBy: 'law-and-safety', reason: '…' },
//                     { ruleId: 'robots_slow_to_0_3_m_s_in_aisle_3', status: 'LIMIT', setBy: 'site-manager', reason: '…' }]
```

ESM and CommonJS, with types. Same rulebook + same request = same decision.

## Run it

```bash
git clone https://github.com/NeuroverseOS/robot-domain-rules && cd robot-domain-rules
npm install
npm run demo      # three rulebooks in plain text, their findings, and a day of decisions each
npm test          # 38 core tests
npm run site      # the switchboard on a local dev server (cd site && npm install first)
```

## Repo map

| Path | What it is |
|---|---|
| [`src/`](src/) | The core. Zero runtime dependencies. `types.ts` first; then `compile.ts`, `evaluate.ts`, `check.ts`, `draft.ts`. |
| [`src/templates/`](src/templates/) | The template contract and the two shipped templates (`grocery-store`, `warehouse`). |
| [`examples/`](examples/) | A grocery store (two manager rules deliberately at odds), a warehouse, a clinic with no template, the 0.2 input shape, and `demo.ts`. |
| [`site/`](site/) | The switchboard: the live demo, built from `src/` and `examples/`. Not part of the npm package. |
| [`test/`](test/) | One test per behaviour. |
| [`docs/`](docs/) | The screenshot. |
| [`AGENTS.md`](AGENTS.md) | The contract and invariants, for people and coding agents. [`CHANGELOG.md`](CHANGELOG.md) for what changed. |

## Who does what

| Your spatial system | This core | Your controller |
|---|---|---|
| Says **where** everything is and supplies the **facts** (which area, how many people, local time, emergency, who approved) | Decides **what is allowed** there, within what limits, and why | **Enforces** the decision |

Location is not this package's job. A spatial system such as posemesh decides which area each participant is in and passes that in. The core trusts the facts it is given and never fills one in: a required fact that is missing or invalid is `BLOCK` (`required_facts`), never permission.

## The request / decision contract

**Request**

```ts
{
  participant: { id, kind, roleId },   // kind and role as the site declared them
  action,                              // one of the site's actions
  areaId,                              // the area the participant is in (or wants to enter)
  facts: { ...the facts the rulebook declares, approvedBy? }
}
```

`approvedBy` is the one built-in fact: a name, or `{ id, authority?, roleId? }`. It clears a `PAUSE` for approval, but only if the approver holds what the rule asks for (`then.by`: an authority, or a higher one; a role; or a role tag). It never clears a `PAUSE` for a condition.

**Decision**

```ts
{
  status: 'ALLOW' | 'LIMIT' | 'PAUSE' | 'BLOCK',
  reasons: [{ ruleId, status, reason, setBy }],   // the checks at the strictest status
  limits?: { [limitId]: number },                 // the lowest value across matching limit rules
  then?: string,                                  // a deny rule's hint, e.g. 'dock'
  trace: [...every check that ran...],
  fingerprint
}
```

How a decision is made, in order: the request must be complete and about declared things; **never rules** (nothing overrides them); the **role must list the action** (an action the rulebook does not know follows `otherwise`: deny, or wait for approval); then **every rule that matches**, and the strictest answer wins: `BLOCK` > `PAUSE` > `LIMIT` > `ALLOW`.

## One rule shape

```ts
{
  id: 'no_restock_saturday_pm',
  text: 'no restock robots in aisle 3 on Saturdays between 14:00 and 16:00',
  who:   'restock_robot',                       // roles, 'tag:staff', 'kind:robot', '*', '!dock' to exclude
  does:  '*',                                   // actions, action tags, '*'
  where: 'aisle-3',                             // areas, area tags, '*'
  when:  [{ fact: 'localTime', op: 'between', from: '14:00', to: '16:00' }, { fact: 'day', op: 'days', days: ['sat'] }],
  then:  { answer: 'deny' },                    // allow | limit {…} | wait {for: 'approval', by?} | wait {for: 'condition'} | deny {instead?}
  setBy: 'site-manager',                        // declared, never inferred
  source: { kind: 'text', ref: '…' },           // template | question | declaration | manual | text
  never?: true                                  // an invariant: checked first, nothing overrides it
}
```

Conditions: `== != > >= < <=`, `in`, `between` (a time window; overnight is fine), `days`. A rule may only depend on facts that are always present (required, or with a default). Facts are typed: `number` (min, max, integer), `boolean`, `time` ("HH:MM"), `day`, `enum`, `string`.

## Rules at odds

The manager wrote "shoppers may take photos in the entrance". The company had answered "staff only". The rulebook says:

```
CONFLICT authority-override (certain) — `shopper_photos_entrance` set by Site manager tries to loosen what
`glasses_capture` set by Company sets: `shopper_photos_entrance` (set by Site manager) says allow;
`glasses_capture` (set by Company) says deny. Both apply to Shopper · take photos or video · Entrance, always.
A lower authority can only tighten, so `shopper_photos_entrance` never takes effect at all.
```

Findings come back on `rulebook.findings` (compile never hides them) and from `checkRulebook(input)` before you compile. Kinds: `contradiction`, `authority-override`, `never_vs_rule`, `shadowed` (a rule that can never change a decision), `duplicate`, `limit_disagreement`, `tightening` (a lower authority making things stricter: fine, for information). Each has a severity (`conflict`, `warning`, `info`), the rule IDs, and a certainty:

- **certain** — any request that matches one rule matches the other.
- **possible** — both conditions can hold at once on paper; whether they ever do depends on facts the rulebook does not control.
- Rules that provably can never match the same request produce no finding. "Disjoint" is only claimed when it is provable.

`compileDomain(input, { strict: true })` throws on any `conflict`.

## A rulebook, rendered

`renderDomainRules(rulebook)` prints the rulebook as text a store manager can read:

```
## Rules

- `robots_near_people` — robots · movement-tagged · everywhere · peopleInZone > 0 → **limit maxSpeedMps 0.3**
  Robots slow to 0.3 m/s while people are in their area. (set by law-and-safety; question robots_near_people:slow)
- `glasses_capture` — persons except staff-tagged · capture-tagged · everywhere · always → **deny**
  Only staff glasses may capture photos, video or audio here. (set by company; question glasses_capture:staff_only)
```

## Templates

| Template | For | Questions |
|---|---|---|
| `grocery-store` | Robots on the floor; staff and shoppers wearing glasses | people near robots, speed, staff and restricted areas, opening hours, scanning near people, glasses capture, robot commands, emergency, unknown actions |
| `warehouse` | Forklift-style robots in aisles; pickers wearing glasses | aisle exclusivity, robots per aisle, dock access, speed, emergency, glasses capture |

Both ship the authority order `law-and-safety` > `company` > `site-manager` > `staff`; a site may declare its own names and order. [`examples/clinic.ts`](examples/clinic.ts) uses no template at all.

## Glasses

`glassesZoneRules(rulebook, areaId, roleId)` turns the rulebook into the `ZoneRules` a person's glasses apply in one area, the same shape as `ZoneRules` in `@neuroverseos/governance/spatial` (optional, not a dependency). Rules with conditions are applied as if they held, so the glasses side only ever tightens.

## Built / not built

| Built, tested | Not built |
|---|---|
| Any site's vocabulary: kinds, actions, areas, roles, facts, limits, authorities | Area geometry, localisation, people counting, identity, sensors (your spatial system) |
| Templates whose answers emit rules; two shipped | A live connection to any spatial system (you pass the facts in) |
| Plain-text drafting against the site's own vocabulary; model prompt + answer validation | Any network call, clock or model inside the core |
| Conflict check with sound disjointness and plain-English findings | Signing a rulebook (the fingerprint identifies; sign the JSON with your own key) |
| Authority: every rule says who set it; lower only tightens; approvals must hold the named authority | Per-area overrides of template answers (write a rule instead) |
| Never rules, limits combined by MIN, approval vs condition waits, fail-closed evaluation | Natural-language understanding beyond the documented patterns (use your own model via the prompt) |
| Frozen rulebooks, `verifyFingerprint`, glasses bridge, the switchboard | |

## Upgrading from 0.2

The 0.2 input shape `{ site: { domainId, hours }, zones, roles, answers }` is still accepted by `compileDomain` and translated through the `grocery-store` template. It is deprecated. Requests may still say `zoneId` and a top-level `targetRobotId`. What changed:

- Zone kinds are area **tags** (`staff_only` → `staff-only`); `isStaff` is the role tag `staff`; `afterHours` is `after-hours`; a zone `maxSpeedMps` becomes the rule `zone_speed_cap:<zone>`.
- Rule IDs in decisions: `zone_declared` → `area_declared`; `unknown_actions` → `unknown_action`; `zone_role_limits` → `area_role_limits:<area>` (and `…:deny`); the emergency rule for glasses commands is `emergency_stop_commands`; `zone_speed_cap` → `zone_speed_cap:<zone>`.
- A `command_robot` request without `targetRobotId` is `required_facts`, not `robot_commands`.
- `rulebook.policy` is gone; the answers are in `rulebook.answers` and their effect is in `rulebook.rules`. `format` is `neuroverse-domain-rules/2`.
- Every check in a decision now carries `setBy`.

Every 0.2 test and every 0.2 demo scenario gives the same status in 0.3.

## License

MIT (versions 0.1.0 and 0.2.0 were published under Apache-2.0). Built on NeuroVerse governance thinking.
