#!/usr/bin/env npx tsx
/**
 * Agent replay on semantic volumes.
 *
 *   npx tsx examples/harness/replay.ts
 *
 * Reads events.jsonl — an AI planner proposing tasks, a spatial system
 * reporting poses and people counts, a manager signing one approval, an
 * emergency that starts and clears — and writes an append-only decision log
 * (decisions.jsonl: request, decision, rulebook fingerprint, approval refs)
 * plus a short summary. Deterministic: every timestamp comes from the
 * events, and the one signature uses a fixed TEST ONLY key.
 *
 * The rulebook is the grocery template over areas mapped from a sample
 * semantic-volumes collection (volumes-to-areas.ts), with trusted keys
 * declared, so only a signed approval counts.
 */

import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  DomainRulesBuilder, compileDomain, evaluateDomainAction, publicKeyOf, signApproval, verifyApproval,
  type ApprovalRequest, type DomainDecision, type DomainRequest,
} from '../../src/index';
import { volumesToAreas, volumeAt, type SemanticVolumesCollection } from './volumes-to-areas';

const dir = import.meta.dirname;
const volumes = JSON.parse(readFileSync(join(dir, 'semantic-volumes.json'), 'utf8')) as SemanticVolumesCollection;

// TEST ONLY signing key for the manager's glasses. A real deployment keeps private keys in its own key management.
const DANA_SEED = '4444444444444444444444444444444444444444444444444444444444444444';

async function main() {
  const danaPublicKey = await publicKeyOf(DANA_SEED);
  const builder = new DomainRulesBuilder({ id: 'harness-store', name: 'Harness store', hours: { open: '07:00', close: '22:00' } }).fromTemplate('grocery-store');
  for (const area of volumesToAreas(volumes)) builder.area(area);
  builder
    .role({ id: 'inventory_robot', name: 'Inventory robot', kind: 'robot', actions: ['enter_zone', 'move', 'scan', 'dock'] })
    .role({ id: 'restock_robot', name: 'Restock robot', kind: 'robot', inherits: 'inventory_robot', actions: ['manipulate'] })
    .role({ id: 'staff', name: 'Staff', kind: 'person', actions: ['ai_overlay', 'camera_capture', 'share_location', 'command_robot'], tags: ['staff'] })
    .answer('robots_near_people', 'slow').answer('robot_speed', 'walking').answer('robots_staff_zones', 'when_staff_present')
    .answer('robots_restricted_zones', 'with_approval').answer('robot_scan_near_people', 'pause').answer('glasses_capture', 'staff_only')
    .answer('robot_commands', 'staff_only').answer('emergency', 'stop_then_dock').answer('unknown_actions', 'block')
    .as('site-manager');
  builder.confirm(builder.addRuleFromText('robots slow to 0.3 m/s in checkout', { id: 'checkout_speed' }));
  const rulebook = compileDomain({ ...builder.toInput(), trustedKeys: [{ keyId: 'dana-glasses', publicKey: danaPublicKey, authority: 'site-manager' }] });

  // World state the spatial system reports. The core never keeps state; the replay does, as a harness would.
  const areaOf = new Map<string, string>();
  const people = new Map<string, number>();
  const staff = new Map<string, number>();
  let emergency = false;
  let lastAsk: { request: DomainRequest; ask: ApprovalRequest } | null = null;
  let approval: Record<string, unknown> | null = null;
  const log: Array<Record<string, unknown>> = [];
  const summary: string[] = [];
  const counts: Record<string, number> = { ALLOW: 0, LIMIT: 0, PAUSE: 0, BLOCK: 0 };
  let seq = 0;

  const lines = readFileSync(join(dir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as Record<string, unknown>);
  for (const ev of lines) {
    const t = ev.t as string;
    const localTime = t.slice(11, 16);   // the event's clock; the core has none
    switch (ev.type) {
      case 'note': summary.push(`${localTime}  ${ev.text}`); break;
      case 'pose': {
        const v = volumeAt(ev.pose as { x: number; y: number; z: number }, volumes.volumes);   // example only: in production the spatial system reports the area
        if (v) areaOf.set(ev.participant as string, v.id);
        break;
      }
      case 'people': people.set(ev.areaId as string, ev.count as number); break;
      case 'staff': staff.set(ev.areaId as string, ev.count as number); break;
      case 'emergency': emergency = ev.active as boolean; summary.push(`${localTime}  ${emergency ? 'EMERGENCY' : 'all clear'} — ${ev.note}`); break;
      case 'approve': {
        if (!lastAsk) throw new Error('nothing to approve');
        const signed = await signApproval({ ...(ev.approver as { id: string; authority?: string }), requestDigest: lastAsk.ask.requestDigest, rulebookFingerprint: lastAsk.ask.rulebookFingerprint, issuedAt: t }, { keyId: ev.keyId as string, privateKey: DANA_SEED });
        const verified = await verifyApproval(signed, rulebook);   // the harness verifies BEFORE evaluating; the evaluator stays pure
        if (!verified.ok) throw new Error(`approval did not verify: ${verified.reason}`);
        approval = verified.approval as unknown as Record<string, unknown>;
        summary.push(`${localTime}  ${ev.note} (rule ${lastAsk.ask.ruleId}, key ${signed.keyId}, signature ${signed.signature.slice(0, 12)}…)`);
        break;
      }
      case 'propose': {
        const p = ev.participant as DomainRequest['participant'];
        const areaId = areaOf.get(p.id) ?? '';
        const request: DomainRequest = {
          participant: p, action: ev.action as string, areaId,
          facts: {
            localTime, peopleInZone: people.get(areaId) ?? 0, staffInZone: staff.get(areaId) ?? 0, emergency,
            ...((ev.facts as Record<string, unknown>) ?? {}),
            ...(ev.withApproval && approval ? { approvedBy: approval } : {}),
          },
        };
        const decision: DomainDecision = evaluateDomainAction(rulebook, request);
        counts[decision.status]++;
        seq++;
        log.push({ seq, t, by: ev.by, request, decision, rulebookFingerprint: rulebook.fingerprint, ...(approval && ev.withApproval ? { approvalRef: { keyId: approval.keyId, signature: approval.signature } } : {}) });
        if (decision.approvalRequests?.length) lastAsk = { request, ask: decision.approvalRequests[0] };
        const why = decision.reasons.map(r => `${r.ruleId} [${r.setBy}]`).join(', ');
        const extra = decision.limits ? ` limits ${JSON.stringify(decision.limits)}` : decision.then ? ` then ${decision.then}` : decision.approvalRequests ? ` ask ${decision.approvalRequests.map(a => a.by ?? 'anyone').join('/')}` : '';
        summary.push(`${localTime}  ${decision.status.padEnd(5)} ${p.id} ${ev.action} in ${areaId || '(unknown)'} — ${why}${extra}   ← ${ev.note}`);
        break;
      }
      default: throw new Error(`unknown event type ${String(ev.type)}`);
    }
  }
  writeFileSync(join(dir, 'decisions.jsonl'), log.map(l => JSON.stringify(l)).join('\n') + '\n');
  console.log(`Rulebook ${rulebook.fingerprint} — ${rulebook.areas.length} areas from ${volumes.volumes.length} semantic volumes; findings: ${rulebook.findings.length}\n`);
  console.log(summary.join('\n'));
  console.log(`\n${seq} decisions: ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')} → decisions.jsonl`);
}

main().catch(e => { console.error(e); process.exit(1); });
