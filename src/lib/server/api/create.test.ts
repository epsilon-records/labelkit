import { randomUUID } from 'node:crypto';
import { beforeEach, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createEndpoint } from './create';
import { createApiKey, resolveApiKey } from '../api-keys';
import { asUser, scopedTo } from '../db/scoped';
import {
	apiKeys,
	auditLog,
	labels,
	memberships,
	orgs,
	parties,
	recordings,
	releases,
	releaseTracks
} from '../db/schema';
import { createTestDb } from '../test-db';
import { expectMatchesSpec } from './openapi-validate';
let db: Awaited<ReturnType<typeof createTestDb>>['db'];
let orgId: string, labelId: string;
let writer: NonNullable<Awaited<ReturnType<typeof resolveApiKey>>>;
let reader: typeof writer;
const owner = randomUUID();
beforeEach(async () => {
	({ db } = await createTestDb());
	const [org] = await db
		.insert(orgs)
		.values({ name: 'API creation fixture', slug: randomUUID() })
		.returning();
	orgId = org.id;
	await db.insert(memberships).values({ orgId, userId: owner, role: 'owner' });
	const [label] = await db.insert(labels).values({ orgId, name: 'Test imprint' }).returning();
	labelId = label.id;
	for (const scopes of [['catalog:read', 'catalog:write'], ['catalog:read']]) {
		const created = await asUser(db, owner, (tx) =>
			createApiKey(tx, orgId, { name: scopes.join(','), scopes })
		);
		const key = (await resolveApiKey(db, created.key))!;
		if (scopes.includes('catalog:write')) writer = key;
		else reader = key;
	}
});
function call(
	operation: 'release' | 'recording' | 'artist' | 'track',
	body: unknown,
	key = writer,
	id?: string,
	idem?: string
) {
	const path =
		operation === 'track'
			? `/v1/releases/${id}/tracks`
			: `/v1/${operation === 'artist' ? 'artists' : operation + 's'}`;
	const request = new Request('http://localhost' + path, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			...(idem !== undefined ? { 'idempotency-key': idem } : {})
		},
		body: JSON.stringify(body)
	});
	return createEndpoint(operation)({
		request,
		url: new URL(request.url),
		params: { id: id ?? '' },
		locals: {
			apiKey: { id: key.id, actorId: key.actorId, scopes: key.scopes },
			membership: { orgId: key.orgId, orgName: 'Test', role: 'agent' },
			db: scopedTo(db, key.actorId)
		} as App.Locals
	});
}
const recordingBody = { title: 'New recording', isrc: 'USAAA2600001', duration: '03:00' };
it('creates each entity through the shared audited path, including a track on a release', async () => {
	const releaseResponse = await call('release', {
		title: 'New release',
		upc: '000123450102',
		label_id: labelId
	});
	expect(releaseResponse.status).toBe(201);
	const { release } = await releaseResponse.json();
	expect(release.type).toBe('single');
	expect(release.org_id).toBeUndefined();
	expect((await call('recording', recordingBody)).status).toBe(201);
	expect((await call('artist', { display_name: 'Test artist' })).status).toBe(201);
	const [recording] = await db.select().from(recordings);
	expect(
		(
			await call(
				'track',
				{ mode: 'existing', recording_id: recording.id, disc: 1, position: 1 },
				writer,
				release.id
			)
		).status
	).toBe(201);
	expect(
		(
			await call(
				'track',
				{
					mode: 'new',
					title: 'Second track',
					isrc: 'USAAA2600002',
					duration: '32:00',
					disc: 1,
					position: 2
				},
				writer,
				release.id
			)
		).status
	).toBe(201);
	expect(await db.select().from(releaseTracks)).toHaveLength(2);
	const writes = (await db.select().from(auditLog)).filter((a) => a.actorId === writer.actorId);
	expect(writes).toHaveLength(6);
	expect(writes.every((a) => a.actorKind === 'agent')).toBe(true);
});
it('rejects every read-only endpoint and denies direct SQL inserts by a read-only actor', async () => {
	for (const op of ['release', 'recording', 'artist', 'track'] as const)
		expect((await call(op, {}, reader, randomUUID())).status).toBe(403);
	await expect(
		asUser(db, reader.actorId, (tx) =>
			tx.insert(parties).values({ orgId, displayName: 'Denied', matchKey: 'denied' })
		)
	).rejects.toThrow();
	expect(await db.select().from(parties)).toHaveLength(0);
});
it('replays a successful idempotency receipt and rejects changed JSON without duplicate writes', async () => {
	const first = await call('recording', recordingBody, writer, undefined, 'retry-1');
	const again = await call('recording', recordingBody, writer, undefined, 'retry-1');
	expect(first.status).toBe(201);
	expect(again.status).toBe(201);
	expect(await first.json()).toEqual(await again.json());
	expect(
		(await call('recording', { ...recordingBody, title: 'Changed' }, writer, undefined, 'retry-1'))
			.status
	).toBe(409);
	expect(await db.select().from(recordings)).toHaveLength(1);
	expect((await call('artist', { display_name: 'Empty key' }, writer, undefined, '')).status).toBe(
		400
	);
});
it('returns validation and duplicate errors and cannot reference another organisation', async () => {
	expect((await call('release', { title: 'Invalid', upc: 'bad', label_id: labelId })).status).toBe(
		400
	);
	expect((await call('recording', recordingBody)).status).toBe(201);
	expect((await call('recording', recordingBody)).status).toBe(409);
	const [other] = await db.insert(orgs).values({ name: 'Other', slug: randomUUID() }).returning();
	const [label] = await db.insert(labels).values({ orgId: other.id, name: 'Other' }).returning();
	expect(
		(await call('release', { title: 'Cross-org', upc: '000123450102', label_id: label.id })).status
	).toBe(400);
	expect(await db.select().from(releases)).toHaveLength(0);
});
it('revoking the write key closes database write authority too', async () => {
	await db.update(apiKeys).set({ revokedAt: new Date() }).where(eq(apiKeys.id, writer.id));
	expect((await call('artist', { display_name: 'Revoked' })).status).toBe(403);
	const rows = await asUser(db, writer.actorId, (tx) =>
		tx.execute(sql`select app.can_catalog_create(${orgId}::uuid) as allowed`)
	);
	expect((rows as unknown as { allowed: boolean }[])[0].allowed).toBe(false);
});

