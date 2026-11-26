import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ApiError, LabelKitClient } from './client.js';
import { responseSchema, sample } from './spec-fixtures.js';

import { runTool, TOOLS } from './tools.js';
import { BASE, bodyFor, CASES, ID, jsonResponse, KEY } from './test-support.js';

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

	it('accepts a timestamp with an offset, as well as Z', async () => {
		const body = bodyFor('/v1/releases') as { data: { updated_at: string }[] };
		body.data[0]!.updated_at = '2026-01-09T10:00:00.000+00:00';
		const result = await runTool(tool('list_releases') as never, { get: async () => body }, {});
		expect(result.isError).toBeUndefined();
		expect(result.structuredContent).toEqual(body);
	});

	it('does not put a reflected key into the tool text via an upstream code', async () => {
		const api = new LabelKitClient({
			apiKey: KEY,
			baseUrl: BASE,
			fetch: (async () => jsonResponse({ error: { code: KEY, message: KEY } }, 400)) as never
		});
		const result = await runTool(tool('list_releases') as never, api, {});
		expect(result.isError).toBe(true);
		expect(JSON.stringify(result)).not.toContain(KEY);
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

describe('create tools against a mocked API client', () => {
	it.each([
		[
			'create_release',
			'/v1/releases',
			'/v1/releases',
			{ title: 'Release', upc: '012345678905', label_id: ID },
			{}
		],
		[
			'create_recording',
			'/v1/recordings',
			'/v1/recordings',
			{ title: 'Track', isrc: 'USABC2600001' },
			{}
		],
		['create_artist', '/v1/artists', '/v1/artists', { display_name: 'Test Artist' }, {}],
		[
			'add_track',
			`/v1/releases/${ID}/tracks`,
			'/v1/releases/{id}/tracks',
			{ mode: 'existing', recording_id: ID, disc: 1, position: 2 },
			{ release_id: ID }
		],
		[
			'add_track',
			`/v1/releases/${ID}/tracks`,
			'/v1/releases/{id}/tracks',
			{ mode: 'new', title: 'Track', isrc: 'USABC2600001', disc: 1, position: 2 },
			{ release_id: ID }
		]
	])('%s posts to %s', async (name, path, spec, body, input) => {
		const response = sample(responseSchema(spec, true));
		const api = { get: vi.fn(), post: vi.fn().mockResolvedValue(response) };
		const result = await runTool(tool(name) as never, api, { ...input, body });
		expect(result.isError).toBeUndefined();
		expect(result.structuredContent).toEqual(response);
		expect(api.get).not.toHaveBeenCalled();
		expect(api.post).toHaveBeenCalledExactlyOnceWith(
			path,
			body,
			expect.stringMatching(/^[\da-f-]{36}$/i)
		);
	});

	it('reuses the supplied key and explains a write-scope rejection', async () => {
		const api = {
			get: vi.fn(),
			post: vi.fn().mockRejectedValue(new ApiError(403, 'insufficient_scope', 'Forbidden.'))
		};
		const body = { display_name: 'Test Artist' };
		const result = await runTool(tool('create_artist') as never, api, {
			body,
			idempotency_key: 'retry-1'
		});
		expect(api.post).toHaveBeenCalledExactlyOnceWith('/v1/artists', body, 'retry-1');
		expect(result).toMatchObject({
			isError: true,
			content: [
				{ text: expect.stringMatching(/403 insufficient_scope: Forbidden\. .*catalog:write/) }
			]
		});
	});
});
