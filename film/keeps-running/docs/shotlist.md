# A World That Keeps Running: shot list

75 s · 96 bpm · 120 beats (30 bars) · 30 fps (2,250 frames) · formats: 16x9 (primary, 1920×1080)
Music: `audio/score.py` (bespoke, D, synthesized) → `audio/music.wav`, `beats.json` · VO: none
Also: a 30 s teaser (12 bars) and a 10 s seamless loop (4 bars) on the same grid (below).

Grid: beat = 0.625 s = 18.75 frames; bar = 2.5 s = **75 frames**; every cut is on a downbeat (frame 75·k).
Measured grid: 96.0 bpm, offset 0.5 ms, 119/121 inliers, fit rms 0.8 ms (`beats.json`).

Layers: **A** the world (3-D town, amber, never lime) · **B** the event (recorded session, lime) · **C** the product (real capture).
Data: `T` = `data/town.json`, `R` = `data/residents.json` (engine, seed 42), `S` = `data/session-events.json`
(primary `s1-basic`, secondary `s2-subagents`: placeholders until the live capture). Resident names are
seed 42's; after the capture they are re-picked from the re-export with the capture world's seed.

| # | bars (beats) | time · frames | L | shot | on screen (asset / data) | motion | out (transition) | sound (hits) |
|---|---|---|---|---|---|---|---|---|
| **A1** | | **The world wakes up** | | | Day 2 · 05:54 → 06:01 at 1× | | | near silence |
| 1 | 0 (0–4) | 0.00–2.50 · 0–74 | A | First light | Frame 0 is already a picture: one lamp pool (T decoration `lamp` nearest the Commons Fountain) on the Civic Atrium's paving, haze, everything else void #05070F. Title "A world, not a dashboard." rises per word from beat 2 (Geist 600, 104 px, left third). | macro, perspective 40°, 2.2 cells above the paving looking **down 40° (no horizon until shot 4:** the product's sky at 05:54 is already pre-dawn mauve at the horizon), exposure −1.5 EV (grade only, hue untouched); crane down 0.4 cells, drift 2° | the title holds; the dark widens into shot 2 (same camera, continuous) | sub drone, air; lamp bell b1.5 |
| 2 | 1 (4–8) | 2.50–5.00 · 75–149 | A | The land emerges | The 24 town lamps' pools appear one by one outward from the Atrium along Market Street and Commons Avenue (T decoration lamps sorted by distance), home windows already warm (R occupancy > 0: residents asleep). Title exits on beat 7.5. | crane up and pull back in log space ×4, kept looking down (tilt 48° → 42°), exposure −1.5 → −0.8 EV | the camera settles behind a walker: shot 3 | lamp bells on 8ths (b4, 5, 5.5, 6.25, 7) |
| 3 | 2 (8–12) | 5.00–7.50 · 150–224 | A | Routines begin | Oren Dorsey (res_0004, baker) on his schedule walk Commons Walk benches → Sunrise Bakery (R: departed 05:44, 51 cells). He reaches the door at 06:00:40; at tick 06:01 the bakery's occupancy goes 0 → 1 and its windows warm (beat 11, frame 206). | follow rig, 3 cells behind, 32° | match cut on the bakery's warm window → shot 4's dawn | theme on keys b8–11; first heartbeat b10; window warm b11 |
| **A2** | | **Life inside the town** | | | 06:01 → 06:41 at 16×; 07:42 at 1×; 07:45 → 21:30 time-lapse | | | the pulse starts |
| 4 | 3 (12–16) | 7.50–10.00 · 225–299 | A | Dawn | Market Street and Hearth Row from district height: the sky from pre-dawn to sunrise (T sky 06:00 → 06:40, night 0.67 → 0.32), lamps fading by the clock; early walkers (gardeners to Lattice Greenhouse, lit at 06:11; barista Ada Calder to the Corner Café, lit at 06:28 ≈ frame 275). | orbit 6°/s around the Civic Atrium, perspective 24°; the sim runs at **16×** (the product's fastest speed) | cut on the downbeat to street level | kick on 1 & 3; clock ticks on 8ths; walking arpeggio |
| 5 | 4 (16–20) | 10.00–12.50 · 300–374 | A | Follow | Kai Silva (res_0031, engineer) steps out of Larkspur House at 07:42 for Northwind Studio (R: 72 cells, reason schedule), along Hearth Lane among the morning commute (R: 17–25 walking at 07:40–08:00). Film caption, Geist Mono 24 px: ◇(drawn) `Kai Silva · engineer · simulated`. | follow rig at **1×**, 32°, 3 cells behind, 1.6 up | hard cut on the downbeat, matched: his screen position = the followed resident's position in C2 | arpeggio; ticks |
| 6 | 5 (20–24) | 12.50–15.00 · 375–449 | C | The town interface, a resident's Why | **C1 → C2** (one clip): the town with its HUD (clock "Day 2 · 07:4x", ×1, minimap, hotbar), then the followed resident's anchored card: Simulated, Now, **Why** (factors linked to their decision event, "Simulated resident · rule-based decision"), needs. | capture clip as recorded; 4% push in log space toward Why over the bar | cut on the downbeat: the card's resident becomes the 3-D resident again (shot 7 starts on the same street) | theme returns (keys b20–22) |
| 7 | 6–7 (24–32) | 15.00–20.00 · 450–599 | A | A day in the Commons | Hearth Flats West in cutaway (roof lifted, camera-facing walls cut low, as the product opens a building): residents at their furniture slots (R slot positions), while the day time-lapses 07:45 → 21:30 (the Commons Clock's hands and the sky, T sky): shadows sweep, the lunch crowd at the café patio (12:00), evening socialising; **the lamps come on together by the clock at ~18:59 (frame ≈ 572)**; windows follow R occupancy. | orbit Hearth Row 6°/s, then crane up over bar 7 to district height facing east (the Agent District) | continuous: the crane carries over Commons Avenue into shot 8 | ticks double to 16ths, 32nds; filter opens; riser over bars 6–7 |
| **A3** | | **A real agent arrives** | | | 21:30 → 21:40 at 1× (from here the film's clock is 1×: "Simulated time ×1. Real agents run at real speed.") | | | drums out, then the swell |
| 8 | 8 (32–36) | 20.00–22.50 · 600–674 | A | The Agent District | Six agent lots on Foundry Road (T agentLots): five bare and free; on **lot_agent_5** the HQ stands as an **unpainted model, waiting for its first event** (T agentHq.states.awaiting_first_event: shell #D4D8DE, glass #B9C0CA, beacon at half opacity, 8-sided). Behind it, on Foundry Yard benches, six residents talk under the lamps (R at 21:40: 6 at Foundry Yard benches; 12 at the fountain rim). Nothing decorative moves within 12 cells of the lots. | glide east above Foundry Road at district height, perspective 24°, target lot 5 | the push begins: shot 9 (continuous) | dusk pad; sub drone; the clock ticks |
| 9 | 9 (36–40) | 22.50–25.00 · 675–749 | A | The focus | The unpainted HQ fills the centre third, the Foundry Yard's amber life behind it. | push in log space ×1.6, slight arc 8° to face the glass front (north façade) | continuous into shot 10 | heartbeat kicks b36–39; riser; whoosh into b40 |
| 10 | 10 (40–44) | 25.00–27.50 · 750–824 | B | It goes live | **On the downbeat: the session's first recorded event** (S primary seq 1–7 at tMs 0: run started, the prompt; hq `live`, `working`). The paint wipes up the façade (shell #5D636E/#727986, identity band id1 #5AA9F5), the glass warms (#FFD18A × night), the beacon becomes the **lime** ring and gives one restrained pulse (0.42 → 1.6 cells, 0.6 s); the robot at the door turns to working. Caption: `Real · Claude Code · observed` (the product's label, Geist Mono). | the push continues to the glass, 22° | push-through: the central glass pane's rectangle grows to the frame | **go-live**: sub drop + the lime bell motif (b40) |
| 11 | 11 (44–48) | 27.50–30.00 · 825–899 | B→C | Through the glass | The camera passes through the pane; by beat 46 the pane is the frame and **C3** fills it: the agent's card in the Studio: Real · Claude Code · observed, **Live · working**, what the session is doing by kind of tool, last event n s ago. | log push ×3 through the pane over 2 beats, then the capture holds with a 3% drift | cut on the downbeat back out: the capture shrinks into the HQ as its roof lifts (shot 12) | whoosh b42.5–44; pulse continues |
| **A4** | | **Every session leaves a trail** | | | 21:40 → 21:52:30 at 1×; the session at its **recorded speed** (film t = tMs/1000 + 29.33 s) | | | the rhythmic lift |
| 12 | 12 (48–52) | 30.00–32.50 · 900–974 | B | Inside the HQ | The roof lifts as the product's fly-in does; the HQ interior is the research-campus diorama at 0.5 scale: Atrium, Observatory, Workshop, Test Chamber, Launch Bay (S rooms). Recorded events (S primary): 31.57 s `Bash node --test` (test) → the Test Rig lights lime; 31.68 permission requested → the robot routes to the **Approval Gate** in the Atrium, the gate warm in warning #F5B84B; 31.87 / 32.13 two Reads while it waits there (the engine keeps it at the gate: S rooms say Atrium); 32.24 `NOTES.md` read error → a small failure tick (incident 1). | high cutaway, perspective 26°, slow orbit 4°/s | continuous into shot 13 | kick/rim/hats; each event a note at its recorded time (16th-snapped) |
| 13 | 13 (52–56) | 32.50–35.00 · 975–1049 | B | The wait | Nothing is recorded for 2.3 s: the robot stands at the gate (real time). The path walked so far glows faintly lime (the product lights paths only by real walks). At 34.53 s the permission is closed as **denied (inferred)**, drawn hatched with a mono `inferred` tag; the second `node --test` starts and the robot walks to the Test Rig. Outside, through the open roof, the Foundry Yard residents still talk (amber). | drift toward the Test Chamber, 3°/s | continuous: the camera is at the rig when the result lands | groove; permission note (soft bell) |
| 14 | 14 (56–60) | 35.00–37.50 · 1050–1124 | B | The failure | **On the downbeat: seq 17, Exit code 1 · 12 tests: 10 passed, 2 failed.** The Test Rig turns failure #FF6B76, one ring, the chamber floor dims in a 2-cell ripple; nothing else moves. One beat later a 1.5 px line draws from the rig to a mono caption with the recorded values: `Bash node --test · exit 1 · 10/12 passed · 374 ms`. 36.95 s `Edit src/task-store.js` (+1 −1 lines) → the Workshop's Build Bench lights lime; 37.28 s the rerun starts. | macro push ×1.3 at beat 57, hold, then follow the robot to the Workshop | continuous into 15 | **failure**: cluster + filter dip (b56); edit note |
| 15 | 15 (60–64) | 37.50–40.00 · 1125–1199 | B | The fix holds | 37.63 s: `12 tests: 12 passed, 0 failed` → the Test Rig lime, one soft pulse. The failure caption's line stays, now pointing at the passed rerun's row-to-be. | pull back ×0.8 to frame rig + caption | the caption's row slides to where the selected row sits in C4: match cut on the downbeat | **pass** chime (b60.2) |
| 16 | 16 (64–68) | 40.00–42.50 · 1200–1274 | C | The failure, inspected | **C4**: the trace sheet beside the town, the failing `node --test` row selected (exit code, 10/12 passed, failing test names, reported / inferred chips, the replay bar). | 6% push toward the selected row | tape stop on 42.5; cut to the pull-away | groove; **tape stop** into b68 |
| **A5** | | **Rewind, inspect, compare** | | | 21:52:30 → 22:05 at 1× (the town never rewinds) | | | suspension |
| 17 | 17–18 (68–76) | 42.50–47.50 · 1275–1424 | B+A | Rewind | Pull away from the HQ to district height. Inside the cutaway the session's lime path **rewinds**: recorded events un-light in reverse order at 3.6× (film t = 42.8 + (12.459 − tMs/1000)/12.459 × 3.45: pass 43.95 s, failure 44.68 s, first call 45.63 s, start 46.25 s), the robot glides back along its recorded walks, an Ice playhead sweeps them. Caption: `Replay · recorded state`. **Outside, the town keeps moving forward at 1×**: Amara Holm leaves the fountain rim for Juniper House (21:57), residents talk on the benches. | slow pull-back, ease-out over 2 bars; the camera slows, not the sim | the rewound path flattens into a timeline strip: shot 18 | reversed event notes; the clock ticks forward |
| 18 | 19 (76–80) | 47.50–50.00 · 1425–1499 | B | Two sessions | Two session timelines side by side on one time axis (S primary 12.5 s: test ×3, read ×2, edit; S secondary 20.4 s: two `Explore` **subagents** on their own lanes, read ×4, execute), ticks in their recorded order and spacing; the **first divergence** marker at call 1 (S compare.diff); `not reported` where the main agent's tokens would be. | the strips draw left to right over 2 beats; 2% push | the strips fold into the session strip of C5 | two voices: L = primary, R = secondary |
| 19 | 20 (80–84) | 50.00–52.50 · 1500–1574 | C | Replay | **C5**: inside the agent's building, the session strip's replay bar dragged back; the diorama shows the recorded state at the playhead (`Replay · recorded state`, Recorded). | capture clip as recorded | cut on the downbeat | theme under the replay |
| 20 | 21 (84–88) | 52.50–55.00 · 1575–1649 | C | Compare | **C6**: Compare at the Lattice Lab: baseline (pinned) vs candidate, two real Claude Code sessions: outcome, tests, tool calls by category, `not reported` tokens, first divergence. | 4% push toward First divergence | the sheet shrinks into the Lattice Lab building (Research Park) | riser into b88 |
| **A6** | | **The world is bigger than the session** | | | 22:05 → 22:25 at 1× | | | broad resolve |
| 21 | 22 (88–92) | 55.00–57.50 · 1650–1724 | A | Out of the Lab | From the Lattice Lab out over Research Park and the pond at night; the compare sheet's position becomes the Lab's lit windows. | crane up and back, log space ×3 | continuous | sub drop + soft crash (b88); Dadd9 |
| 22 | 23–24 (92–100) | 57.50–62.50 · 1725–1874 | A | The town keeps living | The whole Commons at night. The HQ on lot 5 now reads **offline** (S primary hq after run.completed: windows dark, beacon grey #5D626C): one dark building among lit homes, **no lime anywhere**. Residents walk home (R: Quinn Park → Sedge Cottage 22:05, Hiro Gill → Hearth Flats West 22:06, Gael Gill → Hearth Flats East 22:10), 31–38 still out at the fountain and benches. Caption: `Day 2 · 22:07 · Simulated time ×1`. | slow orbit 3°/s at town height, perspective 22° | the view rises to the product's own establishing view: shot 23 | arpeggio, half-time pulse |
| 23 | 25 (100–104) | 62.50–65.00 · 1875–1949 | A | The Commons | Orthographic at the product's view (azimuth 45°, tilt 37°): the town as a lit island, the land fading into haze. The ring road (Ridge Road → Eastway → Brook Road → Westway, T ringRoad) begins to trace in Ice light from its north-west corner, clockwise. | locked-off, 1% push | the trace closes into shot 24 | theme |
| 24 | 26 (104–108) | 65.00–67.50 · 1950–2024 | A→end | The loop | The trace completes the ring, lifts off the ground, rounds into the loop mark's arc with its gap and dot at the north-west (`assets/logo-mark.svg`), and turns lime only as it leaves the town and becomes the 2-D mark. | the mark springs to its end-card position (`SPRING.gentle`) | settles into the end card | **logo** bell (b104) |
| 25 | 27–29 (108–120) | 67.50–75.00 · 2025–2249 | end | A world for AI agents. | The mark + "Runloop" (Geist 600) and "A world for AI agents." (Geist 500, 64 px) on the left third, over the slow night town (dimmed 40%, residents still moving at 1×). Holds 7.5 s. | the town drifts 1°/s behind the card | end (the music's last 4 bars loop) | theme; D pedal; loopable |

Longest stretch without a new event: the end card, bars 27–29 (7.5 s of hold, by design); everywhere else
something new lands every bar (2.5 s) or sooner.

## Sim clock map (film time → town time)

| Shots | Film | Town (Day 2) | Rate |
|---|---|---|---|
| 1–3 | 0.0–7.5 s | 05:54:07 → 06:01:37 | 1× (sim minute = 1 film second; 06:01 at frame 206) |
| 4 | 7.5–10.0 s | 06:01:30 → 06:41:30 | 16× (the product's fastest speed) |
| 5 | 10.0–12.5 s | 07:42:00 → 07:44:30 | 1× (a cut: a time jump between shots) |
| 6 | 12.5–15.0 s | the capture's own clock (≈ 07:4x) | as captured |
| 7 | 15.0–20.0 s | 07:45 → 21:30 | time-lapse, 165 sim min per second (the Clock's hands show it) |
| 8–25 | 20.0–75.0 s | 21:30 → 22:25 | 1×, continuous (the session plays at its real speed inside it) |

## Brief items the product cannot truthfully show, and what the shot does instead

| Brief | Why not (truth) | Instead |
|---|---|---|
| Cyan data trails for real-agent events | Founder decision 2026-10-18 | Lime #B8F36A, the product's own accent; amber stays the town's |
| Streetlights "switch on one by one" (A1) | The product lights every lamp together from the clock's night factor (smoothstep 0.3–0.7); at 05:54 they are already on | Shot 2 *reveals* lamp pools that are already lit, one by one, as the camera and exposure open (a reveal, not a switch). The real switch-on happens in shot 7, all lamps together at ~18:59, by the clock |
| "Tiny residents begin routines" in near darkness | Residents act only by the engine | The first scheduled walkers of Day 2 from the real sim (the baker Oren Dorsey at 05:44); the bakery lights when he arrives (occupancy) |
| A day/night transition at film speed | The product runs at 1×, 4× or 16× | Shot 4 at 16×; shot 7 is a labelled time-lapse (the Commons Clock), not a product speed |
| "A resident inspector" | The product has an anchored resident card with a Why panel, not a separate inspector | C2: the real card, Why factors linked to their decision event |
| "Building assembly" | An agent's HQ appears at once, as an unpainted model, when it is added (Add to World), and is painted on its first real event | Shots 8–10: the unpainted model waits; on the first recorded event it is painted and lit. No construction animation |
| "Its lights activate as a real session starts" | True, on the first prompt (~1 s after SessionStart) | Shot 10 on the first recorded event |
| "Camera passes through the glass into the actual UI" | The product enters a building by lifting its roof, not through glass | Kept as a film transition into a real capture (C3), never as a product feature; the product's roof lift is shown in shot 12 |
| "Tools, subagents and a failing command" in one session | No real recorded session has both yet: `s1-basic` has the failure (exit 1) and no subagents, `s2-subagents` has two Explore subagents and no failure | A4 shows `s1-basic`'s tools and failure; the subagents appear in shot 18 as the second session. The live capture must be prompted to do both in one session (below); then S is regenerated and A4 shows both |
| "Each event illuminates a corresponding element" | The room is decided by the HQ diorama's rules (`worlds/research-campus` activityRules: read/search/web → Observatory, edit/execute → Workshop, test → Test Chamber, deploy/mcp → Launch Bay, a pending permission → the Approval Gate in the Atrium), and the engine's placement wins | Lights follow S `room` (the engine's placement): `s1-basic`'s two Reads happen while a permission is pending, so they light at the Approval Gate, not the Observatory |
| "A thin line connects the metaphor to a trace detail" | A drawn trace row would be an invented screen | The line ends in a film caption carrying only recorded values, then a match cut to the real trace (C4) |
| "Time slows, the event path rewinds" | Replay scrubs recorded events; the town has no history scrubber (W5 is not built) and is never rewound | Only the session's recorded path rewinds; the camera slows; the residents keep walking forward (shot 17) |
| "Two session timelines side by side" / "experiment comparison" | Compare shows only what both runs reported; the main agent's tokens and cost are not reported; forks don't exist | Shot 18 draws recorded events only, `not reported` where a value is missing; C6 is the real Compare sheet. No forks |
| "Logo formed from the town's road network" | The ring road is a 90 × 66-cell rectangle, not a circle | The traced ring road morphs into the mark as a graphic device, Ice on the town, lime only once it is the 2-D logo (lime never lands on the town) |
| "The simulation continues independently of the session" / "slow-moving town that loops" | True while Runloop is open; the prototype pauses while it is off and resumes | The HQ is offline and the town lives on at 1× (shot 22). No "24/7", "always" or "while you sleep" copy anywhere |
| "Footsteps, building ambience, activation pulses" | In the product, cue sounds play only for real agent events (goes live, needs approval, incident, task done); the town has an ambient bed | SFX cues (sfx.mjs) only on B events of those four kinds; the town gets ambience and footsteps, never cues |
| "Composed in Remotion" | (Build approach, not a truth rule) | This project uses the motion-reel pipeline: the same guarantees (a pure function of time, deterministic, frame-exact render, no network at render). Flagged for the founder |

## Required real captures

Captured later, from the running app, after the immersive rework is final. Common setup: a fresh
`RUNLOOP_DATA_DIR`, `pnpm dev`, dark theme, Display quality high, reduced motion off, sound off, a
1920×1080 viewport; stills at deviceScaleFactor 2 (3840×2160, so the film can push to 2× without
upscaling), clips as a lossless 1920×1080 30 fps screen recording. **Record `GET /api/world` → `seed`
and re-run `npx tsx tools/export-town.ts --seed <seed> && npx tsx tools/export-residents.ts --seed <seed>` (from film/) so the 3-D town, decorations and residents match
the captures; then re-pick the followed residents.** Use 16× only to travel between capture times, and
1× during every capture.

| ID | Used in | App state | Route / how | Entity | Must be visible | Kind |
|---|---|---|---|---|---|---|
| **C1** town overview | shot 6 (first half) | Day 2 ≈ 07:40, ×1, populated, the HUD up; no agent yet or the HQ unpainted | `/` (key `0`: whole town), then zoom to Hearth Row | the town | clock "Day 2 · 07:4x", speed ×1 and "Simulated time ×1. Real agents run at real speed.", minimap, hotbar, residents walking | clip 3 s + still |
| **C2** resident card with Why | shot 6 (second half) | same minute, a resident leaving home for work (schedule) | click the resident (or ⌘K their name) → card opens anchored beside them, "Following …" | the commuter matching shot 5 (re-picked from the re-export) | ◇ Simulated, Now ("Walking, to work"), **Why** with factors linked to `seq`, "Simulated resident · rule-based decision", needs | clip 3 s + still |
| **C3a** HQ waiting | planning / shot 8 match | after Add to World (N) on **lot 5**, name "Engineering House", the project folder of the live session | Add to World → lot 5 → name + path | bld_agent_hq_5 | the unpainted HQ and "waiting for its first event" | still |
| **C3** agent going live | shot 11 | Day 2 ≈ 21:30, ×1; start the live session in the folder with the plugin | `/?mode=agents&focus=agent:<id>` with the agent's card open, camera on the HQ's street front | Engineering House | the HQ painting on the first prompt, then the card: Real · Claude Code · observed, **Live · working**, kinds of tool, subagents, last event n s ago | clip 6–10 s from before the first prompt, + still of the card live |
| **C4** failure in the trace | shot 16 | after the session ended | from the agent card: Trace → the sheet beside the town; select the failing `node --test` row | the run | exit code 1, "n/m passed" chip, failing test names, reported / inferred chips, the replay bar, the session's rows | still (+ 2 s clip of the row being selected) |
| **C5** replay scrubbing | shot 19 | same run | Enter building (double-click the HQ) → the session strip → drag the replay bar back from the end | the run inside the HQ diorama | "Replay · recorded state", the playhead moving back, the robots at the recorded state | clip 4 s |
| **C6** compare | shot 20 | two real sessions of the same task in the same folder: the first **pinned as baseline**, then the second | Lab (4) → Compare at the Lattice Lab (`/?mode=lab&overlay=compare&a=<baseline>&b=<candidate>`) | the two runs | Baseline / Candidate, outcome, tests passing, failures, tool calls by category, tokens "not reported", **First divergence** | still + 3 s scroll clip |

**The live session (one real Claude Code Haiku session, ≤ $0.10, `--max-budget-usd 0.10`).** For A4 to show
tools, a subagent and a failure from one real session, prompt it in a small repo with a known bug (the
demo's task store): *"Launch one Explore subagent to summarise src/task-store.js. Then run `node --test`
(no pipes). Fix the failing test with a minimal edit and run `node --test` again."* No pipes, so the
failing run exits non-zero and becomes an incident (a piped run exits 0 and shows no incident). Allow
`Bash(node --test:*)` and edits up front so no permission wait stretches the session; a 10–15 s session
plays at recorded speed in A4 (a longer one is scaled by a constant factor shown in a caption).
**Open decision for the founder:** C6 needs a second session of the same task (a few cents with Haiku;
the earlier three end-to-end sessions cost $0.032 together). Either allow a second run inside the $0.10,
or C6 falls back to the demo mission's pair, which is labelled *Executed* and cannot stand in for Claude
Code sessions.

After the capture: save the session's hook log (the plugin's spool or a logging plugin) as a sanitised
`.jsonl` like the fixtures, run `tools/export-session.ts --primary <capture>` (and the second run as
`--secondary`), and re-run `audio/score.py`: A4's offset and every event note follow the new file.

## 30 s teaser (12 bars, `audio/music_teaser.wav`)

Hero bars, re-timed one bar each, in order: **0, 2, 6, 10, 11, 14, 16, 17, 20, 21, 26, 27**.

| Teaser bar | Time | Hero shot | Layer |
|---|---|---|---|
| 0 | 0.0–2.5 | 1 First light + "A world, not a dashboard." (title in from beat 1, not 2) | A |
| 1 | 2.5–5.0 | 3 Routines begin (the bakery lights) | A |
| 2 | 5.0–7.5 | 7 A day in the Commons (first bar, the time-lapse) | A |
| 3 | 7.5–10.0 | 10 It goes live | B |
| 4 | 10.0–12.5 | 11 Through the glass → C3 | B→C |
| 5 | 12.5–15.0 | 14 The failure | B |
| 6 | 15.0–17.5 | 16 C4 the failure in the trace (tape stop at its end) | C |
| 7 | 17.5–20.0 | 17 Rewind (first bar) | B+A |
| 8 | 20.0–22.5 | 19 C5 replay | C |
| 9 | 22.5–25.0 | 20 C6 compare | C |
| 10 | 25.0–27.5 | 24 The loop (logo forms) | A→end |
| 11 | 27.5–30.0 | 25 End card, held 2.5 s | end |

Each teaser bar plays the hero shot's own animation with its time shifted to the teaser bar (the sets
are shared; only the time offset changes). Shot 7's time-lapse runs over one bar instead of two.

## 10 s seamless loop (4 bars, `audio/music_loop.wav`)

The A6 night town (shots 22–23's sets), no title, no captions, no lime (the HQ offline).
- Camera: the product's establishing view with a periodic sway, azimuth 45° + 4°·sin(2πt/10 s), tilt 37°
  + 1°·sin(2πt/10 s + π/2): frame 300 equals frame 0.
- Town: Day 2 22:40 → 22:50 at 1× (R: 3–8 walking, ~30 outdoors). Residents are blended over the last
  beat: for t in [9.375, 10) s each resident is drawn at its t and at t − 10 s with weights crossfading
  1 → 0 / 0 → 1, so frame 299 → frame 0 is continuous; windows and lamps blend the same way.
- Music: bars 26–29 rendered on their own with their reverb tails wrapped onto the start (seam measured
  continuous; loop −20.1 LUFS = the hero's last 4 bars).

## Per-format notes

16x9 only (no 9x16 / 1x1 requested). Every C capture is 16:9 at 1920×1080, so it fills the frame
without letterbox.

## Render budget (3-D speed probe, 2026-10-18)

Probe: `film/probe-town/` renders the first real set, `keeps-running/sets/town.js` (built from T and R:
ground raster, 28 buildings with roofs by archetype and 776 windows lit from R occupancy, 24 lamps with
pools, 383 decoration items + 1,054 land trees instanced, the HQ on lot 5, 80 residents at their engine
positions, the product's sky, moon shadows 2048², bloom), at three film moments. Machine: no GPU,
SwiftShader (ANGLE Vulkan), 4 cores shared with another agent's browser (load 4–8 during the runs).
Stills: `out/probe-town/stills/t1.500_*.png` (A1 macro 05:56), `t4.500_*.png` (A3 Agent District 21:31,
HQ waiting), `t7.500_*.png` (A6 whole town 22:07, HQ offline), each `_blur8` and `_noblur`.

| Measure (1920×1080) | Result |
|---|---|
| One 3-D sample (one `draw()`), set as built | 1.8–3.4 s, median ≈ 2.6 s (`out/probe-town/timing.json`) |
| …without bloom / without shadows / without both | 1.15 s / 1.74 s / **0.41 s** (`passes.json`): the bloom composer (4× MSAA half-float target + UnrealBloom) costs ≈ 1.3–1.5 s, the shadow map ≈ 0.75–0.9 s |
| Draw calls / triangles per sample | 39–40 (scene 18, shadow pass 8, bloom 14) / ≈ 84k |
| Motion blur | linear in samples: 4 → 8.8–11.6 s, 8 → 20.9–23.1 s, 16 → 35–46 s per frame |
| PNG screenshot per frame | 0.18–0.45 s |
| Page load + set build | 33 s per worker |
| 3 workers (`render.mjs --range 3:4.5 --noblur --workers 3`) | 45 frames in 144 s = **0.31 fps ≈ 1.1× one worker**: SwiftShader already uses every core, so workers do not scale here |

**Full 75 s at 30 fps (2,250 frames; ≈ 1,900 of them 3-D) on this machine:**
- set as built, no blur: ≈ 2 h;
- set as built, the skill's default 16-sample blur: ≈ 20 h (not viable);
- set as built, the samples policy below (≈ 2.5 samples per 3-D frame): ≈ 3.5 h;
- optimised set (bloom replaced by a quarter-resolution emissive glow composited in 2-D; shadows only in
  the day shots 4 and 7, or a cached map of static casters at night): ≈ 0.45 s per sample → ≈ 50 min with
  the policy, ≈ 30 min without blur;
- on a GPU (macOS, ANGLE Metal; the skill measures ~80× for 3-D): minutes. Render the final there; use this
  box for contact sheets (`--every 2`, 1 sample) and range previews.

**Motion-blur samples policy** (`samples(t)` in film.js): 1 on locked-off or slow shots (1, 2, 8, 9, 12, 13,
22, 23, 25); 2 where the camera orbits or walkers pass close (3, 5, 14, 15, 21, 24); 6 on fast camera moves
(4 at 16×, 10–11 the push through the glass, 17 the rewind glide); 8 on C-only frames (2-D, cheap). Shot 7's
time-lapse walkers are drawn as analytic light trails over the shutter interval instead of extra samples.

**Budgets per set, per sample (SwiftShader, 1080p):** ≤ 60 draw calls (probe 40), ≤ 250k triangles
(probe 84k; the Studio's ≈ 400-triangle resident rig × 80 adds 32k), at most 2 full-screen passes and no
MSAA render targets (antialias with the canvas only), additive overdraw limited to ground pools, shadow map
≤ 2048² with static casters (residents cast none at night), per-frame CPU work O(residents). Keep the set
build under ~30 s or prebuild its geometry: three pages building at once under load can hit render.mjs's
120 s `filmReady` timeout (one probe run did).

**What the stills showed (fix in the build):** the A6 town reads as the product's town at night; the
A3 night is too bright and lavender (grade −1 EV toward the midnight palette; lamp pools need more contrast
against the ambient); A1 at 05:56 is the product's pre-dawn, so its camera looks down with no horizon
(updated above); the lamp's light cone reads as a flat triangle (a cheap-hologram look: replace with a
soft gradient volume or drop it); the placeholder residents read as bollards (use the Studio's rigged
resident); the land is dark green, not midnight (grade, not hue changes to product colours).
