import type { RunState } from '@runloop-world/replay';
import type { CompiledWorld, PresentationState } from '@runloop-world/world-engine';

export type IconName =
  | 'search'
  | 'hammer'
  | 'flask'
  | 'rocket'
  | 'bot'
  | 'dot'
  | 'walk'
  | 'gear'
  | 'hourglass'
  | 'question'
  | 'check'
  | 'cross'
  | 'pause'
  | 'alert';

export type Tone = 'neutral' | 'active' | 'ok' | 'err' | 'warn' | 'muted';

export const TONE_COLOR: Record<Tone, string> = {
  neutral: '#94a3b8',
  active: '#7dd3fc',
  ok: '#6ee7b7',
  err: '#fda4af',
  warn: '#fcd34d',
  muted: '#64748b',
};

/** Every presentation state has an icon AND a text label (never colour alone). */
export const STATE_BADGE: Record<PresentationState, { icon: IconName; label: string; tone: Tone }> = {
  idle: { icon: 'dot', label: 'Idle', tone: 'neutral' },
  moving: { icon: 'walk', label: 'Walking', tone: 'active' },
  working: { icon: 'gear', label: 'Working', tone: 'active' },
  waiting: { icon: 'hourglass', label: 'Waiting', tone: 'warn' },
  awaiting_approval: { icon: 'question', label: 'Needs approval', tone: 'warn' },
  succeeded: { icon: 'check', label: 'Done', tone: 'ok' },
  failed: { icon: 'cross', label: 'Failed', tone: 'err' },
  paused: { icon: 'pause', label: 'Paused', tone: 'muted' },
};

const PRESET_ICONS: Record<string, IconName> = { search: 'search', hammer: 'hammer', flask: 'flask', rocket: 'rocket' };
export const presetIcon = (icon: string | undefined): IconName => (icon && PRESET_ICONS[icon]) || 'bot';

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * The badge's second line: the state label plus a short, factual detail
 * taken from Layer 1/2 (active tool, walking destination, waiting reason).
 */
export function badgeDetail(state: PresentationState, agentId: string, run: RunState, world: CompiledWorld): string {
  const base = STATE_BADGE[state].label;
  const agent = run.exec.agents[agentId];
  const ch = run.world.characters[agentId];
  switch (state) {
    case 'working': {
      const call = agent?.activeCallId ? run.exec.toolCalls[agent.activeCallId] : undefined;
      return call ? `${base} · ${call.tool}` : base;
    }
    case 'moving': {
      const t = ch?.target;
      if (t && (t.kind === 'slot' || t.kind === 'overflow')) {
        const label = world.stationsById[t.stationId]?.label;
        return label ? `${base} → ${clip(label, 18)}` : base;
      }
      return t?.kind === 'home' ? `${base} → home` : base;
    }
    case 'waiting': {
      // "waiting for a fix" → "Waiting · for a fix"
      const reason = agent?.stateReason?.replace(/^waiting\s+/i, '');
      return reason ? `${base} · ${clip(reason, 22)}` : base;
    }
    default:
      return base;
  }
}
