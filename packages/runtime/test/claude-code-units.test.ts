import { describe, expect, it } from 'vitest';
import { ingestKey, slimHook, summarizeToolResponse, MAX_STRING } from '../src/tracers/claude-code/hook-input';
import { inputHash, runIdFor, stableJson, subagentId, uuidv5 } from '../src/tracers/claude-code/ids';
import { projectLabelOf } from '../src/tracers/claude-code/mapper';
import {
  classifyCommand,
  failureSummary,
  inputSummary,
  parseTestOutput,
  redactShell,
  relPath,
  sanitizeText,
  successSummary,
  toolCategory,
} from '../src/tracers/claude-code/summarize';
import { ALL_FIXTURES, readFixture } from './claude-code-helpers';

const CWD = '/home/dev/demo';

describe('ids', () => {
  it('uuidv5 matches the RFC 4122 test vector and run ids are deterministic per segment', () => {
    // python: uuid.uuid5(uuid.NAMESPACE_DNS, 'python.org')
    expect(uuidv5('6ba7b810-9dad-11d1-80b4-00c04fd430c8', 'python.org')).toBe('886313e1-3b8a-5372-9b90-0c9aee199e5d');
    expect(runIdFor('s', 1)).toBe(runIdFor('s', 1));
    expect(runIdFor('s', 1)).not.toBe(runIdFor('s', 2));
    expect(runIdFor('s', 1)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('sanitises subagent ids and hashes inputs independently of key order', () => {
    expect(subagentId('acd4fbeb0fe6b7d3f')).toBe('sa-acd4fbeb0fe6b7d3f');
    expect(subagentId('a/b c')).toBe('sa-a_b_c');
    expect(subagentId('x'.repeat(100))).toHaveLength(64);
    expect(stableJson({ b: 1, a: [1, { d: 2, c: 3 }] })).toBe('{"a":[1,{"c":3,"d":2}],"b":1}');
    expect(inputHash({ a: 1, b: 2 })).toBe(inputHash({ b: 2, a: 1 }));
  });
});

describe('slimHook', () => {
  it('is idempotent on every fixture line and drops Claude Code file paths and tool responses', () => {
    for (const name of ALL_FIXTURES) {
      for (const line of readFixture(name)) {
        const once = slimHook(line.input);
        expect(slimHook(once)).toEqual(once);
        expect(once).not.toHaveProperty('transcript_path');
        expect(once).not.toHaveProperty('agent_transcript_path');
        expect(once).not.toHaveProperty('scratchpad_dir');
        expect(once).not.toHaveProperty('tool_response');
        if ('tool_response' in line.input) expect(once).toHaveProperty('tool_result');
      }
    }
  });

  it('keeps a long string\'s head and tail within the limit', () => {
    const long = `Exit code 1\n${'x'.repeat(10_000)}\n# tests 3\n# pass 2\n# fail 1\n`;
    const out = slimHook({ session_id: 's', hook_event_name: 'PostToolUseFailure', error: long }).error as string;
    expect(out.length).toBeLessThanOrEqual(MAX_STRING);
    expect(out.startsWith('Exit code 1\n')).toBe(true);
    expect(out.endsWith('# fail 1\n')).toBe(true);
    expect(out).toContain('characters omitted');
  });

  it('summarises tool responses without contents', () => {
    const agent = summarizeToolResponse({
      status: 'completed',
      agentId: 'a1',
      content: [{ type: 'text', text: 'secret findings' }],
      resolvedModel: 'claude-haiku-5-5',
      totalTokens: 10,
      usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4, service_tier: 'standard' },
    });
    expect(agent.fields).toEqual({ status: 'completed', agentId: 'a1', resolvedModel: 'claude-haiku-5-5', totalTokens: 10 });
    expect(agent.usage).toEqual({ input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 });
    expect(JSON.stringify(agent)).not.toContain('secret findings');
    const edit = summarizeToolResponse({ filePath: '/x', structuredPatch: [{ lines: [' a', '-b', '+c', '+d'] }], originalFile: 'big' });
    expect(edit).toMatchObject({ linesAdded: 2, linesRemoved: 1 });
    expect(JSON.stringify(edit)).not.toContain('big');
    const bash = summarizeToolResponse({ stdout: `${'y'.repeat(5000)}\nend\n`, stderr: '', interrupted: false });
    expect(bash.stdoutTail!.length).toBe(2000);
    expect(bash).toMatchObject({ stdoutLines: 2, stderrLines: 0, fields: { interrupted: false } });
    expect(summarizeToolResponse('a\nb')).toEqual({ bytes: 3, lines: 2 });
  });

  it('derives semantic ingest keys', () => {
    const k = (h: Record<string, unknown>) => ingestKey({ session_id: 's', ...h }, 'd1');
    expect(k({ hook_event_name: 'PreToolUse', tool_use_id: 't1' })).toBe('pre:t1');
    expect(k({ hook_event_name: 'PostToolUse', tool_use_id: 't1' })).toBe('post:t1');
    expect(k({ hook_event_name: 'PostToolUseFailure', tool_use_id: 't1' })).toBe('post:t1');
    expect(k({ hook_event_name: 'UserPromptSubmit', prompt_id: 'p' })).toBe('prompt:p');
    expect(k({ hook_event_name: 'SubagentStart', agent_id: 'a' })).toBe('sa-start:a');
    expect(k({ hook_event_name: 'SubagentStop', agent_id: 'a' })).toBe('sa-stop:a');
    expect(k({ hook_event_name: 'Stop' })).toBe('delivery:d1');
    expect(k({ hook_event_name: 'PreToolUse' })).toBe('delivery:d1');
  });
});

describe('categories', () => {
  it.each([
    ['node --test', 'test'],
    ['node --test 2>&1; echo "EXIT: $?"', 'test'],
    ['pnpm vitest run', 'test'],
    ['npm test', 'test'],
    ['npm run test -- --watch=false', 'test'],
    ['pytest -q tests/', 'test'],
    ['go test ./...', 'test'],
    ['cargo test', 'test'],
    ['pnpm test && git push', 'test'],
    ['git push origin main', 'deploy'],
    ['gh release create v1', 'deploy'],
    ['kubectl apply -f x.yaml', 'deploy'],
    ['node --version && cat package.json', 'execute'],
    ['cat -n test/task-store.test.js', 'execute'],
    ['ls', 'execute'],
  ])('classifies %s as %s', (command, expected) => {
    expect(classifyCommand(command)).toBe(expected);
  });

  it('maps tools to categories', () => {
    const c = (tool: string, input: Record<string, unknown> = {}) => toolCategory(tool, input);
    expect([c('Read'), c('Grep'), c('Glob'), c('WebFetch'), c('WebSearch')]).toEqual(['read', 'search', 'search', 'web', 'web']);
    expect([c('Edit'), c('Write'), c('NotebookEdit')]).toEqual(['edit', 'edit', 'edit']);
    expect([c('Bash', { command: 'npm test' }), c('PowerShell', { command: 'git push' }), c('Monitor')]).toEqual(['test', 'deploy', 'execute']);
    expect([c('Agent'), c('mcp__github__get_me'), c('ExitPlanMode'), c('TaskCreate'), c('MultiEdit')]).toEqual([
      'delegate',
      'mcp',
      'plan',
      'other',
      'other',
    ]);
  });
});

describe('paths and summaries', () => {
  it('never keeps absolute paths', () => {
    expect(relPath(`${CWD}/src/a.ts`, CWD)).toBe('src/a.ts');
    expect(relPath(CWD, CWD)).toBe('.');
    expect(relPath('/home/dev/.claude/settings.json', CWD)).toBe('~/.claude/settings.json');
    expect(relPath('/opt/tools/bin/x', CWD)).toBe('…/bin/x');
    expect(relPath('src/a.ts', CWD)).toBe('src/a.ts');
    expect(sanitizeText(`cat -n ${CWD}/test/x.js && ls /var/lib/app/data`, CWD)).toBe('cat -n test/x.js && ls …/app/data');
    expect(sanitizeText(`cd ${CWD}2/x; curl https://example.com/a/b/c; echo 2>/dev/null`, CWD)).toBe(
      'cd ~/demo2/x; curl https://example.com/a/b/c; echo 2>/dev/null',
    );
    expect(sanitizeText('your current working directory is /home/dev/demo.', CWD)).toBe('your current working directory is ~/demo.');
  });

  it('summarises inputs', () => {
    expect(inputSummary('Read', { file_path: `${CWD}/src/app.ts` }, CWD)).toBe('src/app.ts');
    expect(inputSummary('Read', { file_path: `${CWD}/a.ts`, offset: 10, limit: 20 }, CWD)).toBe('a.ts (lines 10–30)');
    expect(inputSummary('Grep', { pattern: 'useStore', path: `${CWD}/src` }, CWD)).toBe('"useStore" in src');
    expect(inputSummary('Bash', { command: 'GITHUB_TOKEN=ghx_abc pnpm test --password hunter2' }, CWD)).toBe(
      'GITHUB_TOKEN=[REDACTED] pnpm test --password [REDACTED]',
    );
    expect(inputSummary('Agent', { subagent_type: 'Explore', description: 'find auth code' }, CWD)).toBe('→ Explore: "find auth code"');
    expect(inputSummary('TaskCreate', { subject: 'Ship it' }, CWD)).toBe('Ship it');
    expect(inputSummary('Bash', { command: 'x'.repeat(500) }, CWD)).toHaveLength(200);
    expect(redactShell(redactShell('API_KEY=abc'))).toBe('API_KEY=[REDACTED]');
  });

  it('summarises results from what was reported only', () => {
    expect(successSummary('Read', { bytes: 10, file: { numLines: 34, totalLines: 34 } }, undefined)).toBe('Read 34 lines');
    expect(successSummary('Edit', { bytes: 10, linesAdded: 3, linesRemoved: 1 }, undefined)).toBe('+3 −1 lines');
    expect(successSummary('Bash', { bytes: 10, stdoutLines: 0 }, undefined)).toBe('Completed with no output');
    expect(successSummary('Bash', { bytes: 10 }, { tests: 3, passed: 3, failed: 0 })).toBe('3 tests: 3 passed, 0 failed');
    expect(successSummary('WebFetch', { bytes: 100, fields: { code: 200, bytes: 5120 } }, undefined)).toBe('HTTP 200 · 5,120 bytes');
    expect(successSummary('Mystery', { bytes: 100 }, undefined)).toBe('Completed');
    expect(successSummary('Read', undefined, undefined)).toBe('Completed (no result details reported)');
    expect(failureSummary('Exit code 2\nerror: boom\nmore', 2, undefined, CWD)).toBe('Exit code 2: error: boom');
    expect(failureSummary(`File does not exist: ${CWD}/x`, undefined, undefined, CWD)).toBe('File does not exist: x');
  });

  it('labels the project by its base name only', () => {
    expect(projectLabelOf('/home/dev/demo/')).toBe('demo');
    expect(projectLabelOf(null)).toBe('unknown project');
  });
});

describe('parseTestOutput', () => {
  it('reads TAP footers and failing test names', () => {
    const tap = 'TAP version 13\nok 1 - a\nnot ok 2 - b\n  ---\n  type: \'test\'\n  ...\n1..2\n# tests 2\n# pass 1\n# fail 1\n';
    expect(parseTestOutput(tap)).toEqual({ metrics: { tests: 2, passed: 1, failed: 1 }, failingTests: ['b'] });
  });

  it('reads vitest, jest and pytest summaries', () => {
    expect(parseTestOutput(' Test Files  1 failed (1)\n      Tests  2 failed | 10 passed (12)\n').metrics).toEqual({ tests: 12, passed: 10, failed: 2 });
    expect(parseTestOutput('\u001b[32m      Tests  12 passed\u001b[39m (12)\n').metrics).toEqual({ tests: 12, passed: 12, failed: 0 });
    expect(parseTestOutput('Test Suites: 1 failed, 1 total\nTests:       2 failed, 10 passed, 12 total\n').metrics).toEqual({ tests: 12, passed: 10, failed: 2 });
    expect(parseTestOutput('===== 2 failed, 10 passed in 0.12s =====\n').metrics).toEqual({ tests: 12, passed: 10, failed: 2 });
    expect(parseTestOutput('10 passed, 1 skipped in 0.05s\n').metrics).toEqual({ tests: 11, passed: 10, failed: 0 });
  });

  it('leaves counts out when they are ambiguous or absent', () => {
    expect(parseTestOutput('===== 1 failed, 3 passed, 1 error in 0.1s =====').metrics).toBeUndefined();
    expect(parseTestOutput('# tests 3\n# pass 3\n# fail 0\n      Tests  4 passed (4)\n').metrics).toBeUndefined();
    expect(parseTestOutput('all good').metrics).toBeUndefined();
    expect(parseTestOutput('# tests 2\n# pass 5\n# fail 0\n').metrics).toBeUndefined();
  });
});
