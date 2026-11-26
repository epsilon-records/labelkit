import { sql } from 'drizzle-orm';
import type { Database } from '../audit';

/** The role every app query runs as. It has no login and cannot bypass RLS. */
export const APP_ROLE = 'labelkit_app';

export type Scoped = <T>(fn: (tx: Database) => Promise<T>) => Promise<T>;

export type AsUserOptions = {
	/**
	 * Pin the transaction to one label (knowledge labelkit 0051): sets the transaction-local
	 * `app.pinned_org`. Nothing reads it yet; the RLS functions start to honour it in the next step of
	 * the label-session work (epsilon-records/labelkit#258), so until then a pin changes no result.
	 */
	pinOrgId?: string;
};

const PIN_FORMAT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Run `fn` in one transaction as `labelkit_app` on behalf of `userId`.
 *
 * Both settings are transaction-local, so they end with the transaction and never
 * leak to the next request on a pooled connection. RLS policies read the user id
 * through app.current_user_id(), the same way they do for Supabase's own API.
 */
export function asUser<T>(
	db: Database,
	userId: string,
	fn: (tx: Database) => Promise<T>,
	options: AsUserOptions = {}
) {
	const { pinOrgId } = options;
	if (pinOrgId !== undefined && !PIN_FORMAT.test(pinOrgId)) {
		throw new Error('pinOrgId must be a UUID');
	}
	return db.transaction(async (tx) => {
		await tx.execute(
			sql`select set_config('role', ${APP_ROLE}, true), set_config('request.jwt.claim.sub', ${userId}, true)`
		);
		if (pinOrgId !== undefined) {
			await tx.execute(sql`select set_config('app.pinned_org', ${pinOrgId.toLowerCase()}, true)`);
		}
		return fn(tx);
	});
}

/** A request-bound runner: every call is its own transaction as this user. */
export function scopedTo(db: Database, userId: string, options: AsUserOptions = {}): Scoped {
	return (fn) => asUser(db, userId, fn, options);
}

/**
 * The Send Email auth hook's role (EPSILON-147, migration 0025): EXECUTE on
 * app_auth_email.member_org_ids() and nothing else. No JWT identity is set. Called only inside a
 * transaction owned by client.ts, after the route has verified the hook's signature.
 */
export const AUTH_EMAIL_ROLE = 'labelkit_auth_email';
export async function setAuthEmailRole(tx: Database) {
	await tx.execute(
		sql`select set_config('role', ${AUTH_EMAIL_ROLE}, true), set_config('statement_timeout', '1000ms', true)`
	);
}

export type MetricsRole = 'labelkit_metrics_ingest' | 'labelkit_metrics_prune';
/** Called only inside a reserved transaction owned by client.ts. No JWT identity is set. */
export async function setMetricsRole(tx: Database, role: MetricsRole) {
	await tx.execute(
		sql`select set_config('role', ${role}, true), set_config('lock_timeout', '100ms', true), set_config('statement_timeout', '250ms', true)`
	);
}
