import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import {
	auditLog,
	credits,
	importRuns,
	orgs,
	recordings,
	releases,
	releaseTracks,
	rightsShares
} from '../db/schema';
import { createTestDb } from '../test-db';
import { applyImport, ImportTrackConflict } from './apply';
import { generateErn } from '../ddex/ern';
import { completeErnFixture, testContext } from '../ddex/ern.fixture';
import { parseErnDocuments } from './ern';
import { parseSymphonicInventory } from './symphonic';

const SAMPLE = readFileSync(
	new URL('./__fixtures__/symphonic-sample.csv', import.meta.url),
	'utf8'
);
const actor = { id: 'user-1', kind: 'user' as const };

describe('applyImport', () => {
	let db: Awaited<ReturnType<typeof createTestDb>>['db'];
	let orgId: string;
	const ctx = (dryRun: boolean) => ({
		orgId,
		actor,
		fileName: 'sample.csv',
		fileSha256: 'a'.repeat(64),
		dryRun
	});

	beforeEach(async () => {
		({ db } = await createTestDb());
		const [org] = await db
			.insert(orgs)
			.values({ name: 'Epsilon Records', slug: 'epsilon' })
			.returning();
		orgId = org.id;
	});

	it('dry run reports counts and writes nothing', async () => {
		const result = await applyImport(db, parseSymphonicInventory(SAMPLE), ctx(true));
		expect(result.dryRun).toBe(true);
		expect(result.importRunId).toBeNull();
		expect(result.counts.releases.created).toBe(10);
		expect(await db.select().from(releases)).toHaveLength(0);
		expect(await db.select().from(auditLog)).toHaveLength(0);
	});

	it('previews and applies ERN without writing rights or replacing existing tracks', async () => {
		const snapshot = completeErnFixture();
		snapshot.release.upc = '012345678905';
		snapshot.tracks.push({ ...snapshot.tracks[0], disc: 2 });
		const generated = generateErn(snapshot, testContext);
		expect(generated.findings).toEqual([]);
		const text = generated.xml!.replace(
			'</SoundRecording>',
			'<ResourceRightsController><RightSharePercentage>25</RightSharePercentage></ResourceRightsController></SoundRecording>'
		);
		const docs = [{ name: 'fixture.xml', text }];
		const plan = parseErnDocuments(docs);
		const ern = { ...ctx(true), source: 'ddex-ern' as const, fileName: 'fixture.xml' };

		expect((await applyImport(db, plan, ern)).counts.tracks.created).toBe(2);
		expect(await db.select().from(releases)).toHaveLength(0);
		expect(await db.select().from(rightsShares)).toHaveLength(0);
		await applyImport(db, plan, { ...ern, dryRun: false });
		expect(await db.select().from(rightsShares)).toHaveLength(0);
		expect(await db.select().from(releaseTracks)).toHaveLength(2);
		expect(await db.select().from(importRuns)).toMatchObject([{ source: 'ddex-ern' }]);

		const conflict = parseErnDocuments([
			{ ...docs[0], text: text.replace('ZZTST2600001', 'ZZTST2600002') }
		]);
		await expect(applyImport(db, conflict, { ...ern, dryRun: false })).rejects.toBeInstanceOf(
			ImportTrackConflict
		);
		expect(await db.select().from(releaseTracks)).toHaveLength(2);
		expect(await db.select().from(recordings)).toHaveLength(1);
		expect(await db.select().from(rightsShares)).toHaveLength(0);
	});

	it('matches an existing release whose UPC/EAN is padded differently', async () => {
		const snapshot = completeErnFixture();
		snapshot.release.upc = '012345678905';
		const text = generateErn(snapshot, testContext).xml!;
		const ern = { ...ctx(false), source: 'ddex-ern' as const, fileName: 'fixture.xml' };
		await applyImport(db, parseErnDocuments([{ name: 'fixture.xml', text }]), ern);
		// The catalogue may hold the 13-digit form, as a CSV import stores it.
		await db.update(releases).set({ upc: '0012345678905' });

		for (const padded of ['012345678905', '0012345678905', '00012345678905']) {
			const plan = parseErnDocuments([
				{ name: 'fixture.xml', text: text.replace('<ICPN>012345678905<', '<ICPN>' + padded + '<') }
			]);
			const again = await applyImport(db, plan, ern);
			expect(again.counts.releases).toMatchObject({ created: 0, unchanged: 1 });
			expect(again.counts.tracks.created).toBe(0);
		}
		expect(await db.select({ upc: releases.upc }).from(releases)).toEqual([
			{ upc: '0012345678905' }
		]);
	});

	it('imports the catalog with an audit trail', async () => {
		const plan = parseSymphonicInventory(SAMPLE);
		const result = await applyImport(db, plan, ctx(false));

		expect(await db.select().from(releases)).toHaveLength(10);
		expect(await db.select().from(recordings)).toHaveLength(plan.recordings.size);
		expect(await db.select().from(releaseTracks)).toHaveLength(21);
		expect(await db.select().from(importRuns)).toHaveLength(1);
		const createdCredits = await db.select().from(credits);
		expect(createdCredits.every((c) => c.approvedAt != null && c.source === 'symphonicms')).toBe(
			true
		);

		const audit = await db.select().from(auditLog);
		const creates = result.counts;
		const expected =
			creates.labels.created +
			creates.parties.created +
			creates.recordings.created +
			creates.releases.created +
			creates.credits.created +
			10 + // one tracklist entry per release
			1; // the import run
		expect(audit).toHaveLength(expected);
	});

	it('is idempotent: re-importing the same file changes nothing', async () => {
		await applyImport(db, parseSymphonicInventory(SAMPLE), ctx(false));
		const again = await applyImport(db, parseSymphonicInventory(SAMPLE), ctx(false));
		for (const c of Object.values(again.counts)) {
			expect(c.created).toBe(0);
			expect(c.updated).toBe(0);
		}
		expect(await db.select().from(releases)).toHaveLength(10);
		expect(await db.select().from(releaseTracks)).toHaveLength(21);
	});

	it('refuses a plan that has errors', async () => {
		const plan = parseSymphonicInventory('Name\nx\n');
		await expect(applyImport(db, plan, ctx(false))).rejects.toThrow(/has errors/);
	});
});
