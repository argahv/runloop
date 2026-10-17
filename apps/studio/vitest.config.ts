import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'studio',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
