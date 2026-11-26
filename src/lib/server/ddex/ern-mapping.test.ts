import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { create } from 'xmlbuilder2';
import { expect, it } from 'vitest';
import { completeErnFixture, fixtureId, testContext } from './ern.fixture';
import {
	ERN_AVS_VERSION,
	ERN_NAMESPACE,
	generateErn,
	serializeErnXml,
	type ErnSnapshot
} from './ern';

let output = 0;
function run(snapshot = completeErnFixture(), context: unknown = testContext) {
	const result = generateErn(
		snapshot,
		context,
		new Date('2026-11-17T12:00:00Z'),
		'mapping-fixture'
	);
	if (result.xml && process.env.ERN_FIXTURE_DIR) {
		mkdirSync(process.env.ERN_FIXTURE_DIR, { recursive: true });
		writeFileSync(
			join(process.env.ERN_FIXTURE_DIR, `mapping-${String(++output).padStart(3, '0')}.xml`),
			result.xml
		);
	}
	return result;
}
const text = (xml: string, name: string) =>
	create(xml).find((n) => n.node.nodeName === name, false, true)?.node.textContent;
const blocked = (mutate: (snapshot: ErnSnapshot) => void, path: string) => {
	const snapshot = completeErnFixture();
	mutate(snapshot);
	const result = run(snapshot);
	expect(result.xml).toBeNull();
	expect(result.findings.some((f) => f.path.includes(path))).toBe(true);
};

it('M01: root namespace/AVS agree with the downloaded schema lock, with explicit catalogue language', () => {
	const lock = JSON.parse(readFileSync('docs/ddex/schema-lock.json', 'utf8'));
	expect(lock.avs_version).toBe(ERN_AVS_VERSION);
	expect(lock.namespace).toBe(ERN_NAMESPACE);
	expect(run().xml).toContain('LanguageAndScriptCode="en"');
	blocked((s) => {
		delete s.release.metadataLanguage;
	}, 'metadataLanguage');
});
it('M02: header carries explicit test identities, message ID and UTC creation time', () => {
	const xml = run().xml!;
	expect(text(xml, 'MessageId')).toBe('mapping-fixture');
	expect(text(xml, 'MessageCreatedDateTime')).toBe('2026-11-17T12:00:00.000Z');
	expect(xml).toContain(testContext.senderDpid);
	expect(xml).toContain(testContext.recipientDpid);
	expect(run(completeErnFixture(), { ...testContext, senderDpid: 'not-a-dpid' }).xml).toBeNull();
});
it('M03: label and party anchors stay distinct even when table UUIDs coincide', () => {
	const s = completeErnFixture();
	s.parties[0].id = s.label.id;
	for (const c of s.credits) c.partyId = s.label.id;
	const xml = run(s).xml!;
	expect(xml).toContain(`Plabel${s.label.id}`);
	expect(xml).toContain(`Pparty${s.label.id}`);
});
it.each([
	['single', 'Single'],
	['ep', 'EP'],
	['album', 'Album']
])('M04: %s maps to its allowed marketing type %s', (source, target) => {
	const s = completeErnFixture();
	s.release.type = source;
	expect(text(run(s).xml!, 'ReleaseType')).toBe(target);
});
it('M04: compilation cannot invent its missing ERN marketing form', () =>
	blocked((s) => {
		s.release.type = 'compilation';
	}, 'release.type'));
it('M05: missing genre, identifier namespace and invalid calendar date remain findings', () => {
	blocked((s) => {
		s.release.genre = null;
	}, 'release.genre');
	blocked((s) => {
		s.release.catalogNumber = 'FIXTURE-1';
	}, 'catalogNumber');
	blocked((s) => {
		s.release.releaseDate = '2026-02-31';
	}, 'releaseDate');
});
it('M06: two discs retain position 1, with one shared resource and typed component groups', () => {
	const s = completeErnFixture();
	s.tracks.push({ ...s.tracks[0], disc: 2 });
	const xml = run(s).xml!;
	expect(create(xml).filter((n) => n.node.nodeName === 'SoundRecording', false, true)).toHaveLength(
		1
	);
	expect(
		create(xml).filter((n) => n.node.nodeName === 'ReleaseResourceReference', false, true)
	).toHaveLength(2);
	expect(xml).toContain('ResourceGroupType="Component"');
	blocked((s) => {
		s.tracks.push({ ...s.tracks[0] });
	}, 'tracks.position');
});
it.each([
	[999, 'PT0.999S'],
	[1000, 'PT1S'],
	[3600000, 'PT3600S']
])('M07: %s milliseconds is losslessly represented as %s', (ms, want) => {
	const s = completeErnFixture();
	s.recordings[0].durationMs = ms as number;
	expect(text(run(s).xml!, 'Duration')).toBe(want);
});
it.each([null, 0, -1, 1.5])(
	'M07: missing or invalid duration %s does not become a guessed value',
	(ms) =>
		blocked((s) => {
			s.recordings[0].durationMs = ms;
		}, 'durationMs')
);
it('M08: absent warning/type are findings; explicit classifications are preserved', () => {
	blocked((s) => {
		delete s.release.parentalWarning;
	}, 'parentalWarning');
	blocked((s) => {
		delete s.recordings[0].recordingType;
	}, 'recordingType');
	const s = completeErnFixture();
	s.recordings[0].parentalWarning = 'ExplicitContentEdited';
	expect(text(run(s).xml!, 'ParentalWarningType')).toBe('ExplicitContentEdited');
});
it('M09: incomplete/unapproved artists and an unqualified writer never become approved main artists', () => {
	blocked((s) => {
		s.credits[0].approvedAt = null;
	}, 'credits.');
	blocked((s) => {
		s.credits[1].role = 'writer';
	}, '.role');
	blocked((s) => {
		s.release.displayArtistName = null;
	}, 'displayArtistName');
});
it('M10: recording genre cannot be silently dropped or given the album UPC as a track identity', () =>
	blocked((s) => {
		s.recordings[0].genre = 'Fixture genre';
	}, '.genre'));
