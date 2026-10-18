/** Health (P9), attention, capabilities, root matching and binding order. */
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Arrivals, resolveBinding, type BindingLookups } from '../src/agents/binding';
import { capabilitiesFor, type CapabilitySignals } from '../src/agents/capabilities';
import { LIVE_WINDOW_MS, deriveAttention, deriveHealth, type HealthSignals } from '../src/agents/health';
import { LocalRoots, isWithin, labelOf, longestRootMatch, pathHintOf } from '../src/agents/local-roots';
import { openDb } from '../src/store/db';
import { tempDir } from './helpers';

const NOW = Date.parse('2026-10-18T10:00:00Z');
const base: HealthSignals = { ingestOn: true, hasRoot: true, firstEventAt: NOW - 60_000, lastEnvelopeAt: NOW - 1000, openRuns: 1, dispatchRunning: false };

describe('deriveHealth: the first matching rule wins', () => {
  it.each<[string, Partial<HealthSignals>, string]>([
    ['ingest off beats everything', { ingestOn: false }, 'unknown'],
    ['no root yet', { hasRoot: false }, 'not_connected'],
    ['no event yet, even with an open run', { firstEventAt: null }, 'awaiting_first_event'],
    ['an open run with a recent envelope', {}, 'live'],
    ['an open run quiet for 5 min', { lastEnvelopeAt: NOW - LIVE_WINDOW_MS }, 'idle'],
    ['a running dispatch with no open run', { openRuns: 0, dispatchRunning: true, lastEnvelopeAt: null }, 'live'],
    ['no open run (ended, swept or restarted)', { openRuns: 0 }, 'offline'],
  ])('%s → %s', (_label, patch, expected) => {
    expect(deriveHealth({ ...base, ...patch }, NOW)).toBe(expected);
  });

  it('P9: an agent that has sent no events is never live', () => {
    for (const dispatchRunning of [false, true]) {
      for (const openRuns of [0, 1, 3]) {
        for (const lastEnvelopeAt of [null, NOW, NOW - 10]) {
          expect(deriveHealth({ ...base, firstEventAt: null, dispatchRunning, openRuns, lastEnvelopeAt }, NOW)).not.toBe('live');
        }
      }
    }
  });

  it('P9: after a restart (every run closed) an agent with history reads offline', () => {
    expect(deriveHealth({ ...base, openRuns: 0, lastEnvelopeAt: NOW - 5 }, NOW)).toBe('offline');
  });
});

describe('deriveAttention', () => {
  it('ranks permission requests, then dispatch approval, then incidents', () => {
    expect(deriveAttention({ pendingPermissions: 1, openIncidents: 2, dispatchAwaitingApproval: true })).toBe('permission_requested');
    expect(deriveAttention({ pendingPermissions: 0, openIncidents: 2, dispatchAwaitingApproval: true })).toBe('dispatch_awaiting_approval');
    expect(deriveAttention({ pendingPermissions: 0, openIncidents: 2, dispatchAwaitingApproval: false })).toBe('incident');
    expect(deriveAttention({ pendingPermissions: 0, openIncidents: 0, dispatchAwaitingApproval: false })).toBe('none');
  });
});

