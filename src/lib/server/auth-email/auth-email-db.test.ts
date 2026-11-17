import { describe, expect, it } from 'vitest';
import { orgs, memberships, orgAuthSenders } from '../db/schema';
import { createTestDb } from '../test-db';

// Migration 0025 (EPSILON-147): the Send Email hook reads one account's org ids, as a role that
// can do nothing else.
const U1 = '6f1c2b8e-1c1a-4d55-9a57-0b1f1b0a5c11';
const U2 = '6f1c2b8e-1c1a-4d55-9a57-0b1f1b0a5c22';
const NOBODY = '6f1c2b8e-1c1a-4d55-9a57-0b1f1b0a5c33';

describe('labelkit_auth_email', () => {
	it('is a role that cannot log in or bypass RLS', async () => {
		const { client } = await createTestDb();
		const [role] =
			await client`select rolcanlogin, rolbypassrls from pg_roles where rolname = 'labelkit_auth_email'`;
		expect(role).toEqual({ rolcanlogin: false, rolbypassrls: false });
	});

	it('reads exactly one account’s org ids, sorted, and nothing for an address with no membership', async () => {
		const { db, client } = await createTestDb();
		const [a] = await db.insert(orgs).values({ name: 'Epsilon', slug: 'epsilon' }).returning();
		const [b] = await db.insert(orgs).values({ name: 'Label B', slug: 'b' }).returning();
		await db.insert(memberships).values([
			{ orgId: a.id, userId: U1, role: 'owner' },
			{ orgId: b.id, userId: U1, role: 'viewer' },
			{ orgId: b.id, userId: U2, role: 'owner' }
		]);
		const ids = (user: string) =>
			client.begin(async (tx) => {
				await tx`set local role labelkit_auth_email`;
				const rows =
					await tx`select unnest(app_auth_email.member_org_ids(${user}::uuid))::text as id`;
				return rows.map((r) => r.id);
			});
		expect(await ids(U1)).toEqual([a.id, b.id].sort());
		expect(await ids(U2)).toEqual([b.id]);
		expect(await ids(NOBODY)).toEqual([]);
	});

	it('has no table rights of its own', async () => {
		const { client } = await createTestDb();
		for (const probe of [
			'select * from public.memberships',
			'select * from public.orgs',
			'select * from public.labels'
		]) {
			await expect(
				client.begin(async (tx) => {
					await tx`set local role labelkit_auth_email`;
					await tx.unsafe(probe);
				})
			).rejects.toMatchObject({ code: '42501' });
		}
	});

	it('is the only role besides the owner that may call the lookup', async () => {
		const { client } = await createTestDb();
		for (const role of [
			'anon',
			'authenticated',
			'service_role',
			'labelkit_app',
			'labelkit_metrics_ingest'
		]) {
			const [row] =
				await client`select has_function_privilege(${role}, 'app_auth_email.member_org_ids(uuid)', 'execute') as ok`;
			expect(row.ok, role).toBe(false);
		}
		const [row] =
			await client`select has_function_privilege('labelkit_auth_email', 'app_auth_email.member_org_ids(uuid)', 'execute') as ok`;
		expect(row.ok).toBe(true);
	});
});

// Migration 0033 (EPSILON-146): the hook reads one org's branding, by active custom domain or by id,
// and org_auth_senders is readable by no role but the owner.
describe('labelkit_auth_email branding lookups', () => {
	const brand = (
		client: Awaited<ReturnType<typeof createTestDb>>['client'],
		query: 'host' | 'id',
		arg: string
	) =>
		client.begin(async (tx) => {
			await tx`set local role labelkit_auth_email`;
			return query === 'host'
				? tx`select * from app_auth_email.org_brand_by_host(${arg})`
				: tx`select * from app_auth_email.org_brand_by_id(${arg}::uuid)`;
		});

	it('finds an open org by its active custom domain, with its own sender', async () => {
		const { db, client } = await createTestDb();
		const [a] = await db
			.insert(orgs)
			.values({
				name: 'Epsilon Records',
				slug: 'epsilon',
				displayName: 'ERMS',
				customDomain: 'erms.example.test',
				domainStatus: 'active'
			})
			.returning();
		await db.insert(orgAuthSenders).values({
			orgId: a.id,
			domain: 'auth.erms.example.test',
			resendKeySealed: 'v1.t1.fake.fake.fake'
		});
		expect(await brand(client, 'host', 'ERMS.example.test')).toEqual([
			{
				org_id: a.id,
				name: 'Epsilon Records',
				display_name: 'ERMS',
				sender_domain: 'auth.erms.example.test',
				sender_key_sealed: 'v1.t1.fake.fake.fake'
			}
		]);
		expect(await brand(client, 'id', a.id)).toHaveLength(1);
	});

	it('returns nothing for a domain that is not active, an unknown host, or a closed label', async () => {
		const { db, client } = await createTestDb();
		const [b] = await db
			.insert(orgs)
			.values({
				name: 'Label B',
				slug: 'b',
				customDomain: 'b.example.test',
				domainStatus: 'failed'
			})
			.returning();
		expect(await brand(client, 'host', 'b.example.test')).toEqual([]);
		expect(await brand(client, 'host', 'nobody.example.test')).toEqual([]);
		const [c] = await db
			.insert(orgs)
			.values({
				name: 'Label C',
				slug: 'c',
				customDomain: 'c.example.test',
				domainStatus: 'active',
				closedAt: new Date(),
				purgeAfter: new Date(Date.now() + 86_400_000)
			})
			.returning();
		expect(await brand(client, 'host', 'c.example.test')).toEqual([]);
		expect(await brand(client, 'id', c.id)).toEqual([]);
		// A label without its own sender: names, no sender.
		expect(await brand(client, 'id', b.id)).toEqual([
			{
				org_id: b.id,
				name: 'Label B',
				display_name: null,
				sender_domain: null,
				sender_key_sealed: null
			}
		]);
	});

	it('org_auth_senders is closed to every role but the owner, and the lookups only to the hook', async () => {
		const { client } = await createTestDb();
		for (const role of [
			'anon',
			'authenticated',
			'service_role',
			'labelkit_app',
			'labelkit_auth_email',
			'labelkit_metrics_ingest'
		]) {
			await expect(
				client.begin(async (tx) => {
					await tx.unsafe(`set local role ${role}`);
					await tx`select * from public.org_auth_senders`;
				}),
				role
			).rejects.toMatchObject({ code: '42501' });
		}
		for (const fn of [
			'app_auth_email.org_brand_by_host(text)',
			'app_auth_email.org_brand_by_id(uuid)'
		]) {
			for (const role of ['anon', 'authenticated', 'service_role', 'labelkit_app']) {
				const [row] = await client`select has_function_privilege(${role}, ${fn}, 'execute') as ok`;
				expect(row.ok, `${role} ${fn}`).toBe(false);
			}
			const [row] =
				await client`select has_function_privilege('labelkit_auth_email', ${fn}, 'execute') as ok`;
			expect(row.ok, fn).toBe(true);
		}
	});
});
