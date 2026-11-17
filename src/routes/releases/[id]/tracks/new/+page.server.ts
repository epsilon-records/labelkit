import { eq } from 'drizzle-orm';
import { error, redirect } from '@sveltejs/kit';
import { getRelease } from '#lib/server/catalog.js';
import { addTrack } from '#lib/server/catalog-create.js';
import { recordings } from '#lib/server/db/schema.js';
import { editAction, formFields } from '#lib/server/form.js';
import { requireScope } from '#lib/server/guard.js';
import { limitsFor } from '#lib/server/plans.js';
import { plansConfig } from '#lib/server/plans-env.js';
import type { Actions, PageServerLoad } from './$types';
export const load: PageServerLoad = async ({ locals, params }) => {
	const m = requireScope(locals, 'catalog:write');
	if (!/^[0-9a-f-]{36}$/.test(params.id)) error(404, 'Release not found');
	const release = await locals.db((tx) => getRelease(tx, m.orgId, params.id));
	if (!release) error(404, 'Release not found');
	return {
		release,
		recordings: await locals.db((tx) =>
			tx
				.select({ id: recordings.id, title: recordings.title, isrc: recordings.isrc })
				.from(recordings)
				.where(eq(recordings.orgId, m.orgId))
				.orderBy(recordings.title)
		)
	};
};
export const actions: Actions = {
	default: async ({ request, locals, params }) => {
		const m = requireScope(locals, 'catalog:write');
		if (!/^[0-9a-f-]{36}$/.test(params.id)) error(404, 'Release not found');
		const f = await formFields(request);
		const limits = await limitsFor(plansConfig(), m.orgId);
		const result = await editAction('addTrack', f, () =>
			locals.db((tx) =>
				addTrack(
					tx,
					{ orgId: m.orgId, actor: { id: locals.user!.id, kind: 'user' } },
					params.id,
					f,
					limits
				)
			)
		);
		if ('ok' in result && result.ok) redirect(303, `/releases/${params.id}`);
		return result;
	}
};
