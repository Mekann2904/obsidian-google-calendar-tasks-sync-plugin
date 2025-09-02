import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['__tests__/**/*.spec.ts'],
  },
  resolve: {
    alias: [
      {
        find: /^obsidian$/,
        replacement: path.resolve(__dirname, 'tests/mocks/obsidian.ts'),
      },
      {
        find: /^\.\/gcalMapper$/,
        replacement: path.resolve(__dirname, 'tests/mocks/gcalMapper.ts'),
      },
    ],
  },
});


