import { it, expect } from 'vitest';
import { createTestDb } from './test-db';

it('real Supabase: atomic cap across connections, rollback, finite columns, retention and purge', async () => {
	const { client } = await createTestDb();
	// Roles and default grants are inherited from the pinned real Supabase server, not simulated.
	const roles =
		await client`select rolname,rolcanlogin,rolbypassrls from pg_roles where rolname in ('labelkit_metrics_ingest','labelkit_metrics_prune')`;
	expect(roles).toHaveLength(2);
	expect(roles.every((r) => !r.rolcanlogin && !r.rolbypassrls)).toBe(true);
	const columns =
		await client`select column_name from information_schema.columns where table_schema='app_metrics' order by ordinal_position`;
	expect(columns.map((r) => r.column_name)).toEqual([
		'day_utc',
		'route_code',
		'metric_code',
		'bucket',
		'count'
	]);
	const [{ today }] =
		await client`select (clock_timestamp() at time zone 'UTC')::date::text as today`;
	await client`insert into app_metrics.app_performance_daily values (${today},0,0,0,1997),(${today},1,1,1,1997)`;
	// This part proves the cap is atomic, not that record() meets its 100 ms / 250 ms production
	// budget (the next test covers that). Every call takes the same row lock (the day's total row)
	// and holds it until its own COMMIT, so a call can wait for a commit's WAL flush. On a busy CI
	// runner that flush passes 100 ms and the waiter is shed with 55P03 instead of answering
	// (EPSILON-253). Widen the function's own limits on this test's private database only: the
	// function-level SET wins over any session or SET LOCAL value, so ALTER is the one lever.
	await client`alter function app_metrics.record(smallint,smallint,smallint) set lock_timeout = '30s' set statement_timeout = '30s'`;
	const outcomes = await Promise.all(
		Array.from({ length: 20 }, () =>
			client.begin(async (tx) => {
				await tx`set local role labelkit_metrics_ingest`;
				const [row] =
					await tx`select app_metrics.record(1::smallint,1::smallint,1::smallint) as accepted`;
				return row.accepted;
			})
		)
	);
	expect(outcomes.filter(Boolean)).toHaveLength(3);
	const totals =
		await client`select route_code,sum(count)::int as n from app_metrics.app_performance_daily group by route_code order by route_code`;
	expect(totals.map((r) => r.n)).toEqual([2000, 2000]);
	await client`delete from app_metrics.app_performance_daily`;
	await expect(
		client.begin(async (tx) => {
			await tx`set local role labelkit_metrics_ingest`;
			await tx`select app_metrics.record(1::smallint,2::smallint,8::smallint)`;
			throw new Error('rollback');
		})
	).rejects.toThrow('rollback');
	expect(await client`select * from app_metrics.app_performance_daily`).toHaveLength(0);
	for (const [r, m, b] of [
		[0, 0, 0],
		[2, 1, 1],
		[1, 3, 1],
		[1, 1, 9],
		[null, 1, 1]
	])
		await expect(
			client.begin(async (tx) => {
				await tx`set local role labelkit_metrics_ingest`;
				await tx`select app_metrics.record(${r}::smallint,${m}::smallint,${b}::smallint)`;
			})
		).rejects.toMatchObject({ code: '22023' });
	await client`insert into app_metrics.app_performance_daily select (${today}::date-n),1,1,1,1 from generate_series(0,8) n`;
	// Idle prune does not depend on browser/server enable flags.
	await client.begin(async (tx) => {
		await tx`set local role labelkit_metrics_prune`;
		await tx`select app_metrics.prune()`;
	});
	expect(await client`select * from app_metrics.app_performance_daily`).toHaveLength(8);
	await client`insert into app_metrics.app_performance_daily values (${today}::date-9,1,1,1,1)`;
	await client.begin(async (tx) => {
		await tx`set local role labelkit_metrics_ingest`;
		await tx`select app_metrics.record(1::smallint,1::smallint,2::smallint)`;
	});
	expect(
		await client`select * from app_metrics.app_performance_daily where day_utc < ${today}::date-7`
	).toHaveLength(0);
	await client`delete from app_metrics.app_performance_daily`;
	expect(await client`select * from app_metrics.app_performance_daily`).toHaveLength(0);
});

it('real Supabase: record() sheds with 55P03 after 100 ms when the total row is locked, and changes nothing', async () => {
	const { client } = await createTestDb();
	// The budget is part of the function's definition, so a migration that drops it fails here.
	const [{ proconfig }] =
		await client`select proconfig from pg_proc where oid = 'app_metrics.record(smallint,smallint,smallint)'::regprocedure`;
	expect(proconfig).toEqual(
		expect.arrayContaining(['lock_timeout=100ms', 'statement_timeout=250ms'])
	);
	const [{ today }] =
		await client`select (clock_timestamp() at time zone 'UTC')::date::text as today`;
	await client`insert into app_metrics.app_performance_daily values (${today},0,0,0,5),(${today},1,1,1,5)`;

	// Hold the total row's lock in another connection until we release it: no timing involved.
	let release!: () => void;
	const released = new Promise<void>((resolve) => (release = resolve));
	let locked!: () => void;
	const lockTaken = new Promise<void>((resolve) => (locked = resolve));
	const holder = client.begin(async (tx) => {
		await tx`select 1 from app_metrics.app_performance_daily where route_code = 0 and metric_code = 0 for update`;
		locked();
		await released;
	});
	try {
		await Promise.race([lockTaken, holder]);
		await expect(
			client.begin(async (tx) => {
				await tx`set local role labelkit_metrics_ingest`;
				await tx`select app_metrics.record(1::smallint,1::smallint,1::smallint)`;
			})
		).rejects.toMatchObject({ code: '55P03' });
	} finally {
		release();
		await holder;
	}
	const rows =
		await client`select route_code,count::int as n from app_metrics.app_performance_daily order by route_code`;
	expect(rows.map((r) => r.n)).toEqual([5, 5]);
});
