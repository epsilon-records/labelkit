import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, isNotNull, isNull, lt, lte, or, type SQL } from 'drizzle-orm';
import type { Database } from '#lib/server/audit.js';
import { labelHandoffs, labelSessions, memberships, orgs } from '#lib/server/db/schema.js';

/**
 * Sessions on a label's own domain (knowledge labelkit 0051 and 0054, epsilon-records/labelkit#258).
 *
 * Sign-in always completes on labelkit.co. A label that has its own domain then gets the person
 * there with a one-time ticket (a handoff) that the domain exchanges once for a session cookie. The
 * session reaches that label only. Both the ticket and the cookie value are 32 random bytes and only
 * their SHA-256 is stored.
 *
 * Every function here takes the owner connection: label_sessions and label_handoffs have no
 * policy and no grant for any other role (migration 0039). Nothing calls this module yet; the
 * handoff routes and the request hook come in the next pull requests, behind a flag.
 */

/** A ticket lives for 60 seconds. */
export const HANDOFF_TTL_MS = 60_000;
/** A session ends after 7 days without use (labelkit 0054)... */
export const SESSION_IDLE_MS = 7 * 24 * 60 * 60 * 1000;
/** ...and after 30 days at most. */
export const SESSION_ABSOLUTE_MS = 30 * 24 * 60 * 60 * 1000;
/** `lastUsedAt` is written at most this often, so a busy session is not a write per request. */
export const TOUCH_INTERVAL_MS = 60_000;

export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/** A new random value for a ticket or a session cookie: 32 bytes, base64url (43 characters). */
export function newToken(random: (n: number) => Buffer = randomBytes) {
	const token = random(32).toString('base64url');
	return { token, hash: sha256(token) };
}

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/** A host as stored: lowercase, no port, no trailing dot. */
export function normaliseHost(host: string): string {
	return host.trim().toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
}

export const handoffExpiry = (now: Date) => new Date(now.getTime() + HANDOFF_TTL_MS);
export const sessionExpiry = (now: Date) => new Date(now.getTime() + SESSION_ABSOLUTE_MS);
/**
 * The idle limit is 7 days from the last stored use, and a use is stored at most once per
 * TOUCH_INTERVAL_MS, so a use up to a minute before that can be missing. The check allows for it:
 * the idle timeout is 7 days plus at most one minute, and never ends a session early.
 */
export const idleCutoff = (now: Date) =>
	new Date(now.getTime() - SESSION_IDLE_MS - TOUCH_INTERVAL_MS);

export type HandoffInput = { userId: string; orgId: string; host: string; now?: Date };

/**
 * Mint a one-time ticket for `userId` to open a session on `host`, the custom domain of `orgId`.
 * The caller has already checked that the person belongs to that label (the exchange checks again).
 * The ticket is returned once; only its hash is kept.
 */
export async function mintHandoff(db: Database, input: HandoffInput): Promise<string> {
	const now = input.now ?? new Date();
	const { token, hash } = newToken();
	await db.insert(labelHandoffs).values({
		ticketHash: hash,
		userId: input.userId,
		orgId: input.orgId,
		host: normaliseHost(input.host),
		createdAt: now,
		expiresAt: handoffExpiry(now)
	});
	return token;
}

export type ExchangedSession = {
	sessionId: string;
	expiresAt: Date;
	orgId: string;
	userId: string;
};

/**
 * Trade a ticket for a session on `host`, once. The ticket is used in the same statement that checks
 * it (`used_at IS NULL`, not expired, same host), so two requests with one ticket cannot both win. A
 * ticket for another host is left alone. The person must still belong to the label, the label must be
 * open and `host` must still be its custom domain, or no session is made.
 */
export async function exchangeHandoff(
	db: Database,
	input: { ticket: string; host: string; now?: Date }
): Promise<ExchangedSession | null> {
	if (!TOKEN_RE.test(input.ticket)) return null;
	const now = input.now ?? new Date();
	const host = normaliseHost(input.host);
	return db.transaction(async (tx) => {
		const [used] = await tx
			.update(labelHandoffs)
			.set({ usedAt: now })
			.where(
				and(
					eq(labelHandoffs.ticketHash, sha256(input.ticket)),
					eq(labelHandoffs.host, host),
					isNull(labelHandoffs.usedAt),
					gt(labelHandoffs.expiresAt, now)
				)
			)
			.returning({ userId: labelHandoffs.userId, orgId: labelHandoffs.orgId });
		if (!used) return null;

		const [live] = await tx
			.select({ id: orgs.id })
			.from(orgs)
			.innerJoin(
				memberships,
				and(eq(memberships.orgId, orgs.id), eq(memberships.userId, used.userId))
			)
			.where(and(eq(orgs.id, used.orgId), isNull(orgs.closedAt), eq(orgs.customDomain, host)));
		if (!live) return null;

		const { token, hash } = newToken();
		const expiresAt = sessionExpiry(now);
		await tx.insert(labelSessions).values({
			idHash: hash,
			userId: used.userId,
			orgId: used.orgId,
			host,
			createdAt: now,
			lastUsedAt: now,
			expiresAt
		});
		return { sessionId: token, expiresAt, orgId: used.orgId, userId: used.userId };
	});
}

