import { createHash } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { createArtist, createRecording, createRelease, addTrack } from '../catalog-create';
import { EditError } from '../catalog-edit';
import type { Database } from '../audit';
import { apiCreateRequests } from '../db/schema';
import { limitsFor } from '../plans';
import { plansConfig } from '../plans-env';
import { ApiError, requireId, toWire, v1 } from './v1';

type Event = { locals: App.Locals; request: Request; url: URL; params: Record<string, string> };
type Operation = 'release' | 'recording' | 'artist' | 'track';
const stable = (value: unknown): unknown =>
	Array.isArray(value)
		? value.map(stable)
		: value && typeof value === 'object'
			? Object.fromEntries(
					Object.entries(value)
						.sort(([a], [b]) => a.localeCompare(b))
						.map(([k, v]) => [k, stable(v)])
				)
			: value;

/** The receipt and catalogue write commit together. A retry never repeats a successful create. */
export async function once(
	tx: Database,
	ctx: { orgId: string; actorId: string },
	route: string,
	key: string | null,
	body: unknown,
	run: () => Promise<unknown>
) {
	if (key === null) return run();
	if (!/^[\x21-\x7e]{1,200}$/.test(key))
		throw new ApiError(
			400,
			'invalid_request',
			'Idempotency-Key must be 1–200 printable ASCII characters.'
		);
	const fingerprint = createHash('sha256')
		.update(JSON.stringify(stable(body)))
		.digest('hex');
	await tx.execute(
		sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify([ctx.orgId, ctx.actorId, route, key])}, 0))`
	);
	const where = and(
		eq(apiCreateRequests.orgId, ctx.orgId),
		eq(apiCreateRequests.actorId, ctx.actorId),
		eq(apiCreateRequests.route, route),
		eq(apiCreateRequests.key, key)
	);
	const [prior] = await tx.select().from(apiCreateRequests).where(where);
	if (prior) {
		if (prior.fingerprint !== fingerprint)
			throw new ApiError(
				409,
				'idempotency_conflict',
				'This Idempotency-Key was already used with a different request.'
			);
		return prior.response;
	}
	const response = await run();
	await tx.insert(apiCreateRequests).values({ ...ctx, route, key, fingerprint, response });
	return response;
}

export function createEndpoint(operation: Operation) {
	return v1<Event>(
		'catalog:write',
		async (event, { orgId, db }) => {
			const actorId = event.locals.apiKey?.actorId;
			if (!actorId) throw new ApiError(401, 'unauthorized', 'Missing API actor.');
			const contentType = event.request.headers.get('content-type')?.split(';')[0].trim();
			if (contentType !== 'application/json')
				throw new ApiError(400, 'invalid_request', 'Send an application/json object.');
			const text = await event.request.text();
			if (Buffer.byteLength(text) > 65536)
				throw new ApiError(400, 'invalid_request', 'Request is larger than 64 KB.');
			let body: Record<string, unknown>;
			try {
				body = JSON.parse(text);
			} catch {
				throw new ApiError(400, 'invalid_request', 'Invalid JSON.');
			}
			if (!body || typeof body !== 'object' || Array.isArray(body))
				throw new ApiError(400, 'invalid_request', 'Send a JSON object.');
			const fields: Record<string, unknown> = {
				versionTitle: '',
				releaseDate: '',
				catalogNumber: '',
				genre: '',
				subgenre: '',
				duration: ''
			};
			const allowed =
				operation === 'artist'
					? ['display_name']
					: operation === 'release'
						? [
								'title',
								'version_title',
								'release_date',
								'catalog_number',
								'upc',
								'label_id',
								'genre',
								'subgenre'
							]
						: operation === 'recording'
							? ['title', 'version_title', 'isrc', 'duration', 'genre', 'subgenre']
							: [
									'mode',
									'disc',
									'position',
									'recording_id',
									'title',
									'version_title',
									'isrc',
									'duration',
									'genre',
									'subgenre'
								];
			for (const [key, value] of Object.entries(body)) {
				if (!allowed.includes(key))
					throw new ApiError(400, 'invalid_request', `Unknown field: ${key}`);
				fields[key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())] = value;
			}
			if (operation === 'track') {
				for (const field of ['disc', 'position'])
					if (typeof body[field] !== 'number')
						throw new ApiError(400, 'invalid_request', `${field} must be an integer.`);
				if (
					body.mode === 'existing' &&
					Object.keys(body).some((k) => !['mode', 'recording_id', 'disc', 'position'].includes(k))
				)
					throw new ApiError(
						400,
						'invalid_request',
						'Existing tracks accept only mode, recording_id, disc and position.'
					);
				if (body.mode === 'new' && 'recording_id' in body)
					throw new ApiError(400, 'invalid_request', 'New tracks do not accept recording_id.');
			}
			const releaseId = operation === 'track' ? requireId(event.params.id, 'Release') : '';
			const limits =
				operation === 'track' || operation === 'recording'
					? await limitsFor(plansConfig(), orgId)
					: null;
			try {
				return await db((tx) =>
					once(
						tx,
						{ orgId, actorId },
						event.url.pathname,
						event.request.headers.get('idempotency-key'),
						body,
						async () => {
							const ctx = { orgId, actor: { id: actorId, kind: 'agent' as const } };
							const result =
								operation === 'release'
									? await createRelease(tx, ctx, fields)
									: operation === 'artist'
										? await createArtist(tx, ctx, fields)
										: operation === 'recording'
											? await createRecording(tx, ctx, fields, limits)
											: await addTrack(tx, ctx, releaseId, fields, limits);
							return { [operation === 'track' ? 'recording' : operation]: toWire(result) };
						}
					)
				);
			} catch (error) {
				if (error instanceof EditError) {
					const conflict = /already|position is.*used/i.test(error.message);
					throw new ApiError(
						conflict ? 409 : 400,
						conflict ? 'conflict' : 'invalid_request',
						error.message
					);
				}
				const e = error as { code?: string; cause?: { code?: string } };
				const code = e.code ?? e.cause?.code;
				if (code === '23505')
					throw new ApiError(
						409,
						'conflict',
						'A record with this identifier or position already exists.'
					);
				if (code === '42501')
					throw new ApiError(403, 'forbidden', 'This key cannot create records in this label.');
				throw error;
			}
		},
		201
	);
}
