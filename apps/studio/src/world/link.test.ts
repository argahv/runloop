import { describe, expect, it } from 'vitest';
import { ROUTES } from '../state/deeplink';
import { legacyRedirect, modeForKey, modeOfRoute, parseWorldLink, worldHref, writeWorldLink } from './link';

const q = (s: string) => new URLSearchParams(s);

describe('world links', () => {
  it('parses mode, focus and camera, with explore as the default', () => {
    expect(parseWorldLink(q(''))).toEqual({ mode: 'explore', focus: null, cam: null });
    expect(parseWorldLink(q('mode=agents&focus=resident:res_0012&cam=40.5,22,1.75'))).toEqual({
      mode: 'agents',
      focus: { kind: 'resident', id: 'res_0012' },
      cam: { x: 40.5, z: 22, zoom: 1.75 },
    });
  });

  it('ignores modes that do not work yet and malformed values', () => {
    expect(parseWorldLink(q('mode=build')).mode).toBe('explore');
    expect(parseWorldLink(q('mode=society')).mode).toBe('explore');
    expect(parseWorldLink(q('focus=nonsense')).focus).toBeNull();
    expect(parseWorldLink(q('focus=planet:x')).focus).toBeNull();
    expect(parseWorldLink(q('cam=1,2')).cam).toBeNull();
    expect(parseWorldLink(q('cam=1,2,0')).cam).toBeNull();
    expect(parseWorldLink(q('cam=a,b,c')).cam).toBeNull();
  });

  it('round-trips and keeps unrelated parameters', () => {
    const p = q('x=1&mode=lab');
    const link = { mode: 'intelligence' as const, focus: { kind: 'agent' as const, id: 'agt_x' }, cam: { x: 1.234, z: 5, zoom: 2 } };
    writeWorldLink(p, link);
    expect(p.get('x')).toBe('1');
    expect(parseWorldLink(p)).toEqual({ ...link, cam: { x: 1.23, z: 5, zoom: 2 } });
    expect(worldHref({})).toBe('/');
    expect(worldHref({ mode: 'agents' })).toBe('/?mode=agents');
    expect(worldHref({ focus: { kind: 'building', id: 'bld_corner_cafe' } })).toBe('/?focus=building%3Abld_corner_cafe');
  });

  it('maps routes to modes', () => {
    expect(modeOfRoute('/', q('mode=agents'))).toBe('agents');
    expect(modeOfRoute('/')).toBe('explore');
    expect(modeOfRoute('/experiments/')).toBe('lab');
    expect(modeOfRoute('/traces')).toBe('intelligence');
    expect(modeOfRoute('/world')).toBe('agents');
    expect(modeOfRoute('/overview/')).toBe('agents');
    expect(modeOfRoute('/settings')).toBeNull();
  });

  it('modes switch with keys 1–4', () => {
    expect(['1', '2', '3', '4', '5', 'a'].map(modeForKey)).toEqual(['explore', 'agents', 'intelligence', 'lab', null, null]);
  });
});

describe('legacy URLs land where they did before the world', () => {
  // Before: `/` redirected every run deep link with routeForDeepLink and kept the query.
  const cases: [string, string][] = [
    ['run=r1', `${ROUTES.world}?run=r1`],
    ['run=r1&view=graph', `${ROUTES.world}?run=r1&view=graph`],
    ['run=r1&view=world&event=7&agent=main', `${ROUTES.world}?run=r1&view=world&event=7&agent=main`],
    ['run=r1&view=trace&event=4', `${ROUTES.traces}?run=r1&view=trace&event=4`],
    ['run=r1&at=30', `${ROUTES.world}?run=r1&at=30`],
    ['view=trace', `${ROUTES.traces}?view=trace`],
    ['event=3', `${ROUTES.overview}?event=3`],
    ['run=r1&q=test&agent=tester', `${ROUTES.world}?run=r1&q=test&agent=tester`],
  ];
  it.each(cases)('/?%s', (query, target) => {
    expect(legacyRedirect('/', q(query))).toBe(target);
  });

  it('town links and other pages stay put', () => {
    expect(legacyRedirect('/', q(''))).toBeNull();
    expect(legacyRedirect('/', q('mode=agents&focus=agent:agt_x'))).toBeNull();
    expect(legacyRedirect('/traces', q('run=r1'))).toBeNull();
    expect(legacyRedirect('/world/', q('run=r1'))).toBeNull();
  });
});