it('serializes concurrent retries and rolls back failed receipt attempts', async () => {
	const responses = await Promise.all([
		call('artist', { display_name: 'Concurrent' }, writer, undefined, 'parallel'),
		call('artist', { display_name: 'Concurrent' }, writer, undefined, 'parallel')
	]);
	expect(responses.map((r) => r.status)).toEqual([201, 201]);
	expect(await responses[0].json()).toEqual(await responses[1].json());
	expect(await db.select().from(parties)).toHaveLength(1);
	expect(
		(await call('recording', { title: 'Missing ISRC' }, writer, undefined, 'recover')).status
	).toBe(400);
	expect((await call('recording', recordingBody, writer, undefined, 'recover')).status).toBe(201);
});
it('permits derived type refresh but forbids API actors editing unrelated release fields', async () => {
	const response = await call('release', {
		title: 'Original',
		upc: '000123450102',
		label_id: labelId
	});
	const { release } = await response.json();
	await expect(
		asUser(db, writer.actorId, (tx) =>
			tx.update(releases).set({ title: 'Not allowed' }).where(eq(releases.id, release.id))
		)
	).rejects.toThrow();
	expect((await db.select().from(releases))[0].title).toBe('Original');
});
it('sends artists in the documented shape', async () => {
	const response = await call('artist', { display_name: 'Contract artist' });
	expect(response.status).toBe(201);
	const body = await response.json();
	expectMatchesSpec('/v1/artists', '201', body, 'post');
	expect(body.artist).toMatchObject({ display_name: 'Contract artist', kind: 'unknown' });
});
it('keeps one receipt for a track retry that changes the release id letter case', async () => {
	const { release } = await (
		await call('release', { title: 'Case', upc: '000123450102', label_id: labelId })
	).json();
	const track = {
		mode: 'new',
		title: 'Only track',
		isrc: 'USAAA2600003',
		duration: '03:00',
		disc: 1,
		position: 1
	};
	const first = await call('track', track, writer, release.id.toLowerCase(), 'case-retry');
	const again = await call('track', track, writer, release.id.toUpperCase(), 'case-retry');
	expect(first.status).toBe(201);
	expect(again.status).toBe(201);
	expect(await again.json()).toEqual(await first.json());
	expect(await db.select().from(releaseTracks)).toHaveLength(1);
});
