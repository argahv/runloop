import { formatEvent, type ExecState, type FormattedEvent } from '@runloop-world/core';
import { isUnknownEvent, type AnyEvent, type RunMarkerKind, type ToolCategory } from '@runloop-world/events';
import type { IconName } from '../ui/Icon';

/**
 * Studio wording for events: core's text formatter (payload fields only) with
 * agent and task names instead of raw ids, and traced-run wording (sessions,
 * delegation, reported usage, markers). Never adds facts the payload lacks.
 */

export const CATEGORY_LABEL: Record<ToolCategory, string> = {
  read: 'Read',
  search: 'Search',
  web: 'Web',
  edit: 'Edit',
  execute: 'Command',
  test: 'Test',
  deploy: 'Deploy',
  mcp: 'MCP',
  delegate: 'Delegate',
  plan: 'Plan',
  other: 'Other',
};

export const CATEGORY_ICON: Record<ToolCategory, IconName> = {
  read: 'file',
  search: 'search',
  web: 'globe',
  edit: 'pencil',
  execute: 'terminal',
  test: 'flask',
  deploy: 'upload',
  mcp: 'integrations',
  delegate: 'agent',
  plan: 'map',
  other: 'dot',
};

/** Label for a category string from the wire (unknown values pass through). */
export function categoryLabel(c: string): string {
  return (CATEGORY_LABEL as Record<string, string>)[c] ?? c;
}

export const MARKER_GLYPH: Record<RunMarkerKind, string> = {
  compaction: '◫',
  notification: '🔔',
  api_error: '⚠',
  session_resumed: '↻',
  model_switch: '⇄',
  other: '⚑',
};

/** Human wording for tool.call_failed error types. */
const FAILURE_TEXT: Record<string, string> = {
  denied: 'denied',
  aborted: 'interrupted',
  timeout: 'timed out',
  spawn_error: 'could not start',
  exception: 'crashed',
  runtime_restarted: 'cut off by a runtime restart',
  unobserved: 'result not reported',
};

export function failureText(errorType: string): string {
  return FAILURE_TEXT[errorType] ?? `could not run (${errorType})`;
}

/** A traced run (recorded from an external agent's reports), from its folded state. */
export function isTracedExec(exec: ExecState): boolean {
  return exec.run.mode === 'traced' || exec.run.adapter?.kind === 'external';
}

/** Display name of an agent id ('all' and 'system' included). */
export function nameOf(exec: ExecState | undefined, id: string): string {
  if (id === 'all') return 'everyone';
  if (id === 'system') return 'System';
  return exec?.agents[id]?.name ?? id;
}

function taskTitle(exec: ExecState | undefined, taskId: string): string {
  return exec?.tasks[taskId]?.title ?? taskId;
}

// ── Tokens and models ───────────────────────────────────────────────