describe('capabilitiesFor', () => {
  const sig: CapabilitySignals = { ingestOn: true, hasFirstEvent: true, sessions: 2, cli: 'unprobed', policyAllowsDispatch: false, runningDispatches: 0 };

  it('gives every capability a state, and a reason whenever it is not available', () => {
    const caps = capabilitiesFor(sig);
    expect(Object.keys(caps).sort()).toEqual(['cancel', 'control', 'inspect', 'message', 'observe', 'submit_task']);
    for (const c of Object.values(caps)) expect(c.state === 'available' ? c.reason === null : typeof c.reason === 'string' && c.reason.length > 0).toBe(true);
  });

  it('observe after the first event; inspect once a session exists', () => {
    expect(capabilitiesFor(sig).observe.state).toBe('available');
    expect(capabilitiesFor({ ...sig, hasFirstEvent: false }).observe.state).toBe('needs_setup');
    expect(capabilitiesFor({ ...sig, ingestOn: false }).observe.reason).toMatch(/Tracing is off/);
    expect(capabilitiesFor(sig).inspect.state).toBe('available');
    expect(capabilitiesFor({ ...sig, sessions: 0 }).inspect.state).toBe('needs_setup');
  });

  it('submit_task needs both the CLI probe and the policy; cancel only for running dispatches', () => {
    expect(capabilitiesFor(sig).submit_task.state).toBe('needs_setup');
    expect(capabilitiesFor({ ...sig, cli: 'ok' }).submit_task.reason).toMatch(/policy/);
    expect(capabilitiesFor({ ...sig, policyAllowsDispatch: true }).submit_task.reason).toMatch(/CLI/);
    expect(capabilitiesFor({ ...sig, cli: 'ok', policyAllowsDispatch: true }).submit_task.state).toBe('available');
    expect(capabilitiesFor(sig).cancel.state).toBe('unsupported');
    expect(capabilitiesFor({ ...sig, runningDispatches: 1 }).cancel.state).toBe('available');
  });

  it('message and control are unsupported, with the reason shown', () => {
    const caps = capabilitiesFor({ ...sig, cli: 'ok', policyAllowsDispatch: true, runningDispatches: 1 });
    expect(caps.message).toEqual({ state: 'unsupported', reason: expect.stringMatching(/message/) });
    expect(caps.control).toEqual({ state: 'unsupported', reason: expect.stringMatching(/pause or steer/) });
  });
});

describe('root matching', () => {
  const roots = [
    { workspaceId: 'w_repo', root: '/home/dev/code/repo' },
    { workspaceId: 'w_pkg', root: '/home/dev/code/repo/packages/app' },
    { workspaceId: 'w_other', root: '/home/dev/code/repo-two' },
  ];

  it('the longest prefix wins, on segment boundaries', () => {
    expect(longestRootMatch('/home/dev/code/repo', roots, 'linux', '/')?.workspaceId).toBe('w_repo');
    expect(longestRootMatch('/home/dev/code/repo/src/x', roots, 'linux', '/')?.workspaceId).toBe('w_repo');
    expect(longestRootMatch('/home/dev/code/repo/packages/app/src', roots, 'linux', '/')?.workspaceId).toBe('w_pkg');
    expect(longestRootMatch('/home/dev/code/repo-two/x', roots, 'linux', '/')?.workspaceId).toBe('w_other');
    expect(longestRootMatch('/home/dev/code/rep', roots, 'linux', '/')).toBeNull();
    expect(longestRootMatch('/home/dev/code', roots, 'linux', '/')).toBeNull();
  });

  it('folds case on macOS and Windows only', () => {
    expect(longestRootMatch('/HOME/dev/Code/Repo/src', roots, 'linux', '/')).toBeNull();
    expect(longestRootMatch('/HOME/dev/Code/Repo/src', roots, 'darwin', '/')?.workspaceId).toBe('w_repo');
    expect(isWithin('C:\\Users\\Dev\\Repo\\src', 'c:\\users\\dev\\repo', 'win32', '\\')).toBe(true);
    expect(isWithin('C:\\Users\\Dev\\Repo2', 'c:\\users\\dev\\repo', 'win32', '\\')).toBe(false);
  });

  it('labels and hints never contain the whole path', () => {
    expect(labelOf('/home/dev/code/runloop')).toBe('runloop');
    expect(pathHintOf('/home/dev/code/runloop', '/')).toBe('…/code/runloop');
    expect(pathHintOf('/srv/repo', '/')).toBe('…/repo');
    expect(pathHintOf('/repo', '/')).toBe('…/repo');
    for (const p of ['/home/dev/code/runloop', '/srv/repo', '/a/b/c']) expect(pathHintOf(p, '/').includes(p)).toBe(false);
  });

  it('LocalRoots checks typed paths and matches realpath(cwd), symlinks included', () => {
    const dir = tempDir('roots');
    const repo = path.join(dir, 'code', 'repo');
    mkdirSync(path.join(repo, 'src'), { recursive: true });
    writeFileSync(path.join(dir, 'file.txt'), 'x');
    symlinkSync(repo, path.join(dir, 'link'));
    const dataDir = path.join(dir, 'data');
    mkdirSync(dataDir);
    const db = openDb(path.join(dir, 'runloop.db'));
    db.exec(`INSERT INTO agents (agent_id, display_name, hue, org_id, lot_id, housed, created_at) VALUES ('a', 'A', '#5aa9f5', 'org_home', 'lot_agent_1', 1, 'now')`);
    db.exec(`INSERT INTO workspaces (workspace_id, agent_id, label, path_hint) VALUES ('w', 'a', 'repo', '…/code/repo')`);
    const roots = new LocalRoots(db);

    expect(roots.check(path.join(dir, 'missing'), dataDir)).toEqual({ ok: false, problem: 'not_found' });
    expect(roots.check(path.join(dir, 'file.txt'), dataDir)).toEqual({ ok: false, problem: 'not_a_directory' });
    expect(roots.check('/', dataDir)).toEqual({ ok: false, problem: 'filesystem_root' });
    expect(roots.check(dataDir, dataDir)).toEqual({ ok: false, problem: 'inside_data_dir' });
    const ok = roots.check(path.join(dir, 'link'), dataDir);
    expect(ok.ok && ok.realpath.endsWith(path.join('code', 'repo'))).toBe(true);
    if (!ok.ok) throw new Error('expected ok');
    roots.add('w', ok.realpath);
    expect(roots.check(repo, dataDir)).toEqual({ ok: false, problem: 'already_bound' });
    expect(roots.match(path.join(repo, 'src'))?.workspaceId).toBe('w');
    expect(roots.match(path.join(dir, 'link', 'src'))?.workspaceId).toBe('w');
    expect(roots.match(dir)).toBeNull();
    expect(roots.match('relative/path')).toBeNull();
    db.close();
  });
});

