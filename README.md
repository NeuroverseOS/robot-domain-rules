# robot-domain-rules

**AI and robots propose. The space's own rules decide — with a reason, and the authority behind it.**

**[▶ Try it live](https://neuroverseos.github.io/robot-domain-rules/)** · **[PRINCIPLES](PRINCIPLES.md)** · **[SPEC](SPEC.md)** · **[BOUNDARY](BOUNDARY.md)** · [Related work](RELATED-WORK.md)

One rulebook for a physical space, written under authority the space declares, applied the same way to every robot, every person wearing glasses and every AI agent in it. Before acting, a participant asks and gets **yes / slower / wait / no**, with the rules that decided, who set each one, and the fingerprint of the rulebook in force. Pure TypeScript, zero dependencies, no clock, no network, no model inside the decision.

## Where AI fits

AI writes rules — from a manager's plain words, from documents, from a policy system — at whatever authority the space has granted it. AI proposes actions and plans tasks. AI explains decisions. The final "may I?" check is none of those: it is deterministic, takes microseconds, gives the same answer every time, and cannot be talked out of a rule. This is the pattern the industry is settling on for agents — AI authors policy, a deterministic engine decides (AWS AgentCore Policy compiles natural-language policies to [Cedar](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/policy-natural-language.html) and evaluates them without a model) — and the reason is plain: rules that a model interprets at runtime can be talked around. [RoboGuard](https://arxiv.org/pdf/2503.07885) reports that without its guardrail, attacked LLM-controlled robots executed unsafe plans more than 92% of the time. Here the model is upstream of the decision, never inside it. See [RELATED-WORK.md](RELATED-WORK.md) for how this sits next to Cedar, ASIMOV, RoboGuard and Open-RMF.

## For engineers, and the agents that work with you

You will not adopt this package; you will take the principles, the format and the tests. That is the point.

1. **Read [PRINCIPLES.md](PRINCIPLES.md)** (5 minutes): nine rules for spaces shared by people, robots and AI, each one enforced by named conformance cases.
2. **Read [SPEC.md](SPEC.md)** (15 minutes): the rulebook, request, decision, finding and approval formats; the decision algorithm as numbered pseudocode; the conflict analysis; canonical JSON and the fingerprint, byte for byte; signed approvals. JSON Schemas in [`spec/`](spec/).
3. **Run [`conformance/`](conformance/) against your implementation** — 144 language-neutral JSON cases, one line each saying what it proves, with fixed Ed25519 test vectors. The loop is ten lines; [`conformance/README.md`](conformance/README.md) gives the exact comparison rules. The reference passes its own suite in both [`test/conformance.test.ts`](test/conformance.test.ts) and the framework-free [`conformance/run-node.mjs`](conformance/run-node.mjs).

Or use this package directly:

```bash
npm install @neuroverseos/robot-domain-rules      # Node 20+ (Ed25519 via WebCrypto)
```

```ts
import { DomainRulesBuilder, evaluateDomainAction } from '@neuroverseos/robot-domain-rules';

const builder = new DomainRulesBuilder({ id: 'store-1', name: 'Store 1', hours: { open: '07:00', close: '22:00' } })
  .fromTemplate('grocery-store')
  .area({ id: 'aisle-3', name: 'Aisle 3', tags: ['public'] })          // IDs your spatial system reports
  .role({ id: 'inventory_robot', name: 'Inventory robot', kind: 'robot', actions: ['enter_zone', 'move', 'scan', 'dock'] })
  .answer('robots_near_people', 'slow')
  .as('site-manager');                                                  // the authority the next rules are set by
builder.confirm(builder.addRuleFromText('robots slow to 0.3 m/s in aisle 3'));
const rulebook = builder.compile();                                    // frozen JSON; rulebook.findings lists rules at odds

const decision = evaluateDomainAction(rulebook, {
  participant: { id: 'robot-7', kind: 'robot', roleId: 'inventory_robot' },
  action: 'move', areaId: 'aisle-3',
  facts: { peopleInZone: 2, localTime: '14:05', requestedSpeedMps: 1.0 },
});
// decision.status → 'LIMIT'; decision.limits → { maxSpeedMps: 0.3 }
// decision.reasons → [{ ruleId: 'robots_near_people', status: 'LIMIT', setBy: 'law-and-safety', reason: '…' }, …]
```

- **An agent asks before it acts:** [`examples/mcp/`](examples/mcp/) is a ~100-line stdio MCP server with `may_i` and `explain_rulebook`. The MCP SDK is a dependency there only.
- **Your spatial vocabulary:** [`examples/harness/`](examples/harness/) maps a semantic-volumes collection (the shape `aukilabs/domain-harness` describes) onto rulebook areas and replays an event stream — an AI planner proposing tasks, poses and people counts arriving, a manager signing one approval, an alarm starting and clearing — into an append-only decision log. `npx tsx examples/harness/replay.ts`.
- **Signed approvals:** declare `trustedKeys` on the rulebook and only an Ed25519-signed approval, verified by you before evaluation and bound to the request digest and the rulebook fingerprint, clears a wait. `signApproval`, `verifyApproval`, `signRulebook`, `verifyRulebookSignature`. Without `trustedKeys`, plain approvals work (development only).

## For operators

**[The switchboard](https://neuroverseos.github.io/robot-domain-rules/)** runs in your browser; nothing leaves the page.

[![The switchboard: rulebook, situation, decision](docs/switchboard.jpg)](https://neuroverseos.github.io/robot-domain-rules/)

Start from the grocery store, the warehouse, the clinic or an empty site. Answer the template's questions and watch the rules change. Write a rule in plain words, read the draft, confirm it as a chosen authority. Set who is asking, the action, the area, every fact, the emergency switch and an approval — or pick a scenario — and see **YES / SLOWER / WAIT / NO** with the limits, the reasons, the authority chain and the full trace, next to what would happen with no rules at all. The "Rules at odds" panel shows every conflict live. Export the rulebook as JSON or readable text; import one (fingerprint verified); copy the code that asks it.

## Why not Cedar or OPA?

Cedar and OPA/Rego are mature, general policy languages with real tooling, and Cedar has formal analysis this project does not. If they fit your stack, use them. What this project does that they do not, out of the box: rules authored from plain answers and plain words by whoever the space grants authority; a declared authority order where a lower level can only tighten, reported at compile time and enforced at decision time; two kinds of waiting (a person must approve, signed and bound to the request, versus the situation must change); one rulebook and one decision path for robots, people and AI agents; and decisions that name the authority behind every rule. Nothing here prevents compiling this spec's rulebook to Cedar or Rego for evaluation; the conformance cases would tell you whether the compilation is faithful.

## Repo map

| Path | What it is |
|---|---|
| [`PRINCIPLES.md`](PRINCIPLES.md), [`SPEC.md`](SPEC.md), [`BOUNDARY.md`](BOUNDARY.md), [`RELATED-WORK.md`](RELATED-WORK.md) | The principles, the normative spec, what this is and is not, how it compares. |
| [`spec/`](spec/) | JSON Schemas (draft 2020-12) for rulebook, request, decision, findings, approvals. |
| [`conformance/`](conformance/) | 144 language-neutral cases by principle, shared rulebooks, Ed25519 test vectors, a framework-free runner, and the generator that produced them. |
| [`src/`](src/) | The core. Zero runtime dependencies. `types.ts` first; then `compile.ts`, `evaluate.ts`, `check.ts`, `approvals.ts`, `canonical.ts`, `draft.ts`. |
| [`src/templates/`](src/templates/) | The template contract and the two shipped templates (`grocery-store`, `warehouse`). |
| [`examples/`](examples/) | A grocery store (two manager rules deliberately at odds), a warehouse, a clinic with no template, `demo.ts`; [`harness/`](examples/harness/) the semantic-volumes adapter and agent replay; [`mcp/`](examples/mcp/) the `may_i` server. |
| [`site/`](site/) | The switchboard. Its own package, built from `src/`; not published to npm. |
| [`test/`](test/) | Core tests (one per behaviour, plus the seeded conflict-analysis soundness test) and the conformance runner. |
| [`AGENTS.md`](AGENTS.md) | Invariants and working rules for people and coding agents. [`CHANGELOG.md`](CHANGELOG.md) for what changed. |

```bash
git clone https://github.com/NeuroverseOS/robot-domain-rules && cd robot-domain-rules && npm install
npm test                                  # core tests + every conformance case
npm run build && node conformance/run-node.mjs
npm run demo                              # three rulebooks in plain text, their findings, a day of decisions each
npx tsx examples/harness/replay.ts        # the agent replay
npm run site                              # the switchboard locally (cd site && npm install first)
```

## Stability

0.x: the API may still change between minor versions, and breaking changes will be batched rather than trickled. The specification is versioned separately (`robot-domain-rules/1`, see [SPEC.md § 11](SPEC.md)); a change that alters any decision, finding, fingerprint or signature for an existing valid rulebook bumps the spec version and ships with new conformance cases. The 0.2 input shape is still accepted and decides identically.

## License

MIT (versions 0.1.0 and 0.2.0 were published under Apache-2.0). Built on NeuroVerse governance thinking.
