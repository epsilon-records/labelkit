/**
 * Row-level-security behaviour, as data.
 *
 * Why this exists: RLS was the one security-relevant layer in ERMS with no behavioural test
 * anywhere. The suite ran migrations on PostgreSQL 17 in CI and asserted role/policy *counts*,
 * which proves the DDL executed — not that a cross-org read is denied, that a session-less request
 * fails closed, or that a request shaped like Supabase's own API (a role that holds SELECT on the
 * tables but matches no policy) sees nothing.
 *
 * Each case opens a transaction, assumes a role, sets the claim the app sets, runs one probe, and
 * rolls back. The assumption mechanism is deliberately the app's own — `set_config('role', …)` plus
 * `set_config('request.jwt.claim.sub', …)` from `src/lib/server/db/scoped.ts` — so a change to how
 * the app scopes a request moves these results or breaks them.
 *
 * A case may also carry `pin` (the value of app.pinned_org for the transaction; undefined leaves it
 * unset), `setup` (statements run as the case's role before the probe) and `probeAsOwner` (switch to
 * the owner connection's role after `setup`, to read what the role itself cannot see).
 *
 * Cases are flagged with what the engine must provide, and hosts skip what they cannot honour:
 *  - `requiresSupabaseRoles` — needs Supabase's own `anon`/`authenticated`/`service_role`. These
 *    are NOT created here on purpose: an earlier revision of this file fabricated them and granted
 *    `SELECT` only, while a real Supabase grants `anon`/`authenticated` INSERT, UPDATE, DELETE,
 *    REFERENCES, TRIGGER and TRUNCATE on every migrated table. A simulation that hands out fewer
 *    privileges than production can pass a test production would fail, which is the opposite of
 *    what a security fixture is for. Both hosts run on the Supabase stack, which has the real roles
 *    and real grants; scripts/rls-behavior.mjs pointed at plain Postgres skips these cases rather
 *    than imitating them.
 *  - `requiresBypassRls` — needs an engine that honours BYPASSRLS (in-process engines do not).
 *
 * Consumed twice, both on the local Supabase stack:
 *  - src/lib/server/rls-behavior.test.ts  (vitest, `pnpm test`, in a fresh copy of the migrated template)
 *  - scripts/rls-behavior.mjs             (the stack's own database, the one PostgREST serves)
 */

export const IDS = {
	orgA: 'a0000000-0000-4000-8000-00000000000a',
	orgB: 'b0000000-0000-4000-8000-00000000000b',
	labelA: 'c0000000-0000-4000-8000-00000000000c',
	labelB: 'd0000000-0000-4000-8000-00000000000d',
	// Written by probes that must clean up after themselves (each case rolls back anyway).
	sneakLabel: 'e0000000-0000-4000-8000-00000000000e',
	freshLabel: 'f0000000-0000-4000-8000-00000000000f',
	// u1 owns org A only. u2 owns org B. u3 has no membership anywhere.
	u1: '11111111-1111-4111-8111-111111111111',
	u2: '22222222-2222-4222-8222-222222222222',
	u3: '33333333-3333-4333-8333-333333333333',
	// Member management (EPSILON-87): u4 is a viewer in A, u5 is invited by the probes, and u6 is
	// B's second owner — so B has two owners while A's only owner is u1.
	u4: '44444444-4444-4444-8444-444444444444',
	u5: '55555555-5555-4555-8555-555555555555',
	u6: '66666666-6666-4666-8666-666666666666',
	// Label sessions (knowledge labelkit 0051): u7 is a catalog manager in BOTH orgs, so a pin to one
	// label has something real to hide. pinOther is an org id nobody belongs to.
	u7: '77777777-7777-4777-8777-777777777777',
	pinOther: '99999999-0000-4000-8000-000000000099'
};

export const SEED_SQL = [
	`INSERT INTO orgs (id, name, slug) VALUES
		('${IDS.orgA}', 'Alpha Records', 'alpha'),
		('${IDS.orgB}', 'Beta Records', 'beta')`,
	`INSERT INTO memberships (org_id, user_id, role) VALUES
		('${IDS.orgA}', '${IDS.u1}', 'owner'),
		('${IDS.orgA}', '${IDS.u4}', 'viewer'),
		('${IDS.orgB}', '${IDS.u2}', 'owner'),
		('${IDS.orgB}', '${IDS.u6}', 'owner'),
		('${IDS.orgA}', '${IDS.u7}', 'catalog_manager'),
		('${IDS.orgB}', '${IDS.u7}', 'catalog_manager')`,
	`INSERT INTO labels (id, org_id, name) VALUES
		('${IDS.labelA}', '${IDS.orgA}', 'Alpha Sound'),
		('${IDS.labelB}', '${IDS.orgB}', 'Beta Sound')`
];

