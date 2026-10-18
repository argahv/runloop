# Runloop Commons

The starter town of the world simulation (plan: `docs/architecture/world-simulation.md`). `town.json` is a `runloop.town` v1 file; the schema and its rules are in `packages/town/src/schema.ts`.

## Layout (96 × 72 cells, 3 cells per sim minute)

A ring road (Ridge Road, Eastway, Brook Road, Westway) with sidewalks on its inner side. Inside it:

| District | Where | What |
|---|---|---|
| Hearth Row | north-west | 7 houses and 3 blocks of flats on Hearth Lane and Market Street; Hearth Green with the Green Walk, the Green Circle and a community garden |
| Agent District | north-east | 6 reserved 12×10 lots on both sides of Foundry Road (never pre-placed); Northwind Studio and Foundry Works on Market Street; Foundry Yard with the First Commit statue and the Byte Bites food truck |
| Civic Atrium | centre | the plaza at the end of Commons Avenue: Town Hall, Commons Library, the clock, the Signal Board, the fountain |
| Market Street | the east–west avenue | Corner Café (with a patio on the plaza), Sunrise Bakery, Inkwell Books, Bluebird Diner, Green Basket Grocer, Tinker Tools, Lantern Tavern, Signal House |
| Research Park | south-west | Lattice Lab, the Lattice Greenhouse, the pond with its benches and reading lawn |
| Brookside | south-east | 3 cottages and Brookside Flats on Brook Road |

Homes hold 136 people (`population.max`); a new world starts with 80 at 08:00.

## Conventions

- **Ids.** Entities that events name use `dst_`, `lot_`, `bld_`, `spot_`, `org_`. Layout features use `road_`, `xing_`, `area_`, `lmk_`. An agent lot carries the `buildingId` its headquarters gets when an agent is housed.
- **Interiors** (`interiors/<id>.json`) are authored facing south, with the door on the bottom row. A building that faces another way rotates its interior; its footprint is the interior's size, rotated, and its `door` is where the interior's `D` lands (`interiorToTown` in `packages/town/src/frame.ts`).
- **Slots.** Each furniture use is a slot (`<furnitureId>#<use>@<floor>`); a building has `floors` copies of its interior's slots. Each outdoor spot cell is a slot (`<spotId>#<i>`). Furniture tags name the actions a slot serves (`sleep`, `eat`, `work`…) plus role tags (`barista`, `desk`, `study`…) that roles' `work.tag` matches.
- **Access.** `public` buildings are open to anyone during `hours`, `staff` only to their workers, `residents` only to the people who live there.
- **The agent HQ** is `interiors/agent_hq.json`: `worlds/research-campus/world.json` at 0.5 scale, exactly one 12×10 lot.
- **Colours** are warm and keep a CIEDE2000 distance of at least 12 from the Signature lime (`#B8F36A`).

## Residents (tuned in S1/S2)

The layout is unchanged since S0; the people and their days were tuned so the town stays lively (plan §3: at least 25% of residents outdoors 08:00–20:00 and 3% at night; `packages/sim/test/day.test.ts` checks it at 80 and 120 residents).

- **Roles** (shares of 81): engineers 14, researchers 8, students 9, retirees 20, lamplighters 5, and smaller trades. Lamplighters walk night rounds (19:30–08:30) and sleep by day, so the streets are never empty.
- **Schedules** stagger the working day: office, lab and day shifts start around 07:30–07:45 and take their breaks (stroll and socialise) and lunches at different times; students have a recess and a free afternoon; early and late shifts cover the edges. Each resident's boundaries are shifted by a personal ±20 min.
- **Workplaces open before their staff arrive** (cafe 06:00, bakery and greenhouse 05:30, offices and shops 07:00).
- **Weights**: the outdoorsy trait now favours any outdoor place (not just strolls), strolls are shorter (10–30 min) and tire less; benches on Commons Walk, the Green Circle, Foundry Yard and by the pond also serve a picnic lunch (`eat`).

## How the S0 layout was checked

The layout was generated and checked by a throwaway script that applies the ground layering in `schema.ts`. Since S1 `compileTown` (`packages/town/src/compile.ts`) runs every check on load: no overlaps, every door and spot cell reachable on foot from every other, each interior's `D` on its building's door, agent lots fronting a road, no walkable cell or spot in an agent lot, schedules tiling the day, enough beds and work slots at `population.max`. `packages/town/test/compile.test.ts` and `commons.test.ts` cover them.
