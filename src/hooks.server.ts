import { createServerClient } from '@supabase/ssr';
import { error, redirect } from '@sveltejs/kit';
import { sequence, type Handle, type HandleServerError } from '@sveltejs/kit/hooks';
import * as Sentry from '@sentry/sveltekit';
import { PUBLIC_SUPABASE_PUBLISHABLE_KEY, PUBLIC_SUPABASE_URL } from '$app/env/public';
import { SENTRY_DSN } from '$app/env/private';
import { asc, eq } from 'drizzle-orm';
import { authEmailRunner, metricsRunner } from '#lib/server/db/client.js';
import { AUTH_EMAIL_HOOK_PATH } from '#lib/server/auth-email/hook.js';
import { isMetricsRequest } from '#lib/app-metrics-sentry.js';
import { empty } from '#lib/server/app-metrics.js';
import { isAuthorizedWorkerRequest } from '#lib/server/worker-auth.js';
import { db } from '#lib/server/db/client.js';
import { memberships, orgs } from '#lib/server/db/schema.js';
import { scopedTo } from '#lib/server/db/scoped.js';
import { brandForHost, DEFAULT_BRAND, type Brand } from '#lib/server/branding.js';
import { crawlerMetadata, noindex } from '#lib/server/crawler.js';
import { isLandingRequest } from '#lib/server/landing.js';
import { isMachineRoute, isPublicPath, PUBLIC_PAGES } from '#lib/server/public-paths.js';
import { keyFromHeader, resolveApiKey } from '#lib/server/api-keys.js';
import {
	API_INDEX,
	NOT_FOUND,
	apiHostRoute,
	isApiHost,
	OPENAPI_PATH,
	servesApiForTesting
} from '#lib/server/api-host.js';
import {
	LABEL_SESSION_COOKIE,
	labelCookieClearOptions,
	labelSessionUser,
	NO_SUPABASE_COOKIES
} from '#lib/server/label-host.js';
import { resolveLabelSession } from '#lib/server/label-session.js';
import { labelSessionsEnabled } from '#lib/server/label-sessions-env.js';
import { ORG_COOKIE, pickMembership, needsOnboarding } from '#lib/server/org.js';
import { verifiedUser } from '#lib/server/session-user.js';

/** Routes a signed-in user with no label can reach; everything else sends them to create one. */
const isNoLabelAllowed = (path: string) => isPublicPath(path) || path === '/logout';

/**
 * Routes a member of a closed label can still reach: the closed page, logout, and the export page
 * with the downloads under it (each still checks the member's own access).
 */
const isClosedAllowed = (path: string) =>
	isPublicPath(path) ||
	['/org/closed', '/org/export', '/logout'].includes(path) ||
	path.startsWith('/org/export/');

/** Routes a signed-in member can reach before finishing first-run onboarding. */
const ONBOARDING_EXEMPT = [...PUBLIC_PAGES, '/onboarding', '/logout'];

// Server-side error monitoring (shared decision 0003). A no-op when the DSN is unset.
Sentry.init({
	dsn: SENTRY_DSN,
	environment: __SENTRY_ENVIRONMENT__,
	release: __SENTRY_RELEASE__ ?? undefined,
	tracesSampleRate: SENTRY_DSN ? 0.1 : 0,
	// Kit creates its root span before calling this hook. Suppress that boundary too.
	ignoreSpans: [
		{ attributes: { 'http.route': /^\/api\/(?:app-metrics|internal\/app-metrics-prune)$/ } }
	],
	integrations: (defaults) => [
		...defaults.filter((i) => !['Http', 'Http.Server', 'Http.ServerSpans'].includes(i.name)),
		Sentry.httpIntegration({
			ignoreIncomingRequests: (url) => isMetricsRequest(url),
			ignoreRequestBody: (url) => isMetricsRequest(url)
		})
	],
	beforeSend: (event) => (isMetricsRequest(event.request?.url) ? null : event)
});

/** A request-bound runner as this user, pinned to one label on a label's own domain. */
const requestScope = (userId: string, pinOrgId?: string) =>
	pinOrgId ? scopedTo(db(), userId, { pinOrgId }) : scopedTo(db(), userId);

/** The membership read every signed-in request makes, as the user and under RLS. */
const loadMemberships = (userId: string, pinOrgId?: string) =>
	requestScope(
		userId,
		pinOrgId
	)((tx) =>
		tx
			.select({
				orgId: memberships.orgId,
				role: memberships.role,
				orgName: orgs.name,
				onboardedAt: memberships.onboardedAt,
				closedAt: orgs.closedAt
			})
			.from(memberships)
			.innerJoin(orgs, eq(orgs.id, memberships.orgId))
			.where(eq(memberships.userId, userId))
			.orderBy(asc(memberships.createdAt), asc(orgs.name))
	);

