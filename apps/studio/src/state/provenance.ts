import type { ExecState } from '@runloop-world/core';
import type { RunSummary } from '@runloop-world/events';
import type { Tone } from '../ui/Chip';
import type { IconName } from '../ui/Icon';

/** design-system.md, Provenance labelling. */
export interface ProvenanceView {
  kind: 'executed' | 'traced' | 'synthetic';
  label: string;
  detail: string;
  icon: IconName;
  tone: Tone;
}

const SOURCE_LABEL: Record<string, string> = { 'claude-code': 'Claude Code' };

/** The honest provenance banner for traced runs (docs/plans/claude-code-tracer.md §7.3). */
export function tracedBanner(source: string): string {
  const from = source === 'Claude Code' ? 'Claude Code hooks' : source;
  return `Recorded from ${from}. Runloop did not run, approve or verify these actions; results are shown as ${source} reported them. Items marked inferred were reconstructed by Runloop.`;
}

const field = (o: unknown, key: string): unknown => (o && typeof o === 'object' ? (o as Record<string, unknown>)[key] : undefined);

/**
 * Where a run's events come from. Traced runs (adapter kind 'external' or
 * mode 'traced', from the Claude Code tracer) were recorded, not executed by
 * Runloop. Reads the newer fields defensively so older and newer runtimes both work.
 */
export function runProvenance(run: RunSummary | null, exec: ExecState): ProvenanceView {
  const mode = field(run, 'mode') ?? field(exec.run, 'mode');
  const sourceKind = field(field(run, 'source') ?? field(exec.run, 'source'), 'kind');
  if (mode === 'synthetic') {
    return { kind: 'synthetic', label: 'Synthetic', detail: 'Example or fixture data, never mixed with real runs.', icon: 'diamond', tone: 'warn' };
  }
  const adapterKind: unknown = exec.run.adapter?.kind;
  if (mode === 'traced' || adapterKind === 'external') {
    const source = typeof sourceKind === 'string' ? (SOURCE_LABEL[sourceKind] ?? sourceKind) : 'external source';
    return {
      kind: 'traced',
      label: `Traced · ${source}`,
      detail: tracedBanner(source),
      icon: 'eye',
      tone: 'info',
    };
  }
  const scripted = adapterKind === 'scripted' || (!exec.run.adapter && /scripted/i.test(run?.adapterLabel ?? ''));
  return {
    kind: 'executed',
    label: 'Executed',
    detail: scripted
      ? "Runloop's runtime ran the tools itself. Agent decisions come from a scripted adapter, not a model."
      : "Runloop's runtime ran the tools itself.",
    icon: 'terminal',
    tone: 'muted',
  };
}

/** Event-level chip for events Runloop reconstructed. */
export const INFERRED: ProvenanceView = {
  kind: 'traced',
  label: 'Inferred',
  detail: 'Reconstructed by Runloop (for example a denied permission); the source did not report it directly.',
  icon: 'inferred',
  tone: 'warn',
};
