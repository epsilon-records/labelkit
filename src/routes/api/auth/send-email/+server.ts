import { sql } from 'drizzle-orm';
import { PUBLIC_SUPABASE_URL } from '$app/env/public';
import {
	AUDIOKIT_CREDENTIALS_KEY,
	AUTH_EMAIL_EPSILON_ORG_ID,
	RESEND_KEY_EPSILON,
	RESEND_KEY_LABELKIT,
	SEND_EMAIL_HOOK_SECRET
} from '$app/env/private';
import { AUTH_SITE_URL, handleSendEmailHook } from '#lib/server/auth-email/hook.js';
import type { BrandLookup, OrgBrand } from '#lib/server/auth-email/branding.js';
import { featureFor } from '#lib/server/features.js';
import { flagSource } from '#lib/server/features-env.js';
import type { RequestHandler } from './$types';

/**
 * Supabase Auth's Send Email hook (EPSILON-147). Not behind sign-in: hooks.server.ts hands this
 * path the labelkit_auth_email runner and nothing else, and the handler verifies the Standard Webhooks
 * signature before it reads the database. See README, "Sign-in email".
 *
 * Branding per label (EPSILON-146) reads the org through the same runner, with the
 * app_auth_email.org_brand_by_* functions (migration 0033), and is on only for orgs whose
 * `labelkit-branded-auth-email` flag is on.
 */

type BrandRow = {
	org_id: string;
	name: string | null;
	display_name: string | null;
	sender_domain: string | null;
	sender_key_sealed: string | null;
};
export const POST: RequestHandler = ({ request, locals }) =>
	handleSendEmailHook(request, {
		config: {
			hookSecret: SEND_EMAIL_HOOK_SECRET,
			keys: { epsilon: RESEND_KEY_EPSILON, labelkit: RESEND_KEY_LABELKIT },
			epsilonOrgId: AUTH_EMAIL_EPSILON_ORG_ID,
			supabaseUrl: PUBLIC_SUPABASE_URL,
			// Supabase Auth's Site URL. Invites link there, as the hosted template's `{{ .SiteURL }}`
			// did, whichever host the hook's URL names.
			siteUrl: AUTH_SITE_URL,
			credentialsKey: AUDIOKIT_CREDENTIALS_KEY
		},
		memberOrgIds: (userId) =>
			locals.db(async (tx) => {
				const rows = (await tx.execute(
					sql`select unnest(app_auth_email.member_org_ids(${userId}::uuid))::text as id`
				)) as { id: string }[];
				return rows.map((r) => r.id);
			}),
		orgBrand: (lookup: BrandLookup) =>
			locals.db(async (tx): Promise<OrgBrand | null> => {
				const rows = (await tx.execute(
					'orgId' in lookup
						? sql`select * from app_auth_email.org_brand_by_id(${lookup.orgId}::uuid)`
						: sql`select * from app_auth_email.org_brand_by_host(${lookup.host})`
				)) as BrandRow[];
				const row = rows[0];
				return row
					? {
							orgId: row.org_id,
							name: row.name,
							displayName: row.display_name,
							senderDomain: row.sender_domain,
							senderKeySealed: row.sender_key_sealed
						}
					: null;
			}),
		brandingEnabled: (orgId) => featureFor(flagSource(), orgId, 'brandedAuthEmail'),
		fetcher: globalThis.fetch
	});
