import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'events',
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
  },
});
