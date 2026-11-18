import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

// static/llms.txt is what AI assistants read about LabelKit. Its API section names endpoints
// agents will call, so each one must be in docs/openapi.yaml with the same method.
const llms = readFileSync('static/llms.txt', 'utf8');
const spec = readFileSync('docs/openapi.yaml', 'utf8');

/** `METHOD /path` for every operation in the spec. */
function documented(): Set<string> {
	const out = new Set<string>();
	let path = '';
	for (const line of spec.split('\n')) {
		const p = line.match(/^ {2}(\/v1\/[^:]*):$/);
		if (p) path = p[1];
		const m = line.match(/^ {4}(get|post|put|patch|delete):/);
		if (m && path) out.add(`${m[1].toUpperCase()} ${path}`);
	}
	return out;
}

it('llms.txt names only endpoints in docs/openapi.yaml', () => {
	const named = [...llms.matchAll(/`(GET|POST|PUT|PATCH|DELETE) (\/v1\/[^`\s]*)`/g)].map(
		(m) => `${m[1]} ${m[2]}`
	);
	expect(named.length).toBeGreaterThan(0);
	const known = documented();
	for (const endpoint of named) expect(known, endpoint).toContain(endpoint);
});

it('llms.txt points at the published contract on the API host', () => {
	expect(llms).toContain('https://api.labelkit.co/v1/openapi.yaml');
	expect(spec).toMatch(/url: https:\/\/api\.labelkit\.co/);
});

it('llms.txt does not call the API "coming"', () => {
	expect(llms).not.toMatch(/REST API[^.\n]*coming|API: coming/i);
});
