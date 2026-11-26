import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { actions } from '../../routes/recordings/[id]/+page.server';
import { queueJobForLatestMaster } from './audiokit-jobs';
import { createDb } from './db';
import { countingProxy } from './db/counting-proxy';
import { audiokitJobs, auditLog, masters, memberships, orgs, recordings } from './db/schema';
import { scopedTo } from './db/scoped';
import { countAnalysesThisMonth, lockLimit } from './plans';
import * as plansEnv from './plans-env';
import { createTestDb } from './test-db';

/**
 * EPSILON-145: Run / Re-run must answer in under 1 s, and production pays about 98 ms for every
 * database round trip (knowledge labelkit/decisions/0029). These count the action's round trips
 * on the wire, so a change that adds one fails here instead of in production.
 */
// Keep the 1 s production target. Allow 100 ms of CI scheduling jitter on the wall clock;
// the exact exchange-count assertions still fail on any extra database trip.
const CI_RESPONSE_BUDGET_MS = 1_100;
const manager = '00000000-0000-7000-8000-0000000145c1';
let proxy: Awaited<ReturnType<typeof countingProxy>>;
let db: ReturnType<typeof createDb>;
let orgId: string;
let recordingId: string;

beforeAll(async () => {
	const { db: direct, client } = await createTestDb();
	[{ id: orgId }] = await direct.insert(orgs).values({ name: 'Trips', slug: 'trips' }).returning();
	await direct.insert(memberships).values({ orgId, userId: manager, role: 'catalog_manager' });
	[{ id: recordingId }] = await direct
		.insert(recordings)
		.values({ orgId, isrc: 'XXTRP2614001', title: 'Trips' })
		.returning();
	const id = randomUUID();
	await direct.insert(masters).values({
		id,
		orgId,
		recordingId,
		objectKey: `orgs/${orgId}/recordings/${recordingId}/masters/${id}.wav`,
		sizeBytes: 10,
		sha256: 'a'.repeat(64),
		fileName: 'x.wav',
		status: 'ready',
		completedAt: new Date(),
		uploadedBy: manager
	});
	const o = client.options as unknown as {
		host: string[];
		port: number[];
		database: string;
		user: string;
		pass: string | null;
	};
	proxy = await countingProxy(o.host[0], o.port[0]);
	const auth = `${encodeURIComponent(o.user)}:${encodeURIComponent(o.pass ?? '')}`;
	db = createDb(`postgres://${auth}@127.0.0.1:${proxy.port}/${o.database}?sslmode=disable`, {
		max: 1
	});
	await db.execute(sql`select 1`); // connect, authenticate and load types first
});

afterAll(async () => {
	await db?.$client.end({ timeout: 5 });
	proxy?.close();
});

const ctx = () => ({
	orgId,
	role: 'catalog_manager' as const,
	actor: { id: manager, kind: 'user' as const }
});

const eventFor = () =>
	({
		request: new Request('http://localhost/recordings/x?/runAnalysis', {
			method: 'POST',
			body: new URLSearchParams({ operation: 'loudness' })
		}),
		params: { id: recordingId },
		locals: {
			user: { id: manager },
			membership: { orgId, role: 'catalog_manager' },
			db: scopedTo(db, manager)
		}
	}) as never;

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

it('commits a Run and audit within the CI response budget with 98 ms per exchange in four round trips', async () => {
	let result: unknown;
	const event = eventFor();
	// Six before: withAudit's savepoint and its release were two more.
	const started = performance.now();
	expect(await proxy.count(async () => (result = await actions.runAnalysis(event)), 98)).toBe(4);
	const elapsedMs = performance.now() - started;
	console.info(
		JSON.stringify({
			budget: 'runAnalysis',
			rtt_ms: 98,
			round_trips: 4,
			limit_ms: CI_RESPONSE_BUDGET_MS,
			elapsed_ms: elapsedMs
		})
	);
	expect(elapsedMs).toBeLessThan(CI_RESPONSE_BUDGET_MS);
	expect(result).toMatchObject({ action: 'runAnalysis', ok: true, result: { status: 'queued' } });

	const { jobId } = (result as { result: { jobId: string } }).result;
	const [job] = await db.select().from(audiokitJobs).where(eq(audiokitJobs.id, jobId));
	expect(job).toMatchObject({ orgId, recordingId, status: 'queued', requestedBy: manager });
	const audits = await db
		.select({ actorId: auditLog.actorId, actorKind: auditLog.actorKind, after: auditLog.after })
		.from(auditLog)
		.where(and(eq(auditLog.entity, 'audiokit_job'), eq(auditLog.entityId, jobId)));
	expect(audits).toEqual([
		{ actorId: manager, actorKind: 'user', after: { operation: 'loudness', status: 'queued' } }
	]);
});

