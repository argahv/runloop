import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'runtime',
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    // node:sqlite is experimental on Node 22; hide its startup warning in test workers.
    execArgv: ['--disable-warning=ExperimentalWarning'],
  },
});