export const TEARDOWN_SQL = [
	`DELETE FROM labels WHERE id IN ('${IDS.labelA}', '${IDS.labelB}', '${IDS.sneakLabel}', '${IDS.freshLabel}')`,
	// Deleting the orgs cascades to their memberships. Deleting a sole owner's membership on its own
	// is refused by the last-owner rule (0017_members_manage.sql), so the orgs go first.
	`DELETE FROM orgs WHERE id IN ('${IDS.orgA}', '${IDS.orgB}')`,
	`DELETE FROM memberships WHERE user_id IN ('${IDS.u1}', '${IDS.u2}', '${IDS.u3}', '${IDS.u4}', '${IDS.u5}', '${IDS.u6}', '${IDS.u7}')`
];

/**
 * `role` + `claim: null` means no session at all. `expect` is a scalar, or `'error'` for a probe
 * that must be refused (`errorCode` is the SQLSTATE Postgres has to raise, so a policy that
 * silently filters is not confused with one that blocks a write). `errorMatch`, when set, is a
 * pattern the refusal's message must match as well, for cases where a refusal for another reason
 * (say, row-level security instead of the last-owner rule) would be a false pass.
 */
/**
 * @type {{
 *   name: string; role: string; claim: string | null; probe: string; expect: string;
 *   errorCode?: string; errorMatch?: string; requiresSupabaseRoles?: boolean;
 *   requiresBypassRls?: boolean; pin?: string; setup?: string[]; probeAsOwner?: boolean;
 * }[]}
 */
