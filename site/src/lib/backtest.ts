/**
 * Test mode: a recorded event log replayed through the rulebook. Pure; the
 * core's `backtest` and `compareBacktests` do the work. The sample week and
 * its site come from examples/backtest/.
 */

import type { BacktestEvent, CompileDomainInput } from '../../../src/index';
import { sampleSite } from '../../../examples/backtest/rulebook';
import { SAMPLE_WEEK, SAMPLE_WEEK_NOTE } from '../../../examples/backtest/sample-week';
import { cloneJson, type RulebookState } from './model';

export interface ParsedLog {
  events: BacktestEvent[];
  /** Lines or items that were not `{ at, request }` (a header record, a blank line) and were left out. */
  skipped: number;
  /** Set when the text could not be read as a log at all. */
  error?: string;
}

/**
 * Read an event log: a JSON array of events, a JSON object with an `events`
 * array, or JSON Lines with one event per line. Items without a non-empty
 * `at` and a `request` are skipped (the sample week's first line is such a
 * header). Order is kept as given.
 */
export function parseEventLog(text: string): ParsedLog {
  const trimmed = text.trim();
  if (!trimmed) return { events: [], skipped: 0, error: 'The file is empty.' };
  let items: unknown[] | null = null;
  try {
    const v = JSON.parse(trimmed) as unknown;
    if (Array.isArray(v)) items = v;
    else if (v && typeof v === 'object' && Array.isArray((v as { events?: unknown }).events)) items = (v as { events: unknown[] }).events;
    else items = [v];
  } catch {
    items = [];
    for (const line of trimmed.split('\n')) {
      const l = line.trim();
      if (!l) continue;
      try { items.push(JSON.parse(l)); } catch { return { events: [], skipped: 0, error: `Line ${items.length + 1} is not JSON. Expected a JSON array, an object with "events", or one JSON event per line.` }; }
    }
  }
  const events: BacktestEvent[] = [];
  let skipped = 0;
  for (const it of items) {
    const e = it as { at?: unknown; request?: unknown; outcome?: unknown };
    if (!e || typeof e !== 'object' || typeof e.at !== 'string' || !e.at || !('request' in e)) { skipped++; continue; }
    const outcome = e.outcome === 'happened' || e.outcome === 'did_not_happen' || e.outcome === 'unknown' ? e.outcome : undefined;
    events.push({ at: e.at, request: e.request as BacktestEvent['request'], ...(outcome ? { outcome } : {}) });
  }
  if (!events.length) return { events, skipped, error: 'No events found: each needs "at" and "request".' };
  return { events, skipped };
}

export interface SampleWeek {
  note: string;
  events: BacktestEvent[];
  /** The sample site's rulebook state (the grocery store plus aisle 5, a robots count and the rule under test). */
  rulebook: RulebookState;
}

/** The synthetic sample week and the rulebook it was written for ("at most two robots in aisle 5"). */
export function sampleWeek(): SampleWeek {
  const input: CompileDomainInput = cloneJson(sampleSite(2).input);
  return {
    note: SAMPLE_WEEK_NOTE,
    events: cloneJson(SAMPLE_WEEK),
    rulebook: { startingPoint: 'grocery', input, disabledRuleIds: [], actingAs: 'site-manager' },
  };
}

/** The five words the summary uses, in order. */
export const SUMMARY: Array<{ key: 'ALLOW' | 'LIMIT' | 'PAUSE' | 'BLOCK' | 'missingFacts'; word: string; className: string }> = [
  { key: 'ALLOW', word: 'Allowed', className: 'ALLOW' },
  { key: 'LIMIT', word: 'Slower', className: 'LIMIT' },
  { key: 'PAUSE', word: 'Wait', className: 'PAUSE' },
  { key: 'BLOCK', word: 'Blocked', className: 'BLOCK' },
  { key: 'missingFacts', word: 'Missing facts', className: 'missing' },
];

/** "2026-10-05T08:10" → "Mon 10-05 08:10" style short form; other strings are shown as given. */
export function shortAt(at: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}:\d{2})/.exec(at);
  return m ? `${m[2]}-${m[3]} ${m[4]}` : at;
}
