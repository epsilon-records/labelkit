import { error } from '@sveltejs/kit';
import { requireScope } from '#lib/server/guard.js';
import { ernSnapshot } from './snapshot';
import { generateErn } from './ern';

export function requireErnAdmin(locals: App.Locals) {
	const membership = requireScope(locals, 'roles:manage');
	if (membership.role !== 'owner') error(403, 'Only a label owner can export ERN.');
	return membership;
}

export async function requestedErn(locals: App.Locals, releaseId: string, request: Request) {
	const membership = requireErnAdmin(locals);
	if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(releaseId))
		error(404, 'Release not found.');
	const form = await request.formData();
	const values: Record<string, string> = {};
	for (const [key, value] of form) {
		if (typeof value !== 'string' || key in values) error(400, 'Check the export-context form.');
		values[key] = value;
	}
	const snapshot = await locals.db((tx) => ernSnapshot(tx, membership.orgId, releaseId));
	if (!snapshot) error(404, 'Release not found.');
	return { values, result: generateErn(snapshot, values) };
}
