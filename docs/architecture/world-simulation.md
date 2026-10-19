# World simulation: architecture and first slice

> **Status:** plan of record, 2026-10-18. This covers W1, W2 and a thin W4 of `docs/product/world-vision.md`, and replaces the four drafts. **Built** the same day (S0–S4); acceptance evidence, deviations and open items are in `docs/status/verification-report.md` §7 and `TASKS.md` (Milestone W).
>
> **Decision log:** DL-009 (the living-world pivot), DL-010 (this architecture), DL-011 (town lighting) and DL-012 (agents and dispatch).

## 0. Decisions (one per conflict)

- **Packages.** Two new pure packages, `packages/town` and `packages/sim`. `world-engine` stays the per-session diorama, so `ReplayIndex.stateAt == live` still holds. *(Rejected: one merged package.)*
- **Contracts.** They go in `packages/events/src/world.ts`. *(Rejected: `sim/protocol.ts`.)*
- **Agent code.** It goes in `runtime/src/agents/`. *(Rejected: `packages/integrations`, whose name clashes with `integrations/`.)*
- **Clock.** One tick is 1 sim minute, stored as an integer. Speeds are `0|1|4|16`. Agent interiors keep wall time. *(Rejected: `0|1|5|20` and `tickHz`.)*
- **Navigation.** A raster grid with one BFS distance field per door, reusing `Motion` and `positionAt`. *(Rejected: Dijkstra over anchor nodes.)*
- **Interiors.** An interior occupies its building's footprint, and furniture `uses` are slots (no queues). The agent HQ is `research-campus` at 0.5 scale.
- **State flow.** One `applyEvent` serves host, replay and Studio. SSE sends a snapshot, then raw event batches. The resident roster lives in `world.created`. *(Rejected: delta frames, and a `command.applied` event.)*
- **Health.** Six states, plus a separate `attention` field (§2).
- **Binding.** First by dispatch session id, then by the longest `realpath(hook.cwd)` prefix, then through Arrivals and a manual claim. *(Rejected: pairing codes.)*
- **Organisations.** One `org_` id space. Agents belong to `org_home`.
- **Dispatch.** `dontAsk` with allowlists only. *(Rejected: `bypassPermissions`.)*
- **Studio.** New state lives in `world/store.ts`. `/` is the world, and existing pages stay. No agent building is pre-placed. The sky follows sim time (DL-011).
- **Migrations.** `MIGRATIONS[3]` holds the world tables and `MIGRATIONS[4]` the agent tables. Both are reserved in S0.

## 1. Packages and flow

```
events/src/world.ts, world-protocol.ts   commands, events, snapshot, ALLOWED_SOURCES, HTTP/SSE types
town/src     schema compile raster nav lots decorate rng hash                       deps: zod
sim/src      needs schedule decide occupancy interact step apply explain replay generate   deps: events, town
runtime/src  world/{world-store,world-host,projector} agents/{registry,binding,health,capabilities,local-roots}
             dispatch/{claude-cli,dispatch-manager} http/{world,agents,dispatch}.ts
worlds/runloop-commons/{town.json,interiors/*.json}
studio/src   world/{store,link,interpolate,attention,entityIndex} town/ components/{world,panels,agents}/
```

**Flow:**
1. Hooks feed the existing tracer, unchanged.
2. The `projector` turns run events into world commands.
3. `WorldHost` validates them, steps the sim, commits and publishes.
4. Studio applies the same events over SSE.

## 2. Contracts (frozen in S0)

