import { and, eq, sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { labelHandoffs, labelSessions, memberships, orgs } from './db/schema';
import { asUser } from './db/scoped';
import {
	HANDOFF_TTL_MS,
	SESSION_ABSOLUTE_MS,
	SESSION_IDLE_MS,
	exchangeHandoff,
	mintHandoff,
	purgeLabelSessions,
	resolveLabelSession,
	revokeLabelSession,
	revokeLabelSessionsForHost,
	revokeLabelSessionsForOrg,
	revokeLabelSessionsForOrgUser,
	revokeLabelSessionsForUser,
	sha256
} from './label-session';
import { createTestDb } from './test-db';

// Label sessions against a real database (migration 0039). A session on a label's own domain
// reaches that label only, ends on its own clocks, and ends the moment the person, the label or
// the domain stops matching.
const MEMBER = '00000000-0000-7000-8000-0000000000a1';
const OTHER = '00000000-0000-7000-8000-0000000000a2';
const HOST = 'music.example.test';
const HOST_B = 'other.example.test';
const T0 = new Date('2026-11-26T08:00:00Z');
const after = (ms: number, from = T0) => new Date(from.getTime() + ms);

describe('label sessions (database)', () => {
	let db: Awaited<ReturnType<typeof createTestDb>>['db'];
	let orgA: string;
	let orgB: string;

	// A fresh label per test would be slow; each test uses its own people and tickets instead, and
	// the few that change the label put it back.
	beforeAll(async () => {
		({ db } = await createTestDb());
		[{ id: orgA }] = await db
			.insert(orgs)
			.values({ name: 'Music', slug: 'music', customDomain: HOST, domainStatus: 'active' })
			.returning();
		[{ id: orgB }] = await db
			.insert(orgs)
			.values({ name: 'Other', slug: 'other', customDomain: HOST_B, domainStatus: 'active' })
			.returning();
		await db.insert(memberships).values([
			{ orgId: orgA, userId: MEMBER, role: 'catalog_manager' },
			{ orgId: orgB, userId: MEMBER, role: 'viewer' },
			{ orgId: orgB, userId: OTHER, role: 'owner' }
		]);
	});

	const open = async (userId = MEMBER, orgId = orgA, host = HOST, now = T0) => {
		const ticket = await mintHandoff(db, { userId, orgId, host, now });
		const made = await exchangeHandoff(db, { ticket, host, now });
		if (!made) throw new Error('expected a session');
		return made;
	};

	describe('handoff tickets', () => {
		it('stores only the hash of a ticket', async () => {
			const ticket = await mintHandoff(db, { userId: MEMBER, orgId: orgA, host: HOST, now: T0 });
			const rows = await db
				.select()
				.from(labelHandoffs)
				.where(eq(labelHandoffs.ticketHash, sha256(ticket)));
			expect(rows).toHaveLength(1);
			expect(rows[0].expiresAt).toEqual(after(HANDOFF_TTL_MS));
			expect(JSON.stringify(rows)).not.toContain(ticket);
		});

		it('is single-use: the second exchange of one ticket gets nothing', async () => {
			const ticket = await mintHandoff(db, { userId: MEMBER, orgId: orgA, host: HOST, now: T0 });
			const first = await exchangeHandoff(db, { ticket, host: HOST, now: T0 });
			expect(first).toMatchObject({ orgId: orgA, userId: MEMBER });
			expect(await exchangeHandoff(db, { ticket, host: HOST, now: T0 })).toBeNull();
		});

		it('two exchanges at once make one session', async () => {
			const ticket = await mintHandoff(db, { userId: MEMBER, orgId: orgA, host: HOST, now: T0 });
			const both = await Promise.all([
				exchangeHandoff(db, { ticket, host: HOST, now: T0 }),
				exchangeHandoff(db, { ticket, host: HOST, now: T0 })
			]);
			expect(both.filter(Boolean)).toHaveLength(1);
		});

		it('expires after 60 seconds', async () => {
			const ticket = await mintHandoff(db, { userId: MEMBER, orgId: orgA, host: HOST, now: T0 });
			expect(
				await exchangeHandoff(db, { ticket, host: HOST, now: after(HANDOFF_TTL_MS) })
			).toBeNull();
		});

		it('works on the host it was minted for only, and is not used up by another host', async () => {
			const ticket = await mintHandoff(db, { userId: MEMBER, orgId: orgA, host: HOST, now: T0 });
			expect(await exchangeHandoff(db, { ticket, host: HOST_B, now: T0 })).toBeNull();
			expect(await exchangeHandoff(db, { ticket, host: HOST, now: T0 })).not.toBeNull();
		});

		it('is refused for someone who is not (or no longer) a member of the label', async () => {
			const ticket = await mintHandoff(db, { userId: OTHER, orgId: orgA, host: HOST, now: T0 });
			expect(await exchangeHandoff(db, { ticket, host: HOST, now: T0 })).toBeNull();
		});

		it('is refused for a value that is not a ticket', async () => {
			expect(await exchangeHandoff(db, { ticket: 'nope', host: HOST, now: T0 })).toBeNull();
		});
	});

	describe('a session', () => {
		it('resolves to its label and the person’s role there, on its own host only', async () => {
			const { sessionId } = await open();
			expect(await resolveLabelSession(db, { sessionId, host: HOST, now: T0 })).toMatchObject({
				userId: MEMBER,
				orgId: orgA,
				role: 'catalog_manager'
			});
			expect(await resolveLabelSession(db, { sessionId, host: HOST_B, now: T0 })).toBeNull();
			expect(await resolveLabelSession(db, { sessionId: 'nope', host: HOST, now: T0 })).toBeNull();
		});

		it('never reaches a second label the person also belongs to', async () => {
			const { sessionId } = await open();
			const seen = await resolveLabelSession(db, { sessionId, host: HOST, now: T0 });
			expect(seen?.orgId).toBe(orgA);
			expect(seen?.orgId).not.toBe(orgB);
		});

		it('stores only the hash of its id', async () => {
			const { sessionId } = await open();
			const rows = await db
				.select()
				.from(labelSessions)
				.where(eq(labelSessions.idHash, sha256(sessionId)));
			expect(rows).toHaveLength(1);
			expect(JSON.stringify(rows)).not.toContain(sessionId);
		});

		it('ends 7 days after its last use, and use keeps it going', async () => {
			const { sessionId } = await open();
			const day6 = after(6 * 24 * 3600 * 1000);
			expect(await resolveLabelSession(db, { sessionId, host: HOST, now: day6 })).not.toBeNull();
			// Used on day 6, so day 12 is within 7 days of that use.
			const day12 = after(12 * 24 * 3600 * 1000);
			expect(await resolveLabelSession(db, { sessionId, host: HOST, now: day12 })).not.toBeNull();
			const gone = await open();
			expect(
				await resolveLabelSession(db, {
					sessionId: gone.sessionId,
					host: HOST,
					now: after(SESSION_IDLE_MS + 1000)
				})
			).toBeNull();
		});

		it('ends 30 days after it began, however often it is used', async () => {
			const { sessionId } = await open();
			let now = T0;
			while (now.getTime() + 6 * 24 * 3600 * 1000 < T0.getTime() + SESSION_ABSOLUTE_MS) {
				now = after(6 * 24 * 3600 * 1000, now);
				expect(await resolveLabelSession(db, { sessionId, host: HOST, now })).not.toBeNull();
			}
			expect(
				await resolveLabelSession(db, {
					sessionId,
					host: HOST,
					now: after(SESSION_ABSOLUTE_MS)
				})
			).toBeNull();
		});

		it('refreshes its last use at most once a minute', async () => {
			const { sessionId } = await open();
			const read = async () =>
				(
					await db
						.select({ at: labelSessions.lastUsedAt })
						.from(labelSessions)
						.where(eq(labelSessions.idHash, sha256(sessionId)))
				)[0].at;
			await resolveLabelSession(db, { sessionId, host: HOST, now: after(10_000) });
			expect(await read()).toEqual(T0);
			await resolveLabelSession(db, { sessionId, host: HOST, now: after(61_000) });
			expect(await read()).toEqual(after(61_000));
		});
	});

	describe('ending a session', () => {
		it('sign-out ends that session and no other', async () => {
			const a = await open();
			const b = await open();
			expect(await revokeLabelSession(db, a.sessionId, after(1000))).toBe(1);
			expect(
				await resolveLabelSession(db, { sessionId: a.sessionId, host: HOST, now: after(2000) })
			).toBeNull();
			expect(
				await resolveLabelSession(db, { sessionId: b.sessionId, host: HOST, now: after(2000) })
			).not.toBeNull();
			expect(await revokeLabelSession(db, a.sessionId, after(3000))).toBe(0);
		});

		it('removing a member ends their session on the next request, even if nothing revoked it', async () => {
			await db.insert(memberships).values({ orgId: orgA, userId: OTHER, role: 'viewer' });
			const { sessionId } = await open(OTHER);
			expect(await resolveLabelSession(db, { sessionId, host: HOST, now: T0 })).not.toBeNull();
			await db
				.delete(memberships)
				.where(and(eq(memberships.userId, OTHER), eq(memberships.orgId, orgA)));
			expect(await resolveLabelSession(db, { sessionId, host: HOST, now: T0 })).toBeNull();
		});

		it('closing the label ends its sessions, and reopening does not bring a revoked one back', async () => {
			const { sessionId } = await open();
			await db
				.update(orgs)
				.set({ closedAt: T0, purgeAfter: after(30 * 24 * 3600 * 1000) })
				.where(eq(orgs.id, orgA));
			expect(await resolveLabelSession(db, { sessionId, host: HOST, now: T0 })).toBeNull();
			await db.update(orgs).set({ closedAt: null, purgeAfter: null }).where(eq(orgs.id, orgA));
			expect(await resolveLabelSession(db, { sessionId, host: HOST, now: T0 })).not.toBeNull();
			expect(await revokeLabelSessionsForOrg(db, orgA, T0)).toBeGreaterThan(0);
			expect(await resolveLabelSession(db, { sessionId, host: HOST, now: T0 })).toBeNull();
		});

		it('changing the label’s domain ends sessions on the old one', async () => {
			const { sessionId } = await open();
			await db.update(orgs).set({ customDomain: 'moved.example.test' }).where(eq(orgs.id, orgA));
			expect(await resolveLabelSession(db, { sessionId, host: HOST, now: T0 })).toBeNull();
			await db.update(orgs).set({ customDomain: HOST }).where(eq(orgs.id, orgA));
			expect(await revokeLabelSessionsForHost(db, HOST, T0)).toBeGreaterThan(0);
			expect(await resolveLabelSession(db, { sessionId, host: HOST, now: T0 })).toBeNull();
		});

		it('a domain that is not active gives no session', async () => {
			const ticket = await mintHandoff(db, { userId: MEMBER, orgId: orgA, host: HOST, now: T0 });
			await db.update(orgs).set({ domainStatus: 'failed' }).where(eq(orgs.id, orgA));
			expect(await exchangeHandoff(db, { ticket, host: HOST, now: T0 })).toBeNull();
			await db.update(orgs).set({ domainStatus: 'active' }).where(eq(orgs.id, orgA));
		});

		it('revokes by person and by person-and-label', async () => {
			const one = await open(MEMBER, orgA, HOST);
			const two = await open(MEMBER, orgB, HOST_B);
			expect(await revokeLabelSessionsForOrgUser(db, orgA, MEMBER, after(1000))).toBeGreaterThan(0);
			expect(
				await resolveLabelSession(db, { sessionId: one.sessionId, host: HOST, now: after(2000) })
			).toBeNull();
			expect(
				await resolveLabelSession(db, { sessionId: two.sessionId, host: HOST_B, now: after(2000) })
			).not.toBeNull();
			expect(await revokeLabelSessionsForUser(db, MEMBER, after(3000))).toBeGreaterThan(0);
			expect(
				await resolveLabelSession(db, { sessionId: two.sessionId, host: HOST_B, now: after(4000) })
			).toBeNull();
		});
	});

	it('purges what can no longer be used and keeps the rest', async () => {
		const old = await open();
		await mintHandoff(db, { userId: MEMBER, orgId: orgA, host: HOST, now: T0 });
		const later = after(SESSION_ABSOLUTE_MS + 2 * 24 * 3600 * 1000);
		const fresh = await open(MEMBER, orgA, HOST, after(-24 * 3600 * 1000, later));
		const result = await purgeLabelSessions(db, later);
		expect(result.sessions).toBeGreaterThan(0);
		expect(result.handoffs).toBeGreaterThan(0);
		const left = (await db.select({ id: labelSessions.idHash }).from(labelSessions)).map(
			(r) => r.id
		);
		expect(left).not.toContain(sha256(old.sessionId));
		expect(left).toContain(sha256(fresh.sessionId));
	});

	it('is closed to every database role but the owner', async () => {
		for (const table of ['label_sessions', 'label_handoffs']) {
			await expect(
				asUser(db, MEMBER, (tx) => tx.execute(sql.raw(`select count(*) from public.${table}`)))
			).rejects.toBeTruthy();
		}
	});
});
