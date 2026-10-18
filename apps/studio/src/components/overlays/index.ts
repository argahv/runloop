/**
 * In-world engineering overlays (immersive contract §4, §5.4): the sheets
 * that bring Traces, compare, the World Log, sessions and connections into
 * the town; the session strip inside an agent's building; and the
 * navigation that keeps every run link inside the world on `/`.
 *
 * HUD mounts `<OverlayHost sheet={…} />` for the right-hand sheets and
 * `<SessionStrip />` inside an agent building, sizes its insets with
 * `sheetWidth`, and routes its run links through `useStudioNav()`.
 */
export { SHEETS, SHEET_IDS, isSheetId, sheetWidth, NARROW_SHEET_W, type SheetFrame, type SheetId } from './sheets';
export { OverlayHost, SheetContent } from './OverlayHost';
export { SessionStrip } from './SessionStrip';
export { default as TraceSheet } from './TraceSheet';
export { default as SheetScroll } from './SheetScroll';
export { default as OpenInWorld } from './OpenInWorld';
export {
  NavButtonLink,
  StudioNavProvider,
  compareRequests,
  ownerBuilding,
  traceSheetView,
  useInWorld,
  useRouterNav,
  useStudioNav,
  useWorldNav,
  worldNav,
  type StudioNav,
} from './nav';
export { fullPageHref, hasInWorldSheet, hrefForTarget, inWorldHref, inWorldTarget, parseSheetTab, SHEET_TAB_PARAM, type InWorldTarget, type TraceSheetTab } from './routes';