```ts
type Tick = number; type WorldSpeed = 0|1|4|16;
type WorldProvenance = 'simulation'|'user'|'external-agent'|'system'|'inferred';
type CommandSource = 'user'|'external-agent'|'system';
type RunCause = {runId:string; seqFrom:number; seqTo:number};
type ConnectionHealth = 'not_connected'|'awaiting_first_event'|'live'|'idle'|'offline'|'unknown';
type AgentAttention = 'none'|'permission_requested'|'incident'|'dispatch_awaiting_approval';
type WorldCommand =
 | {type:'clock.set'; speed:WorldSpeed}
 | {type:'building.set_open'; buildingId:string; open:boolean}
 | {type:'agent.house'; agentId:string; lotId:string; displayName:string; hue:string}
 | {type:'agent.connection'; agentId:string; health:ConnectionHealth; attention:AgentAttention}
 | {type:'agent.session'; agentId:string; runId:string; phase:'started'|'ended'; outcome?:RunOutcome}
 | {type:'agent.activity'; agentId:string; runId:string; counts:Partial<Record<ToolCategory,number>>;
    execState:'working'|'waiting'|'awaiting_approval'|'idle'; helpers:number; openIncidents:number}
 | {type:'agent.dispatch'; agentId:string; dispatchId:string; phase:'approved'|'running'|'finished'; outcome?:DispatchOutcome};
const ALLOWED_SOURCES = {'clock.set':['user'], 'building.set_open':['user'], 'agent.house':['user','system'],
  'agent.connection':['system'], 'agent.session':['external-agent'], 'agent.activity':['external-agent'],
  'agent.dispatch':['user','system']} satisfies Record<WorldCommand['type'], CommandSource[]>;
interface CommandEnvelope {id:string; source:CommandSource; inferred?:boolean; cause?:RunCause; command:WorldCommand}
type RejectCode = 'forbidden_source'|'unknown_entity'|'lot_unavailable'|'not_housed'|'invalid';
interface WorldEvent {seq:number; tick:Tick; type:WorldEventType; prov:WorldProvenance;
  obs?:'observed'|'executed'; cmdId?:string; actor?:string; cause?:RunCause; p:unknown}
interface ResidentState {idx; id; name; role; homeId; workId; traits; outfit; place:Place; slotId;
  action:'sleep'|'rest'|'eat'|'work'|'socialize'|'stroll'; motion:{path:Cell[]; startTick}|null;
  needs:[NeedTrack,NeedTrack,NeedTrack] /* {v0,rate,t0} ×1000 */; until:Tick; lastDecisionSeq}
type Place = {kind:'outdoor'; spotId:string|null} | {kind:'building'; buildingId:string};
interface AgentPresence {agentId; buildingId; displayName; hue; health; attention; activeRunId; counts; execState; helpers; lastCause}
interface WorldSnapshot {worldId; simVersion; contentHash; seq; tick; speed; prevSpeed; residents; buildings; agents; affinity}
// SSE frames: 'snapshot' | message {events} (id = last seq) | 'clock' {tick, speed, wallMs, lagging}
```

**Events by provenance**
- **system:**
  - `world.created {townId, contentHash, seed, simVersion, startTick, roster}`
  - `world.resumed_after_offline {offlineWallMs}`
  - `world.sim_upgraded`
  - `agent.connection_changed`
- **user:** `world.clock_changed`, `building.open_changed`.
- **user or system:** `agent.housed`, `agent.dispatch_changed`.
- **simulation:**
  - `resident.decided {r, a, place, slotId, reason, block, needs:[h,e,s], top:[action, placeId, total, needPart, schedPart, travelPart]×3}`
  - `resident.departed {r, route:{from, rle}, startTick, dest}`
  - `resident.arrived`
  - `interaction.happened {a, b, placeId, dAffinity}`
- **external-agent or inferred, always with a `cause`:** `agent.session_changed`, `agent.activity_observed`.
- **same as the command's source:** `command.rejected {cmdId, code}`.

**Ids**
- Town ids match `^(dst|lot|bld|spot|org)_[a-z0-9_]+$`.
- Residents are `res_0001` and up.
- Agents, workspaces and dispatches use uuids prefixed `agt_`, `wsp_` and `dsp_`.