/**
 * Which kind of host a request is on, when LABEL_SESSIONS is on (knowledge labelkit 0051, 0054,
 * epsilon-records/labelkit#258): a label's own domain, where the session is label-only; any other
 * host (labelkit.co, previews, localhost), served as before; or one that could not be told. The
 * branding lookup is cached per host for a minute. When it fails, the host might be a label's, so
 * the request is served as signed out and touches no cookie: failing open would read a Supabase
 * session on a label's domain.
 */
type HostKind =
	| { kind: 'standard'; brand?: Brand }
	| { kind: 'label'; orgId: string; brand: Brand }
	| { kind: 'unknown' };

async function hostKind(host: string): Promise<HostKind> {
	if (!labelSessionsEnabled()) return { kind: 'standard' };
	try {
		const brand = await brandForHost(db(), host);
		return brand.orgId ? { kind: 'label', orgId: brand.orgId, brand } : { kind: 'standard', brand };
	} catch {
		return { kind: 'unknown' };
	}
}

/**
 * The person behind a label host's session cookie, with the one membership it gives. Returns null
 * when there is no cookie, or it names no live session on this host (expired, revoked, another host,
 * the person left the label, the label closed or changed its domain). The membership read runs
 * pinned to the label (RLS: every other label of that person is invisible) and is filtered to it
 * again here, so `memberships` is that label or nothing, never another one.
 */
async function labelSignedIn(event: Parameters<Handle>[0]['event'], host: string, orgId: string) {
	const sessionId = event.cookies.get(LABEL_SESSION_COOKIE);
	if (!sessionId) return null;
	let session;
	try {
		session = await resolveLabelSession(db(), { sessionId, host });
	} catch (err) {
		// A database failure says nothing about the cookie: keep it, and serve the request signed out.
		console.error(
			JSON.stringify({
				level: 'error',
				msg: 'label session lookup failed',
				host,
				error: String(err)
			})
		);
		return null;
	}
	const rows = session
		? (await loadMemberships(session.userId, session.orgId)).filter(
				(m) => m.orgId === session.orgId && m.orgId === orgId
			)
		: [];
	if (!session) {
		// Unknown, expired or revoked: drop the stale cookie; the sign-in redirect does the rest.
		event.cookies.delete(LABEL_SESSION_COOKIE, labelCookieClearOptions);
		return null;
	}
	if (!rows.length) return null;
	return {
		user: labelSessionUser(session.userId),
		loaded: rows,
		pinOrgId: session.orgId
	};
}

