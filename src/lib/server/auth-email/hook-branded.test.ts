import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { parseKeyRing } from '../audiokit-credentials';
import { sealSenderKey, type BrandLookup, type OrgBrand } from './branding';
import {
	BRANDING_BUDGET_MS,
	HOOK_BUDGET_MS,
	LEGACY_RESERVE_MS,
	handleSendEmailHook,
	type HookConfig
} from './hook';
import { hookKey, signHook } from './signature';
import { randomHookSecret } from './test-secrets';

// EPSILON-146: auth email branded per label, behind the per-org flag labelkit-branded-auth-email.
// Every Resend call is a mocked fetch; nothing here reaches Resend, Supabase or PostHog.

const SECRET = randomHookSecret();
const EPSILON = '019a0000-0000-7000-8000-00000000e951';
const LABEL_B = '019a0000-0000-7000-8000-0000000000b2';
const USER = '6f1c2b8e-1c1a-4d55-9a57-0b1f1b0a5c11';
const NOW = 1_794_400_000_000;
const RING_ENV = `t1:${randomBytes(32).toString('base64')}`;
const RING = parseKeyRing(RING_ENV);
const FAKE_ORG_KEY = 'fake-resend-key-for-tests-only';

const ERMS: OrgBrand = {
	orgId: EPSILON,
	name: 'Epsilon Records',
	displayName: 'ERMS',
	senderDomain: 'auth.epsilonrecords.com',
	senderKeySealed: sealSenderKey(RING, EPSILON, 'auth.epsilonrecords.com', FAKE_ORG_KEY)
};
const B: OrgBrand = {
	orgId: LABEL_B,
	name: 'Label B',
	displayName: null,
	senderDomain: null,
	senderKeySealed: null
};

function payload(
	type = 'magiclink',
	data: Record<string, unknown> = {},
	metadata: Record<string, unknown> = {}
) {
	return JSON.stringify({
		user: {
			id: USER,
			aud: 'authenticated',
			role: 'authenticated',
			email: 'staff@example.test',
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
			redirect_to: 'https://erms.epsilonrecords.com/auth/callback',
			email_action_type: type,
			site_url: 'https://efalpthvvmvpaikuxymd.supabase.co/auth/v1',
			token_new: '',
			token_hash_new: '',
			...data
		}
	});
}

function signed(body: string, opts: { secret?: string; at?: number } = {}) {
	const ts = Math.floor((opts.at ?? NOW) / 1000);
	const sig = signHook(hookKey(opts.secret ?? SECRET)!, 'msg_1', ts, body);
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
	supabaseUrl: 'https://efalpthvvmvpaikuxymd.supabase.co',
	siteUrl: 'https://labelkit.co',
	credentialsKey: RING_ENV
};

type Opts = {
	/** Orgs by custom domain host. */
	hosts?: Record<string, OrgBrand>;
	/** Orgs by id (invites). */
	ids?: Record<string, OrgBrand>;
	/** Orgs whose flag is on. */
	flagOn?: string[];
	flag?: (orgId: string) => Promise<boolean>;
	lookup?: (l: BrandLookup) => Promise<OrgBrand | null>;
	members?: string[];
	config?: Partial<HookConfig>;
	resend?: () => Response;
	/** Leave the branding deps out entirely, as before EPSILON-146. */
	unwired?: boolean;
};

function setup(o: Opts = {}) {
	const fetcher = vi.fn(async () => o.resend?.() ?? Response.json({ id: 'email_1' }));
	const orgBrand = vi.fn(
		o.lookup ??
			(async (l: BrandLookup) => ('orgId' in l ? o.ids?.[l.orgId] : o.hosts?.[l.host]) ?? null)
	);
	const brandingEnabled = vi.fn(
		o.flag ?? (async (orgId: string) => (o.flagOn ?? []).includes(orgId))
	);
	const memberOrgIds = vi.fn(async () => o.members ?? []);
	const logs: Record<string, unknown>[] = [];
	const run = (req: Request) =>
		handleSendEmailHook(req, {
			config: { ...CONFIG, ...o.config },
			memberOrgIds,
			...(o.unwired ? {} : { orgBrand, brandingEnabled }),
			fetcher: fetcher as unknown as typeof fetch,
			now: () => NOW,
			log: (l) => logs.push(l)
		});
	const sent = () =>
		fetcher.mock.calls.map((call) => {
			const [, init] = call as unknown as [string, RequestInit];
			const headers = init.headers as Record<string, string>;
			return { auth: headers.authorization, body: JSON.parse(init.body as string) };
		});
	return { run, fetcher, orgBrand, brandingEnabled, memberOrgIds, logs, sent };
}

