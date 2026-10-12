/**
 * Backtest — what would this rulebook have decided for recorded activity?
 *
 *   backtest(rulebook, events, options?) → BacktestReport
 *   compareBacktests(baseline, proposed) → BacktestComparison
 *
 * A site keeps a log of what its participants asked to do (and, if it likes,
 * what then happened). Before a rulebook goes live, replay that log through it
 * and read the report: how often each answer would have come back, which rules
 * never fired, which would have stalled work, which conflicts actually
 * occurred, where no rule covered the request, which facts the log did not
 * carry, and where the rule and the record differ. Compare two reports to see
 * what a proposed change would change.
 *
 * Pure and synchronous, like everything else here: no clock (every time
 * comes from the log), no network, no model. The same rulebook and the same
 * log give the same report, byte for byte. The report says what the rules
 * would have decided; it never says why things happened — that is for an
 * evidence system, not a rulebook.
 *
 * History: a rule that counts what a participant did recently gets, for each
 * event, the earlier events of the same participant on the same day of this
 * log (action, area, and the time from the clock fact), unless the event's
 * own request carries `history`, which is then used as it is. Every earlier
 * event of the day counts, whatever was decided or recorded: the log is what
 * was asked. A day is the text of `at` before its first "T" (the whole log is
 * one day when there is none): windows are minute-of-day arithmetic, so
 * yesterday's actions must not count as today's.
 */

import type { DomainDecisionStatus, DomainRequest, Finding, HistoryEntry, Rulebook } from './types';
import { evaluateDomainAction, matchingRules, missingFacts } from './evaluate';
import { DomainRulesError } from './vocabulary';

/** What the site recorded after the request, if anything. Never used to decide; only reported. */
export type BacktestOutcome = 'happened' | 'did_not_happen' | 'unknown';

/** One recorded request, in time order. */
export interface BacktestEvent {
  /** When it was asked: any string that sorts in time order; "YYYY-MM-DDTHH:MM" is the convention. Reported as given. */
  at: string;
  /** Exactly what the participant asked, as `evaluateDomainAction` receives it. */
  request: DomainRequest;
  /** What the record says happened next. Used only for `differences`, never for the decision. */
  outcome?: BacktestOutcome;
}

export interface BacktestOptions {
  /** The declared time fact whose value becomes each history entry's `at`. Default: the first declared `time` fact. */
  clock?: string;
  /** How many example timestamps each finding keeps (the earliest). Default 3. */
  examples?: number;
}

export interface BacktestCounts {
  events: number;
  ALLOW: number;
  LIMIT: number;
  PAUSE: number;
  /** Refused by a rule or a built-in check other than `required_facts`. */
  BLOCK: number;
  /** Refused as `required_facts`: the log did not carry what the decision needed. */
  missingFacts: number;
}

/** One event, decided. */
export interface BacktestRow {
  index: number;
  at: string;
  participantId: string;
  kind: string;
  roleId: string;
  action: string;
  areaId: string;
  status: DomainDecisionStatus;
  /** True when the status is BLOCK `required_facts`. */
  missingFacts: boolean;
  /** The rules (or built-in checks) in `decision.reasons`, in order. */
  ruleIds: string[];
  outcome?: BacktestOutcome;
}

export interface BacktestStall {
  ruleId: string;
  setBy: string;
  status: 'PAUSE' | 'BLOCK';
  count: number;
  /** The earliest `at` values, up to `options.examples`. */
  examples: string[];
}

export interface BacktestConflict {
  kind: Finding['kind'];
  severity: Finding['severity'];
  ruleIds: string[];
  count: number;
  firstAt: string;
  examples: string[];
}

export interface BacktestGap { action: string; count: number; examples: string[] }
export interface BacktestMissingFact { fact: string; count: number; examples: string[] }

/** The rule and the record differ: the rulebook would have refused (or made wait) what the record says happened, or allowed what it says did not. Neither is judged right. */
export interface BacktestDifference {
  index: number;
  at: string;
  status: DomainDecisionStatus;
  outcome: 'happened' | 'did_not_happen';
  ruleIds: string[];
}

