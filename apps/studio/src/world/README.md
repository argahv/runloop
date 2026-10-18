# `world/`: the town's client state

Plan of record: `docs/architecture/world-simulation.md` §5, and the immersive
experience contract (2026-10-18: the world is the whole screen, the UI is a
game HUD). Everything here is plain TypeScript (no React except
`context.tsx`), unit-tested with `pnpm vitest run --project studio src/world`.

| File | What |
|---|---|
| `store.ts` | `createWorldStore()`: a vanilla zustand store, separate from the StudioStore. The snapshot is folded with the sim's own `applyEvent` (in place; `rev` bumps on every change). Commands are never optimistic (`pending`, cleared by their effect event or shown with their rejection). Panel stack (the entity card), follow, entered building, camera requests, the HUD (`overlay`, `menu`, `hud.hidden/interacting`, `cardExpanded`, `bellOpen`, `stage`, `townPaused`), Add to World's lot picking (`lotPick`), attention, agents API data. |
| `connect.ts` | `connectWorld(store)`: world info and town, then `/api/world/stream` (snapshot, event batches, 1 Hz clock); a gap or an unparsable frame resyncs from a fresh snapshot. Polls `/api/agents` and arrivals every 4 s. Seeds attention from the log. |
| `api.ts` | Fetch helpers for `/api/world/*` and `/api/agents/*` (types from `@runloop-world/events` `world-protocol.ts`). |
| `link.ts` | `?mode=&focus=kind:id&cam=x,z,zoom[,az,tilt]&overlay=`, `modeOfRoute`, and `legacyRedirect` (old `/?run=…` links still reach their page, unless they name an `overlay`). |
| `attention.ts` | Severity, grouping (same group within 10 sim-minutes), the popup pacing (one item per 4 s; critical skips it), titles from recorded facts only. |
| `catchUp.ts` | "While you were away": attention groups over the events since the viewer's last seen seq, each citing its seqs. |
| `entityIndex.ts` | Every resident, agent, building, place and district for ⌘K and the directory tree. |
| `selectors.ts` | Panel view models and provenance chips. P10 on the UI side: "Real" only on external-agent entities and events; agent views have no Why; Why factors without a source are dropped. |
| `interpolate.ts` | The client clock (`tick + elapsed·speed`, ≤ 2 s ahead, frozen when paused) and walk positions. |
| `send.ts` | `sendWorldCommand` (body `{id, command}`; the runtime sets source `user`), the speed caption. |

## Modes, sheets and places (contract §2.3, §4)

`setMode` opens a mode's sheet and frames its place (an eye anchor only; nothing in
the sim changes): Agents → the Agent District (its card lists agents and Arrivals),
Intelligence → the Commons Library with the World Log sheet (`overlay: 'log'`), Lab →
the Lattice Lab with the compare sheet (`overlay: 'compare'`). Explore and Agents give
the town back (sheets close). Opening a mode's sheet sets its mode; closing it returns
to Explore. A deep link sets the mode without moving the camera.

`openAddToWorld()` is lot picking in the 3D town (`overlay: 'add'`, the camera flies
to the Agent District, free lots glow) or, without the 3D view (no WebGL, the 2D map
view, another page), the dialog with its lot list (`addToWorld`).

## The town on `/` (`components/world/`)

`WorldHome` is the whole screen: `TownStage` (the 3D town, `Town3D` → `town/TownCanvas`,
or the 2D `WorldMap`) and `hud/WorldHud`, the game HUD: world chip, Find (⌘K) and the
bell (top-left), clock and speed with the sound toggle (top-right), notifications
under it, the minimap (bottom-left; Map M and List L are its 2D routes), the hotbar
(1 Explore, 2 Agents, N Add to World, 3 Intelligence, 4 Lab, Esc menu), entity
cards anchored next to their entity (`hud/anchor.ts`, docked top-right when the
anchor is off-screen; bottom sheets on phones), the guide banner (lot picking,
inside a building, following), sheets, and the Esc menu (`hud/GameMenu`: display,
sound, controls with the truth legend, runtime, connections, pages, help). Pure HUD
logic (layout per viewport, card placement, the Esc cascade, notification pacing,
the minimap's geometry, the lot model) is unit-tested in `hud/hud.test.ts`.
