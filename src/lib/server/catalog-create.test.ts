import { beforeEach, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { createRelease, addTrack } from './catalog-create';
import { EditError } from './catalog-edit';
import { asUser } from './db/scoped';
import {
	auditLog,
	labels,
	memberships,
	orgs,
	recordings,
	releases,
	releaseTracks
} from './db/schema';
import { createTestDb } from './test-db';
let db: Awaited<ReturnType<typeof createTestDb>>['db'];
let orgId: string;
let labelId: string;
const owner = randomUUID(),
	viewer = randomUUID(),
	outsider = randomUUID();
const ctx = () => ({ orgId, actor: { id: owner, kind: 'user' as const } });
const fields = () => ({
	title: 'Test release',
	versionTitle: '',
	releaseDate: '',
	catalogNumber: '',
	upc: '000123450102',
	labelId,
	genre: '',
	subgenre: ''
});
beforeEach(async () => {
	({ db } = await createTestDb());
	const [org] = await db
		.insert(orgs)
		.values({ name: 'Test label', slug: randomUUID() })
		.returning();
	orgId = org.id;
	const [label] = await db.insert(labels).values({ orgId, name: 'Test imprint' }).returning();
	labelId = label.id;
	await db.insert(memberships).values([
		{ orgId, userId: owner, role: 'owner' },
		{ orgId, userId: viewer, role: 'viewer' }
	]);
});
it('creates and attaches new and existing recordings under RLS, derives type and audits atomically', async () => {
	const release = await asUser(db, owner, (tx) =>
		createRelease(tx, ctx(), { ...fields(), type: 'album' })
	);
	expect(release.type).toBe('single');
	const recording = await asUser(db, owner, (tx) =>
		addTrack(tx, ctx(), release.id, {
			mode: 'new',
			disc: '1',
			position: '1',
			title: 'Test recording',
			versionTitle: '',
			isrc: 'USAAA2600001',
			duration: '31:00',
			genre: '',
			subgenre: ''
		})
	);
	expect((await db.select().from(releases))[0].type).toBe('album');
	await asUser(db, owner, (tx) =>
		addTrack(tx, ctx(), release.id, {
			mode: 'existing',
			recordingId: recording.id,
			disc: '2',
			position: '1'
		})
	);
	expect(await db.select().from(releaseTracks)).toHaveLength(2);
	expect(await db.select().from(recordings)).toHaveLength(1);
	expect((await db.select().from(auditLog)).map((a) => a.action)).toEqual([
		'create',
		'create',
		'add_track',
		'add_track'
	]);
});
it('refuses invalid identifiers, duplicate UPCs and occupied positions without partial recordings', async () => {
	await expect(createRelease(db, ctx(), { ...fields(), upc: 'invalid' })).rejects.toBeInstanceOf(
		EditError
	);
	const release = await createRelease(db, ctx(), fields());
	await expect(createRelease(db, ctx(), fields())).rejects.toBeInstanceOf(EditError);
	const track = {
		mode: 'new',
		disc: '1',
		position: '1',
		title: 'Test recording',
		versionTitle: '',
		isrc: 'USAAA2600001',
		duration: '',
		genre: '',
		subgenre: ''
	};
	await addTrack(db, ctx(), release.id, track);
	await expect(
		addTrack(db, ctx(), release.id, { ...track, isrc: 'USAAA2600002' })
	).rejects.toBeInstanceOf(EditError);
	expect(await db.select().from(recordings)).toHaveLength(1);
});
it('denies viewer and outsider creation and attachments even when application guards are bypassed', async () => {
	const release = await createRelease(db, ctx(), fields());
	for (const user of [viewer, outsider]) {
		await expect(
			asUser(db, user, (tx) =>
				createRelease(
					tx,
					{ ...ctx(), actor: { id: user, kind: 'user' } },
					{ ...fields(), upc: '000123450119' }
				)
			)
		).rejects.toThrow();
		await expect(
			asUser(db, user, (tx) =>
				addTrack(tx, { ...ctx(), actor: { id: user, kind: 'user' } }, release.id, {
					mode: 'new',
					disc: '1',
					position: '1',
					title: 'Test',
					versionTitle: '',
					isrc: 'USAAA2600001',
					duration: '',
					genre: '',
					subgenre: ''
				})
			)
		).rejects.toThrow();
	}
	expect(await db.select().from(recordings)).toHaveLength(0);
	expect(await db.select().from(releaseTracks)).toHaveLength(0);
});
it('rejects cross-organisation labels and recordings', async () => {
	const [org] = await db.insert(orgs).values({ name: 'Other', slug: randomUUID() }).returning();
	const [label] = await db
		.insert(labels)
		.values({ orgId: org.id, name: 'Other imprint' })
		.returning();
	await expect(createRelease(db, ctx(), { ...fields(), labelId: label.id })).rejects.toBeInstanceOf(
		EditError
	);
	const release = await createRelease(db, ctx(), fields());
	const [recording] = await db
		.insert(recordings)
		.values({ orgId: org.id, title: 'Other track', isrc: 'USAAA2600001' })
		.returning();
	await expect(
		addTrack(db, ctx(), release.id, {
			mode: 'existing',
			recordingId: recording.id,
			disc: '1',
			position: '1'
		})
	).rejects.toBeInstanceOf(EditError);
	expect(
		await db.select().from(releaseTracks).where(eq(releaseTracks.releaseId, release.id))
	).toHaveLength(0);
});
