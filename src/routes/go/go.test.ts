import { beforeEach, describe, expect, it, vi } from 'vitest';

// /go/[host] (labelkit#258, step 3): the caller of mintHandoff makes the membership and host checks.
const state = vi.hoisted(() => ({
	enabled: true,
	orgRows: [] as { id: string }[],
	selects: 0,
	mint: vi.fn(async () => 'T'.repeat(43))
}));
vi.mock('#lib/server/label-sessions-env.js', () => ({ labelSessionsEnabled: () => state.enabled }));
vi.mock('#lib/server/label-session.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/server/label-session.js')>()),
	mintHandoff: state.mint
}));
vi.mock('#lib/server/db/client.js', () => ({
	db: () => ({
		select: () => {
			state.selects++;
			const chain = { from: () => chain, where: () => chain, limit: async () => state.orgRows };
			return chain;
		}
	})
}));
import { GET } from './[host]/+server';

const USER = '00000000-0000-7000-8000-0000000000a1';
const ORG_A = '019a0000-0000-7000-8000-00000000000a';
const ORG_B = '019a0000-0000-7000-8000-00000000000b';
const HOST = 'music.example.test';

const member = (orgId: string) => ({ orgId, orgName: 'x', role: 'viewer' as const });
async function call(
	host: string,
	opts: { user?: boolean; memberships?: ReturnType<typeof member>[] } = {}
) {
	return await GET({
		params: { host },
		locals: {
			user: opts.user === false ? null : { id: USER },
			memberships: opts.memberships ?? [member(ORG_A)]
		}
	} as never);
}
/** The status and body of the refusal, so two refusals can be compared. */
async function refusal(promise: Promise<Response>) {
	const e = await promise.then(
		() => {
			throw new Error('expected a refusal');
		},
		(err) => err
	);
	return { status: e.status, body: e.body };
}

beforeEach(() => {
	state.enabled = true;
	state.orgRows = [{ id: ORG_A }];
	state.selects = 0;
	state.mint.mockClear();
});

describe('GET /go/[host]', () => {
	it('mints one ticket for a member and sends them to the label host, uncached', async () => {
		const res = await call(HOST);
		expect(res.status).toBe(303);
		expect(res.headers.get('location')).toBe(`https://${HOST}/auth/handoff?t=${'T'.repeat(43)}`);
		expect(res.headers.get('cache-control')).toBe('no-store');
		expect(state.mint).toHaveBeenCalledTimes(1);
		expect(state.mint).toHaveBeenCalledWith(expect.anything(), {
			userId: USER,
			orgId: ORG_A,
			host: HOST
		});
	});

	it('normalises the host it was given before it looks it up and before it signs it into the ticket', async () => {
		const res = await call('Music.Example.TEST:443');
		expect(res.headers.get('location')).toMatch(
			/^https:\/\/music\.example\.test\/auth\/handoff\?t=/
		);
		expect(state.mint).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ host: HOST })
		);
	});

	it('refuses a person who is not a member of the label that owns the host', async () => {
		state.orgRows = [{ id: ORG_B }];
		const res = await refusal(call(HOST, { memberships: [member(ORG_A)] }));
		expect(res.status).toBe(404);
		expect(state.mint).not.toHaveBeenCalled();
	});

	it('refuses a host no label owns, or whose label is closed, the same way', async () => {
		state.orgRows = [];
		const unknown = await refusal(call('nobody.example.test'));
		state.orgRows = [{ id: ORG_B }];
		const notMember = await refusal(call(HOST));
		expect(unknown.status).toBe(404);
		expect(unknown).toEqual(notMember);
		expect(state.mint).not.toHaveBeenCalled();
	});

	it('refuses a member of several labels for the host of one they do not belong to', async () => {
		state.orgRows = [{ id: ORG_B }];
		await expect(call(HOST, { memberships: [member(ORG_A)] })).rejects.toMatchObject({
			status: 404
		});
		state.orgRows = [{ id: ORG_A }];
		const ok = await call(HOST, { memberships: [member(ORG_B), member(ORG_A)] });
		expect(ok.status).toBe(303);
	});

	it.each([
		'localhost',
		'labelkit',
		'evil.com/steal',
		'a.b.com?x=1',
		'user@evil.com',
		'-bad.example.test',
		'exa mple.test',
		'',
		`${'a'.repeat(64)}.example.test`
	])('does not look up %j: it cannot be a label domain', async (host) => {
		await expect(call(host)).rejects.toMatchObject({ status: 404 });
		expect(state.selects).toBe(0);
		expect(state.mint).not.toHaveBeenCalled();
	});

	it('does nothing without a signed-in person', async () => {
		await expect(call(HOST, { user: false })).rejects.toMatchObject({ status: 404 });
		expect(state.selects).toBe(0);
		expect(state.mint).not.toHaveBeenCalled();
	});

	it('does nothing while LABEL_SESSIONS is off', async () => {
		state.enabled = false;
		await expect(call(HOST)).rejects.toMatchObject({ status: 404 });
		expect(state.selects).toBe(0);
		expect(state.mint).not.toHaveBeenCalled();
	});
});