export const RLS_CASES = [
	{
		name: 'a member reads their own org',
		role: 'labelkit_app',
		claim: IDS.u1,
		probe: `SELECT count(*) FROM labels WHERE org_id = '${IDS.orgA}'`,
		expect: '1'
	},
	{
		name: 'a member cannot read another org, even by explicit id',
		role: 'labelkit_app',
		claim: IDS.u1,
		probe: `SELECT count(*) FROM labels WHERE org_id = '${IDS.orgB}'`,
		expect: '0'
	},
	{
		name: 'an unfiltered read returns only the caller org across all labels',
		role: 'labelkit_app',
		claim: IDS.u1,
		probe: 'SELECT count(*) FROM labels',
		expect: '1'
	},
	{
		name: 'the orgs table is member-scoped too',
		role: 'labelkit_app',
		claim: IDS.u1,
		probe: 'SELECT count(*) FROM orgs',
		expect: '1'
	},
	{
		name: 'UPDATE across orgs affects no rows',
		role: 'labelkit_app',
		claim: IDS.u1,
		probe: `WITH upd AS (
			UPDATE labels SET name = 'hijacked' WHERE org_id = '${IDS.orgB}' RETURNING 1
		) SELECT count(*) FROM upd`,
		expect: '0'
	},
	{
		name: 'DELETE across orgs affects no rows',
		role: 'labelkit_app',
		claim: IDS.u1,
		probe: `WITH del AS (
			DELETE FROM labels WHERE org_id = '${IDS.orgB}' RETURNING 1
		) SELECT count(*) FROM del`,
		expect: '0'
	},
	{
		name: 'INSERT into another org is refused, not filtered',
		role: 'labelkit_app',
		claim: IDS.u1,
		probe: `INSERT INTO labels (id, org_id, name)
			VALUES ('${IDS.sneakLabel}', '${IDS.orgB}', 'sneaked in')`,
		expect: 'error',
		errorCode: '42501' // new row violates row-level security policy
	},
	{
		name: 'INSERT into the caller own org is allowed for an owner',
		role: 'labelkit_app',
		claim: IDS.u1,
		// The id is supplied because labels.id is generated by the app (uuidv7), not by the
		// database — a probe that omitted it would fail on the constraint, not on the policy.
		probe: `WITH ins AS (
			INSERT INTO labels (id, org_id, name)
			VALUES ('${IDS.freshLabel}', '${IDS.orgA}', 'Fresh Alpha') RETURNING 1
		) SELECT count(*) FROM ins`,
		expect: '1'
	},
	{
		name: 'no session claim means no rows at all (fail closed)',
		role: 'labelkit_app',
		claim: null,
		probe: 'SELECT count(*) FROM labels',
		expect: '0'
	},
	{
		name: 'a user with no membership reads nothing',
		role: 'labelkit_app',
		claim: IDS.u3,
		probe: 'SELECT count(*) FROM labels',
		expect: '0'
	},
	{
		name: 'the claim is not the org: a member of A cannot pass B id as sub',
		role: 'labelkit_app',
		claim: IDS.u2,
		probe: `SELECT count(*) FROM labels WHERE id = '${IDS.labelA}'`,
		expect: '0'
	},
	// Member management (EPSILON-87, decision 0020). Invites are INSERTs into memberships, role
	// changes UPDATE its role column, removals DELETE. Only an org's owners may do any of it, only
	// in that org, and the org always keeps an owner.
	{
		name: 'members: an owner invites into their own org',
		role: 'labelkit_app',
		claim: IDS.u1,
		probe: `WITH ins AS (
			INSERT INTO memberships (org_id, user_id, role)
			VALUES ('${IDS.orgA}', '${IDS.u5}', 'catalog_manager') RETURNING 1
		) SELECT count(*) FROM ins`,
		expect: '1'
	},
	{
		name: 'members: a cross-org invite is refused, not filtered',
		role: 'labelkit_app',
		claim: IDS.u1,
		probe: `INSERT INTO memberships (org_id, user_id, role)
			VALUES ('${IDS.orgB}', '${IDS.u5}', 'viewer')`,
		expect: 'error',
		errorCode: '42501'
	},
	{
		name: 'members: an owner cannot place themselves in another org',
		role: 'labelkit_app',
		claim: IDS.u1,
		probe: `INSERT INTO memberships (org_id, user_id, role)
			VALUES ('${IDS.orgB}', '${IDS.u1}', 'owner')`,
		expect: 'error',
		errorCode: '42501'
	},
	{
		name: 'members: a non-owner cannot invite, even into their own org',
		role: 'labelkit_app',
		claim: IDS.u4,
		probe: `INSERT INTO memberships (org_id, user_id, role)
			VALUES ('${IDS.orgA}', '${IDS.u5}', 'viewer')`,
		expect: 'error',
		errorCode: '42501'
	},
	{
		name: 'members: the agent role cannot be handed to a person',
		role: 'labelkit_app',
		claim: IDS.u1,
		probe: `INSERT INTO memberships (org_id, user_id, role)
			VALUES ('${IDS.orgA}', '${IDS.u5}', 'agent')`,
		expect: 'error',
		errorCode: '42501'
	},
	{
		name: 'members: an owner changes a role in their own org',
		role: 'labelkit_app',
		claim: IDS.u1,
		probe: `WITH upd AS (
			UPDATE memberships SET role = 'rights_admin'
			WHERE org_id = '${IDS.orgA}' AND user_id = '${IDS.u4}' RETURNING 1
		) SELECT count(*) FROM upd`,
		expect: '1'
	},
	{
		name: 'members: an owner cannot change a role in another org',
		role: 'labelkit_app',
		claim: IDS.u1,
		probe: `WITH upd AS (
			UPDATE memberships SET role = 'viewer'
			WHERE org_id = '${IDS.orgB}' AND user_id = '${IDS.u6}' RETURNING 1
		) SELECT count(*) FROM upd`,
		expect: '0'
	},
	{
		name: 'members: a viewer cannot promote themselves',
		role: 'labelkit_app',
		claim: IDS.u4,
		probe: `WITH upd AS (
			UPDATE memberships SET role = 'owner'
			WHERE org_id = '${IDS.orgA}' AND user_id = '${IDS.u4}' RETURNING 1
		) SELECT count(*) FROM upd`,
		expect: '0'
	},
	{
		name: 'members: a membership cannot be moved to another org',
		role: 'labelkit_app',
		claim: IDS.u1,
		probe: `UPDATE memberships SET org_id = '${IDS.orgB}'
			WHERE org_id = '${IDS.orgA}' AND user_id = '${IDS.u4}'`,
		expect: 'error',
		errorCode: '42501', // permission denied: labelkit_app may update the role column only
		errorMatch: 'permission denied'
	},
	{
		name: 'members: an owner removes a member of their own org',
		role: 'labelkit_app',
		claim: IDS.u1,
		probe: `WITH del AS (
			DELETE FROM memberships
			WHERE org_id = '${IDS.orgA}' AND user_id = '${IDS.u4}' RETURNING 1
		) SELECT count(*) FROM del`,
		expect: '1'
	},
	{
		name: 'members: an owner cannot remove a member of another org',
		role: 'labelkit_app',
		claim: IDS.u1,
		probe: `WITH del AS (
			DELETE FROM memberships WHERE org_id = '${IDS.orgB}' RETURNING 1
		) SELECT count(*) FROM del`,
		expect: '0'
	},
	{
		name: 'members: the last owner cannot step down (owners elsewhere do not count)',
		role: 'labelkit_app',
		claim: IDS.u1,
		probe: `UPDATE memberships SET role = 'viewer'
			WHERE org_id = '${IDS.orgA}' AND user_id = '${IDS.u1}'`,
		expect: 'error',
		errorCode: '23514',
		errorMatch: 'at least one owner'
	},
	{
		name: 'members: the last owner cannot be removed',
		role: 'labelkit_app',
		claim: IDS.u1,
		probe: `DELETE FROM memberships WHERE org_id = '${IDS.orgA}' AND user_id = '${IDS.u1}'`,
		expect: 'error',
		errorCode: '23514',
		errorMatch: 'at least one owner'
	},
	{
		name: 'members: with a second owner in the org, an owner may step down',
		role: 'labelkit_app',
		claim: IDS.u2,
		probe: `WITH upd AS (
			UPDATE memberships SET role = 'viewer'
			WHERE org_id = '${IDS.orgB}' AND user_id = '${IDS.u2}' RETURNING 1
		) SELECT count(*) FROM upd`,
		expect: '1'
	},
	{
		name: 'members: removing every owner in one statement is refused',
		role: 'labelkit_app',
		claim: IDS.u2,
		probe: `DELETE FROM memberships WHERE org_id = '${IDS.orgB}' AND role = 'owner'`,
		expect: 'error',
		errorCode: '23514',
		errorMatch: 'at least one owner'
	},
	{
		name: 'members: bulk owner demotion is refused on the owner connection',
		role: 'postgres',
		claim: null,
		probe: `UPDATE memberships SET role = 'viewer' WHERE org_id = '${IDS.orgB}' AND role = 'owner'`,
		expect: 'error',
		errorCode: '23514',
		errorMatch: 'at least one owner'
	},
	{
		name: 'members: bulk owner demotion is refused under RLS',
		role: 'labelkit_app',
		claim: IDS.u2,
		probe: `UPDATE memberships SET role = 'viewer' WHERE org_id = '${IDS.orgB}' AND role = 'owner'`,
		expect: 'error',
		errorCode: '23514',
		errorMatch: 'at least one owner'
	},
	{
		name: 'members: the owner connection cannot move a sole owner to another org',
		role: 'postgres',
		claim: null,
		// Both orgs exist, and u1 has no destination membership: no FK or key collision.
		probe: `UPDATE memberships SET org_id = '${IDS.orgB}' WHERE org_id = '${IDS.orgA}' AND user_id = '${IDS.u1}'`,
		expect: 'error',
		errorCode: '23514',
		errorMatch: 'membership identity is immutable'
	},
	{
		name: 'members: the owner connection cannot change membership user identity',
		role: 'postgres',
		claim: null,
		probe: `UPDATE memberships SET user_id = '${IDS.u5}' WHERE org_id = '${IDS.orgA}' AND user_id = '${IDS.u4}'`,
		expect: 'error',
		errorCode: '23514',
		errorMatch: 'membership identity is immutable'
	},

	{
		name: 'members: the last-owner rule holds for the owner connection too',
		role: 'postgres',
		claim: null,
		probe: `DELETE FROM memberships WHERE org_id = '${IDS.orgA}' AND user_id = '${IDS.u1}'`,
		expect: 'error',
		errorCode: '23514',
		errorMatch: 'at least one owner'
	},
	{
		requiresSupabaseRoles: true,
		name: 'members: authenticated cannot write memberships (no PostgREST invite path)',
		role: 'authenticated',
		claim: IDS.u1,
		probe: `INSERT INTO memberships (org_id, user_id, role)
			VALUES ('${IDS.orgA}', '${IDS.u5}', 'viewer')`,
		expect: 'error',
		errorCode: '42501'
	},
	// The PostgREST-shaped surface (Supabase's own API, reached with the publishable key plus a
	// user JWT). The member-read policies carry no TO clause, so they apply to PUBLIC — which
	// means this path reads *within* the caller org, by design. What must not happen is a
	// cross-org read, or any write: every catalog write policy is addressed TO labelkit_app.
	{
		requiresSupabaseRoles: true,
		name: 'authenticated reads its own org through the public read policies',
		role: 'authenticated',
		claim: IDS.u1,
		probe: `SELECT count(*) FROM labels WHERE org_id = '${IDS.orgA}'`,
		expect: '1'
	},
	{
		requiresSupabaseRoles: true,
		name: 'authenticated cannot read another org',
		role: 'authenticated',
		claim: IDS.u1,
		probe: `SELECT count(*) FROM labels WHERE org_id = '${IDS.orgB}'`,
		expect: '0'
	},
	{
		requiresSupabaseRoles: true,
		name: 'authenticated with no claim reads nothing',
		role: 'authenticated',
		claim: null,
		probe: 'SELECT count(*) FROM labels',
		expect: '0'
	},
	{
		requiresSupabaseRoles: true,
		name: 'authenticated cannot write: catalog writes are addressed to labelkit_app only',
		role: 'authenticated',
		claim: IDS.u1,
		probe: `INSERT INTO labels (id, org_id, name)
			VALUES ('${IDS.sneakLabel}', '${IDS.orgA}', 'via postgrest')`,
		expect: 'error',
		// Either refusal is correct here: no INSERT policy (42501 row security) or no
		// privilege at all (also 42501, permission denied). Both mean the write cannot happen.
		errorCode: '42501'
	},
	{
		requiresSupabaseRoles: true,
		name: 'anon has the same public read policies but no identity, so it reads nothing',
		role: 'anon',
		claim: null,
		probe: 'SELECT count(*) FROM labels',
		expect: '0'
	},
	{
		requiresSupabaseRoles: true,
		name: 'anon cannot write either',
		role: 'anon',
		claim: null,
		probe: `INSERT INTO labels (id, org_id, name)
			VALUES ('${IDS.sneakLabel}', '${IDS.orgA}', 'via anon')`,
		expect: 'error',
		errorCode: '42501'
	},
	// Documented trust boundary, not an accident: service_role is the one role that bypasses RLS,
	// so it must have no login and never appear in a browser or a request path.
	{
		// Checked on the real server only: PGlite (any 0.5.x build) does not honour BYPASSRLS the
		// way Postgres on disk does, so this probe returns the RLS-filtered count there. Testing it
		// against CI's PostgreSQL 17 is the authoritative run; the vitest host skips it explicitly
		// rather than asserting a value that would encode an in-process quirk as the spec.
		requiresBypassRls: true,
		name: 'service_role is the sole BYPASSRLS role and sees both orgs',
		role: 'service_role',
		claim: null,
		probe: 'SELECT count(*) FROM labels',
		expect: '2'
	}
];

