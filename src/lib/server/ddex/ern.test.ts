import { writeFileSync } from 'node:fs';
import { create } from 'xmlbuilder2';
import { describe, expect, it } from 'vitest';
import { completeErnFixture, fixtureId, testContext } from './ern.fixture';
import { generateErn, NOT_FOR_DELIVERY } from './ern';

const generate = (snapshot = completeErnFixture(), context: unknown = testContext) =>
	generateErn(snapshot, context, new Date('2026-11-17T12:00:00Z'), 'fixture-message');
const elements = (xml: string, name: string) =>
	create(xml).filter((n) => n.node.nodeName === name, false, true);

describe('ERN development generator', () => {
	it('creates escaped, namespace-correct test XML with preserved identifiers and duration', () => {
		const result = generate();
		expect(result.findings).toEqual([]);
		const xml = result.xml!;
		expect(xml).toContain(NOT_FOR_DELIVERY);
		const root = create(xml).root().node;
		expect('namespaceURI' in root && root.namespaceURI).toBe('http://ddex.net/xml/ern/43');
		const header = elements(xml, 'MessageHeader')[0].node;
		expect('namespaceURI' in header && header.namespaceURI).toBeNull();
		expect(elements(xml, 'MessageControlType')[0].node.textContent).toBe('TestMessage');
		expect(elements(xml, 'ICPN')[0].node.textContent).toBe('0123456789012');
		expect(elements(xml, 'Duration')[0].node.textContent).toBe('PT1.001S');
		expect(xml).toContain('Fixture &amp; &lt;sound&gt;');
		// Optional local proof destination; no generated catalogue XML is committed.
		if (process.env.ERN_PROOF_XML) writeFileSync(process.env.ERN_PROOF_XML, xml);
	});

	it('deduplicates resources while preserving repeated placements on different discs', () => {
		const snapshot = completeErnFixture();
		snapshot.tracks.push({ ...snapshot.tracks[0], disc: 2 });
		const xml = generate(snapshot).xml!;
		expect(elements(xml, 'SoundRecording')).toHaveLength(1);
		expect(elements(xml, 'ReleaseResourceReference')).toHaveLength(2);
		expect(elements(xml, 'ResourceGroup')).toHaveLength(3);
	});

	it('reports all missing durable facts without filling them from form context', () => {
		const snapshot = completeErnFixture();
		delete snapshot.release.metadataLanguage;
		delete snapshot.release.parentalWarning;
		delete snapshot.recordings[0].recordingType;
		snapshot.recordings[0].durationMs = null;
		const result = generate(snapshot);
		expect(result.xml).toBeNull();
		expect(result.findings.map((f) => f.path)).toEqual(
			expect.arrayContaining([
				'release.metadataLanguage',
				'release.parentalWarning',
				`recordings.${snapshot.recordings[0].id}.recordingType`,
				`recordings.${snapshot.recordings[0].id}.durationMs`
			])
		);
		expect(generate(snapshot, { ...testContext, metadataLanguage: 'en' }).xml).toBeNull();
	});

	it('denies cross-tenant entities and dangling recording references', () => {
		const snapshot = completeErnFixture();
		snapshot.parties[0].orgId = fixtureId(90);
		snapshot.tracks[0].recordingId = fixtureId(91);
		expect(generate(snapshot).findings.filter((f) => f.kind === 'invalid').length).toBeGreaterThan(
			1
		);
		expect(generate(snapshot).xml).toBeNull();
	});

	it('does not turn a generic writer, unapproved credit or compilation into an invented fact', () => {
		const snapshot = completeErnFixture();
		snapshot.release.type = 'compilation';
		snapshot.credits[1].role = 'writer';
		snapshot.credits[1].approvedAt = null;
		const result = generate(snapshot);
		expect(result.xml).toBeNull();
		expect(result.findings.map((f) => f.kind)).toEqual(
			expect.arrayContaining(['unmapped', 'ambiguous', 'missing_required'])
		);
	});

	it('keeps unsupported territory, deals, recording genres and ownership as findings', () => {
		const snapshot = completeErnFixture();
		snapshot.recordings[0].genre = 'Test recording genre';
		snapshot.rights.push({
			id: fixtureId(90),
			orgId: snapshot.orgId,
			territory: 'GB',
			recordingId: snapshot.recordings[0].id,
			compositionId: null
		});
		const result = generate(snapshot, {
			...testContext,
			territoryScope: 'GB',
			dealScope: 'Fixture-only scope'
		});
		expect(result.xml).toBeNull();
		expect(result.findings.map((f) => f.path)).toEqual(
			expect.arrayContaining([
				'context.scope',
				`rights.${fixtureId(90)}`,
				`recordings.${snapshot.recordings[0].id}.genre`
			])
		);
	});

	it('rejects XML-illegal text instead of deleting it or returning a partial download', () => {
		const snapshot = completeErnFixture();
		snapshot.release.title = 'Bad\u0000title';
		expect(generate(snapshot).xml).toBeNull();
		expect(generate(snapshot).findings.map((f) => f.path)).toContain('release.title');
	});

	it('serialises mapped recording contributors and referenced works without inventing identifiers', () => {
		const snapshot = completeErnFixture();
		snapshot.credits.push({
			...snapshot.credits[1],
			id: fixtureId(80),
			role: 'mastering',
			position: 1
		});
		snapshot.works.push({ id: fixtureId(81), orgId: snapshot.orgId, iswc: 'T1234567890' });
		snapshot.workLinks.push({
			orgId: snapshot.orgId,
			recordingId: snapshot.recordings[0].id,
			compositionId: fixtureId(81)
		});
		const xml = generate(snapshot).xml!;
		expect(elements(xml, 'Role')[0].node.textContent).toBe('MasteringEngineer');
		expect(elements(xml, 'ISWC')[0].node.textContent).toBe('T1234567890');
	});
});
