import { db } from '#lib/server/db/client.js';
import {
	LABEL_SESSION_COOKIE,
	labelCookieOptions,
	noStoreRedirect
} from '#lib/server/label-host.js';
import { exchangeHandoff } from '#lib/server/label-session.js';
import { labelSessionsEnabled } from '#lib/server/label-sessions-env.js';
import type { RequestHandler } from './$types';

/**
 * Where a label's own domain takes the one-time ticket from `/go/<host>` (knowledge labelkit 0051,
 * 0054; labelkit#258) and trades it for a session on this host: a host-only, HttpOnly, Secure,
 * SameSite=Lax cookie that holds the label-session id. Only that id's hash is stored.
 *
 * exchangeHandoff spends the ticket in the statement that checks it, so one ticket makes one
 * session. A ticket that is missing, malformed, expired, spent, minted for another host or for
 * someone who no longer belongs to the label gets the same answer: the sign-in page, no cookie, no
 * detail. Both redirects carry their own non-empty query string, as /auth/callback explains, so the
 * Netlify edge cannot append the spent ticket to the address bar.
 *
 * Reads and writes no Supabase cookie. Off unless LABEL_SESSIONS is on, and then it answers as a bad
 * ticket, which is what an unsigned-in visitor got here before the route existed.
 */
export const GET: RequestHandler = async ({ url, cookies }) => {
	const refused = () => noStoreRedirect('/login?link=invalid');
	const ticket = url.searchParams.get('t');
	if (!labelSessionsEnabled() || !ticket) return refused();

	const session = await exchangeHandoff(db(), { ticket, host: url.host });
	if (!session) return refused();

	cookies.set(LABEL_SESSION_COOKIE, session.sessionId, labelCookieOptions(session.expiresAt));
	return noStoreRedirect('/?signed-in');
};
