import { describe, expect, it, vi } from 'vitest';
import type { BrandLookup, OrgBrand } from './branding';
import { handleSendEmailHook, SEND_RESERVE_MS, type HookConfig } from './hook';
import { hookKey, signHook } from './signature';
import { randomHookSecret } from './test-secrets';

// The return address of a sign-in link: when it is a label's own domain, the link carries it only
// for a member of that label. Every Resend call is a mocked fetch; nothing here reaches Resend,
// Supabase or PostHog.

const SECRET = randomHookSecret();
const EPSILON = '019a0000-0000-7000-8000-00000000e951';
const LABEL_B = '019a0000-0000-7000-8000-0000000000b2';
const LABEL_C = '019a0000-0000-7000-8000-0000000000c3';
const USER = '6f1c2b8e-1c1a-4d55-9a57-0b1f1b0a5c11';
const NOW = 1_794_400_000_000;
const SUPABASE = 'https://efalpthvvmvpaikuxymd.supabase.co';

const B: OrgBrand = {
	orgId: LABEL_B,
	name: 'Label B',
	displayName: null,
	senderDomain: null,
	senderKeySealed: null
};
const HOST_B = 'b.example.test';
const BACK_B = `https://${HOST_B}/auth/callback`;
const BACK_OWN = 'https://labelkit.co/auth/callback';

function payload(type: string, redirectTo: string, metadata: Record<string, unknown> = {}) {
	return JSON.stringify({
		user: {
			id: USER,
			aud: 'authenticated',
			role: 'authenticated',
			email: 'person@example.test',
			new_email: type === 'email_change' ? 'new@example.test' : undefined,
			phone: '',
			app_metadata: {},
			user_metadata: metadata,
			identities: [],
			created_at: '2026-11-11T00:00:00Z',
			updated_at: '2026-11-11T00:00:00Z',
			is_anonymous: false
		},
		email_data: {
			token: '123456',
			token_hash: 'pkce_test-token-hash',
			redirect_to: redirectTo,
			email_action_type: type,
			site_url: `${SUPABASE}/auth/v1`,
			token_new: '654321',
			token_hash_new: type === 'email_change' ? 'pkce_other-hash' : '',
			old_email: 'old@example.test'
		}
	});
}

function signed(body: string) {
	const ts = Math.floor(NOW / 1000);
	const sig = signHook(hookKey(SECRET)!, 'msg_1', ts, body);
	return new Request('https://labelkit.co/api/auth/send-email', {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			'webhook-id': 'msg_1',
			'webhook-timestamp': String(ts),
			'webhook-signature': `v1,${sig}`
		},
		body
	});
}

const CONFIG: HookConfig = {
	hookSecret: SECRET,
	keys: { epsilon: 'fake-key-epsilon', labelkit: 'fake-key-labelkit' },
	epsilonOrgId: EPSILON,
	supabaseUrl: SUPABASE,
	siteUrl: 'https://labelkit.co'
};

type Opts = {
	/** The orgs the recipient belongs to. */
	members?: string[] | Error;
	/** Orgs by custom domain host. */
	hosts?: Record<string, OrgBrand>;
	flagOn?: string[];
	/** Leave the org lookup out entirely. */
	unwired?: boolean;
	lookupFails?: boolean;
};

function setup(o: Opts = {}) {
	const fetcher = vi.fn(async () => Response.json({ id: 'email_1' }));
	const memberOrgIds = vi.fn(async () => {
		if (o.members instanceof Error) throw o.members;
		return o.members ?? [];
	});
	const orgBrand = vi.fn(async (l: BrandLookup) => {
		if (o.lookupFails) throw new Error('lookup failed');
		return 'host' in l ? (o.hosts?.[l.host] ?? null) : null;
	});
	const brandingEnabled = vi.fn(async (id: string) => (o.flagOn ?? []).includes(id));
	const logs: Record<string, unknown>[] = [];
	const run = (body: string) =>
		handleSendEmailHook(signed(body), {
			config: CONFIG,
			memberOrgIds,
			...(o.unwired ? {} : { orgBrand, brandingEnabled }),
			fetcher: fetcher as unknown as typeof fetch,
			now: () => NOW,
			log: (l) => logs.push(l)
		});
	const mails = () =>
		fetcher.mock.calls.map((call) => {
			const [, init] = call as unknown as [string, RequestInit];
			return JSON.parse(init.body as string) as { from: string; subject: string; text: string };
		});
	return { run, fetcher, memberOrgIds, orgBrand, logs, mails };
}

/** The verify links in a message's plain text, parsed. */
function links(text: string) {
	return [...text.matchAll(/https:\/\/\S+/g)].map((m) => new URL(m[0]));
}

