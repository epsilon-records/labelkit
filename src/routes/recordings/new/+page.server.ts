import { redirect } from '@sveltejs/kit';
import { createRecording } from '#lib/server/catalog-create.js';
import { editAction, formFields } from '#lib/server/form.js';
import { requireScope } from '#lib/server/guard.js';
import { limitsFor } from '#lib/server/plans.js';
import { plansConfig } from '#lib/server/plans-env.js';
import type { Actions, PageServerLoad } from './$types';
export const load: PageServerLoad = ({ locals }) => {
	requireScope(locals, 'catalog:write');
	return {};
};
export const actions: Actions = {
	default: async ({ request, locals }) => {
		const m = requireScope(locals, 'catalog:write');
		const f = await formFields(request);
		const limits = await limitsFor(plansConfig(), m.orgId);
		const result = await editAction('create', f, () =>
			locals.db((tx) =>
				createRecording(
					tx,
					{ orgId: m.orgId, actor: { id: locals.user!.id, kind: 'user' } },
					f,
					limits
				)
			)
		);
		if ('ok' in result && result.ok) redirect(303, `/recordings/${result.result.id}`);
		return result;
	}
};