it('commits within the CI response budget with healthy plans, six 98 ms exchanges and an 80 ms billing lookup', async () => {
	vi.spyOn(plansEnv, 'plansConfig').mockReturnValue({
		enabled: true,
		billingUrl: 'https://billing.example',
		adminToken: 'ci-plan-probe',
		exemptOrgIds: []
	});
	const billing = vi.fn(async (url: string) => {
		expect(url).toBe(`https://billing.example/v1/admin/labels/${orgId}/plan`);
		await new Promise((resolve) => setTimeout(resolve, 80));
		return Response.json({
			label_plan: {
				plan: 'label',
				status: 'active',
				current_period_end: null,
				cancel_at_period_end: false,
				limits: { tracks: 10000, seats: 100, analysisJobsPerMonth: 10000 }
			}
		});
	});
	vi.stubGlobal('fetch', billing);
	let result: unknown;
	const started = performance.now();
	const trips = await proxy.count(async () => (result = await actions.runAnalysis(eventFor())), 98);
	const elapsedMs = performance.now() - started;
	expect(trips).toBe(6);
	expect(billing).toHaveBeenCalledTimes(1);
	expect(result).toMatchObject({ action: 'runAnalysis', ok: true, result: { status: 'queued' } });
	console.info(
		JSON.stringify({
			budget: 'runAnalysis-healthy-plans',
			rtt_ms: 98,
			billing_ms: 80,
			limit_ms: CI_RESPONSE_BUDGET_MS,
			round_trips: trips,
			elapsed_ms: elapsedMs
		})
	);
	expect(elapsedMs).toBeLessThan(CI_RESPONSE_BUDGET_MS);
	const { jobId } = (result as { result: { jobId: string } }).result;
	const [job] = await db.select().from(audiokitJobs).where(eq(audiokitJobs.id, jobId));
	expect(job).toMatchObject({ orgId, recordingId, status: 'queued', requestedBy: manager });
	const [audit] = await db
		.select()
		.from(auditLog)
		.where(and(eq(auditLog.entity, 'audiokit_job'), eq(auditLog.entityId, jobId)));
	expect(audit.actorId).toBe(manager);
});

it('adds only the plan check when plans are on: the lock and the count', async () => {
	const trips = await proxy.count(() =>
		scopedTo(
			db,
			manager
		)(async (tx) => {
			await lockLimit(tx, orgId, 'analysis');
			await countAnalysesThisMonth(tx, orgId);
			return queueJobForLatestMaster(tx, ctx(), recordingId, { operation: 'loudness' });
		})
	);
	expect(trips).toBe(6);
});

it('writes neither row when there is no ready master, in the same round trips', async () => {
	const audits = () => db.select({ id: auditLog.id }).from(auditLog);
	const jobs = () => db.select({ id: audiokitJobs.id }).from(audiokitJobs);
	const [auditsBefore, jobsBefore] = [(await audits()).length, (await jobs()).length];
	let outcome: unknown;
	const trips = await proxy.count(async () => {
		outcome = await scopedTo(
			db,
			manager
		)((tx) => queueJobForLatestMaster(tx, ctx(), randomUUID(), { operation: 'loudness' })).catch(
			(e: Error) => e.message
		);
	});
	expect(outcome).toBe('Upload a ready master before running analysis.');
	expect(trips).toBe(4); // begin, set role and user, the statement, rollback
	expect(await audits()).toHaveLength(auditsBefore);
	expect(await jobs()).toHaveLength(jobsBefore);
});