/**
 * The statement the app uses to assume a role and scope a request — the same two `set_config`
 * calls as `src/lib/server/db/scoped.ts`, transaction-local so nothing leaks to the next case.
 *
 * @param {string} role
 * @param {string | null} claim the subject the app would put in request.jwt.claim.sub, or null
 *   for a request with no session at all.
 * @param {string} [pin] the value of app.pinned_org, or undefined to leave it unset.
 */
export function assumeSql(role, claim, pin) {
	const sets = [`set_config('role', '${role}', true)`];
	// A label session pins the transaction to one org (scoped.ts `pinOrgId`). `undefined` sets
	// nothing at all, which is the setting never having existed; '' is the setting set and empty.
	if (pin !== undefined) sets.push(`set_config('app.pinned_org', '${pin}', true)`);
	if (claim === null) {
		sets.push(`set_config('request.jwt.claim.sub', '', true)`);
	} else {
		sets.push(`set_config('request.jwt.claim.sub', '${claim}', true)`);
	}
	return `SELECT ${sets.join(', ')}`;
}

// Anonymous metrics is a distinct execute-only role, never labelkit_app or a pretend user.
for (const role of [
	'anon',
	'authenticated',
	'labelkit_app',
	'labelkit_metrics_ingest',
	'labelkit_metrics_prune'
]) {
	for (const claim of [IDS.u1, IDS.u2]) {
		for (const probe of [
			'SELECT * FROM app_metrics.app_performance_daily',
			'INSERT INTO app_metrics.app_performance_daily VALUES (current_date,1,1,1,1)'
		])
			RLS_CASES.push({
				name: `${role}/${claim === IDS.u1 ? 'owner A' : 'owner B'} cannot access metrics table: ${probe.split(' ')[0]}`,
				role,
				claim,
				probe,
				expect: 'error',
				errorCode: '42501'
			});
		if (!role.startsWith('labelkit_metrics_'))
			RLS_CASES.push({
				name: `${role} cannot execute metrics as tenant owner`,
				role,
				claim,
				probe: 'SELECT app_metrics.record(1::smallint,1::smallint,1::smallint)',
				expect: 'error',
				errorCode: '42501'
			});
	}
}
for (const role of ['labelkit_metrics_ingest', 'labelkit_metrics_prune']) {
	RLS_CASES.push({
		requiresSupabaseRoles: true,
		name: `${role} has no catalogue rights`,
		role,
		claim: null,
		probe: 'SELECT * FROM public.labels',
		expect: 'error',
		errorCode: '42501'
	});
	RLS_CASES.push({
		requiresSupabaseRoles: true,
		name: `${role} cannot execute the other machine capability`,
		role,
		claim: null,
		probe:
			role === 'labelkit_metrics_ingest'
				? 'SELECT app_metrics.prune()'
				: 'SELECT app_metrics.record(1::smallint,1::smallint,1::smallint)',
		expect: 'error',
		errorCode: '42501'
	});
}