const appHandle: Handle = async ({ event, resolve }) => {
	// Label-only sessions (flag LABEL_SESSIONS, off by default): on a label's own domain the session
	// is the host-only label cookie, and no Supabase cookie is ever read or written. Off, or on any
	// other host, everything below runs exactly as it always did.
	const host = await hostKind(event.url.host);
	const onLabelHost = host.kind !== 'standard';

	event.locals.supabase = createServerClient(PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_PUBLISHABLE_KEY, {
		cookies: onLabelHost
			? NO_SUPABASE_COOKIES
			: {
					getAll: () => event.cookies.getAll(),
					setAll: (cookies) => {
						for (const { name, value, options } of cookies) {
							event.cookies.set(name, value, { ...options, path: '/' });
						}
					}
				}
	});

	// Per-customer branding by host (EPSILON-132), before sign-in so the login page is branded too.
	// Pages only: API and machine paths never need it and stay off the owner connection here. A
	// failed lookup must never take the login page down: fall back to LabelKit's own branding.
	// Branding, Auth and the membership read run side by side: each waits on Frankfurt from Ohio
	// (EPSILON-145, knowledge labelkit/decisions/0029).
	const brand =
		host.kind === 'label' || (host.kind === 'standard' && host.brand)
			? Promise.resolve(host.brand)
			: host.kind === 'unknown' || event.url.pathname.startsWith('/api/')
				? Promise.resolve(DEFAULT_BRAND)
				: Promise.resolve()
						.then(() => brandForHost(db(), event.url.host))
						.catch(() => DEFAULT_BRAND);

	// getUser() asks Supabase Auth to verify the token; never trust getSession() alone on the server.
	// verifiedUser() takes the user from getUser() only, and reads the memberships alongside it.
	// Every query for this request runs as labelkit_app on behalf of this user, under RLS.
	const signedIn: {
		user: NonNullable<App.Locals['user']>;
		loaded: Awaited<ReturnType<typeof loadMemberships>>;
		pinOrgId?: string;
	} | null =
		host.kind === 'standard'
			? await verifiedUser(event.locals.supabase.auth, (userId) => loadMemberships(userId))
			: host.kind === 'label'
				? await labelSignedIn(event, event.url.host, host.orgId)
				: null;
	const user = signedIn?.user ?? null;
	event.locals.brand = await brand;
	event.locals.user = user;
	event.locals.membership = null;
	event.locals.memberships = [];
	event.locals.db = () => error(401, 'Sign in first.');

	if (signedIn) {
		event.locals.db = requestScope(signedIn.user.id, signedIn.pinOrgId);
		const rows = signedIn.loaded;
		event.locals.memberships = rows;
		// On a customer's own domain, act in that label when the user belongs to it.
		event.locals.membership = pickMembership(
			rows,
			event.locals.brand.orgId ?? event.cookies.get(ORG_COOKIE)
		);
	}

	const isPublic =
		isPublicPath(event.url.pathname) || isLandingRequest(event.url.pathname, event.locals.brand);
	if (!user && !isPublic) {
		return privateRedirect(event.request, '/login');
	}

	// Signed in but in no label (a new self-serve account, or a member who was removed): the only
	// thing to do is create a label (EPSILON-130), which /signup/label explains when signup is off.
	if (user && !event.locals.membership && !isNoLabelAllowed(event.url.pathname)) {
		return privateRedirect(event.request, '/signup/label');
	}

	// A closed label (migration 0027) does nothing until it is reopened or purged. Owners can still
	// export it and reopen it; everyone else sees the closed page.
	if (
		event.locals.membership?.closedAt &&
		// POST /org switches to another label, which must stay possible.
		event.url.pathname !== '/org' &&
		!isClosedAllowed(event.url.pathname)
	) {
		return privateRedirect(event.request, '/org/closed');
	}

	// First run: send a member who hasn't finished onboarding to the welcome page.
	if (
		!isMachineRoute(event.url.pathname) &&
		needsOnboarding(event.locals.membership, event.url.pathname, ONBOARDING_EXEMPT)
	) {
		return privateRedirect(event.request, '/onboarding');
	}

	const response = await resolve(event, {
		filterSerializedResponseHeaders: (name) =>
			name === 'content-range' || name === 'x-supabase-api-version'
	});
	for (const [name, value] of Object.entries(SECURITY_HEADERS)) response.headers.set(name, value);
	return !isPublic || (event.url.pathname === '/' && user) ? noindex(response) : response;
};

function privateRedirect(request: Request, location: string): Response {
	// Preserve SvelteKit's enhanced form-action redirect handling.
	if (request.method !== 'GET' && request.method !== 'HEAD') redirect(303, location);
	return noindex(new Response(null, { status: 303, headers: { Location: location } }));
}

const ordinaryHandle = SENTRY_DSN ? sequence(Sentry.sentryHandle(), appHandle) : appHandle;
/** Exact anonymous boundary BEFORE Auth, cookies, tenant lookups and Sentry request capture. */
export const handle: Handle = async (input) => {
	const path = input.event.url.pathname;
	// api.labelkit.co serves the API and nothing else: no pages, cookies, Auth or machine routes.
	if (isApiHost(input.event.url.host)) {
		const route = apiHostRoute(path);
		if (route === 'api') return noindex(await apiHandle(input));
		if (route === 'openapi') return noindex(await publicApiDocument(input));
		return noindex(
			jsonResponse(route === 'index' ? 200 : 404, route === 'index' ? API_INDEX : NOT_FOUND)
		);
	}
	const metadata = crawlerMetadata(input.event.url, input.event.request.method);
	if (metadata) return metadata;
	// labelkit.co and custom domains don't serve the API (a plain 404); local dev and previews do.
	if (path.startsWith('/v1/') && !servesApiForTesting(input.event.url.host))
		return noindex(jsonResponse(404, NOT_FOUND));
	if (path === OPENAPI_PATH) return publicApiDocument(input);
	// Supabase Auth's Send Email hook (EPSILON-147): a machine caller with no session. It skips
	// cookies, Auth and branding, and gets only the labelkit_auth_email runner; the route verifies the
	// hook's signature before it uses even that.
	if (path === AUTH_EMAIL_HOOK_PATH) {
		input.event.locals.db = authEmailRunner();
		return input.resolve(input.event);
	}
	if (path === '/api/app-metrics' || path === '/api/internal/app-metrics-prune') {
		if (
			path === '/api/internal/app-metrics-prune' &&
			!isAuthorizedWorkerRequest(input.event.request)
		)
			return empty(401);
		input.event.locals.db = metricsRunner(
			path === '/api/app-metrics' ? 'labelkit_metrics_ingest' : 'labelkit_metrics_prune'
		);
		try {
			// Netlify injects W3C trace context after the browser's credential-free fetch.
			// Discard it only at this exact, server-verified hosting boundary; never
			// consume its values or pass it to the receiver, Auth or Sentry.
			let event = input.event;
			if (
				path === '/api/app-metrics' &&
				event.platform?.context?.site?.id === '4d4e8994-934f-4d38-9eb6-5831c09fc6b1'
			) {
				const headers = new Headers(event.request.headers);
				for (const key of ['traceparent', 'tracestate', 'x-amzn-trace-id', 'x-nf-trace-span-id'])
					headers.delete(key);
				event = { ...event, request: new Request(event.request, { headers }) };
			}
			return await Sentry.suppressTracing(() => input.resolve(event));
		} catch {
			return empty(503);
		}
	}
	if (path.startsWith('/v1/')) return apiHandle(input);
	return ordinaryHandle(input);
};

