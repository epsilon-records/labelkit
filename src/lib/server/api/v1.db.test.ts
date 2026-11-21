import { beforeAll, describe, expect, it } from 'vitest';
import { GET as getRecording } from '../../../routes/v1/recordings/[id]/+server';
import { GET as getAnalysis } from '../../../routes/v1/recordings/[id]/analysis/+server';
import { GET as listRecordings } from '../../../routes/v1/recordings/+server';
import { GET as getRelease } from '../../../routes/v1/releases/[id]/+server';
import { GET as listReleases } from '../../../routes/v1/releases/+server';
import { GET as search } from '../../../routes/v1/search/+server';
import { createApiKey, resolveApiKey, type ResolvedKey } from '../api-keys';
import { recordingAnalysis } from '../analysis';
import {
	audiokitJobs,
	credits,
	labels,
	masters,
	memberships,
	orgs,
	parties,
	recordings,
	releaseTracks,
	releases
} from '../db/schema';
import { asUser, scopedTo } from '../db/scoped';
import { uuidv7 } from '../db/uuidv7';
import { searchCatalog } from '../search';
import { createTestDb } from '../test-db';
import { ApiError, analysisDetail } from './v1.js';
import { expectMatchesSpec } from './openapi-validate';

/**
 * The /v1 reads as a key's agent, under RLS: a key reads its own label's catalogue, search and
 * analysis included, and a key from another label reads none of it. Every body is also checked
 * against the response schema in docs/openapi.yaml (EPSILON-138).
 */

const ownerA = '00000000-0000-7000-8000-0000000000a1';
const ownerB = '00000000-0000-7000-8000-0000000000b1';

