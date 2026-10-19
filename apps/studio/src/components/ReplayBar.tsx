'use client';
import { formatClock } from '@runloop-world/core';
import { useMemo, type CSSProperties } from 'react';
import { useStudio, useStudioStore } from '../state/context';
import { useTicker } from '../state/hooks';
import { SPEEDS } from '../state/store';
import { formatClockPair } from '../state/view';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import styles from './ReplayBar.module.css';

/** Transport: previous / play / next, speed, scrubber with incident markers, live toggle. */
/**
 * `followLabel` names the follow state where "Live" would claim more than the
 * run knows (inside an agent's building it is the agent's health that says
 * live; a quiet open session follows its "Latest" event, without the live dot).
 */
export default function ReplayBar({ glass, followLabel = null }: { glass?: boolean; followLabel?: string | null }) {
  const store = useStudioStore();
  // Not the whole cursor: replay playback replaces it every animation frame.
  const live = useStudio((s) => s.cursor.mode === 'live');
  const cursorPlaying = useStudio((s) => s.cursor.mode === 'replay' && s.cursor.playing);
  useStudio((s) => (s.cursor.mode === 'replay' ? Math.floor(s.cursor.tMs / 100) : -1)); // re-render per 100 ms of playhead
  const playheadSeq = useStudio((s) => s.playheadSeq);
  const runId = useStudio((s) => s.runId);
  const ended = useStudio((s) => s.ended);
  const settleMs = useStudio((s) => s.settleMs);
  const lastSequence = useStudio((s) => s.lastSequence);
  const newSinceReplay = useStudio((s) => s.newSinceReplay);
  const speed = useStudio((s) => s.speed);
  const s = store.getState();

  const t = s.playheadMs();
  const end = s.endMs();
  const settled = ended && t >= settleMs;
  // The live clock moves with wall time, not with store updates.
  useTicker(live && runId !== null && !settled, 250);

  const disabled = runId === null || lastSequence === 0;
  const playing = !disabled && (live ? !settled : cursorPlaying);

  const incidents = useMemo(() => {
    const st = store.getState();
    return st.stateAt(lastSequence).exec.incidents.map((i) => ({ ...i, tMs: st.timeOfSeq(i.seq) }));
  }, [store, lastSequence]);

  const pct = (ms: number) => `${end > 0 ? Math.min(100, (ms / end) * 100) : 0}%`;

  return (
    <div className={styles.bar} role="group" aria-label="Playback" data-glass={glass || undefined}>
      <div className={styles.transport}>
        <Button variant="ghost" size="sm" iconOnly icon="skipBack" onClick={s.stepPrev} disabled={disabled} aria-label="Previous event" title="Previous event (←)" />
        <button
          type="button"
          className={styles.play}
          onClick={s.togglePlay}
          disabled={disabled}
          aria-label={playing ? 'Pause' : 'Play'}
          title={`${playing ? 'Pause' : 'Play'} (Space)`}
        >
          <Icon name={playing ? 'pause' : 'play'} size={14} />
        </button>
        <Button variant="ghost" size="sm" iconOnly icon="skipForward" onClick={s.stepNext} disabled={disabled} aria-label="Next event" title="Next event (→)" />
      </div>

      <span className={styles.clock} aria-hidden="true">
        {formatClockPair(t, end)}
      </span>

      <div className={styles.scrubber}>
        <input
          type="range"
          className={styles.range}
          min={0}
          // Rounded up to a whole step so the last event is reachable (seek clamps to the real end).
          max={Math.max(100, Math.ceil(end / 100) * 100)}
          step={100}
          value={Math.round(t)}
          disabled={disabled}
          onChange={(e) => s.seek(Number(e.target.value))}
          aria-label="Playhead time"
          aria-valuetext={`${formatClockPair(t, end)}, event ${playheadSeq} of ${lastSequence}`}
          style={{ '--pct': pct(t) } as CSSProperties}
        />
        <div className={styles.markers}>
          {incidents.map((i) => (
            <button
              key={i.eventId}
              type="button"
              className={styles.marker}
              data-resolved={i.resolvedSeq !== null && i.resolvedSeq <= playheadSeq ? 'true' : undefined}
              style={{ left: pct(i.tMs) }}
              onClick={() => s.selectEvent(i.seq, { seek: true })}
              aria-label={`Failure at ${formatClock(i.tMs)}: ${i.message}`}
              title={`${formatClock(i.tMs)} · ${i.message}`}
            >
              <Icon name="alert" size={10} />
            </button>
          ))}
        </div>
      </div>

      <div className={styles.speeds} role="group" aria-label="Replay speed">
        {SPEEDS.map((v) => (
          <button key={v} type="button" className={styles.speed} aria-pressed={speed === v} onClick={() => s.setSpeed(v)}>
            {v}×
          </button>
        ))}
      </div>

      <div className={styles.live}>
        {!live && newSinceReplay > 0 && (
          <button type="button" className={styles.newChip} onClick={s.goLive}>
            {newSinceReplay} new
          </button>
        )}
        <button
          type="button"
          className={styles.liveBtn}
          aria-pressed={live}
          onClick={s.goLive}
          disabled={runId === null}
          title="Follow the latest event (L)"
        >
          <span className={styles.liveDot} data-on={live && !ended && !disabled && !followLabel ? 'true' : undefined} aria-hidden="true" />
          {live ? (ended ? 'Latest' : (followLabel ?? 'Live')) : 'Go live'}
        </button>
      </div>
    </div>
  );
}