**Town file (`runloop.town` v1)**
- **Top-level fields:** `size [96,72]`, `walkCellsPerMinute: 3`, `districts`, `roads`, `lots`, `buildings {archetype, footprint, door, interior, orgId, hours}`, `spots`, `orgs`, `roles`, `names`, `weights`, `decoration`.
- **Interiors:** `{grid, furniture {uses [{cell, pose}], tags}}`.
- **Validation:** `compileTown()` reports every problem at once, like `compileWorld`. It checks for:
  - overlaps;
  - unreachable doors;
  - an interior `D` cell that doesn't match the building's door;
  - agent lots that don't face a road;
  - duplicate ids.
- **Hash:** `contentHash` is `fnv1a64(canonicalJson)`.

**Runloop Commons** starts with 80 residents across Civic Atrium, Hearth Row, Market Street, Research Park and the Agent District (six 12×10 lots).

## 3. Simulation

```ts
createWorld(town, {worldId, seed, population, startTick}): EventDraft[]
validateCommand(s, town, env): {ok:true}|{ok:false; code:RejectCode}
step(s, town, tick, inputs, emit:(d:EventDraft)=>WorldEvent): void   // emit assigns seq and applies at once
applyEvent(s, e): SimState                                           // the only mutator
explain(decided): Explanation   // {subject, atSeq, chosen, alternatives}; factor {text, source:{seq, field}}
class WorldReplay { stateAt(seq): SimState }                          // checkpoint + fold
```

`step(T)` runs four phases:

1. **Inputs.** Commands apply in submit order. Each is checked against `ALLOWED_SOURCES` and the entity rules, then emits its effect or `command.rejected`. While the world is paused, only this phase runs.
2. **Wake.** A tick-bucket queue wakes residents on four triggers:
   - arrival, at `ceil(startTick+(len−1)/3)`;
   - a need crossing its threshold, at `t0+ceil((thr−v0)/rate)`;
   - a schedule boundary, jittered by ±20 min;
   - `until` expiring.
3. **Decide.** Due residents are processed in idx order.
   - **Candidates (at most 10):**
     - work, during work hours;
     - eat at home, or at one of the 2 nearest open food places with a free slot;
     - sleep or rest;
     - socialise;
     - stroll;
     - stay.
   - **Score**, in integer arithmetic: `Σw·u²/100 + sched + trait − k·travelMin + hash32(seed,T,idx,'dec')%30`.
   - **Choice:** the highest score wins. Ties go to the lower action ordinal, then the lower place id.
   - **Effects:** emit `decided` and reserve the slot. If the place changes, also emit `departed`.
   - **Closed destination:** residents heading to it re-decide in the same tick (`dest_closed`).
4. **Interact.** Residents who have socialised in the same place for at least 5 min pair up by hash, at most once every 30 min.

**Needs.** Needs are closed-form and re-anchored only when the action changes, so sleeping residents cost nothing to simulate. Weights and schedules are data in `town.json`.

**Liveliness floor.** At least 25% of residents are outdoors between 08:00 and 20:00, and at least 3% at night. New worlds start at 08:00.

**Explanations.** They are built only from the recorded `resident.decided` event, for example "Hunger 72/100 ← seq 812 needs[0]". They are labelled "Simulated resident · rule-based decision" and never invent a reason.

## 4. Runtime

### 4.1 Host

```ts
class WorldHost { constructor(o:{db; town; now:()=>number; seed?; population?}); start(); stop():Promise<void>;
  submit(env):Promise<{ok:true; seq; tick}|{ok:false; code:RejectCode}>; snapshot(); info(); lagMs();
  subscribe(fn:(batch:readonly WorldEvent[])=>void):Unsubscribe }
```

**Ticking**
- Every 50 ms the host runs the ticks that are due: `anchorTick + floor((now−anchorWall)·speed/1000) − tick`.
- At most 40 ticks run per wake. If more are due, the host reports `lagging` and drops them rather than catching up.
- Only the host reads the clock.

**Persistence**
- Every 250 ms or every 500 events, one `tx` (`store/db.ts`) writes the events together with `tick`, `last_seq` and `speed`.
- Events are published only after the commit, as `recorder.ts` does.

