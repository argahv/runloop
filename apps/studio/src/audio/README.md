# `audio/`: the town's soundscape

Plan of record: the immersive experience contract §4b (2026-10-18). Everything is
synthesized with the Web Audio API. There are no audio files, no samples, no new dependencies, and no licences.
The sound is calm by default and follows the camera. Event sounds play **only for real agent events**, so sound
obeys the same truth rule as motion.

## API (`index.ts`)

```ts
import { attachWorldAudio, getAudio, SoundSettings, SoundToggle, useAudioSettings, classifyCue } from '../audio';

getAudio(): RunloopAudio            // the page's engine; an SSR-safe no-op on the server / without Web Audio
  .state                            // 'locked' (before the first gesture) | 'running' | 'suspended' | 'unsupported'
  .unlock()                         // from a user gesture; idempotent (the page's first pointer/key gesture calls it)
  .ui(sound)                        // 'hover' | 'select' | 'open' | 'close' | 'menu' | 'confirm' | 'error' | 'toggle'
  .whoosh(durationMs, pan?)         // a camera fly (not for cuts; never under reduced motion)
  .cue(cue, { agentId?, pan? })     // 'agentLive' | 'incident' | 'taskDone' | 'needsApproval'; false = not played
  .setListener(l)                   // the town's TownListener (~4 Hz); the bed follows it
  .setReducedMotion(v)
  .getSettings() / .update(p) / .subscribe(fn)
attachWorldAudio(store): () => void // world store → cues for live real agent events (call once on `/`)
classifyCue(event, prevAgentState)  // pure: which event earns which cue
useAudioSettings(): [settings, update]
<SoundToggle compact? />            // the HUD speaker toggle (icon + aria-pressed + "Sound on/off")
<SoundSettings />                   // the Esc menu's Sound tab: on/off, master/ambient/UI/events, reduce sound
```

### Wiring on `/` (HUD owns these files)

| Where | Call |
|---|---|
| `components/world/hud/sound.ts` | `export function uiSound(name: UiSound) { getAudio().ui(name); }` (and `export type { UiSound } from '../../../audio'`) |
| `WorldHome.tsx` | `useEffect(() => attachWorldAudio(store), [store]);` |
| `WorldHome.tsx` → `TownStage` | `onFly={(ms, pan) => getAudio().whoosh(ms, pan)}` and `onListener={(l) => getAudio().setListener(l)}` |
| `WorldHome.tsx` → `WorldHud` | `sound={<SoundToggle compact />}` (clock widget and phone bar) and `soundSettings={<SoundSettings />}` (Esc menu) |

Nothing else is needed. The first pointer or key gesture on the page unlocks sound, the tab's visibility suspends it,
and `attachWorldAudio` also passes the store's reduced-motion flag and the agent buildings and lots, which are never a murmur
source. With WebGL off (WorldMap) there is no listener: the bed stays silent and the UI sounds and cues still play.

## Truth rule (P10 for sound)

- `classifyCue` returns a cue only for `agent.*` events. It never returns one for `prov: 'simulation'`, and never for
  residents, interactions, buildings, the clock or commands. This is tested over every `WORLD_EVENT_TYPES` entry and a recorded engine day.
- `attachWorldAudio` cues only **live** events. Nothing from the snapshot, the backfill after a reconnect, or the
  3 s after any resync or return to `live` makes a sound, and a disabled world never cues. It keeps its own agent state
  (health, attention, open incidents), seeded from the snapshot, so a cue means "this just changed".
- Every cue repeats a notification with icon and text. A sound never stands alone.
- The ambient murmur follows **simulated** occupancy (café, fountain, diner, tavern, bakery, squares). It is
  decorative ambience and never comes from an agent building. Settings and the README say so.