// The Send Email hook's lookup (migration 0025, EPSILON-147): only labelkit_auth_email may call it, and
// that role can read nothing else. A signed-in user must not learn another account's labels.
for (const role of ['anon', 'authenticated', 'labelkit_app']) {
	RLS_CASES.push({
		requiresSupabaseRoles: role !== 'labelkit_app',
		name: `${role} cannot call the auth email org lookup`,
		role,
		claim: role === 'anon' ? null : IDS.u1,
		probe: `SELECT app_auth_email.member_org_ids('${IDS.u2}')`,
		expect: 'error',
		errorCode: '42501'
	});
}
RLS_CASES.push({
	requiresSupabaseRoles: false,
	name: 'labelkit_auth_email reads one account’s org ids through the lookup',
	role: 'labelkit_auth_email',
	claim: null,
	probe: `SELECT array_to_string(app_auth_email.member_org_ids('${IDS.u1}'), ',')`,
	expect: IDS.orgA
});
for (const probe of [
	'SELECT count(*) FROM public.memberships',
	'SELECT count(*) FROM public.labels'
]) {
	RLS_CASES.push({
		requiresSupabaseRoles: false,
		name: `labelkit_auth_email has no table rights: ${probe}`,
		role: 'labelkit_auth_email',
		claim: null,
		probe,
		expect: 'error',
		errorCode: '42501'
	});
}

// webhook_events is written only by the AudioKit webhook route on the owner connection. It once
// shipped without RLS while anon and authenticated held every privilege on it. RLS does not
// govern TRUNCATE, so the migration revokes the grants too; these cases pin both.
const WEBHOOK_EVENT_ID = '99999999-9999-4999-8999-999999999999';
for (const role of ['anon', 'authenticated']) {
	const claim = role === 'anon' ? null : IDS.u1;
	for (const [what, probe] of [
		['read', 'SELECT count(*) FROM public.webhook_events'],
		[
			'insert',
			`INSERT INTO public.webhook_events (event_id, event_type, job_id)
				VALUES ('${WEBHOOK_EVENT_ID}', 'job.succeeded', '${WEBHOOK_EVENT_ID}')`
		],
		['update', "UPDATE public.webhook_events SET event_type = 'x'"],
		['delete', 'DELETE FROM public.webhook_events'],
		['truncate', 'TRUNCATE public.webhook_events']
	]) {
		RLS_CASES.push({
			requiresSupabaseRoles: true,
			name: `${role} cannot ${what} webhook_events`,
			role,
			claim,
			probe,
			expect: 'error',
			errorCode: '42501'
		});
	}
}
RLS_CASES.push({
	name: 'webhook_events has row-level security enabled',
	role: 'postgres',
	claim: null,
	probe: "SELECT relrowsecurity::text FROM pg_class WHERE oid = 'public.webhook_events'::regclass",
	expect: 'true'
});

