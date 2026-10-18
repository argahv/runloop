'use client';
/**
 * Sound in the HUD: the speaker toggle (clock widget) and the Sound tab of
 * the Esc menu. Both read the engine's settings with useSyncExternalStore
 * (the server renders the defaults, so hydration matches).
 */
import { useId, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react';
import { Button } from '../ui/Button';
import { SegmentedControl } from '../ui/SegmentedControl';
import styles from './audio.module.css';
import { getAudio, getAudioEngine } from './engine';
import { DEFAULT_AUDIO_SETTINGS } from './settings';
import type { AudioSettings, AudioState } from './types';

const serverSettings = () => DEFAULT_AUDIO_SETTINGS;
const serverState = (): AudioState => 'unsupported';

export function useAudioSettings(): [AudioSettings, (p: Partial<AudioSettings>) => void] {
  const audio = getAudio();
  const settings = useSyncExternalStore(audio.subscribe, audio.getSettings, serverSettings);
  return [settings, audio.update];
}

export function useAudioState(): AudioState {
  const audio = getAudio();
  return useSyncExternalStore(
    audio.subscribe,
    () => audio.state,
    serverState,
  );
}

function SpeakerIcon({ on }: { on: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 9.5h3.2L12 5.5v13l-4.8-4H4z" fill="currentColor" fillOpacity="0.18" />
      {on ? (
        <>
          <path d="M15.5 9.2a4 4 0 0 1 0 5.6" />
          <path d="M18.2 6.6a7.6 7.6 0 0 1 0 10.8" />
        </>
      ) : (
        <>
          <path d="M16 9.5l5 5" />
          <path d="M21 9.5l-5 5" />
        </>
      )}
    </svg>
  );
}

function toggleTitle(on: boolean, state: AudioState): string {
  if (state === 'unsupported') return 'Sound is not available in this browser';
  if (!on) return 'Sound off. Click to turn it on.';
  if (state === 'locked') return 'Sound on: it starts with your first click or key press. Click to mute.';
  return 'Sound on. Click to mute.';
}

/** The HUD speaker toggle: icon + aria-pressed; the visible text says on or off (not by colour alone). */
export function SoundToggle({ compact = false }: { compact?: boolean }) {
  const [settings, update] = useAudioSettings();
  const state = useAudioState();
  const on = settings.enabled;
  const unsupported = state === 'unsupported';
  return (
    <button
      type="button"
      className={styles.toggle}
      data-compact={compact || undefined}
      data-audio-toggle=""
      aria-pressed={on}
      aria-label="Sound"
      title={toggleTitle(on, state)}
      disabled={unsupported}
      onClick={() => {
        const audio = getAudio();
        update({ enabled: !on });
        // This click is the gesture that may start sound.
        audio.unlock();
        if (!on) audio.ui('toggle');
      }}
    >
      <SpeakerIcon on={on && !unsupported} />
      {!compact && <span aria-hidden="true">{on ? 'Sound on' : 'Sound off'}</span>}
    </button>
  );
}

function Slider({ label, help, value, disabled, onChange, extra }: { label: string; help?: string; value: number; disabled?: boolean; onChange: (v: number) => void; extra?: ReactNode }) {
  const id = useId();
  const pct = Math.round(value * 100);
  return (
    <div className={styles.row}>
      <div>
        <label htmlFor={id} className={styles.label}>
          {label}
        </label>
        {help && <p className={styles.hint}>{help}</p>}
      </div>
      <div className={styles.sliderControl}>
        <input
          id={id}
          type="range"
          min={0}
          max={100}
          step={5}
          value={pct}
          disabled={disabled}
          aria-valuetext={pct === 0 ? 'Off' : `${pct}%`}
          className={styles.range}
          style={{ '--fill': `${pct}%` } as CSSProperties}
          onChange={(e) => onChange(Number(e.currentTarget.value) / 100)}
        />
        <output htmlFor={id} className={styles.value}>
          {pct === 0 ? 'Off' : `${pct}%`}
        </output>
        {extra ?? <span aria-hidden="true" />}
      </div>
    </div>
  );
}

function stateLine(state: AudioState, on: boolean): string {
  if (state === 'unsupported') return 'Sound is not available in this browser (no Web Audio).';
  if (!on) return 'Sound is off.';
  if (state === 'locked') return 'Sound starts with your first click or key press in the world.';
  if (state === 'suspended') return 'Sound is paused (hidden tab, or nothing to hear right now).';
  return 'Sound is playing.';
}

/** The Esc menu's Sound tab: on/off, master / ambient / UI / events volumes, reduce sound. Saved per viewer. */
export function SoundSettings() {
  const [s, update] = useAudioSettings();
  const state = useAudioState();
  const unsupported = state === 'unsupported';
  const preview = (what: 'ui' | 'events') => getAudioEngine()?.preview(what);
  return (
    <div className={styles.settings}>
      <p className={styles.status} role="status">
        {stateLine(state, s.enabled)}
      </p>
      <div className={styles.row}>
        <div>
          <p className={styles.label}>Sound</p>
          <p className={styles.hint}>Also the speaker button next to the clock.</p>
        </div>
        <div className={styles.control}>
          <SegmentedControl
            label="Sound"
            size="sm"
            options={[
              { value: 'on', label: 'On' },
              { value: 'off', label: 'Off' },
            ]}
            value={s.enabled ? 'on' : 'off'}
            onChange={(v) => {
              update({ enabled: v === 'on' });
              getAudio().unlock();
            }}
          />
        </div>
      </div>
      <Slider label="Master volume" value={s.master} disabled={unsupported} onChange={(v) => update({ master: v })} />
      <Slider
        label="Ambient"
        help={s.reduce ? 'Off while Reduce sound is on.' : 'The town around the camera: breeze, birds or crickets, voices near busy places, water, distant traffic.'}
        value={s.ambient}
        disabled={unsupported}
        onChange={(v) => update({ ambient: v })}
      />
      <Slider
        label="Interface"
        help="Soft clicks for buttons, cards, the menu and camera moves."
        value={s.ui}
        disabled={unsupported}
        onChange={(v) => update({ ui: v })}
        extra={
          <Button size="sm" variant="ghost" disabled={unsupported || !s.enabled} onClick={() => preview('ui')}>
            Preview
          </Button>
        }
      />
      <Slider
        label="Agent events"
        help="Real agents only: goes live, needs approval, incident, task done. Simulated residents never make an event sound."
        value={s.events}
        disabled={unsupported}
        onChange={(v) => update({ events: v })}
        extra={
          <Button size="sm" variant="ghost" disabled={unsupported || !s.enabled} onClick={() => preview('events')}>
            Preview
          </Button>
        }
      />
      <div className={styles.row}>
        <div>
          <p className={styles.label}>Reduce sound</p>
          <p className={styles.hint}>No ambient bed or hover ticks, quieter interface, and only the needs-approval, incident and task-done cues.</p>
        </div>
        <div className={styles.control}>
          <SegmentedControl
            label="Reduce sound"
            size="sm"
            options={[
              { value: 'off', label: 'Off' },
              { value: 'on', label: 'On' },
            ]}
            value={s.reduce ? 'on' : 'off'}
            onChange={(v) => update({ reduce: v === 'on' })}
          />
        </div>
      </div>
      <p className={styles.note}>
        Every event sound repeats a notification you can read: a sound never stands alone. Sounds are made in your browser (no audio files),
        pause while this tab is hidden, and these settings are saved in this browser only.
      </p>
    </div>
  );
}
