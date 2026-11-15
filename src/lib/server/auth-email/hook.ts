import { z } from 'zod';
import { verifyHook } from './signature';
import { chooseSender, SENDERS, type SenderId } from './sender';
import { render, UnsupportedEmailType, type HookEmailData, type HookUser } from './templates';
import { RESEND_TIMEOUT_MS, ResendFailed, sendWithResend } from './resend';
import { brandedSender, redirectHost, type BrandLookup, type OrgBrand } from './branding';
import type { Sender } from './sender';

/**
 * Supabase Auth's "Send Email" hook (EPSILON-147, decision 0027): Supabase POSTs every auth email
 * here instead of sending it over SMTP, and this picks the sender and sends it through Resend.
 *
 * Order: verify the signature on the raw body, parse, look up the account's org ids (the only
 * database read, as labelkit_auth_email), choose the sender, render, send. **It fails closed**: any
 * missing setting, unknown email type, failed lookup or refused send answers an error, Supabase
 * reports the sign-in as failed, and no email goes out from the other domain instead.
 *
 * What Supabase does with an error answer (supabase/auth `internal/hooks/hookshttp/hookshttp.go`):
 * it reads `{"error":{"http_code","message"}}` only from a 200/202 answer. Any other status is
 * reported to the caller of Auth as a generic 500 ("Invalid payload sent to hook" for 400, "Hook
 * requires authorization token" for 401, "Unexpected status code returned from hook: 502", ...),
 * so the `message` strings below reach this app's logs and tests, not the person signing in. That
 * is still failing closed: no status but 200/202/204 counts as sent. The non-2xx statuses are kept
 * on purpose; a 200 carrying an error would only count as one while `message` is non-empty.
 *
 * **Branded per label (EPSILON-146)**, behind the per-org flag `labelkit-branded-auth-email`: after
 * the signature and payload checks, the hook looks up the org the email is for (branding.ts) and asks
 * the flag for that org. Only when an org is found *and* its flag is on does the email use the
 * label's name and sender. Otherwise, including when the lookup or the flag check fails or there is
 * no flag source, everything below runs exactly as it did before (EPSILON-147).
 */

export const AUTH_EMAIL_HOOK_PATH = '/api/auth/send-email';

/**
 * Supabase Auth's Site URL in production. `scripts/auth-redirects.mjs` (AUTH_SITE_URL) keeps
 * Supabase set to it, and a test holds the two equal. Kept here rather than imported, so the
 * script's command-line part is not bundled into the function.
 */
export const AUTH_SITE_URL = 'https://labelkit.co';

/**
 * Supabase waits 5 s for the whole hook call, then gives up with `hook_timeout` and rolls the
 * email's tokens back. This handler's own budget, from the start of the call across the lookup and
 * every send, leaves the rest for the function's start and the network.
 */
export const HOOK_BUDGET_MS = 4000;

/**
 * The most the optional branding step (EPSILON-146: org lookup and flag check together) may take.
 * When it runs out, the hook falls back to the EPSILON-147 path, which then still has at least the
 * rest of HOOK_BUDGET_MS for its own lookup and the send.
 */
export const BRANDING_BUDGET_MS = 800;

export type HookConfig = {
	hookSecret: string | undefined;
	keys: Record<SenderId, string | undefined>;
	epsilonOrgId: string | undefined;
	supabaseUrl: string;
	/**
	 * Supabase Auth's Site URL, which its own invite template linked as `{{ .SiteURL }}`. Not the
	 * payload's `email_data.site_url`: Supabase fills that with the Auth API's external URL
	 * (`<project>.supabase.co/auth/v1`), not the Site URL (supabase/auth `internal/api/mail.go`).
	 */
	siteUrl: string;
	/** AUDIOKIT_CREDENTIALS_KEY: the key ring that opens a label's own sealed Resend key. */
	credentialsKey?: string;
};

export type HookDeps = {
	config: HookConfig;
	/** Every org id the account belongs to. */
	memberOrgIds: (userId: string) => Promise<string[]>;
	fetcher: typeof fetch;
	/** The org an email is for (migration 0033 functions), or null. Absent: branding is off. */
	orgBrand?: (lookup: BrandLookup) => Promise<OrgBrand | null>;
	/** Whether branded auth email is on for this org (PostHog flag). Absent: off. */
	brandingEnabled?: (orgId: string) => Promise<boolean>;
	now?: () => number;
	log?: (line: Record<string, unknown>) => void;
};

