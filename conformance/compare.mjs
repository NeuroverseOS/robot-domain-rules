/**
 * How a conformance case is judged. Shared by test/conformance.test.ts (runs
 * against src/) and run-node.mjs (runs against dist/). Plain JavaScript so
 * any Node can load it; the rules it encodes are written out in README.md.
 *
 * A case has one of these `expect` shapes:
 *   { decision }       evaluate(rulebook, request) must match (see below)
 *   { plan }           evaluatePlan(rulebook, case.plan) must match (see below)
 *   { findings }       check(rulebook) must report exactly these findings, any order
 *   { error: true }    the rulebook must be rejected by validation
 *   { canonical, fingerprint }   of `case.value`
 *   { requestDigest }  of `case.request`
 *   { verify: { ok } } verifyApproval(case.approval, case.trustedKeys)
 *   { rulebookSignature: { ok } }  verifyRulebookSignature(rulebook, case.signature, case.publicKey)
 *
 * Decision comparison — exact on: status, limits (deep), then, fingerprint;
 * reasons and trace as ordered lists of { ruleId, status, setBy } (the
 * `reason` text is free-form); approvalRequests as an ordered list of
 * { ruleId, by, requestDigest, rulebookFingerprint, setBy } (reason text free).
 * A field absent from the expectation must be absent from the decision.
 *
 * Findings comparison — as a multiset of { kind, severity, ruleIds, certainty,
 * witness? }; ruleIds keep their order; the message is free-form. A witness
 * is judged for VALIDITY, not equality: when the implementation offers
 * `matches(rulebook, request) → ruleIds`, every witness it reports must be a
 * request that matches both rules of its finding, and it must report one
 * wherever the expectation has one. Without `matches`, the witness must equal
 * the reference's (the reference picks the first ID in declaration order and
 * the smallest value in every overlap, SPEC.md § 7.4).
 *
 * Plan comparison — status, finalArea, finalFacts (deep), planDigest and
 * fingerprint exact; steps as an ordered list of { index, action, areaId,
 * decision } with the decision compared as above; planChecks as an ordered
 * list of { ruleId, status, setBy, stepIndex }; firstViolation on
 * { stepIndex, ruleId, setBy, from } (absent means absent); approvalRequests
 * as for a decision.
 */

const check = (c) => ({ ruleId: c.ruleId, status: c.status, setBy: c.setBy });
const ask = (a) => ({ ruleId: a.ruleId, by: a.by, requestDigest: a.requestDigest, rulebookFingerprint: a.rulebookFingerprint, setBy: a.setBy });
const finding = (f) => ({ kind: f.kind, severity: f.severity, ruleIds: [...f.ruleIds], certainty: f.certainty, witness: f.witness });
const planCheck = (c) => ({ ruleId: c.ruleId, status: c.status, setBy: c.setBy, stepIndex: c.stepIndex });

function strip(value) {
  return JSON.parse(JSON.stringify(value));
}

/** The comparable projection of a decision. */
export function projectDecision(d) {
  return strip({
    status: d.status,
    reasons: d.reasons.map(check),
    trace: d.trace.map(check),
    limits: d.limits,
    then: d.then,
    approvalRequests: d.approvalRequests ? d.approvalRequests.map(ask) : undefined,
    fingerprint: d.fingerprint,
  });
}

export function projectFindings(findings) {
  return strip(findings.map(finding)).sort((a, b) => key(a).localeCompare(key(b)));
}

/** The comparable projection of a plan evaluation. */
export function projectPlan(p) {
  return strip({
    status: p.status,
    steps: p.steps.map(s => ({ index: s.index, action: s.action, areaId: s.areaId, decision: projectDecision(s.decision) })),
    planChecks: p.planChecks.map(planCheck),
    firstViolation: p.firstViolation ? { stepIndex: p.firstViolation.stepIndex, ruleId: p.firstViolation.ruleId, setBy: p.firstViolation.setBy, from: p.firstViolation.from } : undefined,
    approvalRequests: p.approvalRequests.map(ask),
    finalFacts: p.finalFacts,
    finalArea: p.finalArea,
    planDigest: p.planDigest,
    fingerprint: p.fingerprint,
  });
}

const withoutWitness = (f) => { const { witness, ...rest } = f; return { ...rest, hasWitness: witness !== undefined }; };

const key = (f) => JSON.stringify(f);

