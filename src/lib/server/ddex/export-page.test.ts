import { render } from 'svelte/server';
import { expect, it } from 'vitest';
import ExportPage from '../../../routes/releases/[id]/ern/+page.svelte';
import type { PageProps } from '../../../routes/releases/[id]/ern/$types';
import { NOT_FOR_DELIVERY, TEST_SENDER_DPID } from './ern';
import { completeErnFixture, testContext } from './ern.fixture';

const props = (form: unknown = null) =>
	({
		data: {
			release: { id: completeErnFixture().release.id, title: 'ERN fixture release' },
			testSender: TEST_SENDER_DPID,
			notice: NOT_FOR_DELIVERY
		},
		form
	}) as PageProps;
it('renders the real context form without inputs that could fabricate catalogue facts', () => {
	const { body } = render(ExportPage, { props: props() });
	expect(body).toContain('Check export');
	for (const field of ['senderDpid', 'recipientDpid', 'territoryScope', 'dealScope'])
		expect(body).toContain(`name="${field}"`);
	for (const field of ['metadataLanguage', 'parentalWarning', 'recordingType', 'genre'])
		expect(body).not.toContain(`name="${field}"`);
	expect(body).toContain('not a registered DDEX ID');
	expect(body).not.toContain('Download ERN');
});
it('renders readable preflight findings and no download for incomplete data', () => {
	const { body } = render(ExportPage, {
		props: props({
			values: testContext,
			ready: false,
			findings: [
				{
					kind: 'missing_required',
					path: 'release.metadataLanguage',
					target: 'Release: Fixture',
					message: 'Metadata language is missing.'
				}
			]
		})
	});
	expect(body).toContain('Metadata language is missing.');
	expect(body).toContain('Release: Fixture');
	expect(body).toContain('No XML was created.');
	expect(body).not.toContain('Download ERN');
});
it('offers only a not-for-delivery POST download after a successful preflight', () => {
	const { body } = render(ExportPage, {
		props: props({ values: testContext, ready: true, findings: [] })
	});
	expect(body).toContain('Download ERN — not for delivery');
	expect(body).toContain('/ern/download');
	expect(body).toContain('method="POST"');
});
