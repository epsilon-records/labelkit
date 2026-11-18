import { expect, it, vi } from 'vitest';
import { POST } from '../../../routes/releases/[id]/ern/download/+server';
import { completeErnFixture, testContext } from './ern.fixture';
import { requestedErn } from './export-request';

const request = (extra = {}) =>
	new Request('http://localhost/releases/x/ern/download', {
		method: 'POST',
		body: new URLSearchParams({ ...testContext, ...extra })
	});
const owner = (db = vi.fn(async () => completeErnFixture())) =>
	({
		user: { id: 'fixture-owner' },
		membership: { role: 'owner', orgId: completeErnFixture().orgId },
		db
	}) as unknown as App.Locals;

it.each(['catalog_manager', 'rights_admin', 'viewer', 'agent'])(
	'denies %s before reading catalogue data',
	async (role) => {
		const db = vi.fn();
		const locals = owner(db);
		locals.membership!.role = role as NonNullable<App.Locals['membership']>['role'];
		await expect(
			requestedErn(locals, completeErnFixture().release.id, request())
		).rejects.toMatchObject({ status: 403 });
		expect(db).not.toHaveBeenCalled();
	}
);

it('downloads only regenerated test XML with private-cache and attachment headers', async () => {
	const locals = owner();
	const response = await POST({
		locals,
		request: request(),
		params: { id: completeErnFixture().release.id }
	} as never);
	expect(response.headers.get('Content-Disposition')).toContain('not-for-delivery-');
	expect(response.headers.get('Cache-Control')).toBe('no-store');
	expect(response.headers.get('Content-Type')).toContain('application/xml');
	expect(await response.text()).toContain('TestMessage');
});

it('rechecks the current catalogue and never trusts an earlier successful preflight', async () => {
	const snapshot = completeErnFixture();
	const db = vi.fn(async () => snapshot);
	const locals = owner(db);
	const first = await requestedErn(locals, snapshot.release.id, request());
	expect(first.result.xml).not.toBeNull();
	delete snapshot.release.parentalWarning;
	await expect(
		POST({ locals, request: request(), params: { id: snapshot.release.id } } as never)
	).rejects.toMatchObject({ status: 422 });
	expect(db).toHaveBeenCalledTimes(2);
});

it('does not accept durable catalogue facts injected into the export context', async () => {
	const snapshot = completeErnFixture();
	delete snapshot.release.metadataLanguage;
	const locals = owner(vi.fn(async () => snapshot));
	const result = await requestedErn(
		locals,
		snapshot.release.id,
		request({ metadataLanguage: 'en' })
	);
	expect(result.result.xml).toBeNull();
	expect(result.result.findings.map((f) => f.path)).toContain('release.metadataLanguage');
});
