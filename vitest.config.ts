import { defineConfig } from 'vitest/config';
import path from 'node:path';

const r = (p: string) => path.resolve(import.meta.dirname, p);

export default defineConfig({
  resolve: {
    alias: [
      { find: '@nodepilot/shared/node', replacement: r('packages/shared/src/node/index.ts') },
      { find: '@nodepilot/shared', replacement: r('packages/shared/src/index.ts') },
      { find: '@nodepilot/instrument', replacement: r('packages/instrument/src/index.ts') },
    ],
  },
  test: {
    include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20_000,
    pool: 'forks',
  },
});
