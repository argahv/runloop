# `town/`: the town renderer (workstream B1)

The 3D town of the world simulation (plan of record: `docs/architecture/world-simulation.md` §5 Rendering).
It draws Runloop Commons from the engine's state only: the compiled town (`@runloop-world/town`), the
`WorldSnapshot` folded with the sim's `applyEvent`, and the clock. It never changes world state and never
ticks the sim.

## Mounting it (contract with the shell)

`TownCanvas.tsx` default-exports the component; mount it with `next/dynamic` and `ssr: false`
(`components/world/Town3D.tsx` does). Props are in `types.ts`:

| Prop | What |
|---|---|
| `town` | The `CompiledTown` (from `GET /api/world/town` through `loadTown`). |
| `getState()` | Called every frame: `{ snapshot, clock }`. The snapshot may be mutated in place. `clock` is `{ tick, speed, receivedAt }` with `receivedAt` in `Date.now()` ms; the renderer draws `tick + (now − receivedAt)·speed/1000`, at most 2 s ahead, frozen while paused (`clock.ts`). |
| `selected`, `follow` | Entity refs (`resident:`, `agent:`, `building:`…). Selected things get a ring and a label; a followed resident or agent keeps the camera on it. |
| `entered` | The building whose interior is open, or null. Grid interiors show as a cutaway; an agent headquarters mounts its run diorama (`agentHouse`). The town dims around it. |
| `cameraRequest` | `{ id, kind: focus \| enter \| exit \| overview \| level \| rotate \| cam, ref?, level?, dir?, cam?, motion? }`. A new `id` triggers it; viewer input interrupts it; reduced motion cuts. A focus or enter whose entity has no position yet (a deep link on load) is retried each frame for up to 6 s. |
| `initialCam`, `onCamChange` | `cam=x,z,zoom` deep links: target in town cells (x column, z row) and px per cell. Reported once the camera settles. |
| `onSelect`, `onEnter`, `onHover`, `onFollowBroken` | What the viewer did: click (null = empty ground), double-click a building or robot, hover, or a pan/zoom that broke a follow. |
| `quality` | `'auto' \| 'high' \| 'low'`. Auto steps down when the p95 frame time is over 22 ms for 2 s and back up after 10 s under 12 ms (`quality.ts`). |
| `reducedMotion` | Camera moves cut, residents step at 2 Hz in still poses, nothing pulses. |
| `seed` | Decoration seed (the world's seed). |
| `agentHouse(agentId)` | The diorama source for an agent's headquarters: `{ world, getFrame, subscribeEffects, selectedAgentId?, onSelectAgent? }` from the StudioStore of that agent's session, or null. Polled every frame while the HQ is open. |
| `obstacles(w, h)` | Screen rectangles of floating chrome that labels keep clear of. |
| `onReady` | After the first frames; the wrapper also gets `data-world-ready="true"`. |

`window.__runloopPerf` (`perf.ts`) exposes draw calls, triangles, frame/JS/render percentiles, the LOD tier and
the quality level; `scripts/perf-town.mjs` reads it.

## What is drawn, and from what

- **Static town** (`StaticTown`, `geometry/`): ground chunks (grass by district, mown park, garden rows,
  asphalt with lane marks, curbs, zebra crossings, paving, gravel paths, the pond), every building from its
  archetype, footprint, facing, floors and palette, shop signs (canvas atlas, façade and blade), trees and
  street props from `decorate(town, seed)`, landmarks, outdoor seating under the spots people sit at, fences
  and the reserved agent lots. A handful of merged meshes; per-frame state only through uniforms
  (`townMaterial.ts`): lit windows when a building is occupied, open signs at night, lamps at night, the open
  building hidden, the town dimmed.
- **Residents** (`Residents.tsx`, `rig/`): one instanced mesh (≈400 triangles a body) with a shader rig
  (walk, idle, sit, work at a counter or desk, talk, sleep) whose formulas are `rig/residentRig.ts`, the
  tested CPU reference. Positions come only from `ResidentState` (`place.ts`): a walk's closed form
  (world-engine `positionAt`, plus a right-hand lane), an outdoor spot's cell, or a furniture slot inside.
  LOD by projected size with ±15% hysteresis (`lod.ts`): full rig ≥ 28 px, still poses with a walking bob
  10–28 px, blocks below. Residents never have visors or glowing eyes.
- **Agents** (`AgentHq.tsx`, `AgentRobot.tsx`, `status.ts`): a housed agent's headquarters on its lot
  (graphite pavilion, identity band, a beacon) and its robot at the door, the Studio's chibi robot silhouette
  (dark visor, eyes that carry state, identity hue on the body). Lime appears only when the agent is live and
  reported working. Waiting for its first event, the HQ stands as an unpainted model; offline, its windows are
  dark. Every agent label carries "Agent · Claude Code".
- **Interiors** (`Interior.tsx`, `geometry/interior.ts`): only the open building; walls on the sides facing
  the camera are cut low; trees and props within 3 cells in front of it are hidden whole (each decoration
  vertex carries its item's cell, `cutRect` in `place.ts`); furniture from the interior file; residents at
  their slots (floor 0). An agent HQ
  mounts `scene/{Board,Stations,Paths,Props,Characters,Effects}` at 0.5 scale (`AgentHouse.tsx`); their
  labels are carried to world space by `ScopedLabelStore`. The static Props are baked once mounted into one
  mesh per material (`MergeStatic.tsx`, `geometry/merge.ts`: ≈80 draw calls → a handful).
- **Sky** (`sky.ts`, `SkyRig.tsx`): sun or moon, hemisphere and ambient from the world's time (DL-011); soft
  variance shadow maps re-rendered only when the sun has turned; lamp pools at night. The theme changes the
  chrome, the labels and the backdrop beyond the town's edge, never the time of day.
- **Labels** (`labels.tsx`): at most 24, placed with `scene/labelLayout.ts`: agents, district names (far),
  building names near the middle of the view (street), and the selected, hovered or followed resident
  ("Simulated").
- **Camera** (`TownCamera.tsx`): orthographic at 37°, pan and zoom, 90° turns, levels town / district /
  street (≈28 cells across) / interior, follow, quick (`--rl-dur-camera`) or cinematic (2.2 s) moves.

## Harness and budgets

`node scripts/perf-town.mjs --serve` serves `harness/` on port 3053: the same `<TownCanvas>` on the Commons,
with the engine running in the page (`harness/localWorld.ts`; fixture agents housed through the same commands
the projector sends) or, with `?live=<runtime url>`, a real runtime's world over SSE. Everything is labelled
"Fixture". `node scripts/perf-town.mjs` measures each camera bookmark under SwiftShader and checks the
budgets (draw calls by view, triangles, JS per frame with 500 actors).

## Tests (`pnpm vitest run --project studio src/town`)

Colour (CIEDE2000 keeps lime out of the town palette and the town file), sky continuity and night, clock
interpolation, LOD hysteresis, adaptive quality, the rig (bounds, seating, foot slide under 5% at 1× and 4×),
placement (walks equal `positionAt`, stay on walkable ground and move continuously; slots inside footprints),
agent status (lime only when working; nothing animates without an event), and the static geometry (finite,
under the triangle budget, deterministic decoration, every interior and cutaway).
