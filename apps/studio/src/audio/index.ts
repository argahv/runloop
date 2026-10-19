/**
 * Runloop's soundscape (contract §4b), synthesized with the Web Audio API:
 * no audio files, no dependencies. See README.md.
 *
 *   getAudio()                 the page's engine (SSR-safe no-op on the server)
 *   attachWorldAudio(store)    real agent events → cues (once, on `/`)
 *   classifyCue(event, prev)   pure: which event earns which cue (never simulated activity)
 *   useAudioSettings()         [settings, update]
 *   <SoundToggle />            the HUD speaker toggle
 *   <SoundSettings />          the Esc menu's Sound tab
 */
export type { AgentAudioState, AudioListener, AudioSettings, AudioSourceKind, AudioState, EventCue, RunloopAudio, UiSound } from './types';
export { EVENT_CUES, UI_SOUNDS } from './types';
export { getAudio } from './engine';
export { attachWorldAudio } from './world';
export { classifyCue } from './cues';
export { AUDIO_SETTINGS_KEY, DEFAULT_AUDIO_SETTINGS } from './settings';
export { SoundSettings, SoundToggle, useAudioSettings, useAudioState } from './react';
