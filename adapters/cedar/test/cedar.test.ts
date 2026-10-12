/**
 * The Cedar export, checked with Cedar's own engine (@cedar-policy/cedar-wasm,
 * a devDependency of this adapter only): the exported policies and schema
 * parse and validate, and on the subset the adapter exports, Cedar's
 * allow/deny agrees with our ALLOW/BLOCK on every request in the shipped
 * examples. Where we say LIMIT or PAUSE, Cedar says allow — the lossy part,
 * stated in the adapter.
 */
import { describe, expect, it } from 'vitest';
import * as cedar from '@cedar-policy/cedar-wasm/nodejs';
import { evaluateDomainAction, type DomainRequest, type Rulebook } from '../../../src/index';
import * as grocery from '../../../examples/grocery-store';
import * as warehouse from '../../../examples/warehouse';
import * as clinic from '../../../examples/clinic';
import { toCedar, toCedarContext, toCedarEntities } from '../index';

const sites: Array<[string, Rulebook, Array<[string, DomainRequest]>]> = [
  ['grocery', grocery.rulebook, grocery.day],
  ['warehouse', warehouse.rulebook, warehouse.day],
  ['clinic', clinic.rulebook, clinic.day],
];

describe('cedar adapter', () => {
  it('exports policies and a schema that Cedar parses and validates, and lists everything it leaves out', () => {
    for (const [name, rb] of sites) {
      const out = toCedar(rb);
      const parsed = cedar.checkParsePolicySet({ staticPolicies: out.policies });
      expect(parsed.type, `${name}: ${JSON.stringify(parsed)}`).toBe('success');
      const schema = cedar.checkParseSchema(out.schema as never);
      expect(schema.type, `${name}: ${JSON.stringify(schema)}`).toBe('success');
      const validated = cedar.validate({ validationSettings: { mode: 'strict' }, schema: out.schema as never, policies: { staticPolicies: out.policies } });
      expect(validated.type, `${name}: ${JSON.stringify(validated)}`).toBe('success');
      if (validated.type === 'success') expect(validated.validationErrors, name).toEqual([]);
      // Every LIMIT and WAIT rule is named as not exported; every deny rule is a forbid.
      for (const r of rb.rules) {
        if (r.then.answer === 'limit' || r.then.answer === 'wait') expect(out.notExported.map(n => n.ruleId), `${name} ${r.id}`).toContain(r.id);
        if (r.then.answer === 'deny' && !out.droppedByAuthority.some(d => d.ruleId === r.id)) expect(out.policies, `${name} ${r.id}`).toContain(`@id(${JSON.stringify(r.id)})\n@setBy(${JSON.stringify(r.setBy)})`);
      }
    }
    // The grocery manager's "shoppers may take photos" tries to loosen the company's staff-only answer: dropped by authority, and said so.
    expect(toCedar(grocery.rulebook).droppedByAuthority).toEqual([{ ruleId: 'shopper_photos_entrance', overriddenBy: 'glasses_capture' }]);
  });

  it('agrees with our ALLOW/BLOCK on the exported subset, and allows where we would LIMIT or PAUSE', () => {
    let compared = 0, lossy = 0;
    for (const [name, rb, day] of sites) {
      const out = toCedar(rb);
      for (const [label, request] of day) {
        const ours = evaluateDomainAction(rb, request);
        const answer = cedar.isAuthorized({
          principal: { type: 'Role', id: request.participant.roleId },
          action: { type: 'Action', id: request.action },
          resource: { type: 'Area', id: request.areaId ?? '' },
          context: toCedarContext(rb, request.facts) as never,
          schema: out.schema as never,
          policies: { staticPolicies: out.policies },
          entities: toCedarEntities(request) as never,
        });
        if (answer.type === 'failure') {
          // Cedar refuses a request its schema cannot validate — an action it does not know, or a required context attribute missing — the same refusals as our unknown_action and required_facts.
          expect(ours.status, `${name}: ${label}: ${JSON.stringify(answer.errors)}`).toBe('BLOCK');
          expect(['unknown_action', 'role_declared', 'area_declared', 'required_facts'], `${name}: ${label}`).toContain(ours.reasons[0].ruleId);
          compared++;
          continue;
        }
        const cedarSays = answer.response.decision;
        if (ours.status === 'ALLOW') { expect(cedarSays, `${name}: ${label}`).toBe('allow'); compared++; }
        else if (ours.status === 'BLOCK') {
          // A BLOCK decided by an exported rule (a deny, a never rule, a role or area check) is a deny in Cedar; a BLOCK for missing facts is ours alone.
          const byMissingFacts = ours.reasons.every(r => r.ruleId === 'required_facts');
          if (!byMissingFacts) { expect(cedarSays, `${name}: ${label} (${ours.reasons.map(r => r.ruleId).join(', ')})`).toBe('deny'); compared++; }
        } else { expect(cedarSays, `${name}: ${label} is ${ours.status} here; Cedar cannot say that`).toBe('allow'); lossy++; }
      }
    }
    expect(compared).toBeGreaterThan(10);
    expect(lossy).toBeGreaterThan(3);
  });
});