describe('/v1 reads (database)', () => {
	let db: Awaited<ReturnType<typeof createTestDb>>['db'];
	let orgA: string;
	let orgB: string;
	let keyA: ResolvedKey;
	let keyB: ResolvedKey;
	let recordingA: string;
	let releaseA: string;

	/** Call a /v1 handler the way the request hook sets it up for this key. */
	const call = async (
		handler: (event: never) => unknown,
		key: ResolvedKey,
		path: string,
		params: Record<string, string> = {}
	) => {
		const response = (await handler({
			url: new URL(`https://api.labelkit.test${path}`),
			params,
			locals: {
				apiKey: { id: key.id, scopes: key.scopes },
				membership: { orgId: key.orgId, orgName: key.orgName, role: 'agent' },
				db: scopedTo(db, key.actorId)
			}
		} as never)) as Response;
		return { status: response.status, body: await response.json() };
	};

	beforeAll(async () => {
		({ db } = await createTestDb());
		[{ id: orgA }] = await db.insert(orgs).values({ name: 'Api A', slug: 'api-a' }).returning();
		[{ id: orgB }] = await db.insert(orgs).values({ name: 'Api B', slug: 'api-b' }).returning();
		await db.insert(memberships).values([
			{ orgId: orgA, userId: ownerA, role: 'owner' },
			{ orgId: orgB, userId: ownerB, role: 'owner' }
		]);
		const [labelA] = await db.insert(labels).values({ orgId: orgA, name: 'Imprint A' }).returning();
		const [labelB] = await db.insert(labels).values({ orgId: orgB, name: 'Imprint B' }).returning();

		const seed = async (
			orgId: string,
			labelId: string,
			n: { release: string; track: string; artist: string; isrc: string; upc: string }
		) => {
			const [recording] = await db
				.insert(recordings)
				.values({ orgId, isrc: n.isrc, title: n.track, durationMs: 215000, genre: 'Techno' })
				.returning();
			const [release] = await db
				.insert(releases)
				.values({
					orgId,
					labelId,
					upc: n.upc,
					title: n.release,
					type: 'ep',
					releaseDate: '2026-01-09'
				})
				.returning();
			await db
				.insert(releaseTracks)
				.values({ orgId, releaseId: release.id, recordingId: recording.id, position: 1 });
			const [artist] = await db
				.insert(parties)
				.values({ orgId, displayName: n.artist, matchKey: n.artist.toLowerCase() })
				.returning();
			await db.insert(credits).values([
				{
					orgId,
					releaseId: release.id,
					partyId: artist.id,
					role: 'main',
					source: 'seed',
					approvedAt: new Date()
				},
				{ orgId, recordingId: recording.id, partyId: artist.id, role: 'main', source: 'seed' }
			]);
			return { recording, release };
		};

		const a = await seed(orgA, labelA.id, {
			release: 'Alpha Dawn',
			track: 'Alpha Track',
			artist: 'Alpha Artist',
			isrc: 'QZFZZ2600001',
			upc: '000000000001'
		});
		recordingA = a.recording.id;
		releaseA = a.release.id;
		await seed(orgB, labelB.id, {
			release: 'Beta Dusk',
			track: 'Beta Track',
			artist: 'Alpha Rival',
			isrc: 'QZFZZ2600002',
			upc: '000000000002'
		});

		const masterId = uuidv7();
		const [master] = await db
			.insert(masters)
			.values({
				id: masterId,
				orgId: orgA,
				recordingId: recordingA,
				objectKey: `orgs/${orgA}/recordings/${recordingA}/masters/${masterId}.wav`,
				format: 'wav',
				sizeBytes: 2048,
				sha256: 'a'.repeat(64),
				fileName: 'Master.wav',
				status: 'ready',
				uploadedBy: 'tester',
				completedAt: new Date()
			})
			.returning();
		await db.insert(audiokitJobs).values({
			orgId: orgA,
			recordingId: recordingA,
			masterId: master.id,
			operation: 'probe',
			status: 'succeeded',
			providerJobId: crypto.randomUUID(),
			submittedAt: new Date(),
			finishedAt: new Date(),
			result: { container: 'wave', codec: 'pcm_s24le', sample_rate: 48000 },
			requestedBy: 'tester'
		});

		const make = async (owner: string, orgId: string) =>
			(await resolveApiKey(
				db,
				(
					await asUser(db, owner, (tx) =>
						createApiKey(tx, orgId, { name: 'Read', scopes: ['catalog:read'] })
					)
				).key
			))!;
		keyA = await make(ownerA, orgA);
		keyB = await make(ownerB, orgB);
	});

	it('key A searches its own label, by name and by ISRC, and the body matches the spec', async () => {
		const byName = await call(search, keyA, '/v1/search?q=alpha');
		expect(byName.status).toBe(200);
		expectMatchesSpec('/v1/search', '200', byName.body);
		expect(byName.body.releases.map((r: { title: string }) => r.title)).toEqual(['Alpha Dawn']);
		expect(byName.body.recordings.map((r: { title: string }) => r.title)).toEqual(['Alpha Track']);
		expect(byName.body.artists.map((r: { name: string }) => r.name)).toEqual(['Alpha Artist']);
		expect(byName.body.releases[0]).toMatchObject({
			label: 'Imprint A',
			release_date: '2026-01-09',
			artists: ['Alpha Artist']
		});

		const byIsrc = await call(search, keyA, '/v1/search?q=QZFZZ2600001');
		expect(byIsrc.body.recordings.map((r: { isrc: string }) => r.isrc)).toEqual(['QZFZZ2600001']);
	});

	it("key B's search never returns label A's catalogue", async () => {
		// Label B's artist is named "Alpha Rival" and the search indexes credited artist names, so
		// B's own release and recording match "alpha" too. What must never appear is label A's.
		const found = await call(search, keyB, '/v1/search?q=alpha');
		expectMatchesSpec('/v1/search', '200', found.body);
		expect(found.body.releases.map((r: { title: string }) => r.title)).toEqual(['Beta Dusk']);
		expect(found.body.recordings.map((r: { title: string }) => r.title)).toEqual(['Beta Track']);
		expect(found.body.artists.map((r: { name: string }) => r.name)).toEqual(['Alpha Rival']);
		const everything = JSON.stringify(found.body);
		for (const name of ['Alpha Dawn', 'Alpha Track', 'Alpha Artist', 'Imprint A', 'QZFZZ2600001']) {
			expect(everything).not.toContain(name);
		}
		// Words only label A's rows contain find nothing for B.
		for (const q of ['dawn', 'QZFZZ2600001', 'Alpha Artist']) {
			const none = await call(search, keyB, `/v1/search?q=${encodeURIComponent(q)}`);
			expect([none.body.releases, none.body.recordings]).toEqual([[], []]);
			expect(none.body.artists.map((r: { name: string }) => r.name)).not.toContain('Alpha Artist');
		}
	});

	it('key A reads the analysis stored for its recording, and the body matches the spec', async () => {
		const read = await call(getAnalysis, keyA, `/v1/recordings/${recordingA}/analysis`, {
			id: recordingA
		});
		expect(read.status).toBe(200);
		expectMatchesSpec('/v1/recordings/{id}/analysis', '200', read.body);
		expect(read.body.analysis.probe).toMatchObject({
			status: 'done',
			result: { container: 'wave', sample_rate: 48000 }
		});
		expect(read.body.analysis.loudness).toMatchObject({ status: 'pending', job_id: null });
	});

	it("key B cannot read label A's analysis: 404, as for a recording that does not exist", async () => {
		const read = await call(getAnalysis, keyB, `/v1/recordings/${recordingA}/analysis`, {
			id: recordingA
		});
		expect(read.status).toBe(404);
		expect(read.body).toEqual({ error: { code: 'not_found', message: 'Recording not found.' } });
		const none = await call(getAnalysis, keyB, '/v1/recordings/x/analysis', {
			id: crypto.randomUUID()
		});
		expect(none.body).toEqual(read.body);
	});

	it("RLS alone hides label A from key B's agent, even when the query names label A", async () => {
		const asB = <T>(fn: Parameters<typeof asUser<T>>[2]) => asUser(db, keyB.actorId, fn);
		const found = await asB((tx) => searchCatalog(tx, orgA, 'alpha'));
		expect([found.releases, found.recordings, found.artists]).toEqual([[], [], []]);
		await expect(asB((tx) => analysisDetail(tx, orgA, recordingA))).rejects.toBeInstanceOf(
			ApiError
		);
		const analysis = await asB((tx) => recordingAnalysis(tx, orgA, recordingA));
		expect(analysis.probe.status).toBe('pending');
		expect(analysis.probe.result).toBeNull();
		// The same read as label A's own agent does see the stored result.
		const own = await asUser(db, keyA.actorId, (tx) => recordingAnalysis(tx, orgA, recordingA));
		expect(own.probe.status).toBe('done');
	});

	it('the four existing reads match their response schemas too, and key B sees none of label A', async () => {
		const releasesA = await call(listReleases, keyA, '/v1/releases');
		expectMatchesSpec('/v1/releases', '200', releasesA.body);
		expect(releasesA.body.data).toHaveLength(1);
		const releaseOne = await call(getRelease, keyA, `/v1/releases/${releaseA}`, { id: releaseA });
		expectMatchesSpec('/v1/releases/{id}', '200', releaseOne.body);
		expect(releaseOne.body.release.tracks[0].credits[0]).toMatchObject({ role: 'main' });
		const recordingsA = await call(listRecordings, keyA, '/v1/recordings');
		expectMatchesSpec('/v1/recordings', '200', recordingsA.body);
		const recordingOne = await call(getRecording, keyA, `/v1/recordings/${recordingA}`, {
			id: recordingA
		});
		expectMatchesSpec('/v1/recordings/{id}', '200', recordingOne.body);
		expect(recordingOne.body.recording.releases).toHaveLength(1);

		const releasesB = await call(listReleases, keyB, '/v1/releases');
		expect(releasesB.body.data.map((r: { id: string }) => r.id)).not.toContain(releaseA);
		expect((await call(getRelease, keyB, '/x', { id: releaseA })).status).toBe(404);
		expect((await call(getRecording, keyB, '/x', { id: recordingA })).status).toBe(404);
	});
});
