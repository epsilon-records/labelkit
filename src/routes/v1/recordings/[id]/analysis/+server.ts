import { analysisDetail, requireId, v1 } from '#lib/server/api/v1.js';
import type { RequestHandler } from './$types';

/** GET /v1/recordings/:id/analysis - the analysis stored for a recording. Reads only; runs nothing. */
export const GET: RequestHandler = v1('catalog:read', ({ params }, { orgId, db }) => {
	const id = requireId(params.id, 'Recording');
	return db((tx) => analysisDetail(tx, orgId, id));
});
