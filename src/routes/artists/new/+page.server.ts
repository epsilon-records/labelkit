import { redirect } from '@sveltejs/kit';
import { createArtist } from '#lib/server/catalog-create.js';
import { editAction, formFields } from '#lib/server/form.js';
import { requireScope } from '#lib/server/guard.js';

import type { Actions, PageServerLoad } from './$types';
export const load: PageServerLoad = ({ locals }) => {
	requireScope(locals, 'catalog:write');
	return {};
};
export const actions: Actions = {
	default: async ({ request, locals }) => {
		const m = requireScope(locals, 'catalog:write');
		const f = await formFields(request);

		const result = await editAction('create', f, () =>
			locals.db((tx) =>
				createArtist(tx, { orgId: m.orgId, actor: { id: locals.user!.id, kind: 'user' } }, f)
			)
		);
		if ('ok' in result && result.ok) redirect(303, `/artists/${result.result.id}`);
		return result;
	}
};
