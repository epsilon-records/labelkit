/** Entirely fictional, in-memory ERN test fixture; never inserted into a runtime catalogue. */
import type { ErnSnapshot } from './ern';
export const fixtureId = (n: number) => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;
export const testContext = {
	senderDpid: 'PADPIDATESTONLY',
	recipientDpid: 'PADPIDATESTRECIPIENT',
	territoryScope: '',
	dealScope: ''
};
export function completeErnFixture(): ErnSnapshot {
	const orgId = fixtureId(1),
		labelId = fixtureId(2),
		releaseId = fixtureId(3),
		recordingId = fixtureId(4),
		partyId = fixtureId(5);
	const title = { title: 'Fixture & <sound>', versionTitle: 'Test version' };
	const facts = {
		metadataLanguage: 'en',
		parentalWarning: 'NotExplicit' as const,
		displayArtistName: 'Fixture & Company'
	};
	return {
		orgId,
		release: {
			id: releaseId,
			orgId,
			labelId,
			upc: '0123456789012',
			catalogNumber: null,
			type: 'single',
			releaseDate: '2026-11-17',
			genre: 'Test genre',
			subgenre: null,
			...title,
			...facts
		},
		label: { id: labelId, orgId, name: 'Fixture label' },
		tracks: [{ orgId, releaseId, recordingId, disc: 1, position: 1 }],
		recordings: [
			{
				id: recordingId,
				orgId,
				isrc: 'ZZTST2600001',
				durationMs: 1001,
				genre: null,
				subgenre: null,
				recordingType: 'MusicalWorkSoundRecording',
				...title,
				...facts
			}
		],
		parties: [{ id: partyId, orgId, displayName: 'Fixture & Company' }],
		credits: [
			{
				id: fixtureId(6),
				orgId,
				releaseId,
				recordingId: null,
				partyId,
				role: 'main',
				position: 0,
				approvedAt: '2026-11-17T00:00:00Z'
			},
			{
				id: fixtureId(7),
				orgId,
				releaseId: null,
				recordingId,
				partyId,
				role: 'main',
				position: 0,
				approvedAt: '2026-11-17T00:00:00Z'
			}
		],
		workLinks: [],
		works: [],
		writers: [],
		rights: []
	};
}
