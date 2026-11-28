import { count, eq } from 'drizzle-orm';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { labelHandoffs, labelSessions, memberships, orgs } from '#lib/server/db/schema.js';
import { createTestDb } from '#lib/server/test-db.js';
import { resolveLabelSession, sha256 } from '#lib/server/label-session.js';
import { GET as go } from '../../go/[host]/+server';
import { GET as handoff } from './+server';

// The two routes end to end against a real database: /go/[host] mints a ticket for a member, and
// /auth/handoff on the label's host spends it once. Single use, the 60-second expiry, the host and
// the person are enforced by the database in label-session.ts (label-session.db.test.ts covers the
// module); these tests go through the routes, so a route that skipped a check would fail here.
const holder = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock('#lib/server/db/client.js', () => ({ db: () => holder.db }));
vi.mock('#lib/server/label-sessions-env.js', () => ({ labelSessionsEnabled: () => true }));

const MEMBER = '00000000-0000-7000-8000-0000000000c1';
const OTHER = '00000000-0000-7000-8000-0000000000c2';
const HOST_A = 'music.example.test';
const HOST_B = 'other.example.test';
const T0 = new Date('2026-11-26T08:00:00Z');

describe('label handoff routes (database)', () => {
	let db: Awaited<ReturnType<typeof createTestDb>>['db'];
	let orgA: string;
	let orgB: string;

	beforeAll(async () => {
		({ db } = await createTestDb());
		holder.db = db;
		[{ id: orgA }] = await db
			.insert(orgs)
			.values({ name: 'Music', slug: 'music', customDomain: HOST_A, domainStatus: 'active' })
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

	beforeEach(() => {
		// Only Date is faked: the database driver needs its real timers.
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(T0);
	});
	afterEach(() => vi.useRealTimers());

	const asMember = (userId: string, orgIds: string[]) => ({
		user: { id: userId },
		memberships: orgIds.map((orgId) => ({ orgId, orgName: 'x', role: 'viewer' }))
	});

	/** Run /go as a signed-in person and return the ticket from the redirect. */
	async function ticketFor(host: string, userId = MEMBER, orgIds = [orgA, orgB]) {
		const res = await go({ params: { host }, locals: asMember(userId, orgIds) } as never);
		expect(res.status).toBe(303);
		const location = new URL(res.headers.get('location') as string);
		expect(location.origin).toBe(`https://${host}`);
		expect(location.pathname).toBe('/auth/handoff');
		return location.searchParams.get('t') as string;
	}

	/** Open /auth/handoff on `host` with `ticket`: the redirect, and the cookie it set, if any. */
	async function open(host: string, ticket: string) {
		const set = vi.fn();
		const res = await handoff({
			url: new URL(`https://${host}/auth/handoff?t=${encodeURIComponent(ticket)}`),
			cookies: { set }
		} as never);
		return {
			location: res.headers.get('location'),
			cookie: set.mock.calls[0]?.[1] as string | undefined
		};
	}

	const sessions = async () => (await db.select({ n: count() }).from(labelSessions))[0].n;
	const tickets = async () => (await db.select({ n: count() }).from(labelHandoffs))[0].n;

	it('gives a member a session for their label, and stores only hashes', async () => {
		const ticket = await ticketFor(HOST_A);
		const stored = await db
			.select()
			.from(labelHandoffs)
			.where(eq(labelHandoffs.ticketHash, sha256(ticket)));
		expect(stored).toHaveLength(1);
		expect(stored[0]).toMatchObject({ userId: MEMBER, orgId: orgA, host: HOST_A });

		const { location, cookie } = await open(HOST_A, ticket);
		expect(location).toBe('/?signed-in');
		expect(cookie).toMatch(/^[A-Za-z0-9_-]{43}$/);
		const resolved = await resolveLabelSession(db, { sessionId: cookie as string, host: HOST_A });
		expect(resolved).toMatchObject({ userId: MEMBER, orgId: orgA, role: 'catalog_manager' });
		const rows = await db
			.select()
			.from(labelSessions)
			.where(eq(labelSessions.idHash, sha256(cookie as string)));
		expect(rows).toHaveLength(1);
	});

	it('is single-use: the same ticket opened twice makes one session', async () => {
		const ticket = await ticketFor(HOST_A);
		const before = await sessions();
		const first = await open(HOST_A, ticket);
		const second = await open(HOST_A, ticket);
		expect(first.location).toBe('/?signed-in');
		expect(second).toEqual({ location: '/login?link=invalid', cookie: undefined });
		expect(await sessions()).toBe(before + 1);
	});

	it('two opens at once still make one session', async () => {
		const ticket = await ticketFor(HOST_A);
		const before = await sessions();
		const results = await Promise.all([open(HOST_A, ticket), open(HOST_A, ticket)]);
		expect(results.map((r) => r.location).sort()).toEqual(['/?signed-in', '/login?link=invalid']);
		expect(await sessions()).toBe(before + 1);
	});

	it('expires after 60 seconds', async () => {
		const ticket = await ticketFor(HOST_A);
		vi.setSystemTime(new Date(T0.getTime() + 61_000));
		const before = await sessions();
		expect(await open(HOST_A, ticket)).toEqual({
			location: '/login?link=invalid',
			cookie: undefined
		});
		expect(await sessions()).toBe(before);
	});

	it('is still good a moment before it expires', async () => {
		const ticket = await ticketFor(HOST_A);
		vi.setSystemTime(new Date(T0.getTime() + 59_000));
		expect((await open(HOST_A, ticket)).location).toBe('/?signed-in');
	});

	it('works on the host it was minted for only, and another host does not use it up', async () => {
		const ticket = await ticketFor(HOST_A);
		const before = await sessions();
		// The person belongs to both labels, and HOST_B is a label's domain: still the wrong host.
		expect(await open(HOST_B, ticket)).toEqual({
			location: '/login?link=invalid',
			cookie: undefined
		});
		expect(await open('labelkit.co', ticket)).toEqual({
			location: '/login?link=invalid',
			cookie: undefined
		});
		expect(await sessions()).toBe(before);
		expect((await open(HOST_A, ticket)).location).toBe('/?signed-in');
	});

	it('is refused for a person who is not a member: no ticket from /go, none that works from the table', async () => {
		const before = await tickets();
		// OTHER belongs to B only; HOST_A is A's. /go says 404 and writes nothing.
		await expect(
			go({ params: { host: HOST_A }, locals: asMember(OTHER, [orgB]) } as never)
		).rejects.toMatchObject({ status: 404 });
		// Even if the hook's membership list claimed A, the ticket is for the person, and the exchange
		// checks the database: a ticket minted for OTHER at A's host makes no session.
		const forged = await go({ params: { host: HOST_A }, locals: asMember(OTHER, [orgA]) } as never);
		const ticket = new URL(forged.headers.get('location') as string).searchParams.get(
			't'
		) as string;
		expect(await tickets()).toBe(before + 1);
		expect(await open(HOST_A, ticket)).toEqual({
			location: '/login?link=invalid',
			cookie: undefined
		});
	});

	it('is refused when the person has left the label since the ticket was minted', async () => {
		const leaver = '00000000-0000-7000-8000-0000000000c3';
		await db.insert(memberships).values({ orgId: orgA, userId: leaver, role: 'viewer' });
		const ticket = await ticketFor(HOST_A, leaver, [orgA]);
		await db.delete(memberships).where(eq(memberships.userId, leaver));
		expect(await open(HOST_A, ticket)).toEqual({
			location: '/login?link=invalid',
			cookie: undefined
		});
	});

	it('does not mint for a host that is not the label’s active domain, or for a closed label', async () => {
		await expect(
			go({
				params: { host: 'nobody.example.test' },
				locals: asMember(MEMBER, [orgA, orgB])
			} as never)
		).rejects.toMatchObject({ status: 404 });

		await db
			.update(orgs)
			.set({ closedAt: T0, purgeAfter: new Date(T0.getTime() + 30 * 24 * 3600 * 1000) })
			.where(eq(orgs.id, orgB));
		try {
			await expect(
				go({ params: { host: HOST_B }, locals: asMember(MEMBER, [orgA, orgB]) } as never)
			).rejects.toMatchObject({ status: 404 });
		} finally {
			await db.update(orgs).set({ closedAt: null, purgeAfter: null }).where(eq(orgs.id, orgB));
		}
	});

	it('gives a member of several labels a session for the one whose host they opened', async () => {
		const a = await open(HOST_A, await ticketFor(HOST_A));
		const b = await open(HOST_B, await ticketFor(HOST_B));
		expect(
			await resolveLabelSession(db, { sessionId: a.cookie as string, host: HOST_A })
		).toMatchObject({ orgId: orgA });
		expect(
			await resolveLabelSession(db, { sessionId: b.cookie as string, host: HOST_B })
		).toMatchObject({ orgId: orgB });
		// Neither cookie works on the other label's host.
		expect(
			await resolveLabelSession(db, { sessionId: a.cookie as string, host: HOST_B })
		).toBeNull();
		expect(
			await resolveLabelSession(db, { sessionId: b.cookie as string, host: HOST_A })
		).toBeNull();
	});
});