const Payload = z.object({
	user: z.looseObject({
		id: z.uuid(),
		email: z.string().min(3),
		new_email: z.string().nullish(),
		user_metadata: z.record(z.string(), z.unknown()).nullish()
	}),
	email_data: z.looseObject({
		token: z.string().default(''),
		token_hash: z.string().default(''),
		redirect_to: z.string().default(''),
		email_action_type: z.string().min(1),
		site_url: z.string().default(''),
		token_new: z.string().default(''),
		token_hash_new: z.string().default(''),
		old_email: z.string().nullish(),
		provider: z.string().nullish(),
		factor_type: z.string().nullish()
	})
});

const Uuid = z.uuid();

/** The error shape Supabase's auth hooks expect; `message` is what the caller of Auth sees. */
export function hookError(status: number, message: string, httpCode = status): Response {
	return new Response(JSON.stringify({ error: { http_code: httpCode, message } }), {
		status,
		headers: { 'content-type': 'application/json' }
	});
}

function defaultLog(line: Record<string, unknown>) {
	const out = JSON.stringify({ event: 'auth_email_hook', ...line });
	if (line.level === 'error') console.error(out);
	else console.log(out);
}

export async function handleSendEmailHook(request: Request, deps: HookDeps): Promise<Response> {
	const log = deps.log ?? defaultLog;
	const { config } = deps;
	const clock = deps.now ?? Date.now;
	const deadline = clock() + HOOK_BUDGET_MS;
	const remaining = () => deadline - clock();

	if (!config.hookSecret) {
		log({ level: 'error', outcome: 'not_configured', reason: 'SEND_EMAIL_HOOK_SECRET' });
		return hookError(500, 'Sign-in email is not configured (hook secret missing).');
	}

	// The body read counts against the budget too: a stalled body must not outlast Supabase's 5 s.
	let rawBody: string;
	try {
		rawBody = await withinBudget(request.text(), remaining());
	} catch {
		log({ level: 'error', outcome: 'body_read_failed' });
		return hookError(500, 'Could not read the Send Email hook request.');
	}
	const nowSeconds = Math.floor(clock() / 1000);
	const verified = verifyHook(config.hookSecret, request.headers, rawBody, nowSeconds);
	if (!verified.ok) {
		log({ level: 'error', outcome: 'rejected', reason: verified.reason });
		return verified.reason === 'bad_secret'
			? hookError(500, 'Sign-in email is not configured (hook secret is malformed).')
			: hookError(401, `Send Email hook rejected: ${verified.reason}`);
	}

	let parsed;
	try {
		parsed = Payload.safeParse(JSON.parse(rawBody));
	} catch {
		parsed = null;
	}
	if (!parsed?.success) {
		log({ level: 'error', outcome: 'bad_payload' });
		return hookError(400, 'Send Email hook payload was not understood.');
	}
	const user = parsed.data.user as HookUser;
	const email = parsed.data.email_data as HookEmailData;
	const type = email.email_action_type;
	const base = { user: user.id, action_type: type, webhook_id: verified.id };

	const invited = user.user_metadata?.invited_org_id;
	const invitedOrgId =
		typeof invited === 'string' && Uuid.safeParse(invited).success ? invited : null;

	const brandingDeadline = clock() + BRANDING_BUDGET_MS;
	const brandingLeft = () => Math.min(remaining(), brandingDeadline - clock());
	const branded = await brandFor(deps, type, invitedOrgId, email.redirect_to, brandingLeft, (l) =>
		log({ ...base, ...l })
	);
	if (branded) {
		const { brand, chosen } = branded;
		if (chosen.fallbackReason) {
			log({
				...base,
				level: 'error',
				outcome: 'sender_fallback',
				org: brand.orgId,
				sender: brand.senderDomain,
				reason: chosen.fallbackReason
			});
		}
		if (!chosen.key) {
			log({ ...base, level: 'error', outcome: 'not_configured', sender: chosen.sender.domain });
			return hookError(
				500,
				`Sign-in email is not configured (no Resend key for ${chosen.sender.domain}).`
			);
		}
		return deliver(deps, config, user, email, chosen.sender, chosen.key, verified.id, remaining, {
			...base,
			branded: true,
			org: brand.orgId
		});
	}

	const epsilonOrgId = config.epsilonOrgId;
	if (!epsilonOrgId || !Uuid.safeParse(epsilonOrgId).success) {
		log({
			...base,
			level: 'error',
			outcome: 'not_configured',
			reason: 'AUTH_EMAIL_EPSILON_ORG_ID'
		});
		return hookError(500, 'Sign-in email is not configured (Epsilon org id missing).');
	}

	let memberOrgIds: string[];
	try {
		memberOrgIds = await withinBudget(deps.memberOrgIds(user.id), remaining());
	} catch {
		log({ ...base, level: 'error', outcome: 'lookup_failed' });
		return hookError(500, 'Could not prepare the sign-in email. Try again shortly.');
	}

	const senderId = chooseSender({
		actionType: type,
		invitedOrgId,
		memberOrgIds,
		epsilonOrgId
	});
	const sender = SENDERS[senderId];
	const key = config.keys[senderId];
	if (!key) {
		// No fallback to the other domain: that would send Epsilon staff LabelKit mail, or the reverse.
		log({ ...base, level: 'error', outcome: 'not_configured', sender: sender.domain });
		return hookError(500, `Sign-in email is not configured (no Resend key for ${sender.domain}).`);
	}
	return deliver(deps, config, user, email, sender, key, verified.id, remaining, base);
}

