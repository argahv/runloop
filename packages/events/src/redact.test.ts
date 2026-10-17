import { describe, expect, it } from 'vitest';
import { REDACTED, REDACTION_PATTERN_SOURCES, redactEvent, redactText, redactValue, secretValuesIn } from './redact';

const secrets = {
  openai: 'sk-' + 'abcdefghijklmnopqrstuvwxyz012345',
  github: 'ghp' + '_abcdefghijklmnopqrstuvwxyz0123456789',
  githubPat: 'github' + '_pat_11ABCDEFG0123456789_abcdefghijklmnop',
  aws: 'AK' + 'IAIOSFODNN7EXAMPLE',
  slack: 'xox' + 'b-1234567890-abcdefghij',
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

  it.each([
    ['curl -u admin:Sup3rS3cretPassw0rd https://x', 'curl -u admin:[REDACTED] https://x'],
    ['psql "postgresql://app_user:pgS3cr3t' + 'Passw0rd@db:5432/app"', 'psql "postgresql://app_user:[REDACTED]@db:5432/app"'],
    ['curl -H "X-API-Key: 4f9d2c8e7a1b4e6f" https://x', 'curl -H "X-API-Key: [REDACTED]" https://x'],
    ['-u sk_' + 'live_51HxYzAbCdEfGhIjKlMnOpQr:', '-u [REDACTED]:'],
    ['mysql -h db -u root -pMyR00tPassw0rd prod', 'mysql -h db -u root -p[REDACTED] prod'],
    ['GET /data?api_key=AIza' + 'SyD-9tSrke72PouQMnMX-a7eZSW0jkFMBWY&x=1', 'GET /data?api_key=[REDACTED]&x=1'],
    ['https://oauth2:glpat' + '-Zx8vQ2mN4pL6rT1yU3wE@gitlab.com/o/r.git', 'https://oauth2:[REDACTED]@gitlab.com/o/r.git'],
    ['docker login -p dckr_pat_2b3e36beeb386dfdaacb9b46004ccb7c', 'docker login -p [REDACTED]'],
    ['Authorization: token ghs' + '_16C7e42F292c6912E7710c838347Ae178B4a', 'Authorization: token [REDACTED]'],
    ['Authorization: Basic YWRtaW46U3VwM3JTM2NyZXQ=', 'Authorization: Basic [REDACTED]'],
    ['-d "username=admin&password=Hunter2Hunter2"', '-d "username=admin&password=[REDACTED]"'],
    ['{"client_secret": "two words"}', '{"client_secret": [REDACTED]}'],
    ['https://hooks.slack.com/' + 'services/T000/B000/XXXXXXXX', 'https://hooks.slack.com/services/[REDACTED]'],
    ['npm' + '_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789', '[REDACTED]'],
    ['ASIAIOSFODNN7EXAMPLE', '[REDACTED]'],
  ])('masks %s', (input, expected) => {
    expect(redactText(input)).toBe(expected);
    expect(redactText(expected)).toBe(expected);
  });

  it.each([
    '12 tests: 10 passed, 2 failed',
    'node --test 2>&1; echo "EXIT: $?"',
    'git push -u origin main',
    'keyboard: us, tokens: 20, max_tokens 1000',
    'Usage: 20.8k tokens · Explore finished',
    'https://user@host.example.com/path and http://localhost:4380/api/runs',
    'Grep "api_key" in src/',
  ])('leaves %s alone', (text) => {
    expect(redactText(text)).toBe(text);
  });

  it('lists the secret values it would mask (to mask them where no pattern sees them)', () => {
    expect(secretValuesIn('psql "postgresql://u:pgS3cr3t' + 'Passw0rd@db" && curl -d "password=Hunter2Hunter2"')).toEqual([
      'pgS3cr3t' + 'Passw0rd',
      'Hunter2Hunter2',
    ]);
    expect(secretValuesIn('password=short')).toEqual([]);
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

describe('REDACTION_PATTERN_SOURCES', () => {
  it('lists the sources of the patterns redactText uses', () => {
    expect(REDACTION_PATTERN_SOURCES.length).toBeGreaterThan(0);
    for (const token of Object.values(secrets)) {
      expect(REDACTION_PATTERN_SOURCES.some((src) => new RegExp(src).test(token))).toBe(true);
    }
  });
});
