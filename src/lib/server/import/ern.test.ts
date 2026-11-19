import { expect, it } from 'vitest';
import { generateErn } from '../ddex/ern';
import { completeErnFixture, testContext } from '../ddex/ern.fixture';
import { parseErnDocuments } from './ern';
import { MAX_IMPORT_BYTES, readErnUpload } from './ern-upload';

function xml() {
	const snapshot = completeErnFixture();
	snapshot.release.upc = '012345678905';
	snapshot.tracks.push({ ...snapshot.tracks[0], disc: 2 });
	const generated = generateErn(snapshot, testContext);
	expect(generated.findings).toEqual([]);
	return generated.xml!;
}

it('reads the exported UPC, ISRC, fractional duration, artists and disc positions', () => {
	const plan = parseErnDocuments([{ name: 'release.xml', text: xml() }]);
	expect(plan.issues.filter((issue) => issue.level === 'error')).toEqual([]);
	expect(plan.labels).toEqual(['Fixture label']);
	expect(Array.from(plan.parties.values())).toEqual(['Fixture & Company']);
	expect(plan.recordings.get('ZZTST2600001')).toMatchObject({
		title: 'Fixture & <sound>',
		durationMs: 1001,
		credits: [{ name: 'Fixture & Company', role: 'main', position: 0 }]
	});
	expect(plan.releases.get('012345678905')).toMatchObject({
		genre: 'Test genre',
		releaseCredits: [{ name: 'Fixture & Company', role: 'main', position: 0 }],
		tracks: [
			{ disc: 1, position: 1, isrc: 'ZZTST2600001' },
			{ disc: 2, position: 1, isrc: 'ZZTST2600001' }
		]
	});
});

it('reports individual rights, territories, shares and deal paths without importing them', () => {
	const source = xml()
		.replace(
			'</SoundRecording>',
			'<ResourceRightsController><RightSharePercentage>25</RightSharePercentage></ResourceRightsController></SoundRecording>'
		)
		.replace(
			'</ern:NewReleaseMessage>',
			'<DealList><ReleaseDeal><Deal><DealTerms><TerritoryCode>NL</TerritoryCode></DealTerms></Deal></ReleaseDeal></DealList></ern:NewReleaseMessage>'
		);
	const plan = parseErnDocuments([{ name: 'rights.xml', text: source }]);
	expect(plan.issues.filter((issue) => issue.level === 'error')).toEqual([]);
	for (const element of [
		'ResourceRightsController',
		'RightSharePercentage',
		'DealTerms',
		'TerritoryCode'
	]) {
		expect(
			plan.issues.some((issue) => issue.message.includes('/' + element + '[1] was not imported.'))
		).toBe(true);
	}
	expect(plan).not.toHaveProperty('rights');
});

it('blocks conflicting catalogue records, broken references and unsupported XML', () => {
	const source = xml();
	const cases = [
		[{ name: 'invalid.xml', text: '<!DOCTYPE ern>' + source }],
		[{ name: 'invalid.xml', text: source.replaceAll('xml/ern/43', 'xml/ern/42') }],
		[
			{
				name: 'invalid.xml',
				text: source.replace(/<ReleaseResourceReference>[^<]+/, '<ReleaseResourceReference>missing')
			}
		],
		[
			{ name: 'one.xml', text: source },
			{ name: 'two.xml', text: source.replaceAll('Fixture &amp; &lt;sound&gt;', 'Other title') }
		]
	];
	for (const docs of cases) {
		expect(parseErnDocuments(docs).issues.some((issue) => issue.level === 'error')).toBe(true);
	}
});

it('reads UTF-8 XML and ZIP entries and rejects invalid or oversized uploads', async () => {
	const zip = Buffer.from(
		'UEsDBBQAAAAIAAAAIQCB58AKCgAAAAgAAAAJAAAAZmlyc3QueG1ss0nLLCou0bcDAFBLAwQUAAAACAAAACEAO4kFBwsAAAAJAAAAEQAAAGZvbGRlci9zZWNvbmQueG1ssylOTc7PS9G3AwBQSwECFAMUAAAACAAAACEAgefACgoAAAAIAAAACQAAAAAAAAAAAAAAgAEAAAAAZmlyc3QueG1sUEsBAhQDFAAAAAgAAAAhADuJBQcLAAAACQAAABEAAAAAAAAAAAAAAIABMQAAAGZvbGRlci9zZWNvbmQueG1sUEsFBgAAAAACAAIAdgAAAGsAAAAAAA==',
		'base64'
	);
	await expect(readErnUpload('releases.zip', zip)).resolves.toEqual([
		{ name: 'first.xml', text: '<first/>' },
		{ name: 'folder/second.xml', text: '<second/>' }
	]);
	await expect(readErnUpload('message.xml', Buffer.from('<first/>'))).resolves.toEqual([
		{ name: 'message.xml', text: '<first/>' }
	]);
	await expect(readErnUpload('bad.zip', Buffer.from('bad'))).rejects.toThrow('could not be read');
	await expect(readErnUpload('too-large.xml', Buffer.alloc(MAX_IMPORT_BYTES + 1))).rejects.toThrow(
		'5 MB'
	);
});
