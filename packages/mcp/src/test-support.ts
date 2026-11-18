import { responseSchema, sample } from './spec-fixtures.js';

export const KEY = `lk_abcd1234_${'A1b2C3d4'.repeat(6).slice(0, 43)}`;
export const ID = '01900000-0000-7000-8000-000000000001';
export const BASE = 'https://api.labelkit.test';

/** Each tool, an input for it, and the request it must make. */
export const CASES = [
	{
		tool: 'search_catalog',
		input: { query: '  vex ra ' },
		url: `${BASE}/v1/search?q=vex+ra`,
		spec: '/v1/search'
	},
	{
		tool: 'list_releases',
		input: { limit: 10, after: ID },
		url: `${BASE}/v1/releases?limit=10&after=${ID}`,
		spec: '/v1/releases'
	},
	{ tool: 'list_releases', input: {}, url: `${BASE}/v1/releases`, spec: '/v1/releases' },
	{
		tool: 'get_release',
		input: { release_id: ID },
		url: `${BASE}/v1/releases/${ID}`,
		spec: '/v1/releases/{id}'
	},
	{
		tool: 'list_recordings',
		input: { limit: 200 },
		url: `${BASE}/v1/recordings?limit=200`,
		spec: '/v1/recordings'
	},
	{
		tool: 'get_recording',
		input: { recording_id: ID },
		url: `${BASE}/v1/recordings/${ID}`,
		spec: '/v1/recordings/{id}'
	},
	{
		tool: 'get_recording_analysis',
		input: { recording_id: ID },
		url: `${BASE}/v1/recordings/${ID}/analysis`,
		spec: '/v1/recordings/{id}/analysis'
	}
] as const;

/** A body the API would send for this case, made from docs/openapi.yaml. */
export const bodyFor = (spec: string, nulls = false) => sample(responseSchema(spec), nulls);

export function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' }
	});
}