// audiokit_label_clients holds each label's sealed AudioKit key and webhook secret (EPSILON-102).
// Only the AudioKit routes read it, on the owner connection. No member of any label, owner or not,
// and no Data API role may read or change it, and RLS does not govern TRUNCATE, so the migration
// revokes the grants as well; these cases pin both.
const LABEL_CLIENT_ID = '88888888-8888-4888-8888-888888888888';
for (const [role, claim] of /** @type {[string, string | null][]} */ ([
	['anon', null],
	['authenticated', IDS.u1],
	['labelkit_app', IDS.u1],
	['labelkit_app', IDS.u4]
])) {
	for (const [what, probe] of [
		['read', 'SELECT count(*) FROM public.audiokit_label_clients'],
		[
			'insert',
			`INSERT INTO public.audiokit_label_clients (org_id, client_id, api_key_sealed, webhook_secret_sealed, status, sync_state)
				VALUES ('${IDS.orgA}', '${LABEL_CLIENT_ID}', 'x', 'x', 'active', 'synced')`
		],
		['update', "UPDATE public.audiokit_label_clients SET sync_state = 'x'"],
		['delete', 'DELETE FROM public.audiokit_label_clients'],
		['truncate', 'TRUNCATE public.audiokit_label_clients']
	]) {
		RLS_CASES.push({
			requiresSupabaseRoles: role === 'anon' || role === 'authenticated',
			name: `${role} (${claim ?? 'no session'}) cannot ${what} audiokit_label_clients`,
			role,
			claim,
			probe,
			expect: 'error',
			errorCode: '42501'
		});
	}
}
RLS_CASES.push({
	name: 'audiokit_label_clients has row-level security enabled',
	role: 'postgres',
	claim: null,
	probe:
		"SELECT relrowsecurity::text FROM pg_class WHERE oid = 'public.audiokit_label_clients'::regclass",
	expect: 'true'
});

// org_auth_senders holds a label's own sign-in sender domain and its sealed Resend key (EPSILON-146,
// migration 0033). The Send Email hook reads it only through the app_auth_email.org_brand_by_*
// functions. No member, no Data API role and not the hook's own role may touch the table itself.
for (const [role, claim] of /** @type {[string, string | null][]} */ ([
	['anon', null],
	['authenticated', IDS.u1],
	['labelkit_app', IDS.u1],
	['labelkit_app', IDS.u4],
	['labelkit_auth_email', null]
])) {
	for (const [what, probe] of [
		['read', 'SELECT count(*) FROM public.org_auth_senders'],
		[
			'insert',
			`INSERT INTO public.org_auth_senders (org_id, domain, resend_key_sealed)
				VALUES ('${IDS.orgA}', 'auth.example.test', 'x')`
		],
		['update', "UPDATE public.org_auth_senders SET resend_key_sealed = 'x'"],
		['delete', 'DELETE FROM public.org_auth_senders'],
		['truncate', 'TRUNCATE public.org_auth_senders']
	]) {
		RLS_CASES.push({
			requiresSupabaseRoles: role === 'anon' || role === 'authenticated',
			name: `${role} (${claim ?? 'no session'}) cannot ${what} org_auth_senders`,
			role,
			claim,
			probe,
			expect: 'error',
			errorCode: '42501'
		});
	}
}
RLS_CASES.push({
	name: 'org_auth_senders has row-level security enabled',
	role: 'postgres',
	claim: null,
	probe:
		"SELECT relrowsecurity::text FROM pg_class WHERE oid = 'public.org_auth_senders'::regclass",
	expect: 'true'
});

