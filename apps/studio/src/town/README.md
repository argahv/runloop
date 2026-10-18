# `town/`: the town renderer (workstream B1, immersive world)

The 3D town of the world simulation (plan of record: `docs/architecture/world-simulation.md` §5 Rendering;
the immersive experience contract of 2026-10-18 for the camera, the land and the HUD hooks).
It draws Runloop Commons from the engine's state only: the compiled town (`@runloop-world/town`), the
`WorldSnapshot` folded with the sim's `applyEvent`, and the clock. It never changes world state and never
ticks the sim. Around the town it draws open country under a sky that follows sim time; that land and its
ambient life are scenery, never state (see "Truth" below).

## Mounting it (contract with the shell)

`TownCanvas.tsx` default-exports the component; mount it with `next/dynamic` and `ssr: false`
(`components/world/Town3D.tsx` does). Props are in `types.ts`:

| Prop | What |
|---|---|
| `town` | The `CompiledTown` (from `GET /api/world/town` through `loadTown`). |
| `getState()` | Called every frame: `{ snapshot, clock }`. The snapshot may be mutated in place. `clock` is `{ tick, speed, receivedAt }` with `receivedAt` in `Date.now()` ms; the renderer draws `tick + (now − receivedAt)·speed/1000`, at most 2 s ahead, frozen while paused (`clock.ts`). |
| `selected`, `follow` | Entity refs (`resident:`, `agent:`, `building:`…). Selected things get a ring and a label; a followed resident or agent keeps the camera on it (a new follow below district level comes in to street level once). |
| `entered` | The building whose interior is open, or null. Flying in, its roof lifts 6 units and dissolves in 450 ms while its walls give way to the cutaway; an agent headquarters' pavilion lifts and fades over its run diorama (`agentHouse`). The town dims around it. Reduced motion cuts. |
| `cameraRequest` | `{ id, kind: focus \| enter \| exit \| overview \| level \| rotate \| cam \| goto, ref?, level?, dir?, deg?, cam?, point?, motion? }`. A new `id` triggers it; viewer input interrupts it; reduced motion cuts. `goto` centres a cell (`point`, the minimap); `rotate` turns `deg` (default 90). A focus or enter whose entity has no position yet (a deep link on load) is retried each frame for up to 6 s. |
| `initialCam`, `onCamChange` | `cam=x,z,zoom[,az[,tilt]]` deep links: target in town cells (x column, z row), px per cell at the target, azimuth and tilt in degrees (defaults 45° and 37°, so 3-part links frame as before). Reported (all five) once the camera settles. |
| `onSelect`, `onEnter`, `onHover`, `onFollowBroken`, `onLongPress` | What the viewer did: click (null = empty ground), double-click a building or robot, hover, a pan/rotate/zoom that broke a follow, a 500 ms press (select and expand). |
| `apiRef` | Filled with `TownApi`: `projectEntity(ref)` (head, roof or centre on screen), `projectCell(x, z, h)`, `groundAt(px, py)` (cells; null = sky), `getCamera()` (`TownCamState`: cells, zoom, degrees, fovY, level, moving, ground `footprint`), `onFrame(fn)`. For anchored cards and the minimap; cheap, no React state. |
| `viewInsets` | Screen space the HUD covers (px from each edge). The view's centre is the centre of what is left (`setViewOffset`, eased), framing keeps clear of it, and labels avoid it. |
| `lotPick`, `onPickLot`, `onHoverLot` | Add to World: free lots glow (ice outline over a graphite under-stroke, breathing; static under reduced motion), the picked one lime; every lot is a label button ("Lot 3 · Free", or its agent's name). Clicking a free lot calls `onPickLot`, never `onSelect`. |
| `onInteraction` | A viewer drag, rotation, tilt or pinch started / ended (the HUD fades while it runs). |
| `onFly` | A quick or cinematic move started: its duration and a stereo pan (−1 … 1), for the fly-in whoosh. Not called for cuts. |
| `onListener` | About 4 Hz: `TownListener` for the soundscape (`listener.ts`): camera place and zoom, minute, night, paused, and nearby sources (murmur from simulated occupancy at the café, fountain, atrium, diner, tavern, bakery; water; greenery; roads; fields) with gain and pan. No source is ever in an agent lot. |
| `surroundings` | `'full'` (default), `'lite'` (phones, low quality: a third of the trees, six static clouds, no cloud shadows, four cars, no birds) or `'off'`. |
| `ambientLife` | Decorative cars, birds, cloud drift and water shimmer (default true; always off under reduced motion). |
| `labelBudget` | At most this many labels (default 24; 12 on phones). |
| `keyboard` | Camera keys on (default true). Off while a menu, a focused sheet or a form owns the keyboard. |
| `paused` | Stop rendering (another canvas is on top). |
| `quality` | `'auto' \| 'high' \| 'low'`. Auto steps down when the p95 frame time is over 22 ms for 2 s and back up after 10 s under 12 ms (`quality.ts`). |
| `reducedMotion` | Camera moves cut, no inertia, residents step at 2 Hz in still poses, nothing pulses, no ambient life. |
| `seed`, `agentHouse(agentId)`, `obstacles(w, h)`, `onReady` | Decoration seed; the diorama source for an agent's headquarters; extra screen rectangles labels keep clear of; called after the first frames (the wrapper also gets `data-world-ready="true"`). |

`window.__runloopPerf` (`perf.ts`) exposes draw calls (and `surroundCalls`, the land's share), triangles,
frame/JS/render percentiles (and `ambientMs`, the land's JS), the LOD tier, the quality level and the decorative
ambient clock; `window.__runloopCam` exposes `{ x, z, zoom, az, tilt, level, moving, frame }` (cells, px per
cell, degrees) for tests. `scripts/perf-town.mjs` reads both.

## The camera (`TownCamera.tsx`, `cameraController.ts`, `cameraMath.ts`, `input.ts`)

A perspective camera with a narrow field of view: 20° from a tilt of 30° up, widening to 28° at the lowest
tilt (10°), so the default view (azimuth 45°, tilt 37°) keeps the isometric look while tilting down reveals
depth and the horizon. `zoom` stays the canonical scale (px per cell at the target): the camera's distance is
`canvasH / (2·zoom·tan(fovY/2))`, levels and `cam=` links keep their meaning. The maths is pure and tested
(`cameraMath.ts`: projection identical to three's camera with a view offset, ground rays, zoom-to-cursor,
fitting under perspective, footprint, springs); `CameraController` holds the dynamics (no React, no three,
tested).

| Input | Action |
|---|---|
| left drag / one finger | pan, ground-anchored; release with inertia (≤ 4 view widths/s, `e^(−6t)`) |
| wheel / trackpad pinch (ctrl) | zoom at the cursor (the ground under it stays put; over the sky, at the centre), eased; shift + wheel turns |
| right or middle drag | turn (0.3°/px, with a little inertia) and tilt (0.2°/px) |
| two fingers | pinch zoom at the centroid, twist (after 6°) turns, both fingers up or down tilt |
| click / tap · double click / tap · long press | select · enter a building or robot's HQ (open ground: fly there one level in) · select and expand |
| W A S D / arrows (Shift ×2.5) | pan one view height per second, screen-relative, 120 ms ramp |
| Q / E · Z / X | turn ∓45° (hold: 90°/s) · tilt toward the horizon / top-down (30°/s) |
| + / − · 0, Home · R | zoom ×1.3 · the whole town · reset to 45° / 37° |

Ranges: tilt 10°–62° (an open interior keeps ≥ 42°; flying in tilts to ≥ 48°); zoom softly in
[fit·0.6, street·2.4] with a 10% rubber band; the target softly within 20 cells of the town (dragging beyond
resists ×0.35, release springs back). Keys are ignored with ⌘/Ctrl/Alt, in text fields and inside dialogs,
trees, radio groups, tab lists, list boxes and `[data-keys=own]`. Quick moves take 400–700 ms by distance;
hops longer than 1.5 view widths arc out to show both ends; cinematic moves (2.2 s) are for earned moments.
LOD under perspective: one tier per frame from the nearest ground in view (`projectedHeightPersp`, ±15%
hysteresis); picking scales each resident's reach with its own distance.

## What is drawn, and from what

- **Static town** (`StaticTown`, `geometry/`): ground chunks (grass by district, mown park, garden rows,
  asphalt with lane marks, curbs, zebra crossings, paving, gravel paths, the pond), every building from its
  archetype, footprint, facing, floors and palette, shop signs (canvas atlas, façade and blade), trees and
  street props from `decorate(town, seed)`, landmarks, outdoor seating under the spots people sit at, fences
  and the reserved agent lots. No slab: the grass margin meets the land, and the roads out cross it on ramped
  `exits` cells. Per-frame state only through uniforms (`townMaterial.ts`): lit windows when a building is
  occupied, open signs at night, lamps at night, the open building's roof lift, the town dimmed, cloud shadows.
- **Residents** (`Residents.tsx`, `rig/`): one instanced mesh (≈400 triangles a body) with a shader rig
  (walk, idle, sit, work at a counter or desk, talk, sleep) whose formulas are `rig/residentRig.ts`, the
  tested CPU reference. Positions come only from `ResidentState` (`place.ts`). LOD (`lod.ts`): full rig
  ≥ 28 px, still poses with a walking bob 10–28 px, blocks below. Residents never have visors or glowing eyes.
- **Agents** (`AgentHq.tsx`, `AgentRobot.tsx`, `status.ts`): a housed agent's headquarters on its lot
  (graphite pavilion, identity band, a beacon) and its robot at the door. Lime appears only when the agent is
  live and reported working. Waiting for its first event, the HQ stands as an unpainted model; offline, its
  windows are dark. Every agent label carries "Agent · Claude Code".
- **Interiors** (`Interior.tsx`, `geometry/interior.ts`): only the open building; walls facing the camera cut
  low; decoration in front hidden whole (`cutRect`); furniture; residents at their slots (floor 0). An agent HQ
  mounts `scene/{Board,Stations,Paths,Props,Characters,Effects}` at 0.5 scale (`AgentHouse.tsx`).
- **The land beyond** (`geometry/surroundings.ts` layout, `geometry/surroundMeshes.ts`, `Surroundings.tsx`):
  a terrain disc out to 900 units (flat around the town, hills under a forest belt to the north and
  north-east, gentle rolls far out), the four roads out (lamps along the first 130 units; nothing else out
  there lights up) and two country lanes, eight farmsteads (windows never lit) and a windmill, patchwork
  fields and orchards, hedges, bushes and groves, the Brook (from a lake west of Research Park, under two
  bridges) and far mountains faceted into the haze. One draw each, trees in four instanced quadrants.
- **Sky and atmosphere** (`sky.ts`, `SkyRig.tsx`, `Atmosphere.tsx`): sun or moon, hemisphere and ambient from
  the world's time (DL-011), soft variance shadow maps re-rendered only when the sun has turned, lamp pools at
  night; a sky dome (zenith, horizon, haze, sun glow, stars at night), linear haze that never reaches the
  town (it starts past the town's farthest corner) and blends the land into the horizon, low-poly clouds that
  drift and fade where they would be in the way, and their soft shadows on the ground. The theme changes the
  HUD and the labels only.
- **Ambient life** (`AmbientLife.tsx`): up to ten cars (headlights at night) and three bird flocks by day.
- **Labels** (`labels.tsx`): at most `labelBudget`, placed with `scene/labelLayout.ts`: agents, district names
  (far), building names near the middle of the view (street), the selected, hovered or followed resident
  ("Simulated"), and lots while picking. Never behind the camera or out in the haze; near the horizon, building
  names only near the target; clear of `obstacles` and `viewInsets`.

## Truth

Everything beyond the town, and the cars, birds, clouds, windmill and water shimmer, is decoration: never
pickable, never in the directory, the minimap, the log or ⌘K, and it carries no state. Cars and birds keep at
least 12 cells from every agent lot (birds also stay out of the Agent District plus 10 cells), farms stand
well outside it, and all of it moves on one ambient clock that stands still while the world is paused and
under reduced motion (`surroundings.test.ts` samples every route and flock).

## Harness and budgets

`node scripts/perf-town.mjs --serve [--port 3053]` serves `harness/`: the same `<TownCanvas>` on the Commons,
with the engine running in the page (`harness/localWorld.ts`; fixture agents housed through the same commands
the projector sends) or, with `?live=<runtime url>`, a real runtime's world over SSE. Everything is labelled
"Fixture". Parameters: `cam=town | district:<id> | street:<x>,<y>[,<px>] | view:<x>,<y>,<px>,<az°>,<tilt°> |
focus:<kind>:<id> | interior:<id> | interior:hq`, `t=HH:MM`, `speed=0|1|4|16`, `land=full|lite|off`,
`lotpick=1`, `inset=<px>` (a sheet on the right), `quality`, `reduced=1`, `stress=<n>`, `agents=0..4`; the
renderer's API is `window.__townApi.current`.

`node scripts/perf-town.mjs` measures each camera bookmark under SwiftShader (hot reload off while measuring)
and checks the budgets: draw calls by view (town 120, street 150, interior 250), ≤ 400k triangles, JS ≤ 4 ms
p50 with 500 actors, the land ≤ 16 calls and ≤ 0.3 ms JS (p50). Bookmarks include `horizon` (tilt 10°,
azimuth 200°), `tilt-street` (tilt 15°) and `lot-pick`.

## Tests (`pnpm vitest run --project studio src/town`)

Colour (CIEDE2000 keeps lime and the semantic colours out of the town, the countryside and the sky), sky
continuity and night, clock interpolation, LOD hysteresis and perspective heights, adaptive quality, the rig,
placement, agent status, static geometry, the camera maths (three-equivalent projection, zoom to the cursor,
fit, footprint, horizon placement at 10°), the controller (ground-anchored pan, inertia, Q/E, tilt clamps,
soft bounds, wheel zoom, interrupts, follow, keys), the land (layout, determinism, clearance of every car,
bird and farm from agent lots, flatness, ≤ 70k triangles) and the listener (sources and pans, nothing in an
agent lot).
