import { createEndpoint } from '#lib/server/api/create.js';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = createEndpoint('artist');

import { and, asc, eq, gt } from 'drizzle-orm';
import { parties } from '#lib/server/db/schema.js';
import { pageParams, toWire, v1 } from '#lib/server/api/v1.js';
export const GET: RequestHandler = v1('catalog:read', ({ url }, { orgId, db }) => {
	const { limit, after } = pageParams(url);
	return db(async (tx) => {
		const rows = await tx
			.select()
			.from(parties)
			.where(and(eq(parties.orgId, orgId), after ? gt(parties.id, after) : undefined))
			.orderBy(asc(parties.id))
			.limit(limit + 1);
		return {
			data: toWire(rows.slice(0, limit)),
			next_cursor: rows.length > limit ? rows[limit - 1].id : null
		};
	});
});
