import { beforeEach, describe, expect, it, vi } from 'vitest';

// The request hook's host branch for label-only sessions (knowledge labelkit 0051, 0054,
// labelkit#258 step 3). Off by default; on, a label's own domain never touches a Supabase cookie and
// the person sees that label and no other.
const ORG_A = '019a0000-0000-7000-8000-00000000000a';
const ORG_B = '019a0000-0000-7000-8000-00000000000b';
const USER = '00000000-0000-7000-8000-0000000000a1';
const LABEL_HOST = 'music.example.test';
const SESSION_ID = 'S'.repeat(43);

const state = vi.hoisted(() => ({
	enabled: false,
	/** Hosts that are a label's custom domain, and which label. */
	labelHosts: {} as Record<string, string>,
	brandFails: false,
	resolve: vi.fn(),
	/** What the membership read returns, whatever the pin: the hook must not rely on it alone. */
	rows: [] as unknown[],
	scopedTo: vi.fn(),
	brandForHost: vi.fn(),
	createServerClient: vi.fn(),
	auth: {
		getSession: vi.fn(),
		getUser: vi.fn()
	}
}));
vi.mock('$app/env/private', () => ({ SENTRY_DSN: undefined, LABEL_SESSIONS: false }));
vi.mock('#lib/server/label-sessions-env.js', () => ({ labelSessionsEnabled: () => state.enabled }));
vi.mock('@supabase/ssr', () => ({ createServerClient: state.createServerClient }));
vi.mock('@sentry/sveltekit', () => ({
	init: vi.fn(),
	httpIntegration: vi.fn(),
	suppressTracing: (fn: () => unknown) => fn(),
	sentryHandle: () => vi.fn(),
	handleErrorWithSentry: (fn: unknown) => fn
}));
vi.mock('#lib/server/db/client.js', () => ({
	db: () => 'owner-db',
	metricsRunner: vi.fn(),
	authEmailRunner: vi.fn()
}));
vi.mock('#lib/server/branding.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/server/branding.js')>()),
	brandForHost: state.brandForHost
}));
vi.mock('#lib/server/label-session.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/server/label-session.js')>()),
	resolveLabelSession: state.resolve
}));
vi.mock('#lib/server/db/scoped.js', () => ({ scopedTo: state.scopedTo }));
import { handle } from './hooks.server';

const row = (orgId: string, orgName: string) => ({
	orgId,
	orgName,
	role: 'catalog_manager' as const,
	onboardedAt: new Date('2026-01-01T00:00:00Z'),
	closedAt: null
});

/** The part of `locals` the tests read. */
type Locals = {
	user: { id: string; email?: string } | null;
	memberships: { orgId: string }[];
	membership: { orgId: string } | null;
	brand: { orgId: string | null };
	db: unknown;
};

function event(href: string, cookies: Record<string, string> = {}) {
	const url = new URL(href);
	const jar = {
		getAll: vi.fn(() => Object.entries(cookies).map(([name, value]) => ({ name, value }))),
		get: vi.fn((name: string) => cookies[name]),
		set: vi.fn(),
		delete: vi.fn()
	};
	return { url, request: new Request(url), cookies: jar, locals: {} as Locals };
}

/** Run the hook; `page` records whether the request got through to the app. */
async function run(href: string, cookies: Record<string, string> = {}) {
	const ev = event(href, cookies);
	const page = vi.fn(async () => new Response('page'));
	const res = await handle({ event: ev, resolve: page } as never);
	return { ev, res, page, locals: ev.locals };
}

beforeEach(() => {
	state.enabled = false;
	state.labelHosts = { [LABEL_HOST]: ORG_A };
	state.brandFails = false;
	state.rows = [row(ORG_A, 'Music'), row(ORG_B, 'Other')];
	state.resolve.mockReset();
	state.resolve.mockResolvedValue({
		userId: USER,
		orgId: ORG_A,
		role: 'catalog_manager',
		expiresAt: new Date('2026-12-26T08:00:00Z')
	});
	state.brandForHost.mockReset();
	state.brandForHost.mockImplementation(async (_db: unknown, host: string) => {
		if (state.brandFails) throw new Error('database down');
		const orgId = state.labelHosts[host] ?? null;
		return orgId
			? { name: 'Music', accent: null, orgId, favicon: null }
			: { name: 'LabelKit', accent: null, orgId: null, favicon: null };
	});
	state.scopedTo.mockReset();
	state.scopedTo.mockImplementation(() => (fn: (tx: unknown) => unknown) => {
		const chain: Record<string, unknown> = {};
		for (const m of ['select', 'from', 'innerJoin', 'where']) chain[m] = () => chain;
		chain.orderBy = async () => state.rows;
		return fn(chain);
	});
	state.auth.getSession.mockReset();
	state.auth.getSession.mockResolvedValue({ data: { session: { access_token: 'opaque' } } });
	state.auth.getUser.mockReset();
	state.auth.getUser.mockResolvedValue({ data: { user: { id: USER, email: 'a@example.test' } } });
	state.createServerClient.mockReset();
	state.createServerClient.mockImplementation(() => ({ auth: state.auth }));
});