// label_sessions and label_handoffs back a person's session on a label's own domain (migration 0039,
// knowledge labelkit 0051). Only label-session.ts reads or writes them, on the owner connection:
// no member, no Data API role and not the Send Email hook's role may touch either table.
for (const table of ['label_sessions', 'label_handoffs']) {
	for (const [role, claim] of /** @type {[string, string | null][]} */ ([
		['anon', null],
		['authenticated', IDS.u1],
		['labelkit_app', IDS.u1],
		['labelkit_app', IDS.u4],
		['labelkit_auth_email', null]
	])) {
		for (const [what, probe] of [
			['read', `SELECT count(*) FROM public.${table}`],
			[
				'insert',
				table === 'label_sessions'
					? `INSERT INTO public.label_sessions (id_hash, user_id, org_id, host, expires_at)
						VALUES (repeat('a', 64), '${IDS.u1}', '${IDS.orgA}', 'a.example.test', now())`
					: `INSERT INTO public.label_handoffs (ticket_hash, user_id, org_id, host, expires_at)
						VALUES (repeat('a', 64), '${IDS.u1}', '${IDS.orgA}', 'a.example.test', now())`
			],
			['update', `UPDATE public.${table} SET host = 'b.example.test'`],
			['delete', `DELETE FROM public.${table}`],
			['truncate', `TRUNCATE public.${table}`]
		]) {
			RLS_CASES.push({
				requiresSupabaseRoles: role === 'anon' || role === 'authenticated',
				name: `${role} (${claim ?? 'no session'}) cannot ${what} ${table}`,
				role,
				claim,
				probe,
				expect: 'error',
				errorCode: '42501'
			});
		}
	}
	RLS_CASES.push({
		name: `${table} has row-level security enabled`,
		role: 'postgres',
		claim: null,
		probe: `SELECT relrowsecurity::text FROM pg_class WHERE oid = 'public.${table}'::regclass`,
		expect: 'true'
	});
}

// Label sessions, step 2 (knowledge labelkit 0051, labelkit#258): a transaction pinned to one label
// sees that label only. app.is_member and app.has_role are false for every other org while
// app.pinned_org is set; an unset or EMPTY pin changes nothing. u7 belongs to both orgs.
const BOTH = ['owner', 'catalog_manager', 'rights_admin', 'viewer', 'agent'];
const allRoles = `ARRAY[${BOTH.map((r) => `'${r}'`).join(',')}]`;
/** @type {[string, string | undefined][]} */
const NOT_PINNED = [
	['no pin', undefined],
	['an empty pin', '']
];
for (const [what, pin] of NOT_PINNED) {
	for (const [name, probe, expect] of [
		["sees both orgs' labels", 'SELECT count(*) FROM labels', '2'],
		['sees both orgs', 'SELECT count(*) FROM orgs', '2'],
		['sees every membership of both orgs', 'SELECT count(*) FROM memberships', '6'],
		['is a member of A', `SELECT app.is_member('${IDS.orgA}')::text`, 'true'],
		['is a member of B', `SELECT app.is_member('${IDS.orgB}')::text`, 'true'],
		['holds a role in B', `SELECT app.has_role('${IDS.orgB}', ${allRoles})::text`, 'true'],
		['has no pin', "SELECT coalesce(app.pinned_org()::text, 'unset')", 'unset']
	]) {
		RLS_CASES.push({
			name: `pin: with ${what}, a member of two labels ${name} (behaviour unchanged)`,
			role: 'labelkit_app',
			claim: IDS.u7,
			pin,
			probe,
			expect
		});
	}
	RLS_CASES.push({
		name: `pin: with ${what}, a member may still write to either label (behaviour unchanged)`,
		role: 'labelkit_app',
		claim: IDS.u7,
		pin,
		probe: `WITH ins AS (
			INSERT INTO labels (id, org_id, name)
			VALUES ('${IDS.sneakLabel}', '${IDS.orgB}', 'second label') RETURNING 1
		) SELECT count(*) FROM ins`,
		expect: '1'
	});
}