export function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Run one case against an implementation `impl`:
 *   { evaluate(rulebook, request), evaluatePlan(rulebook, plan), check(rulebook), validate(rulebook) → problems[],
 *     matches?(rulebook, request) → ruleIds (optional; see witness rule above),
 *     canonical(value), fingerprint(value), requestDigest(request),
 *     verifyApproval(approval, keys) → Promise<{ok}>, verifyRulebookSignature(rulebook, sig, pub) → Promise<boolean> }
 * Returns null when the case passes, else a short description of the mismatch.
 */
export async function runCase(c, impl, rulebook) {
  const e = c.expect;
  if (e.error) {
    const problems = impl.validate(rulebook);
    return problems.length ? null : 'expected the rulebook to be rejected, but validation found no problem';
  }
  if (e.decision) {
    const got = projectDecision(impl.evaluate(rulebook, c.request));
    const want = strip({ ...e.decision, reasons: e.decision.reasons.map(check), trace: e.decision.trace.map(check), approvalRequests: e.decision.approvalRequests?.map(ask) });
    return deepEqual(got, want) ? null : `decision differs\n  want ${JSON.stringify(want)}\n  got  ${JSON.stringify(got)}`;
  }
  if (e.plan) {
    const got = projectPlan(impl.evaluatePlan(rulebook, c.plan));
    const want = strip({ ...e.plan, steps: e.plan.steps.map(s => ({ ...s, decision: { ...s.decision, reasons: s.decision.reasons.map(check), trace: s.decision.trace.map(check), approvalRequests: s.decision.approvalRequests?.map(ask) } })), planChecks: e.plan.planChecks.map(planCheck), approvalRequests: e.plan.approvalRequests.map(ask) });
    return deepEqual(got, want) ? null : `plan evaluation differs\n  want ${JSON.stringify(want)}\n  got  ${JSON.stringify(got)}`;
  }
  if (e.findings) {
    const gotFull = projectFindings(impl.check(rulebook));
    const wantFull = projectFindings(e.findings);
    if (!impl.matches) {
      return deepEqual(gotFull, wantFull) ? null : `findings differ\n  want ${JSON.stringify(wantFull)}\n  got  ${JSON.stringify(gotFull)}`;
    }
    const got = gotFull.map(withoutWitness), want = wantFull.map(withoutWitness);
    if (!deepEqual(got, want)) return `findings differ\n  want ${JSON.stringify(want)}\n  got  ${JSON.stringify(got)}`;
    for (const f of gotFull) {
      if (!f.witness) continue;
      const hit = impl.matches(rulebook, f.witness);
      if (!f.ruleIds.every(id => hit.includes(id))) return `witness of ${f.kind} ${f.ruleIds.join('+')} does not match both rules (matches ${JSON.stringify(hit)}): ${JSON.stringify(f.witness)}`;
    }
    return null;
  }
  if (e.canonical !== undefined || e.fingerprint !== undefined) {
    const canonical = impl.canonical(c.value), fp = impl.fingerprint(c.value);
    if (e.canonical !== undefined && canonical !== e.canonical) return `canonical JSON differs\n  want ${e.canonical}\n  got  ${canonical}`;
    if (e.fingerprint !== undefined && fp !== e.fingerprint) return `fingerprint differs: want ${e.fingerprint}, got ${fp}`;
    return null;
  }
  if (e.requestDigest !== undefined) {
    const got = impl.requestDigest(c.request);
    return got === e.requestDigest ? null : `request digest differs: want ${e.requestDigest}, got ${got}`;
  }
  if (e.verify) {
    const r = await impl.verifyApproval(c.approval, c.trustedKeys);
    return r.ok === e.verify.ok ? null : `verifyApproval: want ok=${e.verify.ok}, got ok=${r.ok}${r.reason ? ` (${r.reason})` : ''}`;
  }
  if (e.rulebookSignature) {
    const ok = await impl.verifyRulebookSignature(rulebook, c.signature, c.publicKey);
    return ok === e.rulebookSignature.ok ? null : `verifyRulebookSignature: want ${e.rulebookSignature.ok}, got ${ok}`;
  }
  return `case has no recognised expectation: ${Object.keys(e).join(', ')}`;
}

/** Load every case file (alphabetical), resolving rulebookRef against the conformance directory. */
export async function loadCases(fs, path, dir) {
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort();
  const out = [];
  for (const file of files) {
    const cases = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    for (const c of cases) {
      const rulebook = c.rulebook ?? (c.rulebookRef ? JSON.parse(fs.readFileSync(path.join(dir, c.rulebookRef), 'utf8')) : undefined);
      out.push({ file, case: c, rulebook });
    }
  }
  return out;
}
