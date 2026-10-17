import { describe, expect, it } from 'vitest';
import { apiBase, DEFAULT_API_BASE, DEFAULT_RUNTIME_PORT, isLoopbackUrl, setApiBaseOverride, startRuntimeCommand, validateApiBase } from './config';

describe('runtime URL config', () => {
  it('defaults to the runtime port 4380 on loopback', () => {
    expect(DEFAULT_RUNTIME_PORT).toBe(4380);
    if (!process.env.NEXT_PUBLIC_RUNLOOP_API) expect(DEFAULT_API_BASE).toBe('http://127.0.0.1:4380');
  });

  it('applies and clears a viewer override', () => {
    setApiBaseOverride('http://127.0.0.1:4392/');
    expect(apiBase()).toBe('http://127.0.0.1:4392');
    setApiBaseOverride(null);
    expect(apiBase()).toBe(DEFAULT_API_BASE);
  });

  it('validates URLs and flags non-loopback hosts', () => {
    expect(validateApiBase('http://127.0.0.1:4380')).toBeNull();
    expect(validateApiBase('127.0.0.1:4380')).not.toBeNull();
    expect(validateApiBase('ftp://127.0.0.1')).not.toBeNull();
    expect(validateApiBase('http://127.0.0.1:4380/api')).not.toBeNull();
    expect(validateApiBase('http://user:pw@127.0.0.1:4380')).not.toBeNull();
    expect(isLoopbackUrl('http://localhost:4380')).toBe(true);
    expect(isLoopbackUrl('http://[::1]:4380')).toBe(true);
    expect(isLoopbackUrl('http://10.0.0.2:4380')).toBe(false);
  });

  it('gives the exact start command for the configured port', () => {
    expect(startRuntimeCommand('http://127.0.0.1:4380')).toBe('pnpm serve');
    expect(startRuntimeCommand('http://127.0.0.1:4392')).toBe('pnpm serve -- --port 4392');
  });
});

describe('Claude Code plugin commands', () => {
  it('point the plugin at this Studio’s runtime only when it is not the default', async () => {
    const { connectCommands, pluginUrlPrefix } = await import('./claude-code');
    expect(pluginUrlPrefix('http://127.0.0.1:4380/')).toBe('');
    expect(pluginUrlPrefix('http://127.0.0.1:4394')).toBe('RUNLOOP_URL=http://127.0.0.1:4394 ');
    expect(connectCommands('http://127.0.0.1:4380')).toEqual({
      serve: 'pnpm serve',
      claude: 'claude --plugin-dir ./integrations/claude-code-plugin',
      doctor: 'node ./integrations/claude-code-plugin/scripts/runloop-hook.mjs --doctor',
    });
    expect(connectCommands('http://127.0.0.1:4394').claude).toBe('RUNLOOP_URL=http://127.0.0.1:4394 claude --plugin-dir ./integrations/claude-code-plugin');
  });
});
