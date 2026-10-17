import { formatEvent, initialExecState, reduceExecution, type ExecState } from '@runloop-world/core';
import type { AnyEvent } from '@runloop-world/events';

function clip(text: string, max = 110): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/**
 * The `demo` text trace: one line per recorded event, e.g.
 * `#036 00:15.6 tester      tool.call_completed  run_command error · 10 passed, 2 failed — 12 tests: …`.
 * Wording comes from core's formatEvent (the same text Studio shows); this
 * class only folds the Layer-1 state it reads (run start, tool names, owners).
 */
export class TracePrinter {
  private runId: string | null = null;
  private state: ExecState = initialExecState();

  format(e: AnyEvent): string {
    if (e.runId !== this.runId) {
      this.runId = e.runId;
      this.state = initialExecState();
    }
    // The bus publishes each run's recorded events in sequence order.
    this.state = reduceExecution(this.state, e);
    const f = formatEvent(e, this.state);
    const head = `#${String(f.seq).padStart(3, '0')} ${f.clock} ${f.actor.padEnd(11)} ${f.type.padEnd(20)}`;
    return `${head} ${clip(f.label, 90)}${f.detail ? ` — ${clip(f.detail)}` : ''}`;
  }
}