describe('resolveBinding', () => {
  const lookups = (o: Partial<{ existing: string; dispatch: string; path: string }>): BindingLookups => ({
    existing: () => (o.existing ? { agentId: o.existing, method: 'path' } : null),
    dispatchAgent: () => o.dispatch ?? null,
    pathAgent: () => o.path ?? null,
  });
  const s = { sessionId: 's1', cwd: '/home/dev/repo' };

  it('an existing binding is fixed, then dispatch, then path, else an Arrival', () => {
    expect(resolveBinding(s, lookups({ existing: 'a1', dispatch: 'a2', path: 'a3' }))).toEqual({ kind: 'bound', agentId: 'a1', method: 'path', isNew: false });
    expect(resolveBinding(s, lookups({ dispatch: 'a2', path: 'a3' }))).toEqual({ kind: 'bound', agentId: 'a2', method: 'dispatch', isNew: true });
    expect(resolveBinding(s, lookups({ path: 'a3' }))).toEqual({ kind: 'bound', agentId: 'a3', method: 'path', isNew: true });
    expect(resolveBinding(s, lookups({}))).toEqual({ kind: 'arrival' });
    expect(resolveBinding({ ...s, cwd: null }, lookups({ path: 'a3' }))).toEqual({ kind: 'arrival' });
  });

  it('Arrivals keep the latest cwd and run ids in memory, bounded', () => {
    const a = new Arrivals(2);
    a.note('s1', null, '/x/one', 't1');
    a.note('s1', 'r1', null, 't2');
    a.note('s1', 'r1', null, 't3');
    expect(a.get('s1')).toEqual({ sessionId: 's1', cwd: '/x/one', runIds: ['r1'], firstSeenAt: 't1', lastEventAt: 't3' });
    a.note('s2', null, null, 't4');
    a.note('s3', null, null, 't5');
    expect(a.all().map((x) => x.sessionId)).toEqual(['s2', 's3']);
    a.remove('s2');
    expect(a.get('s2')).toBeUndefined();
  });
});