for (const [pinned, other, otherName] of /** @type {const} */ ([
	[IDS.orgA, IDS.orgB, 'B'],
	[IDS.orgB, IDS.orgA, 'A']
])) {
	const mine = otherName === 'B' ? 'A' : 'B';
	/**
	 * @param {string} name
	 * @param {string} probe
	 * @param {string} expect
	 * @param {{ errorCode?: string; errorMatch?: string; setup?: string[]; probeAsOwner?: boolean }} [extra]
	 */
	const at = (name, probe, expect, extra = {}) =>
		RLS_CASES.push({
			name: `pin to ${mine}: ${name}`,
			role: 'labelkit_app',
			claim: IDS.u7,
			pin: pinned,
			probe,
			expect,
			...extra
		});
	at('app.pinned_org reads the pin', 'SELECT app.pinned_org()::text', pinned);
	at(`is_member is false for ${otherName}`, `SELECT app.is_member('${other}')::text`, 'false');
	at(`is_member stays true for ${mine}`, `SELECT app.is_member('${pinned}')::text`, 'true');
	at(
		`has_role is false for every role in ${otherName}`,
		`SELECT app.has_role('${other}', ${allRoles})::text`,
		'false'
	);
	for (const role of BOTH) {
		at(
			`has_role(${role}) is false in ${otherName}`,
			`SELECT app.has_role('${other}', ARRAY['${role}'])::text`,
			'false'
		);
	}
	at(
		`has_role stays true for the role held in ${mine}`,
		`SELECT app.has_role('${pinned}', ARRAY['catalog_manager'])::text`,
		'true'
	);
	at(`reads only ${mine}'s labels`, 'SELECT count(*) FROM labels', '1');
	at(
		`cannot read ${otherName}'s labels even by explicit org id`,
		`SELECT count(*) FROM labels WHERE org_id = '${other}'`,
		'0'
	);
	at(`reads only ${mine} in orgs`, 'SELECT count(*) FROM orgs', '1');
	// A has u1, u4 and u7; B has u2, u6 and u7. Unpinned, u7 reads all six.
	at(`reads only ${mine}'s memberships`, 'SELECT count(*) FROM memberships', '3');
	at(
		`cannot insert into ${otherName}, though a catalog manager there`,
		`INSERT INTO labels (id, org_id, name) VALUES ('${IDS.sneakLabel}', '${other}', 'sneaked in')`,
		'error',
		{ errorCode: '42501' }
	);
	at(
		`cannot update ${otherName}'s labels`,
		`WITH upd AS (UPDATE labels SET name = 'hijacked' WHERE org_id = '${other}' RETURNING 1)
			SELECT count(*) FROM upd`,
		'0'
	);
	at(
		`cannot delete ${otherName}'s labels`,
		`WITH del AS (DELETE FROM labels WHERE org_id = '${other}' RETURNING 1) SELECT count(*) FROM del`,
		'0'
	);
	at(
		`may still insert into ${mine}`,
		`WITH ins AS (
			INSERT INTO labels (id, org_id, name) VALUES ('${IDS.freshLabel}', '${pinned}', 'in the pinned label')
			RETURNING 1
		) SELECT count(*) FROM ins`,
		'1'
	);
	at(
		`app.authorize refuses ${otherName} as a non-member`,
		`SELECT app.authorize('${other}', '${IDS.freshLabel}', 'analysis')`,
		'error',
		{ errorCode: '42501', errorMatch: 'not allowed to request processing' }
	);
	at(
		`app.authorize still passes the role check for ${mine}`,
		`SELECT app.authorize('${pinned}', '${IDS.freshLabel}', 'analysis')`,
		'error',
		{ errorCode: 'P0002', errorMatch: 'recording not found' }
	);
	at(
		`app.complete_onboarding does not stamp ${otherName}'s membership`,
		`SELECT count(*) FROM memberships WHERE org_id = '${other}' AND onboarded_at IS NOT NULL`,
		'0',
		{ setup: [`SELECT app.complete_onboarding('${other}')`], probeAsOwner: true }
	);
	at(
		`app.complete_onboarding still stamps ${mine}'s membership`,
		`SELECT count(*) FROM memberships WHERE org_id = '${pinned}' AND onboarded_at IS NOT NULL`,
		'1',
		{ setup: [`SELECT app.complete_onboarding('${pinned}')`] }
	);
}

// A pin names one label. It never widens access: not for a non-member, not for an unrelated org.
RLS_CASES.push(
	{
		name: 'pin: a non-member pinned to A still reads nothing',
		role: 'labelkit_app',
		claim: IDS.u3,
		pin: IDS.orgA,
		probe: `SELECT app.is_member('${IDS.orgA}')::text`,
		expect: 'false'
	},
	{
		name: 'pin: a member of A only, pinned to B, reads nothing',
		role: 'labelkit_app',
		claim: IDS.u1,
		pin: IDS.orgB,
		probe: 'SELECT count(*) FROM labels',
		expect: '0'
	},
	{
		name: 'pin: a pin to an org nobody belongs to hides both labels from a two-label member',
		role: 'labelkit_app',
		claim: IDS.u7,
		pin: IDS.pinOther,
		probe: 'SELECT count(*) FROM labels',
		expect: '0'
	},
	{
		name: 'pin: an upper-case pin is the same org',
		role: 'labelkit_app',
		claim: IDS.u7,
		pin: IDS.orgA.toUpperCase(),
		probe: `SELECT app.is_member('${IDS.orgB}')::text`,
		expect: 'false'
	},
	{
		name: 'pin: no session claim and a pin still reads nothing (fail closed)',
		role: 'labelkit_app',
		claim: null,
		pin: IDS.orgA,
		probe: 'SELECT count(*) FROM labels',
		expect: '0'
	}
);

// The audit of every place that reads `memberships` directly (labelkit#258, step 2). Only the
// functions below do; no policy does. A new one fails here until it is read, and either made to honour
// app.pinned_org or listed with the reason it need not.
RLS_CASES.push(
	{
		name: 'audit: no policy reads memberships directly',
		role: 'postgres',
		claim: null,
		probe: `SELECT count(*) FROM pg_policies
			WHERE qual ILIKE '%memberships%' OR with_check ILIKE '%memberships%'`,
		expect: '0'
	},
	{
		name: 'audit: every policy on a public table reaches orgs only through is_member, has_role or can_catalog_create',
		role: 'postgres',
		claim: null,
		probe: `SELECT count(*) FROM pg_policies
			WHERE schemaname = 'public'
			AND NOT (coalesce(qual, '') || ' ' || coalesce(with_check, '') ~ 'app\\.(is_member|has_role|can_catalog_create)')`,
		expect: '0'
	},
	{
		name: 'audit: the functions that read memberships directly are the audited ones',
		role: 'postgres',
		claim: null,
		probe: `SELECT string_agg(p.proname, ',' ORDER BY p.proname)
			FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
			WHERE n.nspname = 'app' AND p.prokind = 'f' AND p.prosrc ILIKE '%memberships%'`,
		expect:
			'authorize,complete_onboarding,create_api_key,create_org,has_role,is_member,keep_one_owner,purge_org,revoke_api_key'
	}
);
