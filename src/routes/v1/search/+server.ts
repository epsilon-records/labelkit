import { searchQuery, searchResponse, v1 } from '#lib/server/api/v1.js';
import type { RequestHandler } from './$types';

/**
 * GET /v1/search?q= - releases, recordings and artists matching `q`: words by prefix, and ISRC,
 * UPC or catalogue number. At most 25 of each, best match first. Not paged: narrow the query.
 */
export const GET: RequestHandler = v1('catalog:read', ({ url }, { orgId, db }) => {
	const q = searchQuery(url);
	return db((tx) => searchResponse(tx, orgId, q));
});
