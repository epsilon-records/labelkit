import { listArtists } from '#lib/server/catalog.js';
import { requireScope } from '#lib/server/guard.js';
import { hasScope } from '#lib/server/rbac.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	const m = requireScope(locals, 'catalog:read');
	return {
		canCreate: hasScope(m.role, 'catalog:write'),
		artists: await locals.db((tx) => listArtists(tx, m.orgId))
	};
};
