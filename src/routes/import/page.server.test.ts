import { expect, it, vi } from 'vitest';
import { ERN_NAMESPACE } from '#lib/server/ddex/ern.js';
import { MAX_ERN_FINDINGS_BYTES } from '#lib/server/import/ern.js';
import { actions } from './+page.server';

const A = '00000000-0000-7000-8000-00000000000a';
const B = '00000000-0000-7000-8000-00000000000b';

/** A member of `orgId`; the test fails if the action reaches the database. */
function event(action: 'preview' | 'apply', orgId: string, fields: Record<string, string | File>) {
	const body = new FormData();
	for (const [key, value] of Object.entries(fields)) body.set(key, value);
	const db = vi.fn(() => {
		throw new Error('the database was reached');
	});
	const locals = {
		membership: { orgId, orgName: 'Test label', role: 'owner' },
		user: { id: 'u1' },
		db
	};
	const request = new Request('http://localhost/import?/' + action, { method: 'POST', body });
	return { call: () => actions[action]({ request, locals } as never), db };
}

const csv = (fields: Record<string, string>) => ({
	csv: 'Name\nx\n',
	fileName: 'x.csv',
	...fields
});
const ern = (fields: Record<string, string>) => ({
	format: 'ern',
	file: new File(['<a/>'], 'a.xml'),
	...fields
});

it('hands the dry run its organisation to carry to the confirm step', async () => {
	const { call } = event('preview', A, csv({}));
	expect(await call()).toMatchObject({ status: 422, data: { stage: 'blocked', orgId: A } });
});

it.each([
	['a CSV', csv],
	['an ERN', ern]
])('refuses to confirm %s dry run made in another organisation', async (_, fields) => {
	for (const previewed of [B, undefined]) {
		const { call, db } = event('apply', A, fields(previewed ? { orgId: previewed } : {}));
		expect(await call()).toMatchObject({
			status: 409,
			data: { error: expect.stringContaining('organisation changed') }
		});
		expect(db).not.toHaveBeenCalled();
	}
});

it('lets a confirm for the same organisation through to the file check', async () => {
	const { call } = event('apply', A, csv({ orgId: A, sha256: 'stale' }));
	expect(await call()).toMatchObject({
		status: 400,
		data: { error: expect.stringContaining('file changed') }
	});
});

it('refuses an ERN dry run whose findings are too large to send back', async () => {
	const text =
		'<ern:NewReleaseMessage xmlns:ern="' +
		ERN_NAMESPACE +
		'">' +
		'<ProprietaryId/>'.repeat(10) +
		'</ern:NewReleaseMessage>';
	const name = 'a'.repeat(MAX_ERN_FINDINGS_BYTES / 5) + '.xml';
	const { call, db } = event('preview', A, { format: 'ern', file: new File([text], name) });
	const result = await call();
	expect(result).toMatchObject({
		status: 422,
		data: { error: expect.stringContaining('too many findings') }
	});
	expect(JSON.stringify(result).length).toBeLessThan(1000);
	expect(db).not.toHaveBeenCalled();
});
