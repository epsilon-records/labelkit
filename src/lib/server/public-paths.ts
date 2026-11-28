/**
 * Routes reachable without signing in, matched exactly: a new route is behind the sign-in redirect
 * unless it is added here. `/auth/confirm` is where an invite link lands (EPSILON-87); `/auth/handoff` is where a label's own
 * domain takes its sign-in ticket;
 * `/signup/label` sends a visitor with no session on to `/signup` itself.
 */
export const PUBLIC_PAGES: readonly string[] = [
	'/docs',
	'/login',
	'/signup',
	'/signup/label',
	'/privacy',
	'/terms',
	'/auth/callback',
	'/auth/confirm',
	// A label's own domain trades a one-time ticket for its session there (labelkit#258). The ticket
	// is the credential: the route answers a bad one with the sign-in page, and does nothing while
	// LABEL_SESSIONS is off.
	'/auth/handoff',
	// A label's own tab icon, set on /org/branding; the login page shows it.
	'/brand-icon'
];

/**
 * Machine endpoints verify their own credentials before running (worker, reconcile, the daily
 * purge and the master check require the WORKER_SECRET bearer token; the webhooks verify
 * AudioKit's X-Signature HMAC), so the login redirect must not intercept them.
 */
export const MACHINE_ROUTES: readonly string[] = [
	'/api/audiokit/worker',
	'/api/audiokit/reconcile',
	'/api/audiokit/webhook',
	// The daily purge (migration 0027).
	'/api/internal/purge-orgs',
	// The background check of uploaded masters (EPSILON-120).
	'/api/internal/verify-masters'
];

/** `/api/audiokit/webhook/[client_id]`: exactly one non-empty segment after the prefix. */
const CLIENT_WEBHOOK = /^\/api\/audiokit\/webhook\/[^/]+$/;

export function isMachineRoute(pathname: string): boolean {
	return MACHINE_ROUTES.includes(pathname) || CLIENT_WEBHOOK.test(pathname);
}

export function isPublicPath(pathname: string): boolean {
	return PUBLIC_PAGES.includes(pathname) || isMachineRoute(pathname);
}