const hostERMS = { 'erms.epsilonrecords.com': ERMS };

describe('Send Email hook, branded per label (EPSILON-146)', () => {
	describe('signature, before any branding lookup', () => {
		it('a valid signature is accepted', async () => {
			const t = setup({ hosts: hostERMS, flagOn: [EPSILON] });
			expect((await t.run(signed(payload()))).status).toBe(200);
		});

		it('an invalid signature is refused with 401 before the org lookup or flag', async () => {
			const t = setup({ hosts: hostERMS, flagOn: [EPSILON] });
			const res = await t.run(signed(payload(), { secret: randomHookSecret() }));
			expect(res.status).toBe(401);
			expect(t.orgBrand).not.toHaveBeenCalled();
			expect(t.brandingEnabled).not.toHaveBeenCalled();
			expect(t.fetcher).not.toHaveBeenCalled();
		});

		it('a stale timestamp is refused with 401 before the org lookup or flag', async () => {
			const t = setup({ hosts: hostERMS, flagOn: [EPSILON] });
			const res = await t.run(signed(payload(), { at: NOW - 6 * 60_000 }));
			expect(res.status).toBe(401);
			expect((await res.json()).error.message).toContain('stale');
			expect(t.orgBrand).not.toHaveBeenCalled();
			expect(t.fetcher).not.toHaveBeenCalled();
		});
	});

	describe('flag on', () => {
		it('a label with its own sender: its name and domain, with its own key', async () => {
			const t = setup({ hosts: hostERMS, flagOn: [EPSILON] });
			const res = await t.run(signed(payload()));
			expect(res.status).toBe(200);
			expect(t.orgBrand).toHaveBeenCalledWith({ host: 'erms.epsilonrecords.com' });
			expect(t.brandingEnabled).toHaveBeenCalledWith(EPSILON);
			expect(t.memberOrgIds).not.toHaveBeenCalled();
			const [mail] = t.sent();
			expect(mail.auth).toBe(`Bearer ${FAKE_ORG_KEY}`);
			expect(mail.body.from).toBe('"ERMS" <no-reply@auth.epsilonrecords.com>');
			expect(mail.body.subject).toBe('Your ERMS sign-in link');
			expect(mail.body.text).toContain('Sign in to ERMS');
			expect(t.logs.at(-1)).toMatchObject({
				outcome: 'sent',
				branded: true,
				org: EPSILON,
				sender: 'auth.epsilonrecords.com'
			});
		});

		it('a label without its own sender: auth.labelkit.co under the label’s name', async () => {
			const t = setup({ hosts: { 'b.example.test': B }, flagOn: [LABEL_B] });
			await t.run(
				signed(payload('magiclink', { redirect_to: 'https://b.example.test/auth/callback' }))
			);
			const [mail] = t.sent();
			expect(mail.auth).toBe('Bearer fake-key-labelkit');
			expect(mail.body.from).toBe('"Label B" <no-reply@auth.labelkit.co>');
			expect(mail.body.subject).toBe('Your Label B sign-in link');
		});

		it('name: display_name, else name, else LabelKit', async () => {
			const noNames = { ...B, name: '  ', displayName: null };
			const t = setup({ hosts: { 'b.example.test': noNames }, flagOn: [LABEL_B] });
			await t.run(signed(payload('signup', { redirect_to: 'https://b.example.test/x' })));
			expect(t.sent()[0].body.from).toBe('"LabelKit" <no-reply@auth.labelkit.co>');
			expect(t.sent()[0].body.subject).toBe('Confirm your email for LabelKit');
		});

		it('an invite: the inviting org, by id, names the label once', async () => {
			const t = setup({ ids: { [EPSILON]: ERMS }, flagOn: [EPSILON] });
			await t.run(
				signed(
					payload(
						'invite',
						{ redirect_to: '' },
						{ invited_org_id: EPSILON, invited_org_name: 'ERMS' }
					)
				)
			);
			expect(t.orgBrand).toHaveBeenCalledWith({ orgId: EPSILON });
			const [mail] = t.sent();
			expect(mail.body.from).toBe('"ERMS" <no-reply@auth.epsilonrecords.com>');
			expect(mail.body.subject).toBe("You're invited to ERMS");
			expect(mail.body.text).toContain('https://labelkit.co/auth/confirm?token_hash=');
			expect(mail.body.text).not.toContain('LabelKit');
		});

		it('invited_org_id is ignored outside invites: the redirect host decides', async () => {
			const t = setup({
				hosts: { 'b.example.test': B },
				ids: { [EPSILON]: ERMS },
				flagOn: [EPSILON, LABEL_B]
			});
			await t.run(
				signed(
					payload(
						'magiclink',
						{ redirect_to: 'https://b.example.test/auth/callback' },
						{ invited_org_id: EPSILON }
					)
				)
			);
			expect(t.orgBrand).toHaveBeenCalledWith({ host: 'b.example.test' });
			expect(t.sent()[0].body.from).toBe('"Label B" <no-reply@auth.labelkit.co>');
		});

		it('covers recovery and a secure email change with the label’s name', async () => {
			const t = setup({ hosts: hostERMS, flagOn: [EPSILON] });
			await t.run(signed(payload('recovery')));
			expect(t.sent()[0].body.subject).toBe('Reset access to ERMS');
			const c = setup({ hosts: hostERMS, flagOn: [EPSILON] });
			await c.run(signed(payload('email_change', { token_hash_new: 'pkce_other-hash' })));
			const mails = c.sent();
			expect(mails).toHaveLength(2);
			for (const m of mails) {
				expect(m.body.from).toBe('"ERMS" <no-reply@auth.epsilonrecords.com>');
				expect(m.body.subject).toContain('ERMS');
			}
		});

		it('a name with quotes or angle brackets stays one quoted display name', async () => {
			const odd = { ...B, displayName: 'B "Records" <x@evil.test>, y' };
			const t = setup({ hosts: { 'b.example.test': odd }, flagOn: [LABEL_B] });
			await t.run(signed(payload('magiclink', { redirect_to: 'https://b.example.test/' })));
			expect(t.sent()[0].body.from).toBe(
				'"B \\"Records\\" <x@evil.test>, y" <no-reply@auth.labelkit.co>'
			);
			expect(t.sent()[0].body.html).toContain('B &quot;Records&quot; &lt;x@evil.test&gt;');
		});
	});

	describe('fallback to the default sender', () => {
		it('no org on the redirect host: the EPSILON-147 rules (LabelKit for a non-member)', async () => {
			const t = setup({ hosts: hostERMS, flagOn: [EPSILON] });
			await t.run(signed(payload('signup', { redirect_to: 'https://labelkit.co/auth/callback' })));
			expect(t.brandingEnabled).not.toHaveBeenCalled();
			expect(t.memberOrgIds).toHaveBeenCalledWith(USER);
			expect(t.sent()[0].body.from).toBe('LabelKit <no-reply@auth.labelkit.co>');
		});

		it('no redirect at all (a notice): no lookup, EPSILON-147 rules', async () => {
			const t = setup({ hosts: hostERMS, flagOn: [EPSILON], members: [] });
			await t.run(signed(payload('identity_linked_notification', { redirect_to: '' })));
			expect(t.orgBrand).not.toHaveBeenCalled();
			expect(t.sent()[0].body.from).toBe('LabelKit <no-reply@auth.labelkit.co>');
		});

		it('the label’s own key does not open: auth.labelkit.co under its name, logged', async () => {
			const t = setup({
				hosts: hostERMS,
				flagOn: [EPSILON],
				config: { credentialsKey: `t1:${randomBytes(32).toString('base64')}` }
			});
			expect((await t.run(signed(payload()))).status).toBe(200);
			const [mail] = t.sent();
			expect(mail.auth).toBe('Bearer fake-key-labelkit');
			expect(mail.body.from).toBe('"ERMS" <no-reply@auth.labelkit.co>');
			expect(t.logs.find((l) => l.outcome === 'sender_fallback')).toMatchObject({
				org: EPSILON,
				sender: 'auth.epsilonrecords.com'
			});
			expect(JSON.stringify(t.logs)).not.toContain(FAKE_ORG_KEY);
		});

		it('a sealed key copied to another org does not open there', async () => {
			const stolen = {
				...B,
				senderDomain: 'auth.epsilonrecords.com',
				senderKeySealed: ERMS.senderKeySealed
			};
			const t = setup({ hosts: { 'b.example.test': stolen }, flagOn: [LABEL_B] });
			await t.run(signed(payload('magiclink', { redirect_to: 'https://b.example.test/' })));
			expect(t.sent()[0].auth).toBe('Bearer fake-key-labelkit');
			expect(t.sent()[0].body.from).toBe('"Label B" <no-reply@auth.labelkit.co>');
		});

		it('the LabelKit key missing on the branded path fails closed, nothing sent', async () => {
			const t = setup({
				hosts: { 'b.example.test': B },
				flagOn: [LABEL_B],
				config: { keys: { epsilon: 'fake-key-epsilon', labelkit: undefined } }
			});
			const res = await t.run(
				signed(payload('magiclink', { redirect_to: 'https://b.example.test/' }))
			);
			expect(res.status).toBe(500);
			expect(t.fetcher).not.toHaveBeenCalled();
		});
	});

	describe('flag off means the old behaviour', () => {
		it('flag off for the org: Epsilon staff get exactly the EPSILON-147 email', async () => {
			const t = setup({ hosts: hostERMS, flagOn: [], members: [EPSILON] });
			await t.run(signed(payload()));
			expect(t.brandingEnabled).toHaveBeenCalledWith(EPSILON);
			const [mail] = t.sent();
			expect(mail.auth).toBe('Bearer fake-key-epsilon');
			expect(mail.body.from).toBe('Epsilon Records <no-reply@auth.epsilonrecords.com>');
			expect(mail.body.subject).toBe('Your ERMS sign-in link');
			expect(t.logs.at(-1)).not.toHaveProperty('branded');
		});

		it('flag on for another org only: this org keeps the old behaviour', async () => {
			const t = setup({ hosts: { 'b.example.test': B }, flagOn: [EPSILON], members: [LABEL_B] });
			await t.run(signed(payload('magiclink', { redirect_to: 'https://b.example.test/' })));
			expect(t.sent()[0].body.from).toBe('LabelKit <no-reply@auth.labelkit.co>');
		});

		it('the same email, flag off, matches the hook without the branding wiring at all', async () => {
			const off = setup({ ids: { [LABEL_B]: B }, flagOn: [], members: [EPSILON] });
			const before = setup({ unwired: true, members: [EPSILON] });
			const invite = () =>
				signed(payload('invite', {}, { invited_org_id: LABEL_B, invited_org_name: 'Label B' }));
			expect((await off.run(invite())).status).toBe(200);
			expect((await before.run(invite())).status).toBe(200);
			expect(off.orgBrand).toHaveBeenCalledWith({ orgId: LABEL_B });
			expect(off.brandingEnabled).toHaveBeenCalledWith(LABEL_B);
			expect(off.sent()).toEqual(before.sent());
			expect(off.sent()).toHaveLength(1);
		});

		it('a branding step that hangs gives up within its own budget and the old path still sends', async () => {
			vi.useFakeTimers();
			try {
				let clock = NOW;
				const t = setup({
					hosts: hostERMS,
					members: [EPSILON],
					flag: () => new Promise<boolean>(() => {})
				});
				const run = handleSendEmailHook(signed(payload()), {
					config: CONFIG,
					memberOrgIds: t.memberOrgIds,
					orgBrand: t.orgBrand,
					brandingEnabled: t.brandingEnabled,
					fetcher: t.fetcher as unknown as typeof fetch,
					now: () => clock,
					log: () => {}
				});
				await vi.advanceTimersByTimeAsync(0);
				clock += BRANDING_BUDGET_MS;
				await vi.advanceTimersByTimeAsync(BRANDING_BUDGET_MS);
				const res = await run;
				expect(res.status).toBe(200);
				expect(t.memberOrgIds).toHaveBeenCalled();
				expect(t.sent()[0].body.from).toBe('Epsilon Records <no-reply@auth.epsilonrecords.com>');
			} finally {
				vi.useRealTimers();
			}
		});

		it('a slow body read that leaves under the reserve skips branding; the old path still sends', async () => {
			let clock = NOW;
			const t = setup({ hosts: hostERMS, flagOn: [EPSILON], members: [EPSILON] });
			const req = signed(payload());
			// The body read takes all but (reserve - 1) ms of the budget.
			const slowText = req.text.bind(req);
			req.text = async () => {
				const body = await slowText();
				clock += HOOK_BUDGET_MS - LEGACY_RESERVE_MS + 1;
				return body;
			};
			const res = await handleSendEmailHook(req, {
				config: CONFIG,
				memberOrgIds: t.memberOrgIds,
				orgBrand: t.orgBrand,
				brandingEnabled: t.brandingEnabled,
				fetcher: t.fetcher as unknown as typeof fetch,
				now: () => clock,
				log: () => {}
			});
			expect(res.status).toBe(200);
			expect(t.orgBrand).not.toHaveBeenCalled();
			expect(t.brandingEnabled).not.toHaveBeenCalled();
			expect(t.memberOrgIds).toHaveBeenCalledWith(USER);
			expect(t.sent()[0].body.from).toBe('Epsilon Records <no-reply@auth.epsilonrecords.com>');
		});

		it('the reserve leaves branding its full budget on an ordinary call', () => {
			expect(HOOK_BUDGET_MS - LEGACY_RESERVE_MS).toBe(BRANDING_BUDGET_MS);
			expect(LEGACY_RESERVE_MS).toBeGreaterThanOrEqual(1000 + 2000);
		});

		it('a failing flag check is off', async () => {
			const t = setup({
				hosts: hostERMS,
				members: [EPSILON],
				flag: async () => {
					throw new Error('PostHog down');
				}
			});
			expect((await t.run(signed(payload()))).status).toBe(200);
			expect(t.sent()[0].body.from).toBe('Epsilon Records <no-reply@auth.epsilonrecords.com>');
		});

		it('a failing org lookup (e.g. migration 0033 not applied) keeps the old path', async () => {
			const t = setup({
				members: [EPSILON],
				lookup: async () => {
					throw new Error('function app_auth_email.org_brand_by_host(text) does not exist');
				}
			});
			expect((await t.run(signed(payload()))).status).toBe(200);
			expect(t.brandingEnabled).not.toHaveBeenCalled();
			expect(t.logs.some((l) => l.outcome === 'brand_lookup_failed')).toBe(true);
			expect(t.sent()[0].body.from).toBe('Epsilon Records <no-reply@auth.epsilonrecords.com>');
		});
	});

	describe('a Resend error surfaces to Supabase', () => {
		it('a refused send on the branded path answers 502 with the error body, nothing reported as sent', async () => {
			const t = setup({
				hosts: hostERMS,
				flagOn: [EPSILON],
				resend: () => Response.json({ name: 'validation_error' }, { status: 422 })
			});
			const res = await t.run(signed(payload()));
			expect(res.status).toBe(502);
			expect(res.headers.get('content-type')).toBe('application/json');
			expect(await res.json()).toEqual({
				error: {
					http_code: 500,
					message: 'The sign-in email could not be sent. Try again shortly.'
				}
			});
			expect(t.logs.at(-1)).toMatchObject({
				outcome: 'send_failed',
				status: 422,
				branded: true,
				sender: 'auth.epsilonrecords.com'
			});
		});

		it('a Resend rate limit on the branded path passes through as http_code 429', async () => {
			const t = setup({
				hosts: hostERMS,
				flagOn: [EPSILON],
				resend: () => Response.json({ name: 'rate_limit_exceeded' }, { status: 429 })
			});
			const res = await t.run(signed(payload()));
			expect(res.status).toBe(502);
			expect((await res.json()).error.http_code).toBe(429);
		});
	});
});