export interface BacktestReport {
  /** The rulebook that decided. */
  fingerprint: string;
  events: number;
  totals: BacktestCounts;
  /** By area ID, keys sorted; `(none)` for requests without one. */
  byArea: Record<string, BacktestCounts>;
  /** By role ID, keys sorted; `(none)` for requests without one. */
  byRole: Record<string, BacktestCounts>;
  /** Every rule of the rulebook, in rulebook order: how many events it matched and how many it decided (was among the reasons). */
  byRule: Record<string, { matched: number; decided: number }>;
  /** Rules that matched no event, in rulebook order. */
  neverFired: string[];
  /** Rules and built-in checks that decided a PAUSE or BLOCK (other than `required_facts`), most often first, then by first occurrence. */
  wouldStall: BacktestStall[];
  /** The rulebook's findings whose two rules both matched a recorded request, in findings order. */
  conflictsOccurred: BacktestConflict[];
  /** Requests for actions no rule covers (`unknown_action`), by action, most often first, then by action. */
  gaps: BacktestGap[];
  /** What the log did not carry, by fact, most often first, then by fact. `history`, `approvedBy` and `request` as in `missingFacts()`. */
  missingFacts: BacktestMissingFact[];
  /** Where the rule and the record differ, in event order. Only events with an `outcome` other than `unknown`. */
  differences: BacktestDifference[];
  rows: BacktestRow[];
}

export interface BacktestChange {
  index: number;
  at: string;
  from: DomainDecisionStatus;
  to: DomainDecisionStatus;
  /** The deciding rules before and after. */
  before: string[];
  after: string[];
}

/** What a proposed rulebook would change against the same log. */
export interface BacktestComparison {
  baseline: string;
  proposed: string;
  events: number;
  totals: { baseline: BacktestCounts; proposed: BacktestCounts };
  /** Events whose status changed. */
  changed: number;
  /** Not BLOCK before, BLOCK after. */
  newlyBlocked: BacktestChange[];
  /** PAUSE or BLOCK before, ALLOW or LIMIT after. */
  newlyAllowed: BacktestChange[];
  /** Every other status change (for example ALLOW → PAUSE, or LIMIT → ALLOW). */
  otherChanges: BacktestChange[];
  /** Every rule that decided an event in either run: how many it decided before and after. Largest change first, then by rule ID. */
  byRule: Array<{ ruleId: string; baseline: number; proposed: number; change: number }>;
}

const counts = (): BacktestCounts => ({ events: 0, ALLOW: 0, LIMIT: 0, PAUSE: 0, BLOCK: 0, missingFacts: 0 });

