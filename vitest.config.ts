import { defineConfig } from 'vitest/config';

export default defineConfig({
  css: {
    postcss: {
      plugins: [],
    },
  },
  test: {
    root: __dirname,
    include: ['src/**/*.test.ts'],
  },
});
