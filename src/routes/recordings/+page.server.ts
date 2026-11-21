import { eq } from 'drizzle-orm';
import { recordings } from '#lib/server/db/schema.js';
import { requireScope } from '#lib/server/guard.js';
import { hasScope } from '#lib/server/rbac.js';
import type { PageServerLoad } from './$types';
export const load: PageServerLoad = async ({ locals }) => {
	const m = requireScope(locals, 'catalog:read');
	return {
		canCreate: hasScope(m.role, 'catalog:write'),
		recordings: await locals.db((tx) =>
			tx
				.select({ id: recordings.id, title: recordings.title, isrc: recordings.isrc })
				.from(recordings)
				.where(eq(recordings.orgId, m.orgId))
				.orderBy(recordings.title)
		)
	};
};