const supabaseCookies = () => state.createServerClient.mock.calls[0][2].cookies;

describe('flag off (the default)', () => {
	it('serves a label host as before: Supabase cookies, every membership, no label session', async () => {
		const { ev, locals, page } = await run(`https://${LABEL_HOST}/`, {
			'sb-x-auth-token': 't',
			__Host_lk_label: 'ignored',
			'__Host-lk_label': SESSION_ID
		});
		expect(page).toHaveBeenCalled();
		expect(state.resolve).not.toHaveBeenCalled();
		// The Supabase client reads and writes the real cookie jar.
		supabaseCookies().getAll();
		expect(ev.cookies.getAll).toHaveBeenCalled();
		supabaseCookies().setAll([{ name: 'sb-x', value: 'v', options: { httpOnly: true } }]);
		expect(ev.cookies.set).toHaveBeenCalledWith('sb-x', 'v', { httpOnly: true, path: '/' });
		expect(state.auth.getUser).toHaveBeenCalled();
		// Nothing is pinned, and the person keeps every label.
		expect(state.scopedTo.mock.calls.every((c) => c.length === 2)).toBe(true);
		expect(locals.memberships.map((m) => m.orgId)).toEqual([ORG_A, ORG_B]);
		expect(locals.user?.email).toBe('a@example.test');
	});

	it('does not look the host up an extra time', async () => {
		await run(`https://${LABEL_HOST}/`);
		expect(state.brandForHost).toHaveBeenCalledTimes(1);
	});
});

describe('flag on, labelkit.co and every other ordinary host', () => {
	beforeEach(() => {
		state.enabled = true;
	});

	it('is unchanged: Supabase cookies, every membership, no pin, no label session', async () => {
		const { ev, locals, page } = await run('https://labelkit.co/', { 'sb-x-auth-token': 't' });
		expect(page).toHaveBeenCalled();
		expect(state.resolve).not.toHaveBeenCalled();
		supabaseCookies().getAll();
		expect(ev.cookies.getAll).toHaveBeenCalled();
		expect(state.auth.getUser).toHaveBeenCalled();
		expect(state.scopedTo.mock.calls.every((c) => c.length === 2)).toBe(true);
		expect(locals.memberships.map((m) => m.orgId)).toEqual([ORG_A, ORG_B]);
		expect(locals.brand.orgId).toBeNull();
		// The one branding lookup is reused, not repeated.
		expect(state.brandForHost).toHaveBeenCalledTimes(1);
	});

	it('still sends a signed-out visitor to /login', async () => {
		state.auth.getSession.mockResolvedValue({ data: { session: null } });
		state.auth.getUser.mockResolvedValue({ data: { user: null } });
		const { res, page } = await run('https://labelkit.co/releases');
		expect(res.status).toBe(303);
		expect(res.headers.get('location')).toBe('/login');
		expect(page).not.toHaveBeenCalled();
	});
});

