import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { LabelKitClient } from './client.js';
import { runTool, TOOLS } from './tools.js';
import { BASE, bodyFor, CASES, jsonResponse, KEY } from './test-support.js';

const tool = (name: string) => TOOLS.find((t) => t.name === name)!;

describe('tool handlers, against a mocked fetch', () => {
	for (const c of CASES) {
		it(`${c.tool} ${JSON.stringify(c.input)} makes the documented request and returns structured content`, async () => {
			const body = bodyFor(c.spec);
			const fetchImpl = vi.fn(async () => jsonResponse(body));
			const api = new LabelKitClient({ apiKey: KEY, baseUrl: BASE, fetch: fetchImpl as never });

			const result = await runTool(tool(c.tool) as never, api, c.input);

			expect(result.isError).toBeUndefined();
			const [url, init] = fetchImpl.mock.calls[0] as unknown as [URL, RequestInit];
			expect(String(url)).toBe(c.url);
			expect(init.headers).toMatchObject({ Authorization: `Bearer ${KEY}` });
			// The same JSON as structured content and as text.
			expect(result.structuredContent).toEqual(body);
			expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual(body);
			// And it satisfies the tool's own output schema.
			expect(tool(c.tool).outputSchema.safeParse(result.structuredContent).success).toBe(true);
		});

		it(`${c.tool} accepts the nulls the API may send`, async () => {
			const body = bodyFor(c.spec, true);
			const api = { get: async () => body };
			const result = await runTool(tool(c.tool) as never, api, c.input);
			expect(result.isError).toBeUndefined();
			expect(result.structuredContent).toEqual(body);
		});
	}

	it('passes an API error on as a tool error with its code and message', async () => {
		const api = new LabelKitClient({
			apiKey: KEY,
			baseUrl: BASE,
			fetch: (async () =>
				jsonResponse({ error: { code: 'not_found', message: 'Release not found.' } }, 404)) as never
		});
		const result = await runTool(tool('get_release') as never, api, {
			release_id: '01900000-0000-7000-8000-000000000001'
		});
		expect(result.isError).toBe(true);
		expect(result.structuredContent).toBeUndefined();
		expect(result.content).toEqual([
			{ type: 'text', text: 'LabelKit API error 404 not_found: Release not found.' }
		]);
	});

	it('explains a rejected or under-scoped key', async () => {
		const answer = (status: number, code: string) => ({
			get: async () => {
				const { ApiError } = await import('./client.js');
				throw new ApiError(status, code, 'No.');
			}
		});
		const t = tool('list_releases') as never;
		const a = await runTool(t, answer(401, 'unauthorized'), {});
		expect((a.content[0] as { text: string }).text).toContain('LABELKIT_API_KEY');
		const b = await runTool(t, answer(403, 'insufficient_scope'), {});
		expect((b.content[0] as { text: string }).text).toContain('catalog:read');
	});

	it('reports a body it does not recognise instead of passing it on', async () => {
		const api = { get: async () => ({ data: 'nope' }) };
		const result = await runTool(tool('list_releases') as never, api, {});
		expect(result.isError).toBe(true);
		expect((result.content[0] as { text: string }).text).toMatch(
			/does not recognise|not recognise/
		);
	});

	it('reports bad arguments without calling the API', async () => {
		const get = vi.fn();
		for (const [name, input] of [
			['get_release', { release_id: 'nope' }],
			['list_releases', { limit: 500 }],
			['search_catalog', { query: '   ' }],
			['search_catalog', { query: 'a'.repeat(121) }]
		] as const) {
			const result = await runTool(tool(name) as never, { get }, input);
			expect(result.isError, name).toBe(true);
			expect((result.content[0] as { text: string }).text).toMatch(/^Invalid arguments/);
		}
		expect(get).not.toHaveBeenCalled();
	});

	it('drops fields the API adds later', async () => {
		const body = bodyFor('/v1/releases') as { extra?: unknown };
		body.extra = 'new';
		const result = await runTool(tool('list_releases') as never, { get: async () => body }, {});
		expect(result.structuredContent).not.toHaveProperty('extra');
	});

	it('never puts the key in a tool result', async () => {
		const api = new LabelKitClient({
			apiKey: KEY,
			baseUrl: BASE,
			fetch: (async () => {
				throw new Error(`down ${KEY}`);
			}) as never
		});
		const result = await runTool(tool('list_releases') as never, api, {});
		expect(JSON.stringify(result)).not.toContain(KEY);
		expect(z.string().parse((result.content[0] as { text: string }).text)).toMatch(
			/Could not reach/
		);
	});
});
