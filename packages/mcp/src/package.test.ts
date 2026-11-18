import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { VERSION } from './version.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

describe('package.json', () => {
	it('is labelkit-co, at the version the server reports', () => {
		expect(pkg.name).toBe('labelkit-co');
		expect(pkg.version).toBe(VERSION);
		expect(pkg.mcpName).toBe('io.github.epsilon-records/labelkit');
		expect(pkg.bin).toEqual({ 'labelkit-co': 'dist/cli.js' });
	});

	it('cannot be published by accident (D4: Nate approves each publish)', () => {
		expect(pkg.private).toBe(true);
		for (const hook of ['prepublish', 'prepublishOnly', 'publish', 'postpublish']) {
			expect(pkg.scripts[hook], hook).toBeUndefined();
		}
	});

	it('pins the MCP SDK exactly', () => {
		expect(pkg.dependencies['@modelcontextprotocol/server']).toMatch(/^2\.\d+\.\d+$/);
	});
});
