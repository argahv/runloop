# `world/`: the town's client state

Plan of record: `docs/architecture/world-simulation.md` §5. Everything here is
plain TypeScript (no React except `context.tsx`), unit-tested with
`pnpm vitest run --project studio src/world`.

| File | What |
|---|---|
| `store.ts` | `createWorldStore()`: a vanilla zustand store, separate from the StudioStore. The snapshot is folded with the sim's own `applyEvent` (in place; `rev` bumps on every change). Commands are never optimistic (`pending`, cleared by their effect event or shown with their rejection). Panel stack, follow, entered building, camera requests, overlays, attention, agents API data. |
| `connect.ts` | `connectWorld(store)`: world info and town, then `/api/world/stream` (snapshot, event batches, 1 Hz clock); a gap or an unparsable frame resyncs from a fresh snapshot. Polls `/api/agents` and arrivals every 4 s. Seeds attention from the log. |
| `api.ts` | Fetch helpers for `/api/world/*` and `/api/agents/*` (types from `@runloop-world/events` `world-protocol.ts`). |
| `link.ts` | `?mode=&focus=kind:id&cam=x,z,zoom`, `modeOfRoute`, and `legacyRedirect` (old `/?run=…` links still reach their page). |
| `attention.ts` | Severity, grouping (same group within 10 sim-minutes), the ticker's rate limit (one item per 4 s; critical skips it), titles from recorded facts only. |
| `catchUp.ts` | "While you were away": attention groups over the events since the viewer's last seen seq, each citing its seqs. |
| `entityIndex.ts` | Every resident, agent, building, place and district for ⌘K and the directory tree. |
| `selectors.ts` | Panel view models and provenance chips. P10 on the UI side: "Real" only on external-agent entities and events; agent views have no Why; Why factors without a source are dropped. |
| `interpolate.ts` | The client clock (`tick + elapsed·speed`, ≤ 2 s ahead, frozen when paused) and walk positions. |
| `send.ts` | `sendWorldCommand` (body `{id, command}`; the runtime sets source `user`), the speed caption. |

The town renderer (`town/TownCanvas`, workstream B1) is mounted by
`components/world/Town3D.tsx` per `town/types.ts`; `components/world/WorldMap.tsx`
is the 2D map (phones, no WebGL, and the Map overlay).
