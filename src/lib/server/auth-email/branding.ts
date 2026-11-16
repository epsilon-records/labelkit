import {
	CredentialSealError,
	openWithAad,
	parseKeyRing,
	sealWithAad,
	type KeyRing
} from '../audiokit-credentials';
import { SENDERS, type Sender } from './sender';

/**
 * Auth email branded per label (EPSILON-146, knowledge labelkit 0034/0035). Behind the per-org flag
 * `labelkit-branded-auth-email` (features.ts); with it off, hook.ts keeps the EPSILON-147 rules.
 *
 * - **Which label.** An invite: the inviting org (`invited_org_id`, trusted for invites only, as in
 *   sender.ts). Anything else: the org whose active custom domain is the host of the email's
 *   `redirect_to`, which is where the person asked to sign in (the login and signup pages set it to
 *   their own origin). Supabase only keeps a `redirect_to` on its allow list and otherwise puts the
 *   Site URL there, so the host is always one LabelKit serves. Nothing else, and never the person's
 *   memberships, so someone in several labels gets the mail of the label whose site they used.
 * - **Name.** `orgs.display_name`, else `orgs.name`, else "LabelKit". Used as the From name, in the
 *   subject and in the body.
 * - **Sender.** The label's own domain from `org_auth_senders` when it has one, with its own sealed
 *   Resend key; otherwise `no-reply@auth.labelkit.co` with the LabelKit key, under the label's name.
 */

/** One org's branding as the hook's lookup functions return it (migration 0033). */
export type OrgBrand = {
	orgId: string;
	name: string | null;
	displayName: string | null;
	senderDomain: string | null;
	senderKeySealed: string | null;
};

/** Where to look the org up: by the inviting org's id, or by the host the email links to. */
export type BrandLookup = { orgId: string } | { host: string };

const FALLBACK_NAME = 'LabelKit';

/** Strips what must not reach a header or subject (control characters), trims, caps the length. */
function clean(s: string | null | undefined): string {
	const out = Array.from(s ?? '', (c) => {
		const code = c.charCodeAt(0);
		return code < 0x20 || code === 0x7f ? ' ' : c;
	});
	return out.join('').replace(/ {2,}/g, ' ').trim().slice(0, 60);
}

export function labelName(brand: Pick<OrgBrand, 'name' | 'displayName'> | null): string {
	return clean(brand?.displayName) || clean(brand?.name) || FALLBACK_NAME;
}

/**
 * A From header with `name` as the display name. Always quoted (RFC 5322 quoted-string), so commas,
 * angle brackets or "@" in a label's name cannot add a second address.
 */
export function fromHeader(name: string, domain: string): string {
	const quoted = clean(name).replaceAll('\\', '\\\\').replaceAll('"', '\\"');
	return `"${quoted}" <no-reply@${domain}>`;
}

/** The host of an email's `redirect_to`, lowercase; null when there is none or it is not https. */
export function redirectHost(redirectTo: string): string | null {
	if (!redirectTo) return null;
	try {
		const url = new URL(redirectTo);
		return url.protocol === 'https:' && url.hostname ? url.hostname.toLowerCase() : null;
	} catch {
		return null;
	}
}

const senderKeyAad = (orgId: string, domain: string) =>
	Buffer.from(`labelkit:auth-sender:${orgId}:${domain}:resend_key`);

/** Seals a label's Resend key for `org_auth_senders` (for the settings page and tests). */
export function sealSenderKey(ring: KeyRing, orgId: string, domain: string, key: string): string {
	return sealWithAad(ring, key, senderKeyAad(orgId, domain));
}

export type BrandedSender = {
	sender: Sender;
	/** The Resend key to send with; undefined when the LabelKit key is not configured. */
	key: string | undefined;
	/**
	 * Set when the label has its own domain but its key could not be used, so the email falls back
	 * to auth.labelkit.co. Logged; the email still goes out under the label's name.
	 */
	fallbackReason?: string;
};

/**
 * The sender for a label. Its own domain needs its sealed key to open under the key ring; if it
 * does not (ring unset or rotated away, value copied from another row), the label falls back to the
 * LabelKit sender rather than failing the sign-in: it is still the label's name, from the domain every
 * label without its own uses.
 */
export function brandedSender(
	brand: OrgBrand,
	opts: { labelkitKey: string | undefined; credentialsKey: string | undefined }
): BrandedSender {
	const name = labelName(brand);
	const labelkit: BrandedSender = {
		sender: {
			id: 'labelkit',
			domain: SENDERS.labelkit.domain,
			from: fromHeader(name, SENDERS.labelkit.domain),
			product: name,
			branded: true
		},
		key: opts.labelkitKey
	};
	if (!brand.senderDomain || !brand.senderKeySealed) return labelkit;
	let key: string;
	try {
		key = openWithAad(
			parseKeyRing(opts.credentialsKey),
			brand.senderKeySealed,
			senderKeyAad(brand.orgId, brand.senderDomain)
		);
	} catch (e) {
		const reason = e instanceof CredentialSealError ? e.message : 'unknown';
		return { ...labelkit, fallbackReason: reason };
	}
	return {
		sender: {
			id: 'org',
			domain: brand.senderDomain,
			from: fromHeader(name, brand.senderDomain),
			product: name,
			branded: true
		},
		key
	};
}