describe('characterisation: the link in each email type (return address on LabelKit itself)', () => {
	it.each([
		['magiclink', 'Your LabelKit sign-in link'],
		['signup', 'Confirm your email for LabelKit'],
		['recovery', 'Reset access to LabelKit']
	])('%s: a verify link on Supabase, carrying the return address', async (type, subject) => {
		const t = setup({ members: [] });
		expect((await t.run(payload(type, BACK_OWN))).status).toBe(200);
		const [mail] = t.mails();
		expect(mail.subject).toBe(subject);
		const [url] = links(mail.text);
		expect(url.origin).toBe(SUPABASE);
		expect(url.pathname).toBe('/auth/v1/verify');
		expect(url.searchParams.get('type')).toBe(type);
		expect(url.searchParams.get('redirect_to')).toBe(BACK_OWN);
	});

	it('email_change: both messages carry the return address', async () => {
		const t = setup({ members: [] });
		expect((await t.run(payload('email_change', BACK_OWN))).status).toBe(200);
		const mails = t.mails();
		expect(mails).toHaveLength(2);
		for (const m of mails) {
			expect(links(m.text)[0].searchParams.get('redirect_to')).toBe(BACK_OWN);
		}
	});

	it('invite: links to /auth/confirm on the Site URL, never to the return address', async () => {
		const t = setup({ members: [] });
		await t.run(payload('invite', BACK_OWN, { invited_org_id: LABEL_B, invited_org_name: 'B' }));
		const [url] = links(t.mails()[0].text);
		expect(url.origin + url.pathname).toBe('https://labelkit.co/auth/confirm');
		expect(url.searchParams.get('type')).toBe('invite');
		expect(url.searchParams.has('redirect_to')).toBe(false);
	});

	it('a verification code and a notice carry no link', async () => {
		for (const type of ['reauthentication', 'password_changed_notification']) {
			const t = setup({ members: [] });
			expect((await t.run(payload(type, BACK_OWN))).status).toBe(200);
			expect(links(t.mails()[0].text)).toHaveLength(0);
		}
	});

	it('a label domain today: the link carries it whoever the recipient is', async () => {
		// Pins the behaviour the guard below changes only for non-members.
		const t = setup({ members: [LABEL_B], hosts: { [HOST_B]: B } });
		await t.run(payload('magiclink', BACK_B));
		expect(links(t.mails()[0].text)[0].searchParams.get('redirect_to')).toBe(BACK_B);
	});
});

