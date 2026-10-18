/**
 * Pure helpers for Assign task (plan §4.4): the command as a shell line, a
 * dispatch's status in words, and its stream-json output as readable lines.
 * Outcomes are Claude Code's reports, never Runloop's verdict.
 */
import type { DispatchOutputFrame, DispatchSummary } from '@runloop-world/events';
import type { IconName } from '../../ui/Icon';

/** One argv element as a POSIX shell word (display only: Runloop never runs a shell). */
export function shellQuote(arg: string): string {
  if (arg !== '' && /^[A-Za-z0-9_/.:=@%+,-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

export function commandLine(argv: readonly string[]): string {
  return argv.map(shellQuote).join(' ');
}

export type StatusTone = 'live' | 'ok' | 'warn' | 'err' | 'muted';

export interface DispatchStatusView {
  tone: StatusTone;
  icon: IconName;
  title: string;
  detail: string;
  /** Still running (or stopping): cancel is offered. */
  active: boolean;
}

/** A dispatch's state in words; status never relies on colour alone. */
export function dispatchStatusView(d: Pick<DispatchSummary, 'status' | 'outcome' | 'stopping' | 'timeoutMin' | 'exitCode'>): DispatchStatusView {
  if (d.status === 'running' && d.stopping) {
    return { tone: 'warn', icon: 'hourglass', title: 'Stopping…', detail: 'Runloop sent SIGTERM; anything still running is killed after 10 s.', active: true };
  }
  if (d.status === 'running') return { tone: 'live', icon: 'pulse', title: 'Running', detail: 'Claude Code is working headless in the workspace.', active: true };
  if (d.status === 'orphaned') {
    return { tone: 'warn', icon: 'alert', title: 'Still running after a restart', detail: 'Runloop restarted while it ran, so its output is not followed. You can stop it.', active: true };
  }
  switch (d.outcome) {
    case 'completed':
      return { tone: 'ok', icon: 'checkCircle', title: 'Claude Code reports done', detail: 'As reported by Claude Code; Runloop did not check the work.', active: false };
    case 'failed':
      return {
        tone: 'err',
        icon: 'xCircle',
        title: 'Claude Code reports a failure',
        detail: d.exitCode === null ? 'Exit code not reported.' : `It exited with code ${d.exitCode}.`,
        active: false,
      };
    case 'cancelled':
      return { tone: 'muted', icon: 'stop', title: 'Cancelled', detail: 'Stopped at your request. Edits made before that stay in the working tree.', active: false };
    case 'timed_out':
      return { tone: 'warn', icon: 'clock', title: 'Timed out', detail: `Runloop stopped it after ${d.timeoutMin} min.`, active: false };
    case 'budget_exceeded':
      return { tone: 'warn', icon: 'coins', title: 'Budget reached', detail: 'Claude Code stopped at its --max-budget-usd limit.', active: false };
    case 'lost':
      return { tone: 'muted', icon: 'inferred', title: 'Outcome not reported', detail: 'Runloop restarted and the process was gone, so how it ended is unknown.', active: false };
    default:
      return { tone: 'muted', icon: 'circle', title: 'Finished', detail: 'Outcome not reported.', active: false };
  }
}

/** "$0.0123 reported by Claude Code", or that it was not reported (never $0). */
export function costText(usd: number | null): string {
  if (usd === null) return 'Cost not reported';
  // Up to four decimals, at least two: 0.0123, 0.25, 1.00.
  return `$${usd.toFixed(4).replace(/0{1,2}$/, '')} reported by Claude Code`;
}

export interface OutputLine {
  key: number;
  kind: 'system' | 'text' | 'tool' | 'result' | 'stderr' | 'raw';
  text: string;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** What a tool call was about, from its input (file, pattern or command). */
function toolTarget(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const i = input as Record<string, unknown>;
  const v = i.file_path ?? i.path ?? i.pattern ?? i.command ?? i.url ?? i.description;
  return typeof v === 'string' ? clip(v.replace(/\s+/g, ' '), 120) : '';
}

/** stream-json frames as readable lines (the last `max`). Unknown shapes are shown raw, never guessed at. */
export function outputLines(frames: readonly DispatchOutputFrame[], max = 200): OutputLine[] {
  const out: OutputLine[] = [];
  frames.forEach((f) => {
    // Keys are positions in the full list, so they stay stable as output is appended.
    const push = (kind: OutputLine['kind'], text: string) => out.push({ key: out.length, kind, text });
    if (f.stream === 'stderr') return push('stderr', clip(f.line, 400));
    let v: Record<string, unknown>;
    try {
      v = JSON.parse(f.line) as Record<string, unknown>;
    } catch {
      return push('raw', clip(f.line, 400));
    }
    if (v.type === 'system') {
      if (v.subtype === 'init') push('system', `Session started${typeof v.model === 'string' ? ` · model ${v.model}` : ''}`);
      return;
    }
    if (v.type === 'assistant') {
      const content = (v.message as { content?: unknown } | undefined)?.content;
      for (const block of Array.isArray(content) ? content : []) {
        const b = block as Record<string, unknown>;
        if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) push('text', clip(b.text.trim(), 600));
        if (b.type === 'tool_use' && typeof b.name === 'string') push('tool', `${b.name}${toolTarget(b.input) ? ` · ${toolTarget(b.input)}` : ''}`);
      }
      return;
    }
    if (v.type === 'result') {
      const text = typeof v.result === 'string' ? clip(v.result, 600) : '';
      push('result', `Result (${typeof v.subtype === 'string' ? v.subtype.replace(/_/g, ' ') : 'not reported'})${text ? `: ${text}` : ''}`);
    }
    // user (tool results) and other events are in the trace; not repeated here.
  });
  return out.slice(-max);
}

/** "4:58" until the approval expires ("expired" after). */
export function expiresIn(expiresAt: string, nowMs: number): string {
  const s = Math.max(0, Math.floor((Date.parse(expiresAt) - nowMs) / 1000));
  return s === 0 ? 'expired' : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
