import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { flatten, responseSchema } from './spec-fixtures.js';
import { TOOLS } from './tools.js';

/**
 * Each tool's output schema is the /v1 response in docs/openapi.yaml. If the API document changes
 * a field, its type, its nullability or whether it is required, this fails until the tool follows.
 */
const ENDPOINT: Record<string, string> = {
	search_catalog: '/v1/search',
	list_releases: '/v1/releases',
	get_release: '/v1/releases/{id}',
	list_recordings: '/v1/recordings',
	get_recording: '/v1/recordings/{id}',
	get_recording_analysis: '/v1/recordings/{id}/analysis',
	create_release: '/v1/releases',
	add_track: '/v1/releases/{id}/tracks',
	create_recording: '/v1/recordings',
	create_artist: '/v1/artists'
};

describe('tool output schemas match docs/openapi.yaml', () => {
	it('covers every tool', () => {
		expect(Object.keys(ENDPOINT).sort()).toEqual(TOOLS.map((t) => t.name).sort());
	});

	for (const tool of TOOLS) {
		it(`${tool.name} is ${ENDPOINT[tool.name]}'s response, field for field`, () => {
			const fromTool = flatten(
				z.toJSONSchema(tool.outputSchema, { io: 'output', reused: 'inline' })
			);
			const fromSpec = flatten(responseSchema(ENDPOINT[tool.name]!, 'write' in tool));
			expect(fromTool).toEqual(fromSpec);
		});
	}

	it('notices a difference (the check is not vacuous)', () => {
		const spec = responseSchema('/v1/releases');
		const changed = structuredClone(spec);
		changed.properties.next_cursor.type = 'string';
		expect(flatten(changed)).not.toEqual(flatten(spec));
	});
});
