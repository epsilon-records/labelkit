import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LabelKitClient } from './client.js';
import { buildServer } from './server.js';
import { BASE, bodyFor, ID, jsonResponse, KEY } from './test-support.js';
import { VERSION } from './version.js';

const NAMES = [
	'search_catalog',
	'list_releases',
	'get_release',
	'list_recordings',
	'get_recording',
	'get_recording_analysis',
	'create_release',
	'add_track',
	'create_recording',
	'create_artist'
];

let client: Client | undefined;
afterEach(async () => {
	await client?.close();
	client = undefined;
});

async function connect(fetchImpl: typeof fetch) {
	const server = buildServer(new LabelKitClient({ apiKey: KEY, baseUrl: BASE, fetch: fetchImpl }));
	const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
	await server.connect(serverSide);
	client = new Client({ name: 'test', version: '0.0.0' });
	await client.connect(clientSide);
	return client;
}

describe('the server over the protocol', () => {
	it('lists read and create tools, each with a title and an output schema', async () => {
		const c = await connect((async () => jsonResponse({})) as never);
		expect(c.getServerVersion()).toMatchObject({
			name: 'labelkit',
			title: 'LabelKit',
			version: VERSION
		});
		expect(c.getInstructions()).toMatch(/one record label's catalogue/);

		const { tools } = await c.listTools();
		expect(tools.map((t) => t.name).sort()).toEqual([...NAMES].sort());
		for (const t of tools) {
			expect(t.title, t.name).toMatch(/^([A-Z][a-z]+)( [A-Z][a-z]+)*$/);
			expect(t.annotations, t.name).toEqual(
				NAMES.slice(-4).includes(t.name)
					? {
							readOnlyHint: false,
							destructiveHint: false,
							idempotentHint: false,
							openWorldHint: false
						}
					: { readOnlyHint: true, openWorldHint: false }
			);
			expect(t.outputSchema, t.name).toMatchObject({ type: 'object' });
			expect(t.inputSchema, t.name).toMatchObject({ type: 'object' });
			expect(t.description, t.name).toBeTruthy();
		}
		expect(tools.find((t) => t.name === 'search_catalog')?.title).toBe('Search Catalogue');
	});

	it('calls a tool end to end: arguments in, one API request, structured content out', async () => {
		const body = bodyFor('/v1/recordings/{id}');
		const fetchImpl = vi.fn(async () => jsonResponse(body));
		const c = await connect(fetchImpl as never);

		const result = await c.callTool({ name: 'get_recording', arguments: { recording_id: ID } });

		expect(result.isError).toBeFalsy();
		expect(result.structuredContent).toEqual(body);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(String((fetchImpl.mock.calls[0] as unknown[])[0])).toBe(`${BASE}/v1/recordings/${ID}`);
	});

	it('answers an API error as a tool error, and bad input without calling the API', async () => {
		const fetchImpl = vi.fn(async () =>
			jsonResponse({ error: { code: 'not_found', message: 'Recording not found.' } }, 404)
		);
		const c = await connect(fetchImpl as never);
		const missing = await c.callTool({ name: 'get_recording', arguments: { recording_id: ID } });
		expect(missing.isError).toBe(true);
		expect(JSON.stringify(missing.content)).toContain('not_found');

		fetchImpl.mockClear();
		const bad = await c.callTool({ name: 'get_recording', arguments: { recording_id: 'nope' } });
		expect(bad.isError).toBe(true);
		expect(fetchImpl).not.toHaveBeenCalled();
	});
});