**Checkpoints and retention**
- A checkpoint is taken every 10 wall-minutes, at sim midnight and on stop.
- The latest 24 checkpoints are kept, plus one per day for 14 days.
- Ambient events are kept for 3 sim days.

**Boot**
1. Fold forward from the latest checkpoint.
2. Append `world.resumed_after_offline`.
3. If the sim version changed, also append `world.sim_upgraded`.

The `town_json` stored in the database takes precedence over the file on disk. Setting `RUNLOOP_WORLD=off` restores today's runtime.

### 4.2 Schema

```sql
-- MIGRATIONS[3]; every column NOT NULL except host_stopped_at, actor, cmd_id
CREATE TABLE worlds (world_id TEXT PRIMARY KEY, town_id TEXT, content_hash TEXT, town_json TEXT, seed INTEGER,
  sim_version INTEGER, tick INTEGER, last_seq INTEGER, speed INTEGER, prev_speed INTEGER, created_at TEXT, host_stopped_at TEXT);
CREATE TABLE world_events (world_id TEXT, seq INTEGER, tick INTEGER, type TEXT,
  prov TEXT CHECK (prov IN ('simulation','user','external-agent','system','inferred')), actor TEXT, cmd_id TEXT,
  ambient INTEGER, body TEXT, PRIMARY KEY (world_id, seq)) WITHOUT ROWID;
CREATE UNIQUE INDEX world_cmd_once ON world_events (world_id, cmd_id) WHERE cmd_id IS NOT NULL;
CREATE INDEX world_events_by_actor ON world_events (world_id, actor, seq);
CREATE TABLE world_checkpoints (world_id TEXT, seq INTEGER, tick INTEGER, sim_version INTEGER, state_hash TEXT,
  state_gz BLOB, PRIMARY KEY (world_id, seq)) WITHOUT ROWID;
-- MIGRATIONS[4]: absolute paths only in workspace_roots, read only by agents/local-roots.ts
--   agents(agent_id PK, display_name, hue, org_id, lot_id UNIQUE, housed)  workspaces(workspace_id PK, agent_id UNIQUE, label, path_hint)
--   workspace_roots(workspace_id, root_realpath UNIQUE)  agent_connections(agent_id PK, first_event_at, last_envelope_at, dispatch_enabled)
--   session_bindings(session_id PK, agent_id, method)  org_policies(org_id PK, dispatch_json)  audit_log(id, at, action, detail_json)
--   dispatches(dispatch_id PK, agent_id, session_id UNIQUE, argv_template_json, task_redacted, status, pid, exit_code, cost_usd, outcome)
```

### 4.3 Agents

**Hooks**
- Add `TraceSessionManagerOptions.onSessionSeen({sessionId, runId, cwd})`. The cwd stays in memory only.
- Add `Recorder.subscribeAll`.

**Bindings.** A binding is fixed per session id, and continuation segments inherit it. Claiming a session backfills its earlier activity.

**Health.** `deriveHealth` is pure, and the first rule that matches wins:
1. `unknown`: ingest is off.
2. `not_connected`: no workspace root yet.
3. `awaiting_first_event`: no event yet.
4. `live`: a dispatch is running, or an open run had an event in the last 5 min.
5. `idle`: a run is open.
6. `offline`: anything else. A restart lands here, because `recoverInterrupted` has already closed every open run.

**Projector.** It folds bound runs with `reduceExecution` and submits three commands:
- `agent.session`;
- `agent.activity`, at most once per wall second, keyed `act:<runId>:<seqTo>`;
- `agent.connection`, when it changes.

Each command is `external-agent` with `obs: observed`, or `inferred` when it cites idle-sweep or interrupt events. Dispatched runs are also `observed`, because Claude Code ran the tools, not Runloop.

**Capabilities**

| Capability | When available |
|---|---|
| observe | After the first event |
| inspect | Once a session exists |
| submit_task | `needs_setup` until the CLI probe and the policy both pass |
| cancel | For running dispatches |
| message, control | `unsupported`, with the reason shown |

### 4.4 Dispatch v1 (S4)

