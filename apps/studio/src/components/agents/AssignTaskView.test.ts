import type { DispatchOutputFrame, DispatchSummary } from '@runloop-world/events';
import { describe, expect, it } from 'vitest';
import { commandLine, costText, dispatchStatusView, expiresIn, outputLines, shellQuote } from './AssignTaskView';

const frame = (o: unknown, stream: DispatchOutputFrame['stream'] = 'stdout'): DispatchOutputFrame => ({
  at: '2026-10-18T10:00:00.000Z',
  stream,
  line: typeof o === 'string' ? o : JSON.stringify(o),
});

describe('command line', () => {
  it('quotes only what a shell would split or expand', () => {
    expect(
      commandLine(['claude', '-p', "Fix the bug; don't push", '--allowedTools', 'Read', 'Bash(pnpm test:*)', '--max-budget-usd', '0.25', '--plugin-dir', '/opt/runloop/plugin']),
    ).toBe("claude -p 'Fix the bug; don'\\''t push' --allowedTools Read 'Bash(pnpm test:*)' --max-budget-usd 0.25 --plugin-dir /opt/runloop/plugin");
    expect(shellQuote('')).toBe("''");
    expect(shellQuote('$HOME')).toBe("'$HOME'");
  });
});

describe('dispatch status', () => {
  const base: Pick<DispatchSummary, 'status' | 'outcome' | 'stopping' | 'timeoutMin' | 'exitCode'> = {
    status: 'finished',
    outcome: 'completed',
    stopping: false,
    timeoutMin: 10,
    exitCode: 0,
  };

  it('says "Claude Code reports done" for a completed task, as a report', () => {
    const v = dispatchStatusView(base);
    expect(v).toMatchObject({ title: 'Claude Code reports done', tone: 'ok', active: false });
    expect(v.detail).toMatch(/did not check/);
  });

  it('names every other state in words', () => {
    expect(dispatchStatusView({ ...base, status: 'running', outcome: null }).title).toBe('Running');
    expect(dispatchStatusView({ ...base, status: 'running', outcome: null, stopping: true }).title).toBe('Stopping…');
    expect(dispatchStatusView({ ...base, status: 'orphaned', outcome: null }).active).toBe(true);
    expect(dispatchStatusView({ ...base, outcome: 'failed', exitCode: 1 }).detail).toBe('It exited with code 1.');
    expect(dispatchStatusView({ ...base, outcome: 'failed', exitCode: null }).detail).toBe('Exit code not reported.');
    expect(dispatchStatusView({ ...base, outcome: 'timed_out' }).detail).toBe('Runloop stopped it after 10 min.');
    expect(dispatchStatusView({ ...base, outcome: 'budget_exceeded' }).title).toBe('Budget reached');
    expect(dispatchStatusView({ ...base, outcome: 'cancelled' }).title).toBe('Cancelled');
    expect(dispatchStatusView({ ...base, outcome: 'lost' }).title).toBe('Outcome not reported');
  });

  it('never shows an unreported cost as zero', () => {
    expect(costText(null)).toBe('Cost not reported');
    expect(costText(0.0123)).toBe('$0.0123 reported by Claude Code');
    expect(costText(0.25)).toBe('$0.25 reported by Claude Code');
  });
});

describe('output lines', () => {
  it('reads stream-json: init, text, tool calls, result, stderr; skips tool results', () => {
    const lines = outputLines([
      frame({ type: 'system', subtype: 'init', model: 'claude-haiku', cwd: '…/code/acme' }),
      frame({ type: 'assistant', message: { content: [{ type: 'text', text: 'Looking at the tests.' }, { type: 'tool_use', name: 'Read', input: { file_path: '…/code/acme/src/a.ts' } }] } }),
      frame({ type: 'user', message: { content: [{ type: 'tool_result', content: 'file body' }] } }),
      frame({ type: 'result', subtype: 'success', is_error: false, result: 'All good.' }),
      frame('warning: something', 'stderr'),
      frame('not json'),
    ]);
    expect(lines.map((l) => [l.kind, l.text])).toEqual([
      ['system', 'Session started · model claude-haiku'],
      ['text', 'Looking at the tests.'],
      ['tool', 'Read · …/code/acme/src/a.ts'],
      ['result', 'Result (success): All good.'],
      ['stderr', 'warning: something'],
      ['raw', 'not json'],
    ]);
    expect(new Set(lines.map((l) => l.key)).size).toBe(lines.length);
  });

  it('keeps the last lines only, with stable keys', () => {
    const frames = Array.from({ length: 30 }, (_, i) => frame({ type: 'assistant', message: { content: [{ type: 'text', text: `line ${i}` }] } }));
    const last = outputLines(frames, 5);
    expect(last.map((l) => l.text)).toEqual(['line 25', 'line 26', 'line 27', 'line 28', 'line 29']);
    expect(last[0]!.key).toBe(25);
  });
});

describe('approval countdown', () => {
  it('counts down to expired', () => {
    const at = Date.parse('2026-10-18T10:05:00.000Z');
    expect(expiresIn('2026-10-18T10:05:00.000Z', at - 298_000)).toBe('4:58');
    expect(expiresIn('2026-10-18T10:05:00.000Z', at + 1)).toBe('expired');
  });
});