export type ResolvedLabelSession = { userId: string; orgId: string; role: string; expiresAt: Date };

/**
 * The session behind a cookie value on `host`, or null. It must be on this host, not revoked, within
 * both lifetimes, and its person must still belong to the label, which must be open and still own
 * `host` as its custom domain. Those last checks make removal, closing and a domain change end
 * a session on the next request even before anything revokes it. A hit refreshes `lastUsedAt`.
 */
export async function resolveLabelSession(
	db: Database,
	input: { sessionId: string; host: string; now?: Date }
): Promise<ResolvedLabelSession | null> {
	if (!TOKEN_RE.test(input.sessionId)) return null;
	const now = input.now ?? new Date();
	const host = normaliseHost(input.host);
	const idHash = sha256(input.sessionId);
	const [row] = await db
		.select({
			userId: labelSessions.userId,
			orgId: labelSessions.orgId,
			role: memberships.role,
			expiresAt: labelSessions.expiresAt,
			lastUsedAt: labelSessions.lastUsedAt
		})
		.from(labelSessions)
		.innerJoin(
			memberships,
			and(eq(memberships.orgId, labelSessions.orgId), eq(memberships.userId, labelSessions.userId))
		)
		.innerJoin(orgs, eq(orgs.id, labelSessions.orgId))
		.where(
			and(
				eq(labelSessions.idHash, idHash),
				eq(labelSessions.host, host),
				isNull(labelSessions.revokedAt),
				gt(labelSessions.expiresAt, now),
				gt(labelSessions.lastUsedAt, idleCutoff(now)),
				isNull(orgs.closedAt),
				eq(orgs.customDomain, host)
			)
		);
	if (!row) return null;
	if (now.getTime() - row.lastUsedAt.getTime() >= TOUCH_INTERVAL_MS) {
		// Checked again against the stored row, so two requests that both saw the old value write once.
		await db
			.update(labelSessions)
			.set({ lastUsedAt: now })
			.where(
				and(
					eq(labelSessions.idHash, idHash),
					lte(labelSessions.lastUsedAt, new Date(now.getTime() - TOUCH_INTERVAL_MS))
				)
			);
	}
	return { userId: row.userId, orgId: row.orgId, role: row.role, expiresAt: row.expiresAt };
}

const revoke = (db: Database, where: SQL | undefined, now: Date) =>
	db
		.update(labelSessions)
		.set({ revokedAt: now })
		.where(and(where, isNull(labelSessions.revokedAt)))
		.returning({ idHash: labelSessions.idHash })
		.then((rows) => rows.length);

/** End one session (sign-out on the label's domain). Returns how many ended. */
export function revokeLabelSession(db: Database, sessionId: string, now = new Date()) {
	if (!TOKEN_RE.test(sessionId)) return Promise.resolve(0);
	return revoke(db, eq(labelSessions.idHash, sha256(sessionId)), now);
}

/** End every label session of a person (sign-out everywhere). */
export const revokeLabelSessionsForUser = (db: Database, userId: string, now = new Date()) =>
	revoke(db, eq(labelSessions.userId, userId), now);

/** End one person's sessions on one label (they were removed from it). */
export const revokeLabelSessionsForOrgUser = (
	db: Database,
	orgId: string,
	userId: string,
	now = new Date()
) => revoke(db, and(eq(labelSessions.orgId, orgId), eq(labelSessions.userId, userId)), now);

/** End every session of a label (it is closed). */
export const revokeLabelSessionsForOrg = (db: Database, orgId: string, now = new Date()) =>
	revoke(db, eq(labelSessions.orgId, orgId), now);

/** End every session on a host (the label changed or removed its domain). */
export const revokeLabelSessionsForHost = (db: Database, host: string, now = new Date()) =>
	revoke(db, eq(labelSessions.host, normaliseHost(host)), now);

/**
 * Delete tickets and sessions that can no longer be used: expired tickets, and sessions past their
 * absolute end, past the idle window or revoked a day ago. Nothing schedules this yet.
 */
export async function purgeLabelSessions(db: Database, now = new Date()) {
	const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
	const tickets = await db
		.delete(labelHandoffs)
		.where(lt(labelHandoffs.expiresAt, dayAgo))
		.returning({ id: labelHandoffs.ticketHash });
	const sessions = await db
		.delete(labelSessions)
		.where(
			or(
				lt(labelSessions.expiresAt, now),
				lt(labelSessions.lastUsedAt, idleCutoff(now)),
				and(isNotNull(labelSessions.revokedAt), lt(labelSessions.revokedAt, dayAgo))
			)
		)
		.returning({ id: labelSessions.idHash });
	return { handoffs: tickets.length, sessions: sessions.length };
}