| Event (vs the agent's previous state) | Cue | Sound |
|---|---|---|
| `agent.connection_changed`: health becomes `live` | agentLive | sine C5 + G5, 900 ms release, reverb |
| attention becomes `permission_requested` / `dispatch_awaiting_approval` | needsApproval | two FM bell knocks, 220 ms apart |
| attention becomes `incident`; `agent.activity_observed` open incidents rise | incident | low thump, then soft G4 → E4 |
| `agent.dispatch_changed` finished `completed` / failed, timed out, over budget, lost | taskDone / incident | C5 E5 G5 C6 arpeggio |
| `agent.session_changed` ended `succeeded` / `failed` | taskDone / incident | |

Priority within one event: needsApproval > incident > taskDone > agentLive. The pacing is done by `CueLimiter`, which is pure
and has an injected clock:
- **Spacing and queue:** at least 1.2 s between cues; a queue of at most 2, strongest first; a queued cue expires after 4 s.
- **Rate:** at most 6 cues per minute.
- **Per agent and cue:** a cooldown of 60 s for agentLive, 30 s for needsApproval, 20 s for taskDone and 15 s for incident.
- **Silence:** nothing plays while the tab is hidden (and nothing is kept for later), nor for 3 s after a resync.

## Graph and synthesis

```
ambient layers → outdoor (−9 dB inside) → outdoorLp (700 Hz inside) → ambient ┐
birds → outdoor; birds → birdsSend (0.25) → reverb                             │
UI voices → ui → uiSend (0.1) → reverb                                          ├→ master (−1 dB headroom) → compressor (−18 dB, 3:1) → out
cue voices → events → eventsSend (0.2) → reverb (generated 1.6 s impulse) ─────┘
```

- **Bed** (`ambient.ts`). Each layer is set by the mix rules in `mix.ts` from the listener (zoom01, night, paused, interior, sources):
  - breeze: band-passed pink noise, swept slowly;
  - high wind: gusts;
  - birds by day: one-oscillator chirp calls, at a Poisson rate set by greenery and zoom;
  - crickets by night: 18 ms pulse trains;
  - murmur: two speech bands gated into syllables, panned to its source;
  - water: grains and a rumble;
  - distant traffic: brown noise under 140 Hz, plus an occasional pass-by by day;
  - room tone inside a building.

  A paused world fades out its murmur, traffic, birds and crickets in about 1.5 s and keeps half the breeze. A 250 ms timer schedules 0.6 s
  ahead on the audio clock. There are 40 persistent nodes in all, at most 12 one-shot voices (the oldest UI voice is stolen), and no
  ScriptProcessor or AudioWorklet.
- **Lifecycle** (`engine.ts`):
  - No AudioContext exists before the first gesture, and none is created while sound is off. The bed fades in over 2 s.
  - Hidden tab: the master goes to 0 in 150 ms, the context suspends at 300 ms, and when the tab shows again it resumes and fades in over 600 ms.
  - With no town on screen for 5 s, the context idles until the next sound.
- **Reduce sound** turns off the ambient bed and the hover ticks, lowers the UI by 6 dB, and keeps only the needsApproval, incident and taskDone cues. Reduced motion turns off the whoosh.
- **Settings** are stored in localStorage `runloop.audio.v1` (try/catch, clamped) and sync across tabs. Defaults: on, master 0.6, ambient 0.5, UI 0.4, events 0.7.
  Sliders use a squared taper (half = −12 dB).

Measured output at the default settings (offline render, headless Chromium; see below):

| Sound | Level |
|---|---|
| Bed (RMS) | about −36 to −38 dBFS by day outdoors, −41 at night, −46 inside a building, −45 paused |
| UI clicks (peak) | −27 to −37 dBFS; the hover tick is −40 |
| Cues (peak) | −19 to −22 dBFS |
| Full volume | no single sound passes −5 dBFS; the busiest moment the pacing allows peaks at −2.2 dBFS |

Nobody has listened to these sounds yet: every check is a measurement, and the levels are conservative.

## Debug hook

`window.__runloopAudio` is a read-only getter, available in dev and prod. It reports:
- `state`, `created`, `gestureSeen`, `hidden`, `idle`;
- `settings`;
- `listener`: freshness, level, zoom01, night, paused;
- `layers`: each layer's smoothed level, with `interior` and `passing`;
- `active`: the layers audible now;
- `buses`: the current gains;
- `voices`, `persistentNodes`, `cuesWaiting`;
- `lastCues`: each cue with its agent and its result (`play`, `queued`, `cooldown`, `rate`, `suppressed`, `hidden`, `off`, `reduced`);
- `lastUi`.

## Verification

```
pnpm vitest run --project studio src/audio
node apps/studio/src/audio/check/render-check.mjs           # headless Chromium; exit 1 on failure
node apps/studio/src/audio/check/render-check.mjs --serve   # the sound board on :3074 (listen; ?ui=1 shows the toggle and settings)
```

- **Unit tests:**
  - `cues.test.ts`: the S2 table over every event type and a recorded day, the four cues, and S3 limiter pacing, cooldowns, suppression and hidden;
  - `mix.test.ts`: the mix rules;
  - `settings.test.ts`: persistence and clamping;
  - `engine.test.ts`: S1 lifecycle with a fake AudioContext, voices, hidden and mute, reduce, the bed and idling, the page hooks;
  - `world.test.ts`: live-only cues, resyncs, reconnects and the real limiter.
- **Browser check** (`check/`): run live with the real autoplay policy, it checks for no context before a gesture, then a click
  starts sound, the bed follows the listener, and a hidden tab suspends it. Rendered offline (OfflineAudioContext), it
  checks that every sound is non-silent and peaks under 0.9 at default and full volume, that the bed RMS stays within bounds,
  that the busiest moment does not clip (worst of 5 seeds), and that master, ambient, UI, events, mute and reduce each
  change the output. `?layers=1` on the sound board renders each layer of each scene alone, for tuning the trims.