/** 830 → "830", 20520 → "20.5k", 1234567 → "1.23M" (fixed locale). */
export function formatTokens(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${trim(n / 1000, n < 10_000 ? 2 : 1)}k`;
  return `${trim(n / 1_000_000, 2)}M`;
}

const trim = (v: number, digits: number) => v.toFixed(digits).replace(/\.?0+$/, '');

/** 20520 → "20,520". */
export function formatInt(n: number): string {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Short model name for compact cells ("claude-haiku-5-5" → "haiku"); the full id belongs in a tooltip. */
export function shortModel(model: string): string {
  const family = /(opus|sonnet|haiku|fable)/i.exec(model);
  return family ? family[1]!.toLowerCase() : model;
}

export interface UsageLike {
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number | undefined;
  cacheCreationTokens?: number | undefined;
  totalTokens?: number | undefined;
}

/** The reported total, or the sum of the reported parts when the source gave no total. */
export function usageTotal(u: UsageLike): number {
  return u.totalTokens ?? u.inputTokens + u.outputTokens + (u.cacheReadTokens ?? 0) + (u.cacheCreationTokens ?? 0);
}

/** "20.5k tokens · haiku". */
export function usageText(u: UsageLike): string {
  return `${formatTokens(usageTotal(u))} tokens${u.model ? ` · ${shortModel(u.model)}` : ''}`;
}

/** "in 2 · out 193 · cache read 19,620 · cache write 705" (only the parts that were reported). */
export function usageParts(u: UsageLike): string {
  const parts = [`in ${formatInt(u.inputTokens)}`, `out ${formatInt(u.outputTokens)}`];
  if (u.cacheReadTokens !== undefined) parts.push(`cache read ${formatInt(u.cacheReadTokens)}`);
  if (u.cacheCreationTokens !== undefined) parts.push(`cache write ${formatInt(u.cacheCreationTokens)}`);
  return parts.join(' · ');
}

const USAGE_SOURCE: Record<string, string> = {
  'claude-code.agent_result': 'reported by Claude Code (Agent tool result)',
};

/** Where a usage report came from, in words. */
export function usageSourceText(source: string): string {
  return USAGE_SOURCE[source] ?? `reported by ${source}`;
}

// ── Event labels ────────────────────────────────────────────────────

/**
 * One readable line for an event. `exec` (normally the latest state) supplies
 * agent and task names; without it the core wording is used.
 */
export function describeEvent(e: AnyEvent, exec?: ExecState): FormattedEvent {
  const f = formatEvent(e, exec);
  if (isUnknownEvent(e) || !exec) return f;
  const traced = isTracedExec(exec);
  const out = (label: string, detail: string | null = f.detail, severity: FormattedEvent['severity'] = f.severity): FormattedEvent => ({
    ...f,
    label,
    detail,
    severity,
  });

  switch (e.type) {
    case 'run.started': {
      const src = e.payload.source;
      if (!src) return f;
      const part = src.segment > 1 ? ` · part ${src.segment}` : '';
      return out(`Session started · ${src.projectLabel}`, `Claude Code session ${src.sessionId.slice(0, 8)}${part}`);
    }
    case 'run.completed': {
      if (!traced) return f;
      const o = e.payload.outcome;
      const label = o === 'stopped' ? 'Session ended' : o === 'interrupted' ? 'Session closed (interrupted)' : `Session ${o}`;
      return out(label, e.payload.summary ?? null, o === 'stopped' ? 'info' : f.severity);
    }
    case 'agent.registered': {
      if (!traced) return f;
      const p = e.payload;
      if (p.role === 'user') return out(`${p.name} joined`, 'the person prompting Claude Code');
      const what = p.role === 'main agent' ? p.role : `subagent (${p.role})`;
      return out(`${p.name} joined`, `${what}${p.model ? ` · ${p.model}` : ''}${p.embodied ? '' : ' · no character'}`);
    }
    case 'agent.state_changed':
      return out(`${nameOf(exec, e.payload.agentId)} → ${e.payload.state}`);
    case 'agent.message_sent':
      return out(`${nameOf(exec, e.payload.fromAgentId)} → ${nameOf(exec, e.payload.to)}`, e.payload.text);
    case 'agent.usage_reported': {
      const p = e.payload;
      return out(`Usage: ${usageText(p)}`, `${usageParts(p)} · ${usageSourceText(p.source)}`);
    }
    case 'task.created': {
      const p = e.payload;
      if (p.kind === 'delegated') {
        const owner = exec.tasks[p.taskId]?.ownerId;
        return out(`Delegated to ${owner ? nameOf(exec, owner) : 'a subagent'}: ${p.title}`, null);
      }
      if (p.kind === 'turn') return out(`${p.title} started`, null);
      return f;
    }
    case 'task.assigned':
      return out(`Assigned ${taskTitle(exec, e.payload.taskId)} to ${nameOf(exec, e.payload.agentId)}`);
    case 'task.started':
      return out(f.label.replace(e.payload.taskId, taskTitle(exec, e.payload.taskId)));
    case 'task.blocked':
      return out(`Blocked: ${taskTitle(exec, e.payload.taskId)}`);
    case 'task.completed':
      return out(`Completed ${taskTitle(exec, e.payload.taskId)}`);
    case 'task.failed': {
      const p = e.payload;
      const detail = p.errorType === 'api_error' ? `API error: ${p.reason}` : p.reason;
      return out(`Failed ${taskTitle(exec, p.taskId)}`, detail);
    }
    case 'tool.call_failed': {
      const call = exec.toolCalls.get(e.payload.callId);
      return out(`${call?.tool ?? e.payload.callId}: ${failureText(e.payload.errorType)}`, e.payload.message);
    }
    case 'tool.permission_requested':
      return out(f.label, traced ? `permission mode: ${e.payload.scope}` : f.detail);
    case 'tool.permission_resolved': {
      const p = e.payload;
      if (p.by !== 'unknown') return f;
      return out(`Permission ${p.decision}`, 'Who answered was not reported');
    }
    default:
      return f;
  }
}