/**
 * The org this email is branded for, with its sender, or null to keep the EPSILON-147 path. Null
 * whenever anything is missing or fails: no lookup or flag wired, no org to look for, no org found,
 * a failed lookup, the flag off, or a failed flag check. So the flag off (or PostHog keys unset)
 * changes nothing.
 */
async function brandFor(
	deps: HookDeps,
	type: string,
	invitedOrgId: string | null,
	redirectTo: string,
	remaining: () => number,
	log: (line: Record<string, unknown>) => void
): Promise<{ brand: OrgBrand; chosen: ReturnType<typeof brandedSender> } | null> {
	if (!deps.orgBrand || !deps.brandingEnabled) return null;
	let lookup: BrandLookup | null = null;
	if (type === 'invite' && invitedOrgId) lookup = { orgId: invitedOrgId };
	else {
		const host = redirectHost(redirectTo);
		if (host) lookup = { host };
	}
	if (!lookup) return null;
	let brand: OrgBrand | null;
	try {
		brand = await withinBudget(deps.orgBrand(lookup), remaining());
	} catch {
		// Includes running out of BRANDING_BUDGET_MS: the old path still has its own time.
		log({ level: 'error', outcome: 'brand_lookup_failed' });
		return null;
	}
	if (!brand) return null;
	let on: boolean;
	try {
		on = await withinBudget(deps.brandingEnabled(brand.orgId), remaining());
	} catch {
		on = false;
	}
	if (!on) return null;
	return {
		brand,
		chosen: brandedSender(brand, {
			labelkitKey: deps.config.keys.labelkit,
			credentialsKey: deps.config.credentialsKey
		})
	};
}

/** Renders the email(s) and sends them through Resend with `sender` and `key`. */
async function deliver(
	deps: HookDeps,
	config: HookConfig,
	user: HookUser,
	email: HookEmailData,
	sender: Sender,
	key: string,
	webhookId: string,
	remaining: () => number,
	base: Record<string, unknown>
): Promise<Response> {
	const log = deps.log ?? defaultLog;
	const type = email.email_action_type;
	let messages;
	try {
		messages = render({
			sender,
			user,
			email,
			supabaseUrl: config.supabaseUrl,
			siteUrl: config.siteUrl
		});
	} catch (e) {
		if (!(e instanceof UnsupportedEmailType)) throw e;
		log({
			...base,
			level: 'error',
			outcome: 'unsupported',
			reason: e.message,
			sender: sender.domain
		});
		return hookError(500, `This kind of email (${type}) is not supported.`);
	}

	// A secure email change is two messages. They go out at once, each with its own idempotency key,
	// and share what is left of the budget: one after the other could outlast Supabase's 5 s.
	const results = await Promise.allSettled(
		messages.map((message, i) => {
			const left = Math.min(RESEND_TIMEOUT_MS, remaining());
			return left > 0
				? sendWithResend(deps.fetcher, key, sender.from, message, `${webhookId}:${i}`, left)
				: Promise.reject(new ResendFailed(0, 'timeout'));
		})
	);
	const failures = results.flatMap((r) => (r.status === 'rejected' ? [r.reason as unknown] : []));
	if (failures.length) {
		const statuses = failures.map((e) => (e instanceof ResendFailed ? e.status : 0));
		const status = statuses.includes(429) ? 429 : statuses[0];
		const first = failures[0];
		log({
			...base,
			level: 'error',
			outcome: 'send_failed',
			sender: sender.domain,
			status,
			reason: first instanceof Error ? first.message : 'unknown',
			sent: results.length - failures.length,
			of: results.length
		});
		return status === 429
			? hookError(502, 'Too many emails were sent recently. Wait a while, then try again.', 429)
			: hookError(502, 'The sign-in email could not be sent. Try again shortly.', 500);
	}
	const ids = results.map((r) => (r.status === 'fulfilled' ? r.value : ''));

	log({ ...base, level: 'info', outcome: 'sent', sender: sender.domain, resend_ids: ids });
	return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
}

/** `work`, or a rejection once `ms` have passed (the work itself is not cancelled). */
function withinBudget<T>(work: Promise<T>, ms: number): Promise<T> {
	if (ms <= 0) return Promise.reject(new Error('deadline'));
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error('deadline')), ms);
	});
	return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}
