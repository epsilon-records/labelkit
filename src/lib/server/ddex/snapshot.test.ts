import { randomUUID } from 'node:crypto';
import { beforeAll, expect, it } from 'vitest';
import { createTestDb } from '../test-db';
import { scopedTo } from '../db/scoped';
import {
	credits,
	labels,
	memberships,
	orgs,
	parties,
	recordings,
	releases,
	releaseTracks
} from '../db/schema';
import { ernSnapshot } from './snapshot';
import { generateErn } from './ern';
import { testContext } from './ern.fixture';

let db: Awaited<ReturnType<typeof createTestDb>>['db'];
const actor = randomUUID(),
	otherActor = randomUUID();
let orgId: string, releaseId: string, otherReleaseId: string;
beforeAll(async () => {
	({ db } = await createTestDb());
	for (const [i, userId] of [actor, otherActor].entries()) {
		const [{ id: org }] = await db
			.insert(orgs)
			.values({ name: 'ERN test org', slug: `ern-fixture-${i}` })
			.returning();
		await db.insert(memberships).values({ orgId: org, userId, role: 'owner' });
		const [{ id: labelId }] = await db
			.insert(labels)
			.values({ orgId: org, name: 'ERN test label' })
			.returning();
		const [{ id: partyId }] = await db
			.insert(parties)
			.values({ orgId: org, displayName: 'ERN test artist', matchKey: `ern artist ${i}` })
			.returning();
		const [{ id: recordingId }] = await db
			.insert(recordings)
			.values({
				orgId: org,
				title: 'ERN test recording',
				isrc: `ZZERN260000${i}`,
				durationMs: 1001
			})
			.returning();
		const [{ id }] = await db
			.insert(releases)
			.values({
				orgId: org,
				labelId,
				title: `ERN test release ${i}`,
				upc: `12345678901${i}`,
				type: 'single',
				genre: 'Test genre'
			})
			.returning();
		await db.insert(releaseTracks).values([
			{ orgId: org, releaseId: id, recordingId, disc: 1, position: 1 },
			{ orgId: org, releaseId: id, recordingId, disc: 2, position: 1 }
		]);
		await db.insert(credits).values([
			{ orgId: org, releaseId: id, partyId, role: 'main', source: 'test', approvedAt: new Date() },
			{ orgId: org, recordingId, partyId, role: 'main', source: 'test', approvedAt: new Date() }
		]);
		if (i === 0) {
			orgId = org;
			releaseId = id;
		} else otherReleaseId = id;
	}
});

it('reads one consistent selected-release snapshot under the actual member RLS role', async () => {
	const snapshot = await scopedTo(db, actor)((tx) => ernSnapshot(tx, orgId, releaseId));
	expect(snapshot?.release.title).toBe('ERN test release 0');
	expect(snapshot?.tracks.map((t) => [t.disc, t.position])).toEqual([
		[1, 1],
		[2, 1]
	]);
	expect(snapshot?.recordings).toHaveLength(1);
	expect(snapshot?.parties).toHaveLength(1);
	expect(snapshot?.credits).toHaveLength(2);
	expect(JSON.stringify(snapshot)).not.toContain('ERN test release 1');
	expect(JSON.stringify(snapshot)).not.toContain('objectKey');
	const result = generateErn(snapshot!, testContext);
	expect(result.xml).toBeNull();
	expect(result.findings.map((f) => f.path)).toContain('release.metadataLanguage');
	expect(result.findings.map((f) => f.path)).toContain('release.parentalWarning');
});

it('returns no snapshot when the tenant or RLS actor does not own the release', async () => {
	expect(await scopedTo(db, otherActor)((tx) => ernSnapshot(tx, orgId, releaseId))).toBeNull();
	expect(await scopedTo(db, actor)((tx) => ernSnapshot(tx, orgId, otherReleaseId))).toBeNull();
});
