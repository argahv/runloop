# `components/overlays/`: the engineering pages inside the world

Immersive contract §4 and §5.4 (2026-10-18). The engineering pages open over
the town on `/` instead of leaving it: Traces, compare, the World Log,
sessions and connections. The town stays visible and live to the left.
Their run links open other sheets and buildings, never pages. The legacy
routes stay as full pages, unchanged at their URLs, each with an
"Open in the world" link.

| File | What |
|---|---|
| `sheets.ts` | `SheetId`, `SHEETS` (title, wide or narrow, place), `sheetWidth(id, vw)`: narrow 440, wide clamp(720, 60vw, 1180) and at most vw−32, phones full width. Pure. |
| `routes.ts` | Legacy page ⇄ world URL, pure: `inWorldTarget(href)`, `inWorldHref(href)` ("Open in the world"), `fullPageHref(sheet, state)` ("Full page"), `parseSheetTab` (`tab=world`). |
| `worldNav.ts` | `StudioNav` and `worldNav(world, studio, navigate)`, the in-world navigation over the two stores (no React, unit-tested). `traceSheetView` (World tab requested) and `compareRequests` (pair requested). |
| `nav.tsx` | `useStudioNav()`: a provider's nav, else in-world on `/`, else today's router navigation. `useWorldNav`, `useRouterNav`, `StudioNavProvider`, `useInWorld`, `NavButtonLink` (a page link that opens its sheet in the world). |
| `OverlayHost.tsx` | The sheet frame (non-modal region, focus in and back, Esc clears the trace selection then closes, "Full page", the place it frames) and `SheetContent`. |
| `TraceSheet.tsx` | The trace sheet: compact `RunHeader`, `ReplayBar`, tabs World · Timeline · Logs · Metrics · State · Metadata, the inspector. The World tab is the run's Live World; the town pauses while it shows 3D. Keeps `tab=world` and the filter in the URL while open. |
| `SessionStrip.tsx` | Inside an agent's building: session picker (Open / Recorded), the state chip from `stripMode.ts` ("Live" only when the agent is live, else "Open · idle 12m"; "Recorded · latest"; "Replay · recorded state"; icon and text), `ReplayBar` (scrubbing moves the diorama to the recorded state; "Latest" without the live dot when the agent is not live; its speeds drop out when the strip is narrow), Trace, Compare, Leave. It mounts the run world while shown, so a finished run settles inside. |
| `SheetScroll.tsx` | The scrolling body for page panels, and the `rl-sheet` container their CSS sizes grids by. |
| `OpenInWorld.tsx` | "Open in the world" on legacy pages; Settings get "Back to the world". |

## Where every page goes

| Legacy URL (still a full page) | In the world |
|---|---|
| `/traces?run=&event=&agent=&at=` + filter | `/?overlay=trace&run=…` (same parameters) |
| `/world?run=[&view=graph]` | the run's agent building (replay inside), else `/?overlay=trace&tab=world&run=…` |
| `/experiments?a=&b=` | `/?overlay=compare&a=&b=` (`mode=lab`) |
| `/overview` | `/?overlay=sessions` |
| `/integrations` | `/?overlay=connect` |
| `/settings` | the Esc menu (no URL) |

`/?run=…` without `overlay` still redirects to its page, as before
(`world/link.ts` `legacyRedirect`).

## Pages inside sheets

The page components export their content for the sheets: `TraceView`
(`pages/TraceView.tsx`, re-exported by `TracesPage`), `ComparePanel`
(`ExperimentsPage`), `SessionsPanel` (`OverviewPage`, `compact` = a list for
the narrow sheet), `ConnectionsPanel` (`IntegrationsPage`) and
`AppearanceSettings`, `RuntimeChip`, `RuntimeSettings`, `PrivacySettings`,
`ShortcutList` (`SettingsPage`). Rendered on `/` (inside the HUD's sheet
frame), the page default exports render their sheet form, so a sheet that
mounts the page component directly gets the in-world version too.

## Mounting (HUD)

```tsx
<OverlayHost sheet={isSheetId(overlay) ? overlay : null} onClose={() => store.getState().setOverlay('none')} mobile={phone} insets={{ top: 84, bottom }} />
{enteredAgent && <SessionStrip agentId={enteredAgent} onOpenTrace={…} onLeave={() => store.getState().enter(null)} />}
```

Tests: `pnpm vitest run --project studio src/components/overlays`.
