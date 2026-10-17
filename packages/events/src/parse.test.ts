import { describe, expect, it } from 'vitest';
// events has no dependency on testkit (testkit depends on events), so tests import its source directly.
import { codingMissionFixture } from '../../testkit/src/index';
import { deriveRefs, isUnknownEvent, type EventDraft } from './event';
import { invalidEnvelopeEvent, parseEvent, parseKnownEvent } from './parse';
import { EVENT_TYPES, isEventType } from './payloads';

const fixture = codingMissionFixture();
const sample = () => JSON.parse(JSON.stringify(fixture[0]!)) as Record<string, unknown>;

describe('parseEvent', () => {
  it('accepts every fixture event (after a JSON round trip) as a known event', () => {
    for (const e of fixture) {
      const r = parseEvent(JSON.parse(JSON.stringify(e)));
      expect(r.ok, `#${e.sequence}`).toBe(true);
      if (!r.ok) continue;
      expect(isUnknownEvent(r.event)).toBe(false);
      expect(r.event).toEqual(e);
      expect(parseKnownEvent(e).ok).toBe(true);
    }
  });

  it('covers most event types with the fixture', () => {
    const seen = new Set(fixture.map((e) => e.type));
    const missing = EVENT_TYPES.filter((t) => !seen.has(t));
    expect(missing.sort()).toEqual(
      [
        'run.paused',
        'run.resumed',
        'run.marker',
        'agent.usage_reported',
        'task.failed',
        'tool.call_failed',
        'tool.permission_requested',
        'tool.permission_resolved',
      ].sort(),
    );
  });

  it.each([
    ['bad eventId', { eventId: 'not-a-uuid' }],
    ['uuid with an invalid version', { runId: '00000001-0000-0000-8000-000000000001' }],
    ['sequence 0', { sequence: 0 }],
    ['fractional sequence', { sequence: 1.5 }],
    ['bad visibility', { visibility: 'secret' }],
    ['bad timestamp', { timestamp: 'yesterday' }],
    ['missing type', { type: undefined }],
  ])('rejects an invalid envelope (%s) without throwing', (_name, patch) => {
    const r = parseEvent({ ...sample(), ...patch });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.length).toBeGreaterThan(0);
  });

  it.each([null, undefined, 42, 'event', [], {}])('rejects non-events (%s) without throwing', (raw) => {
    expect(parseEvent(raw).ok).toBe(false);
  });

  it('returns an UnknownEvent for an unknown type', () => {
    const r = parseEvent({ ...sample(), type: 'world.weather_changed', payload: { rain: true } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(isUnknownEvent(r.event)).toBe(true);
    expect(r.event).toMatchObject({ unknown: true, reason: 'unknown_type', type: 'world.weather_changed', payload: { rain: true } });
    expect(parseKnownEvent({ ...sample(), type: 'world.weather_changed' })).toMatchObject({ ok: false });
  });

  it('returns an UnknownEvent for an unsupported schema version', () => {
    const r = parseEvent({ ...sample(), schemaVersion: 2 });
    expect(r.ok && isUnknownEvent(r.event) && r.event.reason).toBe('unsupported_version');
  });

  it('returns an UnknownEvent with the error for an invalid payload', () => {
    const r = parseEvent({ ...sample(), payload: { title: 7 } });
    expect(r.ok).toBe(true);
    if (!r.ok || !isUnknownEvent(r.event)) throw new Error('expected an UnknownEvent');
    expect(r.event.reason).toBe('invalid_payload');
    expect(r.event.error).toMatch(/title/);
    const strict = parseKnownEvent({ ...sample(), payload: { title: 7 } });
    expect(strict.ok).toBe(false);
    if (!strict.ok) expect(strict.error).toMatch(/^invalid_payload/);
  });

  it('rejects a failing test run reported with negative counts', () => {
    const completed = fixture.find((e) => e.type === 'tool.call_completed' && e.payload.metrics)!;
    const bad = { ...completed, payload: { ...completed.payload, metrics: { tests: 12, passed: -1, failed: 2 } } };
    expect(parseKnownEvent(bad).ok).toBe(false);
  });
});

describe('traced runs (additive schema)', () => {
  const traced = {
    title: 'Claude Code · demo',
    missionId: 'claude-code',
    worldId: 'research-campus',
    adapter: { id: 'claude-code', kind: 'external', label: 'Claude Code (traced via hooks)' },
    mode: 'traced',
    source: { kind: 'claude-code', sessionId: 's-1', segment: 1, projectLabel: 'demo', model: null },
  };
  const withPayload = (type: string, payload: unknown, extra: Record<string, unknown> = {}) => ({ ...sample(), type, payload, ...extra });

  it('accepts a traced run.started without seed or workspace', () => {
    expect(parseKnownEvent(withPayload('run.started', traced)).ok).toBe(true);
  });

  it('requires mode, source and an external adapter together', () => {
    const { mode: _m, ...noMode } = traced;
    const { source: _s, ...noSource } = traced;
    for (const bad of [noMode, noSource, { ...traced, adapter: { ...traced.adapter, kind: 'scripted' } }]) {
      expect(parseKnownEvent(withPayload('run.started', bad)).ok).toBe(false);
    }
  });

  it('still requires seed and workspace on executed runs', () => {
    const executed = sample().payload as Record<string, unknown>;
    const { seed: _seed, ...noSeed } = executed;
    expect(parseKnownEvent(withPayload('run.started', executed)).ok).toBe(true);
    expect(parseKnownEvent(withPayload('run.started', noSeed)).ok).toBe(false);
  });

  it('parses provenance, markers, usage, tool categories and the new kinds', () => {
    const marker = parseKnownEvent(withPayload('run.marker', { kind: 'compaction', label: 'Compaction', agentId: 'main' }, { provenance: 'reported' }));
    expect(marker.ok && marker.event.provenance).toBe('reported');
    const usage = { agentId: 'sa-1', model: 'claude-haiku-5-5', inputTokens: 2, outputTokens: 193, cacheReadTokens: 19620, source: 'claude-code.agent_result' };
    expect(parseKnownEvent(withPayload('agent.usage_reported', usage)).ok).toBe(true);
    expect(parseKnownEvent(withPayload('agent.usage_reported', { ...usage, inputTokens: -1 })).ok).toBe(false);
    const call = { callId: 'c', agentId: 'main', tool: 'Bash', category: 'test', inputSummary: 'npm test' };
    expect(parseKnownEvent(withPayload('tool.call_started', call)).ok).toBe(true);
    expect(parseKnownEvent(withPayload('tool.call_started', { ...call, category: 'dance' })).ok).toBe(false);
    expect(parseKnownEvent(withPayload('task.created', { taskId: 't', title: 'Turn 1', kind: 'turn', dependsOn: [] })).ok).toBe(true);
    expect(parseKnownEvent(withPayload('tool.call_failed', { callId: 'c', errorType: 'unobserved', message: 'x', durationMs: 0 })).ok).toBe(true);
    expect(parseEvent({ ...sample(), provenance: 'guessed' }).ok).toBe(false);
  });

  it('derives the actor of markers and usage reports', () => {
    expect(deriveRefs({ type: 'run.marker', payload: { kind: 'other', label: 'x', agentId: 'main' } })).toEqual({ actorId: 'main' });
    expect(deriveRefs({ type: 'run.marker', payload: { kind: 'other', label: 'x' } })).toEqual({});
    expect(
      deriveRefs({ type: 'agent.usage_reported', payload: { agentId: 'sa-1', model: null, inputTokens: 1, outputTokens: 1, source: 's' } }),
    ).toEqual({ actorId: 'sa-1' });
  });
});

describe('invalidEnvelopeEvent', () => {
  const fallback = { runId: '00000000-0000-4000-8000-000000000000', timestamp: '2026-10-17T09:00:00.000Z' };

  it('turns an invalid envelope with a sequence into an UnknownEvent that keeps its place', () => {
    const raw: Record<string, unknown> = { ...sample(), visibility: 'internal' };
    const parsed = parseEvent(raw);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    const e = invalidEnvelopeEvent(raw, parsed.error, fallback)!;
    expect(isUnknownEvent(e)).toBe(true);
    expect(e).toMatchObject({
      eventId: raw.eventId,
      runId: raw.runId,
      sequence: raw.sequence,
      timestamp: raw.timestamp,
      type: raw.type,
      visibility: 'sensitive',
      reason: 'invalid_envelope',
      error: parsed.error,
    });
  });

  it('fills missing fields deterministically and needs an integer sequence', () => {
    const e = invalidEnvelopeEvent({ sequence: 7, timestamp: 'yesterday' }, 'bad', fallback)!;
    expect(e).toMatchObject({ eventId: `invalid:${fallback.runId}:7`, runId: fallback.runId, timestamp: fallback.timestamp, type: 'invalid' });
    expect(invalidEnvelopeEvent({ sequence: 7 }, 'bad', fallback)).toEqual(e);
    for (const raw of [null, 'x', {}, { sequence: 0 }, { sequence: 1.5 }, { sequence: '3' }]) {
      expect(invalidEnvelopeEvent(raw, 'bad', fallback)).toBeNull();
    }
  });
});

describe('event helpers', () => {
  it('isEventType knows exactly the payload schemas', () => {
    for (const t of EVENT_TYPES) expect(isEventType(t)).toBe(true);
    expect(isEventType('world.anything')).toBe(false);
  });

  it('deriveRefs copies subject ids from the payload', () => {
    const d = (draft: EventDraft) => deriveRefs(draft);
    expect(d({ type: 'task.started', payload: { taskId: 'T1', agentId: 'a' } })).toEqual({ actorId: 'a', taskId: 'T1' });
    expect(d({ type: 'task.completed', payload: { taskId: 'T1', summary: '', artifactIds: [] } })).toEqual({ taskId: 'T1' });
    expect(d({ type: 'agent.message_sent', payload: { messageId: 'm', fromAgentId: 'a', to: 'b', text: '' } })).toEqual({
      actorId: 'a',
    });
    expect(d({ type: 'run.completed', payload: { outcome: 'succeeded' } })).toEqual({});
  });
});
