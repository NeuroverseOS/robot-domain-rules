# Cedar export (example adapter)

`toCedar(rulebook)` turns the part of a rulebook that [Cedar](https://www.cedarpolicy.com/) can say into Cedar policies and a Cedar schema, so a team already on Cedar (AWS Verified Permissions, Bedrock AgentCore) can carry the deny/permit subset over. It is an example, not part of the core, and it is **lossy on purpose and says so**.

```ts
import { toCedar, toCedarContext, toCedarEntities } from './adapters/cedar';   // copy the file; it imports the core from ../../src

const { policies, schema, notExported, droppedByAuthority } = toCedar(rulebook);
// policies           Cedar policy set text — one permit per role (its action list), one forbid per deny rule, one permit per allow rule
// schema             Cedar schema (JSON): Role, Action, Area entity types; context attributes from the facts
// notExported        [{ ruleId, reason }] — every rule it could not carry over, in plain words
// droppedByAuthority [{ ruleId, overriddenBy }] — rules a higher authority overrides; they never took effect, so they are not exported
```

## What carries over

| In the rulebook | In Cedar |
|---|---|
| A role and its action list | `permit(principal == Role::"r", action in [Action::"a", …], resource)` |
| A deny rule, a never rule, an area's `allowRoles` / `denyRoles` | `forbid(principal, action, resource) when { … }` with the rule's selectors and conditions |
| An allow rule | `permit`, restricted to the (role, action) pairs the role lists — an allow never grants an action the role does not have |
| `setBy`, `never`, `instead` | Annotations `@setBy`, `@never`, `@instead`; `@id` is the rule ID |
| Authority | Resolved **first**: a rule the conflict check reports as an `authority-override` is dropped and listed |
| Facts | Context attributes: whole numbers → `Long`; other numbers → `Decimal` (compared with `.lessThan` …); time → `Long` minutes since midnight; day, enum, string → `String`; boolean → `Boolean`. `toCedarContext(rulebook, facts)` builds the context the way the engine would see the facts (defaults filled in). |
| Unknown action, role or area; a missing required fact | Cedar refuses the request at schema validation — the same refusal as `unknown_action` / `required_facts` |

## What does not, and is listed in `notExported`

- **LIMIT** rules: Cedar answers allow or deny, not "go ahead, slower".
- **Both kinds of WAIT**: no approval and no "until the situation changes" in Cedar; approvals and `trustedKeys` with them.
- **History conditions** ("at most five scans an hour"): Cedar has no history.
- **Plan rules**: Cedar judges one request, not a plan.
- `otherwise: wait-for-approval`: Cedar denies an action it has no policy for, which matches `deny` only.

So where this rulebook says **LIMIT** or **PAUSE**, the Cedar export says **allow**. Where it says **ALLOW** or **BLOCK** on exported rules, Cedar agrees. [`test/cedar.test.ts`](test/cedar.test.ts) runs the exported policies through Cedar's own engine (`@cedar-policy/cedar-wasm`, a devDependency of this adapter only): the policies and schema parse and validate in strict mode, and on every request in the three shipped examples Cedar's decision matches ours on the exported subset and allows the lossy cases.

```bash
cd adapters/cedar && npm install && npm run typecheck && npm test
```

The conformance cases in [`conformance/`](../../conformance/) are the way to check any such compilation for faithfulness; this adapter deliberately does not claim to pass them.
