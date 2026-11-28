import { error } from '@sveltejs/kit';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '#lib/server/db/client.js';
import { orgs } from '#lib/server/db/schema.js';
import { handoffUrl, labelHostFrom, noStoreRedirect } from '#lib/server/label-host.js';
import { mintHandoff } from '#lib/server/label-session.js';
import { labelSessionsEnabled } from '#lib/server/label-sessions-env.js';
import type { RequestHandler } from './$types';

/**
 * Hands a signed-in person over to a label's own domain (knowledge labelkit 0051, 0052, 0054;
 * labelkit#258). Signed in on labelkit.co and a member of the label that owns `host`, they get a
 * one-time ticket and a 303 to `https://<host>/auth/handoff?t=<ticket>`, where the domain trades it
 * once for its own session.
 *
 * mintHandoff trusts its caller, so this is where the two checks are made: the person belongs to the
 * label (the memberships the hook read under RLS), and `host` is that label's active custom domain
 * and the label is open. Anything else is the same plain 404, whether the host is unknown, belongs
 * to another label, or the person is not a member: the answer never says which.
 *
 * Reads `orgs` on the owner connection to resolve a host to a label, like the hook's branding read.
 * Off unless LABEL_SESSIONS is on.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	const host = labelHostFrom(params.host);
	if (!labelSessionsEnabled() || !locals.user || !host) error(404, 'Not found.');

	const [label] = await db()
		.select({ id: orgs.id })
		.from(orgs)
		.where(and(eq(orgs.customDomain, host), isNull(orgs.closedAt)))
		.limit(1);
	if (!label || !locals.memberships.some((m) => m.orgId === label.id)) error(404, 'Not found.');

	const ticket = await mintHandoff(db(), { userId: locals.user.id, orgId: label.id, host });
	return noStoreRedirect(handoffUrl(host, ticket));
};