describe('a label domain as the return address', () => {
	const types = ['magiclink', 'signup', 'recovery', 'email_change'];

	it.each(types)(
		'%s, recipient not in that label: the link has no return address',
		async (type) => {
			const t = setup({ members: [LABEL_C], hosts: { [HOST_B]: B } });
			expect((await t.run(payload(type, BACK_B))).status).toBe(200);
			for (const m of t.mails()) {
				const [url] = links(m.text);
				expect(url.pathname).toBe('/auth/v1/verify');
				expect(url.searchParams.has('redirect_to')).toBe(false);
				expect(m.text).not.toContain(HOST_B);
			}
		}
	);

	it('a recipient who belongs to no label gets the plain link', async () => {
		const t = setup({ members: [], hosts: { [HOST_B]: B } });
		await t.run(payload('magiclink', BACK_B));
		expect(links(t.mails()[0].text)[0].searchParams.has('redirect_to')).toBe(false);
	});

	it.each(types)('%s, recipient in that label: the return address stays', async (type) => {
		const t = setup({ members: [LABEL_C, LABEL_B], hosts: { [HOST_B]: B } });
		expect((await t.run(payload(type, BACK_B))).status).toBe(200);
		for (const m of t.mails()) {
			expect(links(m.text)[0].searchParams.get('redirect_to')).toBe(BACK_B);
		}
	});

	it('membership is compared without regard to letter case', async () => {
		const t = setup({ members: [LABEL_B.toUpperCase()], hosts: { [HOST_B]: B } });
		await t.run(payload('magiclink', BACK_B));
		expect(links(t.mails()[0].text)[0].searchParams.get('redirect_to')).toBe(BACK_B);
	});

	it('a host no label owns: no return address', async () => {
		const t = setup({ members: [LABEL_B], hosts: {} });
		await t.run(payload('magiclink', 'https://nobody.example.test/auth/callback'));
		expect(links(t.mails()[0].text)[0].searchParams.has('redirect_to')).toBe(false);
	});

	it('a return address that is not a URL, or not https: no return address', async () => {
		for (const bad of ['not a url', 'javascript:alert(1)', `http://${HOST_B}/auth/callback`]) {
			const t = setup({ members: [LABEL_B], hosts: { [HOST_B]: B } });
			await t.run(payload('magiclink', bad));
			expect(links(t.mails()[0].text)[0].searchParams.has('redirect_to')).toBe(false);
		}
	});

	it('a host that only looks like LabelKit is not LabelKit', async () => {
		for (const host of ['labelkit.co.evil.test', 'evil-labelkit.co', 'labelkit.co@evil.test']) {
			const t = setup({ members: [] });
			await t.run(payload('magiclink', `https://${host}/auth/callback`));
			expect(links(t.mails()[0].text)[0].searchParams.has('redirect_to')).toBe(false);
		}
	});

	it('a return address with credentials is dropped, for LabelKit hosts and label domains alike', async () => {
		for (const back of [
			`https://user:pw@${HOST_B}/auth/callback`,
			`https://user@${HOST_B}/auth/callback`,
			'https://user:pw@labelkit.co/auth/callback'
		]) {
			const t = setup({ members: [LABEL_B], hosts: { [HOST_B]: B } });
			expect((await t.run(payload('magiclink', back))).status).toBe(200);
			expect(links(t.mails()[0].text)[0].searchParams.has('redirect_to')).toBe(false);
		}
	});

	it('lookups that fail send the plain link, and the email still goes out', async () => {
		const failing: Opts[] = [
			{ members: new Error('db down'), hosts: { [HOST_B]: B }, flagOn: [LABEL_B] },
			{ members: [LABEL_B], hosts: { [HOST_B]: B }, lookupFails: true },
			{ members: [LABEL_B], unwired: true }
		];
		for (const o of failing) {
			const t = setup(o);
			const res = await t.run(payload('magiclink', BACK_B));
			expect(res.status).toBe(200);
			expect(t.mails()).toHaveLength(1);
			expect(links(t.mails()[0].text)[0].searchParams.has('redirect_to')).toBe(false);
		}
	});

	it('a failed membership lookup with no branding to fall back on stays fail-closed, as before', async () => {
		const t = setup({ members: new Error('db down'), hosts: { [HOST_B]: B } });
		expect((await t.run(payload('magiclink', BACK_B))).status).toBe(500);
		expect(t.fetcher).not.toHaveBeenCalled();
	});

	it('a membership read that fails slowly still lets the branded email out in time', async () => {
		vi.useFakeTimers();
		try {
			let clock = NOW;
			const t = setup({ members: [LABEL_B], hosts: { [HOST_B]: B }, flagOn: [LABEL_B] });
			const slowFail = vi.fn(
				() =>
					new Promise<string[]>((_, reject) =>
						setTimeout(() => {
							clock += 900;
							reject(new Error('db slow'));
						}, 900)
					)
			);
			const run = handleSendEmailHook(signed(payload('magiclink', BACK_B)), {
				config: CONFIG,
				memberOrgIds: slowFail,
				orgBrand: t.orgBrand,
				brandingEnabled: async (id) => id === LABEL_B,
				fetcher: t.fetcher as unknown as typeof fetch,
				now: () => clock,
				log: () => {}
			});
			await vi.advanceTimersByTimeAsync(1000);
			const res = await run;
			expect(res.status).toBe(200);
			const [mail] = t.mails();
			expect(mail.from).toBe('"Label B" <no-reply@auth.labelkit.co>');
			expect(links(mail.text)[0].searchParams.has('redirect_to')).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});

	it('a membership read that never answers still leaves a found label its branding and a sent email', async () => {
		vi.useFakeTimers();
		try {
			let clock = NOW;
			const t = setup({ hosts: { [HOST_B]: B }, flagOn: [LABEL_B] });
			// Pending for the full validation allowance (4000 - 2200 - 800 = 1000 ms), then gone.
			const neverAnswers = vi.fn(() => new Promise<string[]>(() => {}));
			const tick = (ms: number) => {
				clock += ms;
				return vi.advanceTimersByTimeAsync(ms);
			};
			const run = handleSendEmailHook(signed(payload('magiclink', BACK_B)), {
				config: CONFIG,
				memberOrgIds: neverAnswers,
				orgBrand: t.orgBrand,
				brandingEnabled: async (id) => id === LABEL_B,
				fetcher: t.fetcher as unknown as typeof fetch,
				now: () => clock,
				log: () => {}
			});
			await tick(0); // lets the body read finish, so the lookups' timers are armed
			await tick(1000);
			const res = await run;
			expect(res.status).toBe(200);
			const [mail] = t.mails();
			expect(mail.from).toBe('"Label B" <no-reply@auth.labelkit.co>');
			expect(links(mail.text)[0].searchParams.has('redirect_to')).toBe(false);
			// The branding step still had its full allowance: the send had at least SEND_RESERVE_MS.
			expect(clock - NOW).toBeLessThanOrEqual(4000 - SEND_RESERVE_MS);
		} finally {
			vi.useRealTimers();
		}
	});

	it('no time left for the lookups: nothing is started, the plain link goes out', async () => {
		let clock = NOW;
		const t = setup({ members: [LABEL_B], hosts: { [HOST_B]: B } });
		const req = signed(payload('magiclink', BACK_B));
		const text = req.text.bind(req);
		req.text = async () => {
			const body = await text();
			clock += 1900; // leaves less than the send reserve
			return body;
		};
		const res = await handleSendEmailHook(req, {
			config: CONFIG,
			memberOrgIds: t.memberOrgIds,
			orgBrand: t.orgBrand,
			brandingEnabled: async () => false,
			fetcher: t.fetcher as unknown as typeof fetch,
			now: () => clock,
			log: () => {}
		});
		expect(res.status).toBe(200);
		expect(t.orgBrand).not.toHaveBeenCalled();
		expect(links(t.mails()[0].text)[0].searchParams.has('redirect_to')).toBe(false);
	});

	it('the person is not branded as that label when the return address is dropped', async () => {
		const t = setup({ members: [LABEL_C], hosts: { [HOST_B]: B }, flagOn: [LABEL_B] });
		await t.run(payload('magiclink', BACK_B));
		const [mail] = t.mails();
		expect(mail.from).toBe('LabelKit <no-reply@auth.labelkit.co>');
		expect(mail.subject).toBe('Your LabelKit sign-in link');
	});

	it('a member still gets the label’s branding and return address', async () => {
		const t = setup({ members: [LABEL_B], hosts: { [HOST_B]: B }, flagOn: [LABEL_B] });
		await t.run(payload('magiclink', BACK_B));
		const [mail] = t.mails();
		expect(mail.from).toBe('"Label B" <no-reply@auth.labelkit.co>');
		expect(links(mail.text)[0].searchParams.get('redirect_to')).toBe(BACK_B);
	});
});

describe("LabelKit's own hosts as the return address", () => {
	it.each([
		'https://labelkit.co/auth/callback',
		'https://www.labelkit.co/auth/callback',
		'http://localhost:5173/auth/callback',
		'https://deploy-preview-12--labelkit.netlify.app/auth/callback'
	])('%s: kept for anyone', async (back) => {
		const t = setup({ members: [], hosts: { [HOST_B]: B } });
		await t.run(payload('magiclink', back));
		expect(links(t.mails()[0].text)[0].searchParams.get('redirect_to')).toBe(back);
	});

	it('no return address stays no return address', async () => {
		const t = setup({ members: [] });
		await t.run(payload('magiclink', ''));
		expect(links(t.mails()[0].text)[0].searchParams.has('redirect_to')).toBe(false);
	});
});

describe('an invite', () => {
	it('with the inviting org known, does not spend lookups on the return address', async () => {
		const t = setup({ members: [], hosts: { [HOST_B]: B } });
		await t.run(payload('invite', BACK_B, { invited_org_id: LABEL_B }));
		expect(t.orgBrand).not.toHaveBeenCalledWith({ host: HOST_B });
		expect(t.memberOrgIds).toHaveBeenCalledTimes(1); // the sender choice only
	});

	it('is unchanged when its return address is a label domain: same link, same sender', async () => {
		const meta = { invited_org_id: LABEL_B, invited_org_name: 'Label B' };
		const t = setup({ members: [], hosts: { [HOST_B]: B } });
		const plain = setup({ members: [], hosts: { [HOST_B]: B } });
		expect((await t.run(payload('invite', BACK_B, meta))).status).toBe(200);
		expect((await plain.run(payload('invite', BACK_OWN, meta))).status).toBe(200);
		expect(t.mails()).toEqual(plain.mails());
		const [url] = links(t.mails()[0].text);
		expect(url.origin + url.pathname).toBe('https://labelkit.co/auth/confirm');
		expect(t.mails()[0].text).not.toContain(HOST_B);
	});

	it('a branded invite for a not-yet-member still goes out as that label', async () => {
		const t = setup({ members: [], hosts: {}, flagOn: [LABEL_B] });
		t.orgBrand.mockImplementation(async (l: BrandLookup) => ('orgId' in l ? B : null));
		await t.run(payload('invite', '', { invited_org_id: LABEL_B, invited_org_name: 'Label B' }));
		const [mail] = t.mails();
		expect(mail.from).toBe('"Label B" <no-reply@auth.labelkit.co>');
		expect(mail.subject).toBe("You're invited to Label B");
	});
});