**Preview.** The request is checked against the org policy.
- **Defaults:** haiku, a $0.25 budget (capped at $1), a 10-min timeout.
- **Presets:** Read-only (`Read Grep Glob`), or Edit+test, which adds `Edit Write "Bash(pnpm test:*)"`.
- **Approval nonce:** single use, kept in memory, valid for 5 min, and bound to `sha256(argv+cwd+envKeys)`.

**Spawn.** This requires an allowed Origin, a JSON body and the nonce. The runtime re-checks the workspace realpath, then runs:

```
claude -p <task> --session-id <uuid> --permission-mode dontAsk --allowedTools … --model … --max-budget-usd … --output-format stream-json --verbose
```

- **Process:** `shell:false`, in its own process group.
- **`--plugin-dir`:** passed only if the workspace has never sent a hook.
- **Environment allowlist:** `PATH`, `HOME`, `ANTHROPIC_API_KEY` (never stored) and `RUNLOOP_URL`. `CLAUDE_CODE_SESSION_ID` is stripped.

**Lifecycle**
- `claude-cli.ts` probes the CLI's flags first.
- Output is capped at 1 MiB, and the final `result` is stored as reported.
- Cancel sends SIGTERM, then SIGKILL after 10 s (as in `sandbox/command.ts`).
- After a restart, a dispatch whose pid is still alive is `orphaned`; otherwise it is `lost`.
- Every step is written to `audit_log`.

**UI copy:**
- "Billed to your Anthropic account"
- "Edits land in your working tree"
- "Claude Code reports done"

### 4.5 API

All writes go through the guards in `http/app.ts`.

```
GET  /api/world  |  /api/world/town  |  /api/world/snapshot  |  /api/world/events?after&limit&actor&type&prov
GET  /api/world/stream        SSE per http/sse.ts; Last-Event-ID = world seq; >5k behind → snapshot; clock 1 Hz
GET  /api/world/explain?ref=resident:res_0012&atSeq
POST /api/world/commands      {id, command} → 202; source always 'user'; body with source/prov → 400
GET|POST /api/agents, GET /api/agents/:id    AgentSummary {agentId, displayName, buildingId, health, attention,
                              capabilities, workspace{label, pathHint}, sessions}; POST {displayName, lotId, workspace:{path}|{fromSessionId}}
GET  /api/agents/arrivals, POST /api/agents/:id/claim
S4:  POST /api/agents/:id/dispatches/preview, POST /api/dispatches, GET /api/dispatches/:id[/stream], POST …/cancel
```

**Adding an agent:**
1. `POST /api/agents` inserts the agent with `housed=0`.
2. It submits `agent.house` with id `house:<agentId>`.
3. If the command is rejected, the insert is rolled back. On success, `housed` becomes 1.

At boot, any agent still unhoused is resubmitted.

## 5. Studio

> **Updated by DL-014 (2026-10-18), the immersive town.** On `/` the chrome below became a game HUD over a full-screen world: no mode rail, context panel or ticker (the hotbar, anchored entity cards and notifications replace them), Lab and Intelligence open as sheets in the town instead of linking to `/experiments` and `/traces`, and `?overlay=` opens a sheet by link. The panels' content and truth rules are unchanged. See `docs/design/design-system.md` ("The town") and `apps/studio/src/world/README.md`.

**Routes**
- `/` renders `WorldHome`. `world/link.ts` parses `?mode=explore|agents|intelligence|lab&focus=kind:id&cam=`.
- **Agents mode** focuses the Agent District and lists agents and Arrivals.
- **Lab** opens `/experiments`.
- **Intelligence** shows the World Log and links to `/traces`.
- `/world?run=` gains the breadcrumb "Agent District › {building} › Session #n" and a "Back to town" link.

**Chrome**
- A clock showing "Day 3 · 14:20".
- Speed controls ⏸ 1× 4× 16×, captioned "Simulated time ×k. Real agents run at real speed".
- "● 1 agent live".
- **Add to World**.
- `ModeRail`, `ContextPanel` and `AttentionTicker`.

