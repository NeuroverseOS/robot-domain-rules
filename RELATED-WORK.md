# Related work

How this compares with the systems a robotics or agent team is likely to weigh it against. Cell wording is kept honest; "as far as I found" marks what was not confirmed in the sources below.

| | NeuroverseOS | AgentCore / Cedar (AWS) | ASIMOV (Google DeepMind) | RoboGuard (UPenn) | Open-RMF |
|---|---|---|---|---|---|
| What it governs | Task permissions for robots, people with glasses and AI agents in one space | AI agents' tool calls | An AI robot brain's choices | An AI robot's plans | Robot fleet traffic, doors, lifts |
| Who writes the rules | Any person, agent or system, weighted by the authority the space declares | Developers/admins, in Cedar or plain English | Mostly AI-generated from data | The system designer | Integrators, in facility configuration |
| Who decides at runtime | Deterministic rules on stated facts | Deterministic rules | The AI model interprets the rules | An AI grounds rules, then formal logic checks the plan | Deterministic traffic planner |
| Whole plans, not only one action | ✅ deterministic, against the effects the site declared, with plan rules (where it ends, what before what, how many); checks plans, does not write them | ❌ one request at a time | ❌ | ✅ checks and *synthesises* plans (LTL) | Traffic plans, not task plans |
| Robots / people / AI agents under one law | ✅ / ✅ / ✅ | — / — / ✅ | ✅ / — / — | ✅ / — / — | ✅ / — / — |
| Declared authority that can only tighten | ✅ | ❌ (forbid-wins, no authority levels) | ❌ | ❌ | ❌ |
| Conflicts between rules | Exact for the rule language, with a witness request per finding; cross-checked with the Z3 SMT solver in tests; plain words saying who wins | Formal automated reasoning over Cedar's richer language | ❌ | Resolved automatically, not shown | Traffic conflicts resolved, not rule conflicts |
| Human approval from the right authority | ✅ separate from "wait until clear", signed | Not built in, as far as I found | ❌ | ❌ | ❌ |
| Unknown or missing fact → no | ✅ | ✅ default deny | ❌ the model guesses | Partly | n/a |
| Each decision says why and whose rule | ✅ rule, reason, authority | ✅ rule and reason, no authority | Model reasoning text | Logic trace | ❌ |
| Knows the physical space | Uses facts from your spatial system (e.g. posemesh) | ❌ | ✅ reads scenes | ✅ | ✅ maps, lanes, lifts |
| Maturity | New — a reference implementation | Production (AWS) | Research benchmark | Research | Deployed (hospitals, airports) |

Reading: the others either decide well but only for software agents (Cedar), let the AI interpret the rules (ASIMOV, RoboGuard), or coordinate robot traffic (Open-RMF). NeuroverseOS combines declared, tighten-only authority over rules from any author; one rulebook for robots, people and AI agents; approval distinct from waiting; a deterministic decision that names whose rule decided; and the same check over a whole plan. Theirs are more mature. Cedar's analysis covers a richer policy language than this one; on this rule language the analysis here is exact and the [Cedar adapter](adapters/cedar/) carries the deny/permit subset over, saying what it drops. RoboGuard is the reference for plan *synthesis* — turning rules and a scene into a plan — which this project leaves to planners.

**Layers, not competitors.** In a real deployment these sit on top of each other: certified safety controllers and the standards behind them (ISO 10218, 3691-4, 13482) decide whether a motion is physically safe; traffic coordination (Open-RMF, or your own) decides who goes where when; a permission and authority layer (this, or Cedar for software agents) decides what each participant may do here, by whose say-so, and what needs a person; plan checking for AI planners (this; RoboGuard's grounding for the synthesis side) checks a proposed plan before any step runs; and AI proposing on top — rules in plain words, plans, explanations — never inside the decision.

Sources:

- AWS Bedrock AgentCore Policy, natural-language policies compiled to Cedar: https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/policy-natural-language.html
- ASIMOV (Google DeepMind): https://arxiv.org/pdf/2503.08663
- RoboGuard (UPenn): https://arxiv.org/pdf/2503.07885
- Open-RMF introduction: https://learn2.ubiquityrobotics.com/jazzy-devel/open_rmf/open_rmf_intro.html
- Normative multi-agent systems, for the authority and conflict lineage: https://arxiv.org/pdf/1709.02018
