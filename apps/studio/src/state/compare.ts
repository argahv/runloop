import { foldExecution, initialExecState, type DiffNote, type ExecState, type FieldDiff, type RunDiff } from '@runloop-world/core';
import { invalidEnvelopeEvent, parseEvent, type AnyEvent, type RunOutcome } from '@runloop-world/events';
import type { IconName } from '../ui/Icon';
import { formatTokens } from './labels';
import { formatDuration } from './timeline';

/**
 * Studio wording for run compare (core `diffRuns`): side names, why a value
 * is not comparable, and the tone of a change. A change only gets a semantic
 * colour when it is comparable and the direction is a judgement the data
 * supports (fewer failing tests is better; more tool calls is just different).
 */

export type Side = 'a' | 'b';
export const SIDE_NAME: Record<Side, string> = { a: 'Baseline', b: 'Candidate' };
export const SIDE_LETTER: Record<Side, string> = { a: 'A', b: 'B' };

const NOTE_TEXT: Record<DiffNote, string> = {
  not_reported: 'not reported in either run',
  not_reported_a: 'not reported for the baseline',
  not_reported_b: 'not reported for the candidate',
  running: 'both runs are still recording',
  running_a: 'the baseline is still recording',
  running_b: 'the candidate is still recording',
  coverage_differs: 'reported for different agents in each run',
  mode_differs: 'one run was executed by Runloop, the other traced',
  pace_differs: 'the demo ran at a different pace (speed) in each run',
  pace_unknown: 'the demo’s pace was not recorded for one run',
};

export function noteText(note: DiffNote): string {
  return NOTE_TEXT[note];
}

export interface ChangeView {
  tone: 'ok' | 'err' | 'warn' | 'info' | 'muted';
  icon: IconName;
  /** Always says what changed in words (colour is never the only signal). */
  text: string;
  /** The reason it is not comparable, or a caveat. */
  detail: string | null;
}

export interface ChangeSpec {
  /** Which way is better; `neutral` = a difference, not a verdict. */
  better: 'lower' | 'higher' | 'neutral';
  /** The change in words from |delta| and its direction, e.g. "2.0 s faster", "2 fewer failing". */
  say: (n: number, down: boolean) => string;
  /** Tone of a change for the worse (default warn). */
  worse?: 'err' | 'warn';
}

/** The change chip for a numeric field. */
export function changeView(f: FieldDiff<number>, spec: ChangeSpec): ChangeView {
  if (!f.comparable || f.delta === null) {
    return { tone: 'muted', icon: 'minus', text: 'not comparable', detail: f.note ? noteText(f.note) : null };
  }
  const caveat = f.note ? noteText(f.note) : null;
  if (f.delta === 0) return { tone: 'muted', icon: 'minus', text: 'no change', detail: caveat };
  const down = f.delta < 0;
  const text = spec.say(Math.abs(f.delta), down);
  const icon: IconName = down ? 'arrowDown' : 'arrowUp';
  if (spec.better === 'neutral') return { tone: 'info', icon, text, detail: caveat };
  const improved = spec.better === 'lower' ? down : !down;
  return { tone: improved ? 'ok' : (spec.worse ?? 'warn'), icon, text, detail: caveat };
}

/** "2 fewer calls", "1 more call". */
const fewerMore = (one: string, many = `${one}s`) => (n: number, down: boolean) => `${n} ${down ? 'fewer' : 'more'} ${n === 1 ? one : many}`;

/** Specs for the fields the Experiments page shows. */
export const CHANGE = {
  duration: { better: 'lower', say: (n, down) => `${formatDuration(n)} ${down ? 'faster' : 'slower'}` },
  toolCalls: { better: 'neutral', say: fewerMore('call') },
  failedCalls: { better: 'lower', say: fewerMore('failed call'), worse: 'err' },
  failures: { better: 'lower', say: fewerMore('failure'), worse: 'err' },
  passed: { better: 'higher', say: (n, down) => `${n} ${down ? 'fewer' : 'more'} passing`, worse: 'err' },
  failing: { better: 'lower', say: (n, down) => `${n} ${down ? 'fewer' : 'more'} failing`, worse: 'err' },
  tests: { better: 'neutral', say: fewerMore('test') },
  testRuns: { better: 'neutral', say: fewerMore('test run') },
  tokens: { better: 'lower', say: (n, down) => `${formatTokens(n)} ${down ? 'fewer' : 'more'} tokens` },
  permissions: { better: 'neutral', say: fewerMore('request') },
  denied: { better: 'neutral', say: fewerMore('denial') },
  waits: { better: 'lower', say: (n, down) => `${formatDuration(n)} ${down ? 'less' : 'more'} waiting` },
  turns: { better: 'neutral', say: fewerMore('turn') },
  subagents: { better: 'neutral', say: fewerMore('subagent') },
  events: { better: 'neutral', say: fewerMore('event') },
} satisfies Record<string, ChangeSpec>;

/** How an outcome reads; a traced session that ended normally is "ended" (it claims nothing about success). */
export function outcomeText(outcome: RunOutcome | null, traced: boolean): string {
  if (outcome === null) return 'still recording';
  return traced && outcome === 'stopped' ? 'ended' : outcome;
}

/** The outcome change: success ↔ failure is judged; anything else is described. */
export function outcomeChange(o: RunDiff['outcome'], traced: [boolean, boolean]): ChangeView {
  if (!o.comparable) return { tone: 'muted', icon: 'minus', text: 'not comparable', detail: o.note ? noteText(o.note) : null };
  const caveat = o.note ? noteText(o.note) : null;
  if (!o.changed) return { tone: 'muted', icon: 'minus', text: 'same outcome', detail: caveat };
  const to = outcomeText(o.b, traced[1]);
  if (o.b === 'succeeded' && o.a === 'failed') return { tone: 'ok', icon: 'arrowUp', text: 'now succeeds', detail: caveat };
  if (o.b === 'failed') return { tone: 'err', icon: 'arrowDown', text: 'now fails', detail: caveat };
  return { tone: 'info', icon: 'swap', text: `now ${to}`, detail: caveat };
}

// ── loading a run for compare ──────────────────────────────────────────

/**
 * Fold raw events (as the API returns them) onto `from`. Invalid envelopes
 * that still name a sequence fold as unknown events (anomalies), like the
 * live store. Folding stops at the first missing sequence; `complete` says
 * whether every event through `expected` was folded.
 */
export function foldRaw(raws: readonly unknown[], runId: string, from: ExecState = initialExecState(), expected = 0): { exec: ExecState; complete: boolean } {
  const bySeq = new Map<number, AnyEvent>();
  let lastTimestamp = new Date(0).toISOString();
  for (const raw of raws) {
    const parsed = parseEvent(raw);
    const event = parsed.ok ? parsed.event : invalidEnvelopeEvent(raw, parsed.error, { runId, timestamp: lastTimestamp });
    if (!event || event.runId !== runId || event.sequence <= from.lastSequence || bySeq.has(event.sequence)) continue;
    if (parsed.ok) lastTimestamp = event.timestamp;
    bySeq.set(event.sequence, event);
  }
  const ordered: AnyEvent[] = [];
  for (let seq = from.lastSequence + 1; bySeq.has(seq); seq++) ordered.push(bySeq.get(seq)!);
  const exec = ordered.length ? foldExecution(ordered, from) : from;
  return { exec, complete: exec.lastSequence >= expected };
}
