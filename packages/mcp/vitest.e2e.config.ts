import { defineConfig } from 'vitest/config';

// Runs the built package (dist/cli.js) over stdio. Build first: `pnpm --filter labelkit-co build`.
export default defineConfig({
	test: { include: ['e2e/**/*.e2e.test.ts'], environment: 'node', testTimeout: 30_000 }
});