/** A JSON response with the security headers, for the API host's index and 404s. */
function jsonResponse(status: number, body: unknown) {
	const res = new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
	});
	for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.headers.set(name, value);
	return res;
}

/** The OpenAPI document: public, so it skips the key check and every session lookup. */
const publicApiDocument: Handle = async ({ event, resolve }) => {
	event.locals.user = null;
	event.locals.brand = DEFAULT_BRAND;
	event.locals.memberships = [];
	event.locals.membership = null;
	event.locals.db = () => error(404, 'Not found.');
	const response = await resolve(event);
	for (const [name, value] of Object.entries(SECURITY_HEADERS)) response.headers.set(name, value);
	return response;
};

/**
 * The public /v1 API (EPSILON-137): an `Authorization: Bearer lk_…` key, never a cookie, so no
 * browser session can be ridden into it. The key is looked up on the owner connection; the request
 * then runs as the key's agent under RLS, exactly like a signed-in member.
 */
const apiHandle: Handle = async ({ event, resolve }) => {
	const fail = (status: number, code: string, message: string) => {
		const res = new Response(JSON.stringify({ error: { code, message } }), {
			status,
			headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
		});
		for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.headers.set(name, value);
		return res;
	};
	event.locals.user = null;
	event.locals.brand = DEFAULT_BRAND;
	event.locals.memberships = [];
	event.locals.membership = null;
	event.locals.db = () => error(401, 'Missing or invalid API key.');
	const key = keyFromHeader(event.request.headers.get('authorization'));
	if (!key) return fail(401, 'unauthorized', 'Missing or invalid API key.');
	let resolved;
	try {
		resolved = await resolveApiKey(db(), key);
	} catch {
		return fail(503, 'unavailable', 'The API is unavailable right now.');
	}
	if (!resolved) return fail(401, 'unauthorized', 'Missing or invalid API key.');
	event.locals.membership = { orgId: resolved.orgId, orgName: resolved.orgName, role: 'agent' };
	event.locals.memberships = [event.locals.membership];
	event.locals.apiKey = { id: resolved.id, actorId: resolved.actorId, scopes: resolved.scopes };
	event.locals.db = scopedTo(db(), resolved.actorId);
	const response = await resolve(event);
	for (const [name, value] of Object.entries(SECURITY_HEADERS)) response.headers.set(name, value);
	return response;
};

/** Sent with every server response. The CSP itself comes from SvelteKit (vite.config.ts). */
const SECURITY_HEADERS = {
	'Strict-Transport-Security': 'max-age=63072000; includeSubDomains',
	'X-Content-Type-Options': 'nosniff',
	'X-Frame-Options': 'DENY',
	'Referrer-Policy': 'strict-origin-when-cross-origin',
	'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()'
};

/**
 * Unexpected errors: full detail goes to the server log under a short reference, and
 * the browser only sees the reference. Errors raised on purpose with error(), 404s and
 * other framework errors keep their own safe messages.
 */
const ordinaryError: HandleServerError = Sentry.handleErrorWithSentry((caught) => {
	if (caught.kind !== 'unknown') return;
	const { error: err, event } = caught;
	const ref = crypto.randomUUID().slice(0, 8);
	console.error(
		JSON.stringify({
			level: 'error',
			ref,
			method: event.request.method,
			path: event.url.pathname,
			user: event.locals.user?.id ?? null,
			org: event.locals.membership?.orgId ?? null,
			error: err instanceof Error ? { message: err.message, stack: err.stack } : String(err)
		})
	);
	return { message: `Something went wrong (ref ${ref}).` };
});

export const handleError: HandleServerError = (caught) => {
	if (['/api/app-metrics', '/api/internal/app-metrics-prune'].includes(caught.event.url.pathname))
		return { message: 'Unavailable' };
	return ordinaryError(caught);
};
