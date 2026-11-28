import { beforeEach, describe, expect, it, vi } from 'vitest';

// /auth/handoff (labelkit#258, step 3): one ticket, one host-only session cookie. The database side
// (single use, 60-second expiry, host, person) is covered at the route level in handoff.db.test.ts.
const state = vi.hoisted(() => ({
	enabled: true,
	exchange: vi.fn()
}));
vi.mock('#lib/server/label-sessions-env.js', () => ({ labelSessionsEnabled: () => state.enabled }));
vi.mock('#lib/server/db/client.js', () => ({ db: () => 'owner-db' }));
vi.mock('#lib/server/label-session.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/server/label-session.js')>()),
	exchangeHandoff: state.exchange
}));
import { GET } from './+server';

const TICKET = 'Tt'.repeat(21) + 'T';
const SESSION = 'Ss'.repeat(21) + 'S';
const HOST = 'music.example.test';
const EXPIRES = new Date('2026-12-26T08:00:00Z');

function call(query: string, host = HOST) {
	const cookies = { set: vi.fn(), get: vi.fn(), getAll: vi.fn(), delete: vi.fn() };
	const res = GET({
		url: new URL(`https://${host}/auth/handoff${query}`),
		cookies
	} as never);
	return { res, cookies };
}

beforeEach(() => {
	state.enabled = true;
	state.exchange.mockReset();
	state.exchange.mockResolvedValue({
		sessionId: SESSION,
		expiresAt: EXPIRES,
		orgId: 'org',
		userId: 'user'
	});
});

describe('GET /auth/handoff', () => {
	it('trades the ticket on this host for a host-only, HttpOnly, Secure, SameSite=Lax cookie', async () => {
		const { res, cookies } = call(`?t=${TICKET}`);
		const response = await res;
		expect(state.exchange).toHaveBeenCalledWith('owner-db', { ticket: TICKET, host: HOST });
		expect(cookies.set).toHaveBeenCalledTimes(1);
		expect(cookies.set).toHaveBeenCalledWith('__Host-lk_label', SESSION, {
			path: '/',
			httpOnly: true,
			secure: true,
			sameSite: 'lax',
			expires: EXPIRES
		});
		// The __Host- prefix forbids a Domain attribute; none is set, so the cookie cannot leave this host.
		expect(Object.keys(cookies.set.mock.calls[0][2])).not.toContain('domain');
		expect(response.status).toBe(303);
		expect(response.headers.get('cache-control')).toBe('no-store');
	});

	it('goes to / with a query of its own, so the ticket cannot be appended to the address bar', async () => {
		const response = await call(`?t=${TICKET}`).res;
		expect(response.headers.get('location')).toBe('/?signed-in');
		expect(response.headers.get('location')).not.toContain(TICKET);
	});

	it('never reads or writes a Supabase cookie', async () => {
		const { res, cookies } = call(`?t=${TICKET}`);
		await res;
		expect(cookies.get).not.toHaveBeenCalled();
		expect(cookies.getAll).not.toHaveBeenCalled();
		expect(cookies.delete).not.toHaveBeenCalled();
		expect(cookies.set.mock.calls.map((c) => c[0])).toEqual(['__Host-lk_label']);
	});

	it.each([
		[
			'spent, expired, minted for another host, or for a person who left (the exchange says null)',
			true
		],
		['not a ticket at all', false]
	])('sends a bad ticket (%s) to /login without a cookie or a detail', async (_name, asked) => {
		state.exchange.mockResolvedValue(null);
		const { res, cookies } = call(`?t=${asked ? TICKET : 'junk'}`);
		const response = await res;
		expect(response.status).toBe(303);
		expect(response.headers.get('location')).toBe('/login?link=invalid');
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(response.headers.get('location')).not.toContain('junk');
		expect(cookies.set).not.toHaveBeenCalled();
	});

	it('refuses the same ticket the second time', async () => {
		state.exchange.mockResolvedValueOnce({
			sessionId: SESSION,
			expiresAt: EXPIRES,
			orgId: 'org',
			userId: 'user'
		});
		state.exchange.mockResolvedValue(null);
		const first = call(`?t=${TICKET}`);
		expect((await first.res).headers.get('location')).toBe('/?signed-in');
		const second = call(`?t=${TICKET}`);
		expect((await second.res).headers.get('location')).toBe('/login?link=invalid');
		expect(second.cookies.set).not.toHaveBeenCalled();
	});

	it('does not even ask for a missing ticket', async () => {
		for (const query of ['', '?t=', '?x=1']) {
			const { res, cookies } = call(query);
			expect((await res).headers.get('location')).toBe('/login?link=invalid');
			expect(cookies.set).not.toHaveBeenCalled();
		}
		expect(state.exchange).not.toHaveBeenCalled();
	});

	it('passes the host it was served on, port and all, for the exchange to normalise', async () => {
		await call(`?t=${TICKET}`, 'Music.Example.TEST:8443').res;
		expect(state.exchange).toHaveBeenCalledWith('owner-db', {
			ticket: TICKET,
			host: 'music.example.test:8443'
		});
	});

	it('does nothing while LABEL_SESSIONS is off: the sign-in page, no exchange, no cookie', async () => {
		state.enabled = false;
		const { res, cookies } = call(`?t=${TICKET}`);
		const response = await res;
		expect(response.headers.get('location')).toBe('/login?link=invalid');
		expect(state.exchange).not.toHaveBeenCalled();
		expect(cookies.set).not.toHaveBeenCalled();
	});
});