describe('flag on, a label host', () => {
	beforeEach(() => {
		state.enabled = true;
	});
	const COOKIES = { '__Host-lk_label': SESSION_ID, 'sb-x-auth-token': 'supabase', erms_org: ORG_B };

	it('acts as the person in that label only, however many labels they belong to', async () => {
		const { locals, page } = await run(`https://${LABEL_HOST}/releases`, COOKIES);
		expect(page).toHaveBeenCalled();
		expect(state.resolve).toHaveBeenCalledWith('owner-db', {
			sessionId: SESSION_ID,
			host: LABEL_HOST
		});
		// The membership read returned both labels (as a database without the pin would); the hook
		// keeps the pinned one, and never falls back to another.
		expect(locals.memberships.map((m) => m.orgId)).toEqual([ORG_A]);
		expect(locals.membership?.orgId).toBe(ORG_A);
		expect(locals.user?.id).toBe(USER);
		expect(locals.brand.orgId).toBe(ORG_A);
	});

	it('pins every query of the request to the label: the membership read and locals.db', async () => {
		const { locals } = await run(`https://${LABEL_HOST}/`, COOKIES);
		expect(state.scopedTo.mock.calls.length).toBeGreaterThanOrEqual(2);
		for (const call of state.scopedTo.mock.calls) {
			expect(call.slice(1)).toEqual([USER, { pinOrgId: ORG_A }]);
		}
		expect(typeof locals.db).toBe('function');
	});

	it('ignores the label-switch cookie: the host decides the label', async () => {
		const { locals, ev } = await run(`https://${LABEL_HOST}/`, COOKIES);
		expect(locals.membership?.orgId).toBe(ORG_A);
		expect(ev.cookies.get).not.toHaveBeenCalledWith('erms_org');
	});

	it('never reads or writes a Supabase cookie, and never asks Supabase Auth', async () => {
		const { ev } = await run(`https://${LABEL_HOST}/releases`, COOKIES);
		// Only the label cookie is ever read by name, and the jar is never listed.
		expect(ev.cookies.get.mock.calls.map((c) => c[0])).toEqual(['__Host-lk_label']);
		expect(ev.cookies.getAll).not.toHaveBeenCalled();
		// The client Supabase would use sees an empty jar and drops what it would write.
		expect(supabaseCookies().getAll()).toEqual([]);
		supabaseCookies().setAll([{ name: 'sb-x', value: 'v', options: {} }]);
		expect(ev.cookies.set).not.toHaveBeenCalled();
		expect(state.auth.getSession).not.toHaveBeenCalled();
		expect(state.auth.getUser).not.toHaveBeenCalled();
	});

	it('sends an unknown cookie to /login and drops it', async () => {
		state.resolve.mockResolvedValue(null);
		const { ev, res, page } = await run(`https://${LABEL_HOST}/releases`, COOKIES);
		expect(res.status).toBe(303);
		expect(res.headers.get('location')).toBe('/login');
		expect(page).not.toHaveBeenCalled();
		expect(ev.cookies.delete).toHaveBeenCalledWith('__Host-lk_label', {
			path: '/',
			httpOnly: true,
			secure: true
		});
		expect(state.scopedTo).not.toHaveBeenCalled();
		expect(state.auth.getUser).not.toHaveBeenCalled();
	});

	it('treats an expired session like an unknown one (the lookup answers null)', async () => {
		state.resolve.mockResolvedValue(null);
		const { res } = await run(`https://${LABEL_HOST}/`, COOKIES);
		expect(res.headers.get('location')).toBe('/login');
	});

	it('gives a person who is no longer a member nothing: the session does not resolve', async () => {
		// resolveLabelSession joins memberships, so a removed member's session answers null.
		state.resolve.mockResolvedValue(null);
		const { res, locals } = await run(`https://${LABEL_HOST}/members`, COOKIES);
		expect(res.status).toBe(303);
		expect(locals.memberships).toEqual([]);
		expect(locals.membership).toBeNull();
		expect(locals.user).toBeNull();
	});

	it('sends a visitor with no cookie to /login without asking the database', async () => {
		const { res } = await run(`https://${LABEL_HOST}/releases`, {});
		expect(res.headers.get('location')).toBe('/login');
		expect(state.resolve).not.toHaveBeenCalled();
	});

	it('serves the sign-in page and the handoff route without a session', async () => {
		for (const path of ['/login', '/auth/handoff']) {
			const { page, res } = await run(`https://${LABEL_HOST}${path}`, {});
			expect(page).toHaveBeenCalled();
			expect(res.status).toBe(200);
		}
		expect(state.auth.getUser).not.toHaveBeenCalled();
	});

	it('serves the request signed out, and keeps the cookie, when the session lookup fails', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		state.resolve.mockRejectedValue(new Error('database down'));
		const { ev, res } = await run(`https://${LABEL_HOST}/releases`, COOKIES);
		expect(res.headers.get('location')).toBe('/login');
		expect(ev.cookies.delete).not.toHaveBeenCalled();
	});

	it('serves the request signed out when the pinned read finds no membership', async () => {
		state.rows = [];
		const { res, locals } = await run(`https://${LABEL_HOST}/releases`, COOKIES);
		expect(res.headers.get('location')).toBe('/login');
		expect(locals.memberships).toEqual([]);
	});

	it('does not read the label cookie on another label’s host: each host resolves its own', async () => {
		state.labelHosts['other.example.test'] = ORG_B;
		state.resolve.mockResolvedValue(null);
		await run('https://other.example.test/', COOKIES);
		expect(state.resolve).toHaveBeenCalledWith('owner-db', {
			sessionId: SESSION_ID,
			host: 'other.example.test'
		});
	});
});

describe('flag on, a host that cannot be told apart', () => {
	beforeEach(() => {
		state.enabled = true;
		state.brandFails = true;
	});

	it('is served signed out and touches no cookie: it might be a label’s domain', async () => {
		const { ev, res } = await run('https://music.example.test/releases', {
			'sb-x-auth-token': 'supabase',
			'__Host-lk_label': SESSION_ID
		});
		expect(res.headers.get('location')).toBe('/login');
		expect(ev.cookies.getAll).not.toHaveBeenCalled();
		expect(ev.cookies.get).not.toHaveBeenCalled();
		expect(state.auth.getSession).not.toHaveBeenCalled();
		expect(state.auth.getUser).not.toHaveBeenCalled();
		expect(state.resolve).not.toHaveBeenCalled();
	});

	it('still serves the sign-in page', async () => {
		const { page } = await run('https://music.example.test/login');
		expect(page).toHaveBeenCalled();
	});
});
