import { describe, expect, it } from 'vitest';
import { buildAnalysis, type AnalysisJob } from '#lib/analysis.js';
import { GET as getAnalysis } from '../../../routes/v1/recordings/[id]/analysis/+server';
import { GET as getSearch } from '../../../routes/v1/search/+server';
import { ApiError, analysisWire, searchQuery, toWire } from './v1.js';
import { expectMatchesSpec, openapiDoc } from './openapi-validate';

const url = (q: string) => new URL(`https://x/v1/search?${q}`);

describe('GET /v1/search q', () => {
	it('is 1 to 120 characters once whitespace is collapsed', () => {
		expect(searchQuery(url('q=%20%20vex%20%20ra%20'))).toBe('vex ra');
		// A tab or newline is a control character, not a space to fold.
		expect(() => searchQuery(url('q=vex%09ra'))).toThrow(ApiError);
		expect(() => searchQuery(url('q=vex%0Ara'))).toThrow(ApiError);
		expect(searchQuery(url(`q=${'a'.repeat(120)}`))).toHaveLength(120);
		for (const bad of ['', 'q=', 'q=%20%09', `q=${'a'.repeat(121)}`, 'q=a%00b', 'q=a%07']) {
			expect(() => searchQuery(url(bad)), bad).toThrow(ApiError);
		}
	});
});

describe('/v1 responses match docs/openapi.yaml', () => {
	it('search results, in the wire shape', () => {
		const body = toWire({
			query: 'vex',
			releases: [
				{
					id: '01900000-0000-7000-8000-000000000030',
					title: 'First Release',
					versionTitle: null,
					catalogNumber: 'FUZ001',
					upc: '000000000001',
					releaseDate: '2026-01-09',
					label: 'Imprint',
					artists: ['Test Artist']
				}
			],
			recordings: [
				{
					id: '01900000-0000-7000-8000-000000000020',
					title: 'First Track',
					versionTitle: 'Extended Mix',
					isrc: 'QZFZZ2600001',
					artists: []
				}
			],
			artists: [{ id: '01900000-0000-7000-8000-000000000010', name: 'Test Artist', credits: 2 }]
		});
		expectMatchesSpec('/v1/search', '200', body);
		expect(() => expectMatchesSpec('/v1/search', '200', { query: 'x' })).toThrow();
	});

	it('an analysis with a done, a failed and a pending card', () => {
		const job = (over: Partial<AnalysisJob>): AnalysisJob => ({
			id: '01900000-0000-7000-8000-000000000050',
			operation: 'probe',
			status: 'succeeded',
			result: { container: 'wave', codec: 'pcm_s24le' },
			error: null,
			requestedAt: new Date('2026-01-01T00:00:00Z'),
			finishedAt: '2026-01-01T00:01:00.000Z',
			...over
		});
		const analysis = buildAnalysis([
			job({}),
			job({
				id: '01900000-0000-7000-8000-000000000051',
				operation: 'tempo',
				status: 'failed',
				result: null,
				error: { code: 'internal', message: 'boom' },
				finishedAt: null
			})
		]);
		const body = { analysis: analysisWire(analysis) };
		expectMatchesSpec('/v1/recordings/{id}/analysis', '200', body);
		expect(body.analysis.probe).toMatchObject({
			status: 'done',
			requested_at: '2026-01-01T00:00:00.000Z',
			finished_at: '2026-01-01T00:01:00.000Z',
			result: { container: 'wave', codec: 'pcm_s24le' }
		});
		expect(body.analysis.tempo).toMatchObject({ status: 'failed', reason: 'boom' });
		expect(body.analysis.key).toMatchObject({ status: 'pending', job_id: null, result: null });
	});

	it('every operation documents a 200 body schema and the 401 and 403 errors', () => {
		for (const [path, item] of Object.entries(openapiDoc.paths)) {
			if (path === '/v1/openapi.yaml' || !item.get) continue;
			expect(Object.keys(item.get.responses), path).toEqual(
				expect.arrayContaining(['200', '401', '403'])
			);
			expectMatchesSpecShape(path);
		}
	});
});

function expectMatchesSpecShape(path: string) {
	// A 200 with a schema, not just a description (EPSILON-138).
	expect(() => expectMatchesSpec(path, '200', 'not an object'), path).toThrow(/does not match/);
}

describe('the new routes check the key', () => {
	const call = async (handler: (event: never) => unknown, locals: object, extra: object = {}) =>
		(await handler({
			locals,
			url: url('q=x'),
			params: { id: '01900000-0000-7000-8000-000000000020' },
			...extra
		} as never)) as Response;

	it('answer 401 without a key and 403 without catalog:read', async () => {
		for (const handler of [getSearch, getAnalysis]) {
			const none = await call(handler, {});
			expect(none.status).toBe(401);
			expect(await none.json()).toEqual({
				error: { code: 'unauthorized', message: 'Missing or invalid API key.' }
			});
			const scopeless = await call(handler, {
				apiKey: { id: 'k', scopes: ['processing:request'] },
				membership: { orgId: 'o', orgName: 'O', role: 'agent' }
			});
			expect(scopeless.status).toBe(403);
			expect((await scopeless.json()).error.code).toBe('insufficient_scope');
		}
	});

	it('answer 400 for a bad q and 404 for an id that is not a uuid, before touching the database', async () => {
		const locals = {
			apiKey: { id: 'k', scopes: ['catalog:read'] },
			membership: { orgId: 'o', orgName: 'O', role: 'agent' },
			db: () => Promise.reject(new Error('the database must not be reached'))
		};
		const bad = await call(getSearch, locals, { url: url('q=') });
		expect(bad.status).toBe(400);
		expect((await bad.json()).error.code).toBe('invalid_request');
		const missing = await call(getAnalysis, locals, { params: { id: 'nope' } });
		expect(missing.status).toBe(404);
		expect(missing.headers.get('cache-control')).toBe('no-store');
	});
});
