import type { AgentSummary } from '@runloop-world/events';
import { afterEach, describe, expect, it } from 'vitest';
import { parseComparePair } from '../../state/baselines';
import { parseDeepLink } from '../../state/deeplink';
import { parseFilter } from '../../state/filters';
import { createStudioStore } from '../../state/store';
import { legacyRedirect, parseOverlay } from '../../world/link';
import { createWorldStore, MODE_PLACES } from '../../world/store';
import { fullPageHref, hasInWorldSheet, inWorldHref, inWorldTarget, parseSheetTab } from './routes';
import { NARROW_SHEET_W, SHEETS, sheetWidth } from './sheets';
import { compareRequests, ownerBuilding, traceSheetView, worldNav } from './worldNav';

const params = (href: string) => new URL(href, 'http://studio.test').searchParams;

describe('sheet frames and widths (contract §1.1 O, §1.2)', () => {
  it('wide sheets are clamp(720, 60vw, 1180); narrow sheets 440; phones the whole width', () => {
    expect(sheetWidth('trace', 1440)).toBe(864);
    expect(sheetWidth('compare', 1920)).toBe(1152);
    expect(sheetWidth('trace', 1280)).toBe(768);
    expect(sheetWidth('compare', 1100)).toBe(720);
    expect(sheetWidth('trace', 2400)).toBe(1180);
    for (const id of ['log', 'sessions', 'connect'] as const) expect(sheetWidth(id, 1440)).toBe(NARROW_SHEET_W);
    expect(sheetWidth('trace', 390)).toBe(390);
    expect(sheetWidth('log', 760)).toBe(760);
  });

  it('a wide sheet always leaves some of the world in view', () => {
    for (let vw = 761; vw <= 2600; vw += 37) expect(sheetWidth('trace', vw)).toBeLessThanOrEqual(vw - 32);
  });

  it('the World Log and compare frame the same places as their modes', () => {
    expect(SHEETS.log.place).toEqual(MODE_PLACES.intelligence);
    expect(SHEETS.compare.place).toEqual(MODE_PLACES.lab);
    expect(SHEETS.trace.place).toBeNull();
  });
});

describe('legacy pages open in the world (contract §4.1–4.2)', () => {
  const cases: [string, string][] = [
    ['/traces?run=r1&event=12', '/?overlay=trace&run=r1&event=12'],
    ['/traces/?run=r1&agent=ag-1&at=5&q=pytest&status=error', '/?overlay=trace&run=r1&agent=ag-1&at=5&q=pytest&status=error'],
    ['/traces', '/?overlay=trace'],
    ['/world?run=r1', '/?overlay=trace&tab=world&run=r1'],
    ['/world/?run=r1&view=graph&event=3', '/?overlay=trace&tab=world&run=r1&view=graph&event=3'],
    ['/experiments?a=base&b=cand', '/?overlay=compare&a=base&b=cand'],
    ['/experiments/', '/?overlay=compare'],
    ['/overview', '/?overlay=sessions'],
    ['/integrations/', '/?overlay=connect'],
    ['/settings', '/'],
    ['/?mode=agents', '/?mode=agents'],
  ];
  it.each(cases)('%s → %s', (from, to) => {
    expect(inWorldHref(from)).toBe(to);
  });

  it('other origins and unknown paths are not Studio pages', () => {
    expect(inWorldTarget('https://example.com/traces?run=r1')).toBeNull();
    expect(inWorldTarget('/nope')).toBeNull();
    expect(inWorldHref('/nope')).toBe('/');
    expect(hasInWorldSheet('/settings')).toBe(false);
    expect(hasInWorldSheet('/overview')).toBe(true);
  });

  it('the world URL keeps the selection, the filter, the pair and the World tab, and never redirects back', () => {
    for (const [from] of cases.filter(([f]) => f !== '/settings' && !f.startsWith('/?'))) {
      const before = params(from);
      const after = params(inWorldHref(from));
      // A sheet link stays on the town (WorldHome's legacy redirect skips it).
      expect(legacyRedirect('/', after)).toBeNull();
      expect(parseOverlay(after)).not.toBeNull();
      const a = parseDeepLink(before);
      const b = parseDeepLink(after);
      expect([b.runId, b.seq, b.agentId, b.at]).toEqual([a.runId, a.seq, a.agentId, a.at]);
      expect(parseFilter(after)).toEqual(parseFilter(before));
      expect(parseComparePair(after)).toEqual(parseComparePair(before));
    }
    expect(parseSheetTab(params(inWorldHref('/world?run=r1')))).toBe('world');
    expect(parseSheetTab(params(inWorldHref('/traces?run=r1')))).toBeNull();
  });

  it('a plain old run link to `/` still goes to its page', () => {
    expect(legacyRedirect('/', params('/?run=r1&event=4'))).toBe('/world?run=r1&event=4');
    expect(legacyRedirect('/', params('/?run=r1&view=trace'))).toBe('/traces?run=r1&view=trace');
  });

  it('"Full page" goes back to the legacy page showing the same thing, and round-trips', () => {
    expect(fullPageHref('trace', { runId: 'r1', seq: 12 })).toBe('/traces?run=r1&event=12');
    expect(fullPageHref('trace', { runId: 'r1', worldTab: true })).toBe('/world?run=r1');
    expect(fullPageHref('trace', { runId: null })).toBe('/traces');
    expect(fullPageHref('compare', { pair: { a: 'x', b: 'y' } })).toBe('/experiments?a=x&b=y');
    expect(fullPageHref('sessions', {})).toBe('/overview');
    expect(fullPageHref('connect', {})).toBe('/integrations');
    expect(fullPageHref('log', {})).toBeNull();
    expect(inWorldHref(fullPageHref('trace', { runId: 'r1', seq: 12, at: 9 })!)).toBe('/?overlay=trace&run=r1&event=12&at=9');
    expect(inWorldHref(fullPageHref('compare', { pair: { a: 'x', b: 'y' } })!)).toBe('/?overlay=compare&a=x&b=y');
  });
});

