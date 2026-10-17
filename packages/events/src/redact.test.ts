import { describe, expect, it } from 'vitest';
import { REDACTED, redactEvent, redactText, redactValue } from './redact';

const secrets = {
  openai: 'sk-abcdefghijklmnopqrstuvwxyz012345',
  github: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
  githubPat: 'github_pat_11ABCDEFG0123456789_abcdefghijklmnop',
  aws: 'AKIAIOSFODNN7EXAMPLE',
  slack: 'xoxb-1234567890-abcdefghij',
};

describe('redactText', () => {
  it.each(Object.entries(secrets))('masks %s tokens', (_name, token) => {
    const out = redactText(`token=${token} end`);
    expect(out).toBe(`token=${REDACTED} end`);
    expect(out).not.toContain(token);
  });

  it('masks bearer credentials but keeps the scheme', () => {
    expect(redactText('Authorization: Bearer abc.def-ghi_123')).toBe(`Authorization: Bearer ${REDACTED}`);
  });

  it('masks literal secret values of 8+ characters only', () => {
    expect(redactText('pw=hunter2hunter2!', { secrets: ['hunter2hunter2'] })).toBe(`pw=${REDACTED}!`);
    expect(redactText('short=abc', { secrets: ['abc'] })).toBe('short=abc');
    expect(redactText('a.b*c+d(e)f a.b*c+d(e)f', { secrets: ['a.b*c+d(e)f'] })).toBe(`${REDACTED} ${REDACTED}`);
  });

  it('leaves ordinary text untouched and is idempotent', () => {
    expect(redactText('12 tests: 10 passed, 2 failed')).toBe('12 tests: 10 passed, 2 failed');
    const once = redactText(`a ${secrets.openai} b Bearer xyzxyzxyz ${secrets.aws}`, { secrets: ['supersecretvalue'] });
    expect(redactText(once, { secrets: ['supersecretvalue'] })).toBe(once);
  });
});

describe('redactValue', () => {
  it('walks nested arrays and objects, keeping untouched references', () => {
    const clean = { n: 1, list: ['a'] };
    const value = { clean, deep: { args: ['x', `key ${secrets.github}`] }, flag: true, nil: null };
    const out = redactValue(value);
    expect(out.deep.args[1]).toBe(`key ${REDACTED}`);
    expect(out.clean).toBe(clean);
    expect(out.flag).toBe(true);
    expect(out.nil).toBeNull();
    expect(value.deep.args[1]).toContain(secrets.github); // input not mutated
    expect(redactValue(clean)).toBe(clean);
  });
});

describe('redactEvent', () => {
  const event = { type: 'tool.call_started', visibility: 'public' as const, payload: { inputSummary: `curl -H "Bearer ${'t'.repeat(20)}"` } };

  it('redacts the payload and marks the event redacted', () => {
    const { event: out, changed } = redactEvent(event);
    expect(changed).toBe(true);
    expect(out.visibility).toBe('redacted');
    expect(out.payload.inputSummary).toBe(`curl -H "Bearer ${REDACTED}"`);
    expect(event.visibility).toBe('public');
  });

  it('is idempotent', () => {
    const once = redactEvent(event).event;
    const twice = redactEvent(once);
    expect(twice.changed).toBe(false);
    expect(twice.event).toBe(once);
  });

  it('keeps sensitive events sensitive and returns clean events as-is', () => {
    expect(redactEvent({ ...event, visibility: 'sensitive' as const }).event.visibility).toBe('sensitive');
    const clean = { visibility: 'public' as const, payload: { text: 'hello' } };
    expect(redactEvent(clean)).toEqual({ event: clean, changed: false });
    expect(redactEvent(clean).event).toBe(clean);
  });
});
