import type { StudioState } from './store';
import type { StatusView } from './view';

/** What the Studio is showing right now (design-system.md: always say which). */
export type ConnectionState = 'connecting' | 'live' | 'paused' | 'disconnected' | 'replaying' | 'recorded' | 'synthetic' | 'idle';

export interface ConnectionView extends StatusView {
  state: ConnectionState;
  /** One sentence for tooltips and screen readers. */
  detail: string;
}

type Input = Pick<StudioState, 'runtime' | 'runId' | 'conn' | 'cursor' | 'ended' | 'run' | 'loadError'>;

/**
 * Priority: losing the runtime beats everything; then synthetic data is always
 * labelled; then loading; then where the playhead is (replay) and what the run is doing.
 */
export function connectionState(s: Input, opts: { synthetic?: boolean } = {}): ConnectionState {
  if (s.runtime.status === 'offline') return 'disconnected';
  if (s.runId && (s.conn === 'error' || s.loadError)) return 'disconnected';
  if (opts.synthetic) return 'synthetic';
  if (s.runtime.status === 'unknown') return 'connecting';
  if (!s.runId) return 'idle';
  if (s.conn === 'loading' || s.conn === 'reconnecting') return 'connecting';
  if (s.cursor.mode === 'replay') return s.cursor.playing ? 'replaying' : 'paused';
  if (s.run?.paused) return 'paused';
  if (s.ended) return 'recorded';
  return 'live';
}

const VIEWS: Record<ConnectionState, Omit<ConnectionView, 'state'>> = {
  connecting: { icon: '…', text: 'Connecting', tone: 'muted', detail: 'Connecting to the local runtime.' },
  live: { icon: '●', text: 'Live', tone: 'live', detail: 'Events are arriving now from the runtime.' },
  // Neutral, not a warning: reviewing a past moment is not "attention / waiting / blocked".
  paused: { icon: '⏸', text: 'Paused', tone: 'info', detail: 'The playhead is paused at a recorded moment; nothing is re-executed.' },
  disconnected: { icon: '✗', text: 'Disconnected', tone: 'err', detail: 'The local runtime is not reachable. Data already recorded is safe in its database.' },
  replaying: { icon: '▶', text: 'Replaying', tone: 'info', detail: 'Replaying persisted events; nothing is re-executed.' },
  recorded: { icon: '■', text: 'Recorded', tone: 'muted', detail: 'This run has ended; you are viewing its recorded events.' },
  synthetic: { icon: '◇', text: 'Synthetic', tone: 'warn', detail: 'Example or fixture data, not a real run.' },
  idle: { icon: '●', text: 'Online', tone: 'ok', detail: 'The local runtime is online. No run is open.' },
};

export function connectionView(state: ConnectionState): ConnectionView {
  return { state, ...VIEWS[state] };
}
