import type { TestMetrics } from '@runloop-world/events';

export interface TapSummary {
  /** From the `# tests / # pass / # fail` footer; undefined if the footer is missing. */
  metrics?: TestMetrics;
  /** Names of failing tests (suites excluded), in output order. */
  failingTests: string[];
}

const NOT_OK = /^(\s*)not ok \d+ - (.*?)(?:\s+#\s*(?:SKIP|TODO)\b.*)?$/i;

function unescapeTap(name: string): string {
  return name.replace(/\\#/g, '#').replace(/\\\\/g, '\\');
}

/** Parse node:test's TAP reporter output. Only reads what the runner printed. */
export function parseTap(output: string): TapSummary {
  const lines = output.split(/\r?\n/);
  const footer = (key: string): number | undefined => {
    const re = new RegExp(`^# ${key} (\\d+)\\s*$`);
    for (let i = lines.length - 1; i >= 0; i--) {
      const m = re.exec(lines[i]!);
      if (m) return Number(m[1]);
    }
    return undefined;
  };
  const tests = footer('tests');
  const passed = footer('pass');
  const failed = footer('fail');

  const failingTests: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = NOT_OK.exec(lines[i]!);
    if (!m) continue;
    // A failing describe() block is reported as `not ok` with `type: 'suite'` in its YAML.
    let isSuite = false;
    const indent = m[1]!.length;
    if (lines[i + 1]?.trim() === '---') {
      for (let j = i + 2; j < lines.length; j++) {
        const line = lines[j]!;
        if (line.trim() === '...') break;
        if (line.slice(0, indent + 2).trim() === '' && /^\s*type: 'suite'\s*$/.test(line)) isSuite = true;
      }
    }
    if (!isSuite) failingTests.push(unescapeTap(m[2]!));
  }

  return {
    ...(tests !== undefined && passed !== undefined && failed !== undefined ? { metrics: { tests, passed, failed } } : {}),
    failingTests,
  };
}

/** "12 tests: 10 passed, 2 failed" */
export function formatTestSummary(m: TestMetrics): string {
  return `${m.tests} tests: ${m.passed} passed, ${m.failed} failed`;
}
