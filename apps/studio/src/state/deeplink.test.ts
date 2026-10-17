import { describe, expect, it } from 'vitest';
import { linkFromView, linkTo, parseDeepLink, ROUTES, routeForDeepLink, writeDeepLink } from './deeplink';

const p = (q: string) => parseDeepLink(new URLSearchParams(q));

describe('deep links', () => {
  it('parses run, view, event, agent and the playhead', () => {
    expect(p('run=r1&view=trace&event=36&agent=tester&at=30')).toEqual({ runId: 'r1', view: 'trace', seq: 36, agentId: 'tester', at: 30 });
    expect(p('')).toEqual({ runId: null, view: null, seq: null, agentId: null, at: null });
    expect(p('at=0').at).toBe(0);
    expect(p('at=-1').at).toBeNull();
  });

  it('ignores invalid views and sequences', () => {
    expect(p('view=movie&event=0').view).toBeNull();
    expect(p('event=0').seq).toBeNull();
    expect(p('event=1.5').seq).toBeNull();
    expect(p('event=abc').seq).toBeNull();
  });

  it('routes the root link to the right page', () => {
    expect(routeForDeepLink(p(''))).toBe(ROUTES.overview);
    expect(routeForDeepLink(p('run=r1'))).toBe(ROUTES.world);
    expect(routeForDeepLink(p('run=r1&view=graph'))).toBe(ROUTES.world);
    expect(routeForDeepLink(p('run=r1&view=trace&event=4'))).toBe(ROUTES.traces);
  });

  it('writes the selection and keeps unrelated parameters', () => {
    const params = new URLSearchParams('q=test&event=3');
    writeDeepLink(params, { runId: 'r1', view: null, seq: 7, agentId: null, at: null });
    expect(params.toString()).toBe('q=test&run=r1&event=7');
    expect(linkTo(ROUTES.traces, { runId: 'r1', seq: 36, agentId: 'tester' })).toBe('/traces?run=r1&event=36&agent=tester');
    expect(p(linkTo(ROUTES.world, { runId: 'r1', view: 'graph' }).split('?')[1]!)).toEqual({ runId: 'r1', view: 'graph', seq: null, agentId: null, at: null });
  });

  it('names what is on screen: the event, or the agent card (never its derived event), and a paused playhead', () => {
    const live = { mode: 'live' } as const;
    const paused = { mode: 'replay', playing: false } as const;
    expect(linkFromView({ inspectorTab: 'agent', selectedSeq: 30, selectedAgentId: 'sa-1', cursor: live, playheadSeq: 45 })).toEqual({ seq: null, agentId: 'sa-1', at: null });
    expect(linkFromView({ inspectorTab: 'event', selectedSeq: 9, selectedAgentId: 'main', cursor: paused, playheadSeq: 9 })).toEqual({ seq: 9, agentId: null, at: null });
    expect(linkFromView({ inspectorTab: 'event', selectedSeq: 9, selectedAgentId: 'main', cursor: paused, playheadSeq: 20 })).toEqual({ seq: 9, agentId: null, at: 20 });
    expect(linkFromView({ inspectorTab: 'agent', selectedSeq: 30, selectedAgentId: 'sa-1', cursor: paused, playheadSeq: 31 })).toEqual({ seq: null, agentId: 'sa-1', at: 31 });
  });
});
