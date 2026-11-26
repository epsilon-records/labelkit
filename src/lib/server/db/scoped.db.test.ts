import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../audit';
import { createTestDb } from '../test-db';
import { asUser, scopedTo } from './scoped';

// The optional label pin (knowledge labelkit 0051): a transaction-local setting that nothing reads
// yet. These tests only pin down how it is set and that it never leaks.
const USER = '00000000-0000-7000-8000-0000000000b1';
const ORG = '019A0000-0000-7000-8000-0000000000B2';

describe('asUser label pin', () => {
	let db: Awaited<ReturnType<typeof createTestDb>>['db'];
	beforeAll(async () => {
		({ db } = await createTestDb());
	});

	const pinned = (tx: Database) =>
		tx
			.execute(sql`select nullif(current_setting('app.pinned_org', true), '') as org`)
			.then((r) => (r as unknown as { org: string | null }[])[0].org);

	it('sets app.pinned_org for the transaction, lowercased', async () => {
		expect(await asUser(db, USER, pinned, { pinOrgId: ORG })).toBe(ORG.toLowerCase());
		expect(await scopedTo(db, USER, { pinOrgId: ORG })(pinned)).toBe(ORG.toLowerCase());
	});

	it('sets nothing without a pin, and the pin does not outlive its transaction', async () => {
		expect(await asUser(db, USER, pinned)).toBeNull();
		await asUser(db, USER, async () => {}, { pinOrgId: ORG });
		expect(await asUser(db, USER, pinned)).toBeNull();
	});

	it('refuses a pin that is not a UUID', () => {
		expect(() => asUser(db, USER, pinned, { pinOrgId: "x'; drop table orgs; --" })).toThrow(
			'pinOrgId must be a UUID'
		);
	});
});