**Panels**
- **Resident:** ◇ Simulated, Now, Why (factors without a source are dropped), needs, schedule, relationships, Follow.
- **Building:** occupancy n/cap, Enter.
- **Agent building:**
  - health shown as text and icon, with "last event 12 s ago";
  - capability chips with reasons;
  - workspace label and pathHint;
  - sessions (interior, `/traces`, Compare);
  - Assign task;
  - "Real · Claude Code · observed".

  There is **no Why** on agent buildings.

**Rendering (`town/`)**
- **Static scene:**
  - Ground is merged per chunk.
  - Buildings are instanced per archetype, with `aLit` set when occupied.
- **Residents:**
  - One instanced body of about 320 triangles, animated by a shader rig. `rig/residentRig.ts` is the CPU reference.
  - Above 28 px they are fully rigged. Between 10 and 28 px they bob. Below 10 px they are dots. Tier changes use ±15% hysteresis.
- **Agents:** `scene/Character.tsx`, at most 12.
- **Interiors:**
  - Only the focused building mounts its interior, as a `classifyWalls` cutaway.
  - The agent house mounts `scene/{Board,Stations,Paths,Characters,Effects}` at 0.5 scale from `StudioStore`.
- **Sky:** `town/sky.ts` lives in Studio only. A ΔE test keeps lime out of the palette.
- **Labels:** at most 24.
- **Adaptive quality:** `'auto'` steps down when p95 frame time exceeds 22 ms for 2 s.
- **Interpolation:** `tick + (now−receivedAt)·speed/1000`, clamped to 2 s ahead.

**Accessibility**
- `EntityDirectory` is a tree whose nodes act like clicks in the 3D view.
- ⌘K finds entities.
- `WorldMap` takes over below 760 px or when WebGL is unavailable.
- Reduced motion cuts the camera instead of animating it.

**Add to World** has three steps:
1. Claude Code and a name.
2. A lot.
3. An Arrival, or a typed path. The path must exist, sit outside the data dir and not already be bound.

The building then appears dimmed, labelled "Waiting for first event".

## 6. Truth rules (each is a test)

1. **P1.** `prov` is one of the 5 values. Phases 2–4 emit only `simulation`. An effect event's `prov` equals its envelope's source, or is `inferred`.
2. **P2.** Commands received over HTTP are always `user`. A body containing `source` or `prov` gets 400.
3. **P3.** A table-driven test checks that every forbidden source is rejected with `forbidden_source`. An unhoused agent gets `not_housed`.
4. **P4.** Every agent event's `cause` points into a run bound to that agent, and its counts equal that range's tool calls.
5. **P5.** Projecting `s1-basic` and `s2-subagents` leaves `canonicalJson(residents)` identical to a control world's.
6. **P6.** No resident slot, route end or place is inside an agent lot.
7. **P7.** Ingesting with the world paused produces the same run events as with the world off. Presence still updates; the tick holds.
8. **P8.** The workspace realpath appears 0 times in world tables, snapshots and API responses.
9. **P9.** An agent that has sent no events is never `live`. After a restart it is `offline`.
10. **P10.** Every Why factor's `seq` exists, and the chosen action is the argmax of `top`. Agent panels have no Why. "Real" appears only on `external-agent` entities.
11. **P11.** `sim` and `runtime/src/world` never import `dispatch`. Nothing spawns without a valid nonce, and the spawned argv equals the preview.

## 7. Build order and workstreams

**S0: contracts.** All three engineers, about 3 days, one PR containing:
- `events/src/world.ts` and `world-protocol.ts`, with parse tests;
- the town schema and layout;
- migrations 3 and 4;
- the `Grid` interface in `world-engine/src/grid.ts`;
- fixtures in `sim/test/fixtures/`.

After S0, any contract change needs a reviewed PR that also updates the fixtures.

**Workstreams**
- **A, engine.** Owns `packages/{town,sim}`, `runtime/src/world`, `http/world.ts`, `worlds/runloop-commons` and `runtime.ts`.
  - S1: compile, nav, host and stream, with `agent.*` apply done early. S1 ends with a generated fixture day.
  - S2: phases, explain, replay and the benchmark.