export function backtest(rulebook: Rulebook, events: BacktestEvent[], options: BacktestOptions = {}): BacktestReport {
  if (!Array.isArray(events)) throw new DomainRulesError('backtest: events must be a list of { at, request, outcome? }.');
  events.forEach((e, i) => {
    if (!e || typeof e !== 'object' || typeof e.at !== 'string' || !e.at || !('request' in e)) throw new DomainRulesError(`backtest: events[${i}] must be { at, request, outcome? } with a non-empty "at".`);
    if (e.outcome !== undefined && !['happened', 'did_not_happen', 'unknown'].includes(e.outcome)) throw new DomainRulesError(`backtest: events[${i}].outcome must be happened, did_not_happen or unknown when given.`);
  });
  const clock = options.clock ?? rulebook.facts.find(f => f.type === 'time')?.id;
  if (clock !== undefined && !rulebook.facts.some(f => f.id === clock && f.type === 'time')) throw new DomainRulesError(`backtest: clock "${clock}" is not a declared time fact.`);
  const keep = options.examples ?? 3;

  const totals = counts();
  const byArea = new Map<string, BacktestCounts>();
  const byRole = new Map<string, BacktestCounts>();
  const byRule: Record<string, { matched: number; decided: number }> = {};
  for (const r of rulebook.rules) byRule[r.id] = { matched: 0, decided: 0 };
  const stalls = new Map<string, BacktestStall>();
  const conflicts = rulebook.findings.map(f => ({ finding: f, count: 0, examples: [] as string[] }));
  const gaps = new Map<string, BacktestGap>();
  const missing = new Map<string, BacktestMissingFact>();
  const differences: BacktestDifference[] = [];
  const rows: BacktestRow[] = [];
  const prior = new Map<string, { day: string; entries: HistoryEntry[] }>();
  const dayOf = (at: string) => { const t = at.indexOf('T'); return t < 0 ? '' : at.slice(0, t); };
  const tally = (c: BacktestCounts, status: DomainDecisionStatus, missingFacts: boolean) => { c.events++; if (missingFacts) c.missingFacts++; else c[status]++; };
  const bump = <T extends { count: number; examples: string[] }>(map: Map<string, T>, key: string, make: () => T, at: string) => {
    const item = map.get(key) ?? make();
    item.count++;
    if (item.examples.length < keep) item.examples.push(at);
    map.set(key, item);
  };

  events.forEach((event, index) => {
    const raw = event.request;
    const p = raw && typeof raw === 'object' ? raw.participant : undefined;
    const participantId = p && typeof p === 'object' && typeof p.id === 'string' ? p.id : '';
    const areaId = raw && typeof raw === 'object' ? String(raw.areaId ?? raw.zoneId ?? '') : '';
    // History: the earlier events of this participant in this log, unless the request brings its own.
    const day = dayOf(event.at);
    const earlier = prior.get(participantId);
    const request: DomainRequest = raw && typeof raw === 'object' && raw.history === undefined && participantId
      ? { ...raw, history: earlier && earlier.day === day ? [...earlier.entries] : [] }
      : raw;
    const decision = evaluateDomainAction(rulebook, request);
    const isMissing = decision.status === 'BLOCK' && decision.reasons.some(r => r.ruleId === 'required_facts');
    const ruleIds = decision.reasons.map(r => r.ruleId);
    const row: BacktestRow = {
      index, at: event.at, participantId,
      kind: p && typeof p === 'object' && typeof p.kind === 'string' ? p.kind : '',
      roleId: p && typeof p === 'object' && typeof p.roleId === 'string' ? p.roleId : '',
      action: raw && typeof raw === 'object' && typeof raw.action === 'string' ? raw.action : '',
      areaId, status: decision.status, missingFacts: isMissing, ruleIds,
      ...(event.outcome !== undefined ? { outcome: event.outcome } : {}),
    };
    rows.push(row);

    tally(totals, decision.status, isMissing);
    const areaKey = areaId || '(none)', roleKey = row.roleId || '(none)';
    if (!byArea.has(areaKey)) byArea.set(areaKey, counts());
    if (!byRole.has(roleKey)) byRole.set(roleKey, counts());
    tally(byArea.get(areaKey)!, decision.status, isMissing);
    tally(byRole.get(roleKey)!, decision.status, isMissing);

    const matched = matchingRules(rulebook, request);
    for (const id of matched) if (id in byRule) byRule[id].matched++;
    for (const id of ruleIds) if (id in byRule) byRule[id].decided++;

    if (isMissing) {
      for (const fact of missingFacts(rulebook, request)) bump(missing, fact, () => ({ fact, count: 0, examples: [] }), event.at);
    } else if (decision.status === 'PAUSE' || decision.status === 'BLOCK') {
      const status = decision.status;
      for (const r of decision.reasons) bump(stalls, `${r.ruleId}\u0000${status}`, () => ({ ruleId: r.ruleId, setBy: r.setBy, status, count: 0, examples: [] }), event.at);
    }
    if (ruleIds.includes('unknown_action')) bump(gaps, row.action, () => ({ action: row.action, count: 0, examples: [] }), event.at);
    for (const c of conflicts) {
      if (!c.finding.ruleIds.every(id => matched.includes(id))) continue;
      c.count++;
      if (c.examples.length < keep) c.examples.push(event.at);
    }
    if (event.outcome === 'happened' && (decision.status === 'PAUSE' || decision.status === 'BLOCK')) differences.push({ index, at: event.at, status: decision.status, outcome: 'happened', ruleIds });
    if (event.outcome === 'did_not_happen' && (decision.status === 'ALLOW' || decision.status === 'LIMIT')) differences.push({ index, at: event.at, status: decision.status, outcome: 'did_not_happen', ruleIds });

    if (participantId && row.action) {
      const at = clock && raw.facts && typeof raw.facts === 'object' && typeof (raw.facts as Record<string, unknown>)[clock] === 'string' ? { at: (raw.facts as Record<string, unknown>)[clock] as string } : {};
      const list = earlier && earlier.day === day ? earlier : { day, entries: [] };
      list.entries.push({ action: row.action, areaId, ...at });
      prior.set(participantId, list);
    }
  });

  const sorted = <T>(map: Map<string, T>): Record<string, T> => Object.fromEntries([...map.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  const byCount = <T extends { count: number; examples: string[] }>(items: T[], tie: (a: T, b: T) => number): T[] =>
    items.sort((a, b) => b.count - a.count || tie(a, b));
  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return {
    fingerprint: rulebook.fingerprint,
    events: events.length,
    totals,
    byArea: sorted(byArea),
    byRole: sorted(byRole),
    byRule,
    neverFired: rulebook.rules.filter(r => byRule[r.id].matched === 0).map(r => r.id),
    // Stalls keep insertion order (first occurrence) as the tie-break, so sort is stable on count.
    wouldStall: [...stalls.values()].sort((a, b) => b.count - a.count),
    conflictsOccurred: conflicts.filter(c => c.count > 0).map(c => ({ kind: c.finding.kind, severity: c.finding.severity, ruleIds: [...c.finding.ruleIds], count: c.count, firstAt: c.examples[0], examples: c.examples })),
    gaps: byCount([...gaps.values()], (a, b) => cmp(a.action, b.action)),
    missingFacts: byCount([...missing.values()], (a, b) => cmp(a.fact, b.fact)),
    differences,
    rows,
  };
}

/**
 * Current rulebook versus proposed rulebook, on the same log: both reports
 * must come from the same events (same count, same `at` sequence).
 */
export function compareBacktests(baseline: BacktestReport, proposed: BacktestReport): BacktestComparison {
  if (baseline.events !== proposed.events || baseline.rows.some((r, i) => r.at !== proposed.rows[i].at)) {
    throw new DomainRulesError('compareBacktests: the two reports must come from the same event log (same events, in the same order).');
  }
  const newlyBlocked: BacktestChange[] = [], newlyAllowed: BacktestChange[] = [], otherChanges: BacktestChange[] = [];
  const decided = new Map<string, { baseline: number; proposed: number }>();
  const tally = (ids: string[], side: 'baseline' | 'proposed') => {
    for (const id of ids) { const d = decided.get(id) ?? { baseline: 0, proposed: 0 }; d[side]++; decided.set(id, d); }
  };
  baseline.rows.forEach((a, i) => {
    const b = proposed.rows[i];
    tally(a.ruleIds, 'baseline');
    tally(b.ruleIds, 'proposed');
    if (a.status === b.status) return;
    const change: BacktestChange = { index: i, at: a.at, from: a.status, to: b.status, before: a.ruleIds, after: b.ruleIds };
    const lenient = (s: DomainDecisionStatus) => s === 'ALLOW' || s === 'LIMIT';
    if (b.status === 'BLOCK') newlyBlocked.push(change);
    else if (!lenient(a.status) && lenient(b.status)) newlyAllowed.push(change);
    else otherChanges.push(change);
  });
  const byRule = [...decided.entries()]
    .map(([ruleId, d]) => ({ ruleId, baseline: d.baseline, proposed: d.proposed, change: d.proposed - d.baseline }))
    .sort((x, y) => Math.abs(y.change) - Math.abs(x.change) || (x.ruleId < y.ruleId ? -1 : x.ruleId > y.ruleId ? 1 : 0));
  return {
    baseline: baseline.fingerprint,
    proposed: proposed.fingerprint,
    events: baseline.events,
    totals: { baseline: baseline.totals, proposed: proposed.totals },
    changed: newlyBlocked.length + newlyAllowed.length + otherChanges.length,
    newlyBlocked, newlyAllowed, otherChanges, byRule,
  };
}
