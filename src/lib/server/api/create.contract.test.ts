import { expect, it } from 'vitest';
import { createEndpoint } from './create';
import { expectMatchesSpec, openapiDoc } from './openapi-validate';
import { artistToWire } from './v1';

/** Contract tests for docs/openapi.yaml that need no database. */

const row = {
	id: '01900000-0000-7000-8000-000000000010',
	orgId: '01900000-0000-7000-8000-000000000001',
	kind: 'unknown',
	displayName: 'Test Artist',
	matchKey: 'test artist',
	createdAt: new Date('2026-01-01T00:00:00Z')
};

it('documents an artist exactly as the list and create endpoints send it', () => {
	const artist = artistToWire(row);
	// Internal columns (org id, match key) never reach the wire, and there is no updated_at.
	expect(Object.keys(artist).sort()).toEqual(['created_at', 'display_name', 'id', 'kind']);
	expectMatchesSpec('/v1/artists', '200', { data: [artist], next_cursor: null });
	expectMatchesSpec('/v1/artists', '201', { artist }, 'post');
	expect(() => expectMatchesSpec('/v1/artists', '201', { artist: { id: row.id } }, 'post')).toThrow(
		/does not match/
	);
	expect(() =>
		expectMatchesSpec('/v1/artists', '201', { artist: { ...artist, match_key: 'x' } }, 'post')
	).toThrow(/does not match/);
});

it('documents the 404 the track endpoint gives for an id that is not a UUID', async () => {
	const post = openapiDoc.paths['/v1/releases/{id}/tracks'].post;
	expect(Object.keys(post.responses)).toContain('404');
	const request = new Request('http://localhost/v1/releases/not-a-uuid/tracks', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ mode: 'existing', recording_id: row.id, disc: 1, position: 1 })
	});
	const response = await createEndpoint('track')({
		request,
		url: new URL(request.url),
		params: { id: 'not-a-uuid' },
		locals: {
			apiKey: { id: 'k', actorId: row.id, scopes: ['catalog:write'] },
			membership: { orgId: row.orgId, orgName: 'Test', role: 'agent' },
			db: {}
		} as unknown as App.Locals
	});
	expect(response.status).toBe(404);
	expectMatchesSpec('/v1/releases/{id}/tracks', '404', await response.json(), 'post');
});