- **B, Studio.** Owns `studio/src/{world,town,components/world,components/panels}`, `app/page.tsx`, `AppShell.tsx` and `scripts/{perf-town,e2e-world}.mjs`.
  - S1: shell, town, clock, map and directory, built against the fixtures.
  - S2: residents, panels, Why, World Log and ⌘K.
  - S3: Add to World and AgentHouse.
- **C, agents.** Owns `runtime/src/{agents,dispatch}`, `world/projector.ts`, `http/{agents,dispatch}.ts`, the tracer hooks and `components/agents`.
  - From day 3: registry, binding, health and projector.
  - S3: integration with B.
  - S4: dispatch.

**Order**
- S0 comes first, then S1 (W1), S2 (W2) and S3 (thin W4, observe only).
- S4 ships only if S1–S3 are green; otherwise it moves to the next slice.
- Leave `core/src/compare.ts` and `ExperimentsPage.tsx` alone while compare work is in flight.

## 8. Acceptance

**S1**
- **Automated:**
  - The Commons compiles.
  - Every door reaches every other door, and descending the distance fields gives the same paths as `bfs`.
  - At least 6 agent lots front a road.
  - `contentHash` and `decorate` are identical across processes.
  - With a fake clock, 10 s at speed 4 gives exactly 40 ticks. Pause holds the tick, and resume restores the previous speed.
  - A restart keeps ids and names and appends `resumed_after_offline`.
  - After a SIGKILL, the world resumes at the last flushed seq.
  - Folding the SSE stream reproduces the server's state hash, and a reconnect leaves no gap.
  - Legacy URLs still work.
- **Manual:** after a restart, the town is identical.
- **Screenshots:** Town, District and Street views, in both themes, at 1280, 1440, 1920 and 390 px.

**S2**
- **Automated:** run one sim day at 80 and at 120 residents, with no input.
  - At least 95% of residents do at least 3 actions, sleep at least 5 h and eat at least twice.
  - No awake resident goes 6 h without deciding.
  - The liveliness floor holds.
  - Closing the café gives 0 new routes to it, and residents already on the way re-decide in the same tick.
  - P10 holds.
  - A replayed `explain(atSeq)` matches the live one.
- **E2E:** on a fresh world, at least 48 of 80 residents are moving within 3 s, and ⌘K on a name opens that resident's Why.
- **Manual:** follow one resident through lunch at 4×; the Why matches what happened.
- **Screenshots:** Market Street, the café interior, a Why panel, night.

**S3** (`agents.int.test.ts`)
- **Automated:**
  - Add to World on a temp repo shows `awaiting_first_event`.
  - Running `s1-basic` and `s2-subagents` inside the root binds by path and goes `live`. Counts equal the tool calls, the tracer goldens are unchanged, and P4, P5, P7 and P8 hold.
  - A session from outside the root goes to Arrivals, and claiming it backfills.
  - After a restart, the building survives and the agent reads `offline`.
- **Manual (real plugin):**
  - The agent is live within 2 s of the first hook.
  - The interior matches Live World.
  - The clock keeps running after the session ends.
- **Screenshots:** the waiting, live, idle and offline states, and the interior.

**S4**
- **Fake `claude`:** it logs argv and replays hooks, then exits, hangs or ignores SIGTERM. The tests check that:
  - argv equals the preview;
  - a bad, reused or expired nonce gets 403 or 409;
  - a foreign Origin gets 403;
  - a moved root gets 409;
  - cancel kills the process group;
  - audit rows are written.
- **Opt-in real run** (`RUNLOOP_REAL_CLAUDE=1`, haiku, under $0.05):
  - "Create hello.txt" ends bound by dispatch and `completed` with a cost, and the file exists.
  - A cancel at the first PreToolUse reads `cancelled` within 2 s.

