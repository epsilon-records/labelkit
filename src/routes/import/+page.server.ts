import { createHash } from 'node:crypto';
import { fail } from '@sveltejs/kit';
import { recentImports } from '#lib/server/catalog.js';
import { requireScope } from '#lib/server/guard.js';
import { applyImport, ImportTrackConflict } from '#lib/server/import/apply.js';
import { countRecordings, LIMIT_MESSAGES, limitsFor, lockLimit } from '#lib/server/plans.js';
import { plansConfig } from '#lib/server/plans-env.js';

/** Thrown inside the import transaction to roll back an import that goes over the plan. */
class OverLimit extends Error {}
import {
	normalizeCsvText,
	parseSymphonicInventory,
	summarizePlan
} from '#lib/server/import/symphonic.js';
import { parseErnDocuments } from '#lib/server/import/ern.js';
import { ErnUploadError, MAX_IMPORT_BYTES, readErnUpload } from '#lib/server/import/ern-upload.js';
import type { Actions, PageServerLoad } from './$types';

const MAX_BYTES = MAX_IMPORT_BYTES;

export const load: PageServerLoad = async ({ locals }) => {
	const m = requireScope(locals, 'catalog:write');
	return { runs: await locals.db((tx) => recentImports(tx, m.orgId)) };
};

async function readCsv(form: FormData) {
	// Step 1 uploads a file; step 2 posts back the exact text that was previewed.
	const file = form.get('file');
	if (file instanceof File && file.size > 0) {
		if (file.size > MAX_BYTES) return { error: 'File is larger than 5 MB.' } as const;
		return { name: file.name, text: normalizeCsvText(await file.text()) } as const;
	}
	const text = form.get('csv');
	const name = form.get('fileName');
	if (typeof text === 'string' && text && typeof name === 'string') {
		// The confirm step posts the previewed text back; it gets the same limit as an upload.
		if (Buffer.byteLength(text) > MAX_BYTES) return { error: 'File is larger than 5 MB.' } as const;
		return { name, text: normalizeCsvText(text) } as const;
	}
	return { error: 'Choose a SymphonicMS inventory export (.csv).' } as const;
}

async function run(request: Request, locals: App.Locals, dryRun: boolean) {
	const m = requireScope(locals, 'catalog:write');
	const form = await request.formData();
	const isErn = form.get('format') === 'ern';
	let name: string;
	let sha256: string;
	let csvText: string | undefined;
	let plan: ReturnType<typeof parseSymphonicInventory>;
	if (isErn) {
		const file = form.get('file');
		if (!(file instanceof File) || !file.size || file.size > MAX_BYTES) {
			return fail(400, { error: 'Choose a non-empty ERN XML or ZIP file up to 5 MB.' });
		}
		name = file.name;
		const bytes = Buffer.from(await file.arrayBuffer());
		sha256 = createHash('sha256').update(bytes).digest('hex');
		if (!dryRun && form.get('sha256') !== sha256) {
			return fail(400, { error: 'The file changed since the dry run. Run the dry run again.' });
		}
		try {
			plan = parseErnDocuments(await readErnUpload(name, bytes));
		} catch (e) {
			if (e instanceof ErnUploadError) return fail(400, { error: e.message });
			throw e;
		}
		if (plan.issues.length > 1000) {
			return fail(422, {
				error: 'The upload has too many findings to review. Split it into smaller batches.'
			});
		}
	} else {
		const csv = await readCsv(form);
		if ('error' in csv) return fail(400, { error: csv.error });
		name = csv.name;
		csvText = csv.text;
		sha256 = createHash('sha256').update(csvText).digest('hex');
		if (!dryRun && form.get('sha256') !== sha256) {
			return fail(400, { error: 'The file changed since the dry run. Run the dry run again.' });
		}
		plan = parseSymphonicInventory(csvText);
	}
	const summary = summarizePlan(plan);
	const base = {
		fileName: name,
		sha256,
		summary,
		format: isErn ? ('ern' as const) : ('csv' as const),
		issues: isErn ? plan.issues : plan.issues.slice(0, 200),
		moreIssues: isErn ? 0 : Math.max(0, plan.issues.length - 200)
	};
	if (summary.errors > 0) return fail(422, { ...base, stage: 'blocked' as const });

	const limits = await limitsFor(plansConfig(), m.orgId);
	let overLimit = false;
	let result;
	try {
		result = await locals.db(async (tx) => {
			if (limits || isErn) await lockLimit(tx, m.orgId, 'tracks');
			const applied = await applyImport(tx, plan, {
				orgId: m.orgId,
				actor: { id: locals.user!.id, kind: 'user' },
				fileName: name,
				fileSha256: sha256,
				dryRun,
				source: isErn ? 'ddex-ern' : undefined
			});
			// A dry run has already rolled back, so count what it would add on top of today's catalog.
			if (limits) {
				const total = dryRun
					? (await countRecordings(tx, m.orgId)) + applied.counts.recordings.created
					: await countRecordings(tx, m.orgId);
				if (total > limits.tracks) {
					overLimit = true;
					if (!dryRun) throw new OverLimit();
				}
			}
			return applied;
		});
	} catch (e) {
		if (e instanceof ImportTrackConflict) {
			return fail(409, { ...base, stage: 'blocked' as const, error: e.message });
		}
		if (e instanceof OverLimit) {
			return fail(402, {
				...base,
				stage: 'blocked' as const,
				limit: LIMIT_MESSAGES.tracks(limits!.tracks)
			});
		}
		throw e;
	}
	if (overLimit) {
		return fail(402, {
			...base,
			stage: 'blocked' as const,
			limit: LIMIT_MESSAGES.tracks(limits!.tracks)
		});
	}
	return {
		...base,
		stage: dryRun ? ('previewed' as const) : ('imported' as const),
		counts: result.counts,
		// Carried to the confirm step so the import applies exactly what was previewed.
		csv: dryRun ? csvText : undefined
	};
}

export const actions: Actions = {
	preview: ({ request, locals }) => run(request, locals, true),
	apply: ({ request, locals }) => run(request, locals, false)
};