/** A minimal agent summary for the wiring tests (only the fields the navigation reads). */
const agent = (agentId: string, buildingId: string, runIds: string[]): AgentSummary =>
  ({
    agentId,
    displayName: agentId,
    buildingId,
    sessions: runIds.map((runId, i) => ({ runId, sessionId: `s-${runId}`, segment: i, status: 'succeeded', startedAt: '2026-10-18T10:00:00Z', endedAt: null, bindingMethod: 'cwd' })),
  }) as unknown as AgentSummary;

function setup() {
  const world = createWorldStore();
  const studio = createStudioStore();
  const went: string[] = [];
  world.getState().setAgents('ok', [agent('agt_eng', 'bld_hq_eng', ['run-eng']), agent('agt_docs', 'bld_hq_docs', ['run-docs'])], [], 0);
  return { world, studio, went, nav: worldNav(world, studio, (href) => went.push(href)) };
}

describe('in-world navigation (contract §4.1, §5.4)', () => {
  afterEach(() => {
    traceSheetView.setState({ worldTab: false });
    compareRequests.setState({ pair: null });
  });

  it('a trace link opens the trace sheet at the event, on the trace views', () => {
    const { world, studio, nav } = setup();
    traceSheetView.setState({ worldTab: true });
    nav.openTrace('run-demo', { seq: 7 });
    expect(world.getState().overlay).toBe('trace');
    expect(studio.getState().runId).toBe('run-demo');
    expect(studio.getState().pendingFocus).toMatchObject({ seq: 7, agentId: null });
    expect(traceSheetView.getState().worldTab).toBe(false);
  });

  it("a run's world is its agent's building; an unowned run's is the trace sheet's World tab", () => {
    const { world, studio, nav } = setup();
    nav.openRunWorld('run-eng');
    expect(world.getState().entered).toBe('bld_hq_eng');
    expect(world.getState().overlay).toBe('none');
    expect(studio.getState().runId).toBe('run-eng');

    nav.openRunWorld('run-demo');
    expect(world.getState().overlay).toBe('trace');
    expect(traceSheetView.getState().worldTab).toBe(true);
    // Another run's Live World is not this building's: the viewer leaves it first.
    expect(world.getState().entered).toBeNull();
  });

  it("opening another agent's trace from inside a building leaves it; its own stays inside", () => {
    const { world, nav } = setup();
    world.getState().enter('bld_hq_eng');
    nav.openTrace('run-eng');
    expect(world.getState().entered).toBe('bld_hq_eng');
    nav.openTrace('run-docs');
    expect(world.getState().entered).toBeNull();
    expect(ownerBuilding(world.getState(), 'run-docs')).toBe('bld_hq_docs');
    expect(ownerBuilding(world.getState(), 'run-unknown')).toBeNull();
  });

  it('compare opens Lab mode (the compare sheet at the Lattice Lab) with the pair', () => {
    const { world, nav } = setup();
    nav.openCompare({ a: 'base', b: 'cand' });
    expect(world.getState().mode).toBe('lab');
    expect(world.getState().overlay).toBe('compare');
    expect(world.getState().camera).toMatchObject({ kind: 'focus', ref: MODE_PLACES.lab });
    expect(compareRequests.getState().pair).toEqual({ a: 'base', b: 'cand' });
  });

  it('page links open their sheet or the Esc menu; anything else navigates', () => {
    const { world, studio, went, nav } = setup();
    nav.openPage('/overview');
    expect(world.getState().overlay).toBe('sessions');
    nav.openPage('/integrations/');
    expect(world.getState().overlay).toBe('connect');
    nav.openPage('/settings');
    expect(world.getState().menu).toBe('display');
    nav.openPage('/traces?run=run-x&event=2&status=error');
    expect(world.getState().menu).toBeNull();
    expect(world.getState().overlay).toBe('trace');
    expect(studio.getState().runId).toBe('run-x');
    expect(studio.getState().filter.statuses).toEqual(['error']);
    nav.openPage('/world?run=run-y&event=3');
    expect(studio.getState().runId).toBe('run-y');
    expect(traceSheetView.getState().worldTab).toBe(true);
    nav.openPage('/experiments?a=p&b=q');
    expect(world.getState().overlay).toBe('compare');
    nav.openPage('https://example.com/docs');
    expect(went).toEqual(['https://example.com/docs']);
  });
});
