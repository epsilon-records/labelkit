import { error, fail } from '@sveltejs/kit';
import { and, eq } from 'drizzle-orm';
import { releases } from '#lib/server/db/schema.js';
import { requireErnAdmin, requestedErn } from '#lib/server/ddex/export-request.js';
import { NOT_FOR_DELIVERY, TEST_SENDER_DPID } from '#lib/server/ddex/ern.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params }) => {
	const m = requireErnAdmin(locals);
	if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(params.id))
		error(404, 'Release not found.');
	const [release] = await locals.db((tx) =>
		tx
			.select({ id: releases.id, title: releases.title })
			.from(releases)
			.where(and(eq(releases.orgId, m.orgId), eq(releases.id, params.id)))
	);
	if (!release) error(404, 'Release not found.');
	return { release, testSender: TEST_SENDER_DPID, notice: NOT_FOR_DELIVERY };
};

export const actions: Actions = {
	default: async ({ request, locals, params }) => {
		const { result, values } = await requestedErn(locals, params.id, request);
		if (result.findings.length)
			return fail(422, { values, findings: result.findings, ready: false });
		return { values, findings: [], ready: true };
	}
};
