# Style guide: A World That Keeps Running

There is no reference footage. This guide comes from the founder brief (2026-10-18), the founder's
decisions (lime for real agents, 30 fps, no voice-over), the Runloop Signature design system and the
product's own 3-D town (`apps/studio/src/town`: its sky, glow and HQ rules). Every value below is buildable:
colours from `assets/brand.json`, timing from `beats.json` (96 BPM, a bar is 2.5 s = 75 frames, a beat is
0.625 s = 18.75 frames at 30 fps).

## The three layers (the rule everything else follows)

| Layer | What it is | Colour it may use | Data it comes from |
|---|---|---|---|
| **A · The world** | The 3-D Runloop Commons: land, buildings, lamps, simulated residents | Night palette, amber windows and lamps, moonlight. **Never lime.** | `data/town.json`, `data/residents.json` (the real engine, seed 42 until the capture world's seed replaces it) |
| **B · The event** | What a real Claude Code session reported: the HQ going live, tool calls lighting rooms, the failure, the replay path, the session timelines | **Lime #B8F36A** for reported activity; failure #FF6B76 for the recorded failure; warning #F5B84B for the recorded permission wait; Ice for the replay playhead; inferred events hatched | `data/session-events.json` (recorded events through the runtime's ingest and reducers) |
| **C · The product** | Real captures of the running Studio | The capture's own pixels, never re-coloured, re-drawn or graded | `assets/captures/` (to be captured; see the shot list) |

Rules:
- **Simulated and real never share a colour.** Amber means a resident (or the clock) did it; lime means Claude Code reported it. A frame that contains both keeps them apart in space (residents outside on the Foundry Yard benches, the session inside the HQ).
- **B is only ever drawn from a recorded event.** No event, no light. Spacing is the recorded spacing (A4 plays the session at recorded speed); the only change allowed is snapping a sound to the nearest 16th note (at most 78 ms).
- **C is at most 2 bars at a time and is always bracketed** by an A or B shot of the same entity (the resident before their card, the HQ before its card, the Test Chamber before the trace row, the Lattice Lab after the compare sheet).
- **Layer changes are motivated by a shape, not a flash:** A→B by light appearing in the world; B→C by a push through the HQ's glass or a thin line ending where the captured UI element sits; C→A/B by the capture shrinking back into the building or sheet position it belongs to.

## Rhythm

- 96 BPM, 4/4; every cut on a downbeat (frame 75·k). 25 shots in 75 s: median shot 1 bar (2.5 s) in A3–A5, 2–3 bars in A1, A2 bars 6–7 and A6. Something new every bar (2.5 s); the longest unchanging stretch is the 3-bar end card.
- Holds: A1 bar 0 (the first lamp pool) breathes for a full bar; the failure (A4 bar 14) holds 1 beat before the camera moves; the end card holds 3 bars.
- Accents inside shots sit on beats or 16ths: lamp reveals on 8ths in A1, recorded events on their own recorded times in A4 (the failure falls on bar 14's downbeat by construction: A4 offset 29.33 s).

## Motion vocabulary

- **Camera (one rig per shot, named in the shot list):**
  - *Orbit*: ≤ 6°/s around a named target, constant rate, eased in/out over half a bar (`E.inOutSine`).
  - *Crane*: vertical moves over 1–2 bars, `SPRING.gentle` (stiffness 120, damping 20) on the target, never overshooting below ground.
  - *Push / pull*: distance in log space (`d = a·(b/a)^p`), so it reads as a constant-rate dolly; macro pushes ×1.3–1.6 per bar.
  - *Follow*: 3 cells behind and 1.6 up a walking resident, 32° vertical FOV, target spring `SPRING.gentle`, the resident's own lane offset (Studio `laneOffset`).
  - *Establishing*: orthographic at the product's own view (azimuth 45°, tilt 37°), or perspective with the product's narrow lens (20–28° vertical), which keeps the miniature, isometric read.
  - No handheld shake, no whip pans, no roll. The only fast move is the push through the HQ's glass (bar 11, 1 bar, log space).
- **Entrances:** lights do the entering. Lamp pools bloom over 6 frames; windows warm over 9 frames (the product's emphasis duration, 320 ms ≈ 10 frames); the HQ's paint arrives as a wipe up the façade over half a beat; titles rise per word through a mask, 4-frame stagger, `cubic-bezier(0.2,0.8,0.2,1)` (the product's `--rl-ease-out`).
- **Exits:** light leaves the way it came (fade on the same curve, reversed); titles drop out through the same mask; C captures shrink back into their building (scale and position springs, `SPRING.snappy`).
- **Event pulses (B):** one ring per event, from the station outward, 0.42 → 1.6 cells radius in 0.6 s, opacity 0.9 → 0, lime; never repeating, never ambient. A station stays lit while its call runs (start → end event).
- **The failure:** a *focused disturbance*, not an explosion: the Test Rig's light turns failure red on the event frame, one ring, the Test Chamber's floor dims in a 2-cell ripple over 0.5 s, the rest of the HQ and the town are untouched. The camera answers with a 1.3× macro push one beat later.
- **The rewind:** the lime path retracts along the robot's recorded walks, events un-light in reverse order, an Ice playhead line sweeps them; the town outside keeps moving forward at 1×.
- **Residents:** the engine's positions only (closed-form walks at 3 cells per sim minute). Body motion follows the Studio's rig (walk, idle, sit, talk). No resident is ever posed, added or moved for a shot.
- **Signature move:** *the light knows why.* Every light that changes in the film changes because the simulation or the recorded session changed it (a resident arrives and a window warms; the first prompt arrives and the HQ is painted; exit 1 and the Test Rig turns red). The camera finds the light; the light is never decoration.

## Composition

- The town is a **midnight diorama**: framed so the Commons reads as a lit island on dark land, the haze taking the horizon; ground fills 60–75% of the frame in establishing shots.
- Subject on thirds; the HQ always slightly above centre when it is the subject, so its beacon has sky above it.
- Scale contrast in every act: one macro (a single lamp pool, a single resident, the Test Rig) against one wide (Market Street, the Agent District, the whole Commons).
- C captures are shown **full-bleed** (1920×1080, the capture's own framing) or pushed into a crop of one card; never inside device frames, never with drop shadows or glow. Crops keep the product's own margins (a card plus 24 px of the world around it).
- Type sits left-aligned on the safe area (96 px sides, 60 px top/bottom at 1080p), never centred on a gradient.

## Colour + texture

- **Night grade:** the product's own night sky (`brand.json town.nightSky`: zenith #0A1226, horizon #1D2944, haze #1A233B) with `film.void` #05070F at the frame's edges and in A1's darkness. The sky comes from `town.json sky` (the Studio's `skyAt`) at each shot's sim time; the film may darken exposure, never change hue.
- **Exposure, not hue:** the product's night is lighter and more lavender than the brief's midnight (A3 at 21:31 in the probe), and its 05:5x pre-dawn already has a mauve horizon. The film pulls exposure (−1 EV at night, −1.5 EV in A1) and frames A1 without a horizon; it never repaints the product's sky or materials.
- **Amber:** lit windows #FFD18A (only in occupied buildings, by `residents.json occupancy`), lamps #FFD89A (on from the night factor, smoothstep 0.3–0.7, as the product), shop signs #FFF1D6 when open. Bloom only on these emissive elements: strength 0.25–0.4, threshold 0.85–0.9.
- **Lime:** only B (above). The HQ's beacon is lime only while the session is live and reported working, as in the product (`status.ts`).
- **Haze:** exponential fog in #1A233B starting past the town's far edge (as the product: haze never reaches the town), densest at the horizon; under each lit lamp a soft light cone (additive sprite, 4–6% opacity) so the lamp pools read as volumetric. No floating particles, no dust motes, no lens flares.
- **Materials:** the product's flat-shaded, warm low-poly town (cream and peach walls, terracotta and teal roofs) seen at night; matte, no reflections except the pond and the HQ's glass.
- **Grain:** a fine luminance grain (σ 1.5%, per frame, seeded) in `post()` over A and B only; none over C.

## Type in motion

- **Display (Geist 500–600, `fonts/display.ttf`):** two titles only, both the brand's words: "A world, not a dashboard." (A1) and "A world for AI agents." (end card). 88–112 px at 1080p, tracking −0.02em, Ice #E8EBF0. Per-word mask rise, 4-frame stagger.
- **Data (Geist Mono, `fonts/ui.ttf`):** short captions with real recorded values (e.g. `Bash node --test · exit 1 · 10/12 passed · 374 ms`, `Replay · recorded state`, `Day 2 · 21:40 · Simulated time ×1`), 24–28 px, Ice at 85%, tabular numerals. A caption appears on a beat, holds at least 1 bar, and points at what it describes with a 1.5 px line.
- **Glyphs:** neither face has ◇, ✓ or ⏸: draw the Simulated diamond, check marks and pause bars as shapes.
- Nothing smaller than 22 px at 1080p (phone legibility).

## Do / don't

**Do**
1. Light a window only when `residents.json` says someone is inside; light the HQ only from a recorded event.
2. Keep the town moving forward at all times (1× from A3 on), including during the rewind.
3. Cut on downbeats and carry a shape across every layer change (the HQ glass becomes the capture's frame).

**Don't**
1. Use lime, cyan or any glow on the town, the residents or the UI chrome; use colour alone to mean state.
2. Invent screens, metrics or events: no fake trace rows, no token or cost numbers the session did not report, no agent walking into the town.
3. Use template moves: centred title on a gradient, everything fading in, corner labels, frame borders, particle bursts, a spinning logo.