it('M11: confirmed linked ISWC is retained, but missing work IDs and writer shares are findings', () => {
	const s = completeErnFixture();
	s.works.push({ id: fixtureId(80), orgId: s.orgId, iswc: 'T1234567890' });
	s.workLinks.push({
		orgId: s.orgId,
		recordingId: s.recordings[0].id,
		compositionId: fixtureId(80)
	});
	expect(text(run(s).xml!, 'ISWC')).toBe('T1234567890');
	s.works[0].iswc = null;
	expect(run(s).xml).toBeNull();
	blocked((s) => {
		s.writers.push({
			id: fixtureId(81),
			orgId: s.orgId,
			compositionId: fixtureId(80),
			partyId: s.parties[0].id,
			role: 'composer',
			share: '100.0000'
		});
	}, 'writers.');
});
it('M12–M14: ownership and contract-like scope are not deals or worldwide permissions', () => {
	blocked((s) => {
		s.rights.push(
			{
				id: fixtureId(80),
				orgId: s.orgId,
				territory: 'WW',
				recordingId: s.recordings[0].id,
				compositionId: null
			},
			{
				id: fixtureId(81),
				orgId: s.orgId,
				territory: 'GB',
				recordingId: s.recordings[0].id,
				compositionId: null
			}
		);
	}, 'rights.');
	expect(
		run(completeErnFixture(), {
			...testContext,
			territoryScope: 'GB',
			dealScope: 'Fixture-only scope'
		}).xml
	).toBeNull();
	expect(run().xml).not.toContain('DealList');
});
it('M15: a complete metadata fixture has no delivery file or network/storage location', () => {
	const xml = run().xml!;
	expect(xml).not.toContain('<File>');
	expect(xml).not.toContain('TechnicalDetails');
	expect(xml).not.toContain('https://');
});

it('keeps entity-shaped text literal in schema-validated export fixtures', () => {
	const snapshot = completeErnFixture();
	const title = 'Title &copy; &amp; < > " \'';
	const artist = 'Artist &copy; &amp; < > " \'';
	snapshot.release.title = title;
	snapshot.recordings[0].title = title;
	snapshot.parties[0].displayName = artist;
	snapshot.release.displayArtistName = artist;
	snapshot.recordings[0].displayArtistName = artist;
	const result = run(snapshot);
	expect(result.findings).toEqual([]);
	expect(text(result.xml!, 'TitleText')).toBe(title);
	expect(
		create(result.xml!)
			.filter((n) => n.node.nodeName === 'FullName', false, true)
			.map((n) => n.node.textContent)
	).toContain(artist);
	expect(text(result.xml!, 'DisplayArtistName')).toBe(artist);
	expect(result.xml).toContain('&amp;copy; &amp;amp; &lt; &gt;');
});

it('uses the same escaping for copyright text and attributes without adding new export fields', () => {
	const value = 'Copyright &copy; &amp; < > " \'';
	const doc = create();
	doc.ele('CLine').att('Example', value).ele('CLineText').txt(value);
	const xml = serializeErnXml(doc);
	expect(text(xml, 'CLineText')).toBe(value);
	expect(xml).toContain('Example="Copyright &amp;copy; &amp;amp; &lt; &gt; &quot;');
	const root = create(xml).root().node;
	expect(
		'getAttribute' in root && typeof root.getAttribute === 'function'
			? root.getAttribute('Example')
			: undefined
	).toBe(value);
	const numeric = create();
	numeric.ele('Text').txt('&#65;');
	expect(serializeErnXml(numeric)).toContain('&amp;#65;');
});

it('does not duplicate a version already in the display title', () => {
	const snapshot = completeErnFixture();
	snapshot.release.title = 'Release (Radio Edit)';
	snapshot.release.versionTitle = 'Radio Edit';
	const xml = run(snapshot).xml!;
	expect(xml).toContain('<DisplayTitleText>Release (Radio Edit)</DisplayTitleText>');
	expect(xml).toContain('<SubTitle>Radio Edit</SubTitle>');
});

it('accepts the ERN language pattern on both the release and recording', () => {
	const snapshot = completeErnFixture();
	snapshot.release.metadataLanguage = 'en-Latn-US';
	snapshot.recordings[0].metadataLanguage = 'en-Latn-US';
	expect(run(snapshot).xml?.match(/LanguageAndScriptCode="en-Latn-US"/g)).toHaveLength(2);
	blocked((s) => {
		s.release.metadataLanguage = 'en-1234';
	}, 'release.metadataLanguage');
	blocked((s) => {
		s.recordings[0].metadataLanguage = 'en-1234';
	}, 'metadataLanguage');
});
