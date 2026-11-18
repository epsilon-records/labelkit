import { error } from '@sveltejs/kit';
import { requestedErn } from '#lib/server/ddex/export-request.js';
import type { RequestHandler } from './$types';

/** A fresh preflight is required for every download; a prior form result is never trusted. */
export const POST: RequestHandler = async ({ request, locals, params }) => {
	const { result } = await requestedErn(locals, params.id, request);
	if (!result.xml)
		error(
			422,
			'The catalogue is incomplete or changed. Return to Export ERN and check the findings.'
		);
	return new Response(result.xml, {
		headers: {
			'Content-Type': 'application/xml; charset=utf-8',
			'Content-Disposition': `attachment; filename="not-for-delivery-${params.id}.xml"`,
			'Cache-Control': 'no-store',
			'X-Robots-Tag': 'noindex',
			'X-Content-Type-Options': 'nosniff'
		}
	});
};
