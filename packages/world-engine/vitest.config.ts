import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'world-engine',
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
  },
});