**Every milestone:** `pnpm -r typecheck`, `pnpm test` (all 632 existing tests pass), `pnpm build` and `claude plugin validate --strict`.

## 9. Budgets

| Area | Budget | Measured by |
|---|---|---|
| Sim | Tick p99 ≤ 2 ms at 120 residents. At 300 residents: tick p99 ≤ 5 ms, max ≤ 15 ms, and one sim day ≤ 2 s. ≤ 6k events and ≤ 1 MB per day. Checkpoint ≤ 100 KB gzipped. | `sim/bench/tick.bench.ts` on Node 22 (CI allows 2×) |
| Runtime | ≤ 50 MB after 7 wall-days at 1×. Boot ≤ 300 ms. Event-loop lag p99 ≤ 20 ms at 16× while ingesting 50 envelopes/s; add a worker only if this fails. | Runtime tests, `monitorEventLoopDelay` |
| Render | Draw calls ≤ 120 (town), 150 (street), 250 (interior). ≤ 400k triangles. JS ≤ 4 ms per frame with 500 actors. | `scripts/perf-town.mjs` under SwiftShader, via `window.__runloopPerf` |
| Real GPU | M1 or Iris Xe, 1440×900, street level, 300 residents: p50 ≤ 16.7 ms, p95 ≤ 33 ms | `--gpu`, logged in the verification report |

**Determinism**
- Seed 42 with 300 residents, 7 days and 50 commands gives the same hash over 2 runs and 2 processes.
- Replay equals live at every checkpoint.
- A re-run from day 3 reproduces the rest of the log.
- Invariants hold every tick: positions are walkable, occupancy ≤ capacity, and needs stay within [0, 100].
- `purity.test.ts` bans `Date`, `Math.random`, `performance`, transcendental `Math` functions and timers in `packages/{town,sim}`.

## 10. Reuse vs replace

**Reuse:**
- `packages/{events,core,replay}`, the tracer and `store/db.ts`;
- the `http/sse.ts`, `recorder.ts` and `sandbox/command.ts` patterns;
- `acquireLock`;
- `scene/*.tsx`, `labelLayout.ts`, `palette.ts` and `ui/*`;
- Traces and Compare.

**Extend:**
- `grid.ts`, `migrations.ts`, `session-manager.ts`, `recorder.ts` and `runtime.ts`;
- `CameraRig`, `prefs.ts`, `AppShell.tsx`, `useStudioCommands.ts` and `WorldPage.tsx`.

**Replace:**
- the `/` redirect;
- `StudioSidebar`, except on run pages;
- the contents of `IntegrationsPage`;
- per-character crowd components;
- town-wide bloom.

`run-manager.ts` stays, for the demo only.

## 11. Cuts

| Deferred | Why |
|---|---|
| Build and Society modes, org tasks, meetings | Part of W3 |
| History scrubber, forks, re-run UI | Part of W5. The event log and `WorldReplay` land now. |
| LLM residents | Part of W6, and they cost money |
| Pairing codes | `hook.cwd` plus Arrivals is enough |
| Personas, catch-up, onboarding v2 | After S3 |
| Message and control, Codex, worktree dispatch | No adapter exists yet |
| Worker threads, simulating while Runloop is off | Not needed. When Runloop is off, the world is honestly shown as paused. |

## 12. Risks

| Risk | Mitigation |
|---|---|
| Novelty over utility | Buildings are one step from Traces and Compare. Measure return visits and actions taken in the world. |
| Empty streets | Liveliness tests, an 08:00 start, lit windows. |
| Mounting the diorama inside the town | Spike it in week 1 of S3. Fallback: Enter opens `/world?run=`. |
| Nondeterminism | Fixed-point arithmetic, the purity scan, cross-process hashes. |
| Database growth | Retention and a storage test. |
| A session binds to the wrong agent | The longest realpath prefix wins, and claims show the pathHint. |
| Dispatch cost or side effects | Nonce, allowlists, budget caps and the audit log. S4 is optional. |
| Claude Code CLI flags drift | A flag probe, fake-binary tests, and one real run per release. |