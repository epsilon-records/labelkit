import type { User } from '@supabase/supabase-js';
import { normaliseHost } from './label-session';

/**
 * The browser side of label sessions (knowledge labelkit 0051, 0054, labelkit#258): the cookie that
 * holds the session id on a label's own domain, the handoff URL, and the stand-ins the request hook
 * needs on such a host. The database side is label-session.ts.
 */

/**
 * `__Host-` makes the browser refuse the cookie unless it is Secure, set from this host, has no
 * Domain and has Path=/. It can never be shared with a parent domain or a subdomain.
 */
export const LABEL_SESSION_COOKIE = '__Host-lk_label';

/** Host-only, HttpOnly, Secure, SameSite=Lax; it ends with the session's absolute lifetime. */
export function labelCookieOptions(expires: Date) {
	return {
		path: '/',
		httpOnly: true,
		secure: true,
		sameSite: 'lax' as const,
		expires
	};
}

/** What clearing the cookie must repeat: the browser matches on name, path and attributes. */
export const labelCookieClearOptions = { path: '/', httpOnly: true, secure: true } as const;

/** A host as `orgs.custom_domain` holds it (the same shape as its CHECK constraint). */
const HOST_FORMAT = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** The normalised host from a URL segment, or null when it cannot be a label's custom domain. */
export function labelHostFrom(value: string | null | undefined): string | null {
	const host = normaliseHost(value ?? '');
	return host.length <= 253 && HOST_FORMAT.test(host) ? host : null;
}

/** Where `/go/<host>` sends the browser: the label's own domain, which exchanges the ticket once. */
export const handoffUrl = (host: string, ticket: string) =>
	`https://${host}/auth/handoff?t=${encodeURIComponent(ticket)}`;

/**
 * A redirect that is never cached or stored. The handoff URL carries a ticket, and Location is read
 * back by browsers, proxies and the Netlify edge.
 */
export const noStoreRedirect = (location: string) =>
	new Response(null, { status: 303, headers: { Location: location, 'Cache-Control': 'no-store' } });

/**
 * The hook's `locals.user` for a label session. A label session knows the person's id only; it holds
 * no Supabase user, so there is no email and no metadata. Nothing on a label host reads more.
 */
export const labelSessionUser = (id: string): User => ({
	id,
	aud: 'authenticated',
	app_metadata: {},
	user_metadata: {},
	created_at: ''
});

/**
 * Cookie storage for the Supabase client on a label host: nothing is read and nothing is written, so
 * a Supabase session cookie (or a PKCE verifier) can neither be used nor created there.
 */
export const NO_SUPABASE_COOKIES = { getAll: () => [], setAll: () => {} };
