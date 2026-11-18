import { randomUUID } from 'node:crypto';
import { create } from 'xmlbuilder2';
import { z } from 'zod';

export const ERN_NAMESPACE = 'http://ddex.net/xml/ern/43';
export const ERN_AVS_VERSION = '12';
export const TEST_SENDER_DPID = 'PADPIDATESTONLY';
export const NOT_FOR_DELIVERY = 'Development export — not for delivery';
const dpid = z
	.string()
	.max(100)
	.regex(/^PADPIDA[a-zA-Z0-9]+$/, 'Enter a DDEX party ID.');
export const ExportContext = z
	.object({
		senderDpid: dpid,
		recipientDpid: dpid,
		territoryScope: z.string().max(2000).default(''),
		dealScope: z.string().max(2000).default('')
	})
	.strict();
export type ErnContext = z.infer<typeof ExportContext>;
export type Finding = {
	kind: 'missing_required' | 'unmapped' | 'ambiguous' | 'invalid';
	path: string;
	message: string;
	target?: string;
};
export type ErnWarning = 'Explicit' | 'ExplicitContentEdited' | 'NoAdviceAvailable' | 'NotExplicit';
export type ErnRecordingType =
	'MusicalWorkSoundRecording' | 'NonMusicalWorkSoundRecording' | 'SpokenWordSoundRecording';
type Entity = { id: string; orgId: string };
type Title = { title: string; versionTitle: string | null };
type DurableFacts = {
	metadataLanguage?: string | null;
	parentalWarning?: ErnWarning | null;
	displayArtistName?: string | null;
};
export type ErnSnapshot = {
	orgId: string;
	release: Entity &
		Title &
		DurableFacts & {
			labelId: string;
			upc: string;
			catalogNumber: string | null;
			type: string;
			releaseDate: string | null;
			genre: string | null;
			subgenre: string | null;
		};
	label: Entity & { name: string };
	tracks: {
		orgId: string;
		releaseId: string;
		recordingId: string;
		disc: number;
		position: number;
	}[];
	recordings: (Entity &
		Title &
		DurableFacts & {
			isrc: string;
			durationMs: number | null;
			genre: string | null;
			subgenre: string | null;
			recordingType?: ErnRecordingType | null;
		})[];
	parties: (Entity & { displayName: string })[];
	credits: (Entity & {
		releaseId: string | null;
		recordingId: string | null;
		partyId: string;
		role: string;
		position: number;
		approvedAt: string | Date | null;
	})[];
	workLinks: { orgId: string; recordingId: string; compositionId: string }[];
	works: (Entity & { iswc: string | null })[];
	writers: (Entity & { compositionId: string; partyId: string; role: string; share: string })[];
	rights: (Entity & {
		territory: string;
		recordingId: string | null;
		compositionId: string | null;
	})[];
};
const RELEASE_TYPES: Record<string, string> = { single: 'Single', ep: 'EP', album: 'Album' };
const CONTRIBUTORS: Record<string, string> = {
	remixer: 'Remixer',
	producer: 'Producer',
	composer: 'Composer',
	mixer: 'MixingEngineer',
	mastering: 'MasteringEngineer'
};
const WARNINGS = new Set(['Explicit', 'ExplicitContentEdited', 'NoAdviceAvailable', 'NotExplicit']);
const RECORDING_TYPES = new Set([
	'MusicalWorkSoundRecording',
	'NonMusicalWorkSoundRecording',
	'SpokenWordSoundRecording'
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const validText = (value: unknown): value is string =>
	typeof value === 'string' &&
	value.trim().length > 0 &&
	[...value].every((c) => {
		const cp = c.codePointAt(0)!;
		return (
			cp === 9 ||
			cp === 10 ||
			cp === 13 ||
			(cp >= 32 && !(cp >= 0xd800 && cp <= 0xdfff) && cp !== 0xfffe && cp !== 0xffff)
		);
	});
const anchor = (prefix: string, id: string) => `${prefix}${id}`;
const displayTitle = (row: Title) =>
	row.versionTitle ? `${row.title} (${row.versionTitle})` : row.title;
const duration = (ms: number) =>
	`PT${Math.floor(ms / 1000)}${ms % 1000 ? `.${String(ms % 1000).padStart(3, '0')}` : ''}S`;

/** Pure preflight/generator. Context can never override durable catalogue facts. */
export function generateErn(
	snapshot: ErnSnapshot,
	input: unknown,
	now = new Date(),
	messageId: string = randomUUID()
): { findings: Finding[]; xml: string | null } {
	const findings: Finding[] = [];
	const add = (kind: Finding['kind'], path: string, message: string) => {
		const recording = snapshot.recordings.find((r) => path.startsWith(`recordings.${r.id}`));
		const contextLabels: Record<string, string> = {
			'context.senderDpid': 'Sender DDEX party ID',
			'context.recipientDpid': 'Recipient DDEX party ID',
			'context.scope': 'Deal and territory scope'
		};
		const target =
			contextLabels[path] ??
			(recording
				? `Recording: ${recording.title}`
				: path.startsWith('release.')
					? `Release: ${snapshot.release.title}`
					: 'Export');
		findings.push({ kind, path, message, target });
	};
	const context = ExportContext.safeParse(input);
	if (!context.success)
		for (const issue of context.error.issues)
			add('invalid', `context.${issue.path.join('.')}`, issue.message);
	const entities = [
		snapshot.release,
		snapshot.label,
		...snapshot.recordings,
		...snapshot.parties,
		...snapshot.credits,
		...snapshot.works,
		...snapshot.writers,
		...snapshot.rights
	];
	for (const entity of entities) {
		if (entity.orgId !== snapshot.orgId || !UUID.test(entity.id))
			add('invalid', 'catalogue', 'The export contains an invalid or cross-label reference.');
	}
	if (snapshot.release.labelId !== snapshot.label.id)
		add('invalid', 'release.labelId', 'The release label does not match.');
	const recordings = new Map(snapshot.recordings.map((r) => [r.id, r]));
	const parties = new Map(snapshot.parties.map((p) => [p.id, p]));
	const works = new Map(snapshot.works.map((w) => [w.id, w]));
	if (
		recordings.size !== snapshot.recordings.length ||
		parties.size !== snapshot.parties.length ||
		works.size !== snapshot.works.length
	)
		add('ambiguous', 'catalogue', 'Duplicate source identities must be resolved.');
	if (new Set(snapshot.recordings.map((r) => r.isrc)).size !== snapshot.recordings.length)
		add('ambiguous', 'recordings.isrc', 'Different recordings share an ISRC.');
	const positions = new Set<string>();
	const used = new Set<string>();
	for (const track of snapshot.tracks) {
		const position = `${track.disc}:${track.position}`;
		if (
			track.orgId !== snapshot.orgId ||
			track.releaseId !== snapshot.release.id ||
			!recordings.has(track.recordingId)
		)
			add('invalid', 'tracks', 'A track has an invalid or cross-label recording reference.');
		if (
			!Number.isInteger(track.disc) ||
			!Number.isInteger(track.position) ||
			track.disc < 1 ||
			track.position < 1 ||
			positions.has(position)
		)
			add('invalid', 'tracks.position', 'Disc and track positions must be positive and unique.');
		positions.add(position);
		used.add(track.recordingId);
	}
	if (!snapshot.tracks.length)
		add('missing_required', 'tracks', 'Add tracks before exporting this release.');
	for (const row of snapshot.recordings)
		if (!used.has(row.id))
			add('invalid', `recordings.${row.id}`, 'The snapshot includes an unrelated recording.');
	if (!/^[0-9]{12,13}$/.test(snapshot.release.upc))
		add('invalid', 'release.upc', 'A canonical UPC is required.');
	if (!RELEASE_TYPES[snapshot.release.type])
		add(
			'unmapped',
			'release.type',
			'The release marketing form is not mapped; compilation needs separate catalogue facts.'
		);
	if (snapshot.release.catalogNumber)
		add(
			'unmapped',
			'release.catalogNumber',
			'The catalogue number needs its controlling identifier namespace.'
		);
	if (!validText(snapshot.label.name))
		add('missing_required', 'label.name', 'The label name is required.');
	for (const party of snapshot.parties)
		if (!validText(party.displayName))
			add('invalid', `parties.${party.id}.displayName`, 'A valid party name is required.');
	const creditsFor = (id: string, release: boolean) =>
		snapshot.credits
			.filter((c) => (release ? c.releaseId === id : c.recordingId === id))
			.sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
	for (const credit of snapshot.credits) {
		if (
			!parties.has(credit.partyId) ||
			(credit.releaseId === null) === (credit.recordingId === null) ||
			(credit.releaseId !== null && credit.releaseId !== snapshot.release.id) ||
			(credit.recordingId !== null && !used.has(credit.recordingId)) ||
			!Number.isInteger(credit.position) ||
			credit.position < 0
		)
			add('invalid', `credits.${credit.id}`, 'A credit has an invalid target, party or sequence.');
		if (!credit.approvedAt)
			add('ambiguous', `credits.${credit.id}`, 'Approve the credit before exporting it.');
		if (!['main', 'featured', ...Object.keys(CONTRIBUTORS)].includes(credit.role))
			add('unmapped', `credits.${credit.id}.role`, 'The credit role is ambiguous or unmapped.');
		if (credit.releaseId && CONTRIBUTORS[credit.role])
			add(
				'unmapped',
				`credits.${credit.id}`,
				'This non-display release credit has no agreed ERN destination.'
			);
	}
	const checkTitle = (row: Title & DurableFacts, path: string, list: ErnSnapshot['credits']) => {
		if (!validText(row.title) || (row.versionTitle !== null && !validText(row.versionTitle)))
			add('invalid', `${path}.title`, 'Valid title and version text are required.');
		if (
			(path === 'release' || row.metadataLanguage) &&
			(!row.metadataLanguage || !/^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})*$/.test(row.metadataLanguage))
		)
			add(
				'missing_required',
				`${path}.metadataLanguage`,
				'Metadata language is missing from the catalogue.'
			);
		if (!row.parentalWarning || !WARNINGS.has(row.parentalWarning))
			add(
				'missing_required',
				`${path}.parentalWarning`,
				'Explicit-content classification is missing from the catalogue.'
			);
		if (!validText(row.displayArtistName))
			add(
				'missing_required',
				`${path}.displayArtistName`,
				'The confirmed display-artist text is missing from the catalogue.'
			);
		if (!list.some((c) => c.role === 'main' && c.approvedAt))
			add('missing_required', `${path}.artists`, 'An approved main artist is required.');
	};
	checkTitle(snapshot.release, 'release', creditsFor(snapshot.release.id, true));
	if (
		!validText(snapshot.release.genre) ||
		(snapshot.release.subgenre !== null && !validText(snapshot.release.subgenre))
	)
		add('missing_required', 'release.genre', 'Release genre is missing or invalid.');
	if (
		snapshot.release.releaseDate &&
		(!/^\d{4}-\d{2}-\d{2}$/.test(snapshot.release.releaseDate) ||
			!Number.isFinite(Date.parse(snapshot.release.releaseDate)) ||
			new Date(snapshot.release.releaseDate).toISOString().slice(0, 10) !==
				snapshot.release.releaseDate)
	)
		add('invalid', 'release.releaseDate', 'The release date is invalid.');
	for (const recording of snapshot.recordings) {
		const path = `recordings.${recording.id}`;
		checkTitle(recording, path, creditsFor(recording.id, false));
		if (!/^[A-Z]{2}[A-Z0-9]{3}[0-9]{7}$/.test(recording.isrc))
			add('invalid', `${path}.isrc`, 'A canonical ISRC is required.');
		if (!Number.isSafeInteger(recording.durationMs) || recording.durationMs! <= 0)
			add('missing_required', `${path}.durationMs`, 'A confirmed positive duration is required.');
		if (!recording.recordingType || !RECORDING_TYPES.has(recording.recordingType))
			add(
				'missing_required',
				`${path}.recordingType`,
				'Recording type is missing from the catalogue.'
			);
		if (recording.genre || recording.subgenre)
			add(
				'unmapped',
				`${path}.genre`,
				'Recording genre needs a track product with its own confirmed identifier; it cannot be dropped.'
			);
	}
	for (const link of snapshot.workLinks) {
		if (
			link.orgId !== snapshot.orgId ||
			!used.has(link.recordingId) ||
			!works.has(link.compositionId)
		)
			add('invalid', 'works', 'A work has an invalid or cross-label reference.');
	}
	for (const work of snapshot.works)
		if (!work.iswc || !/^T[0-9]{10}$/.test(work.iswc))
			add(
				'unmapped',
				`works.${work.id}.iswc`,
				'A linked work cannot be identified without a confirmed ISWC.'
			);
	for (const writer of snapshot.writers)
		add(
			'unmapped',
			`writers.${writer.id}`,
			'Work-specific writer shares cannot be flattened into recording credits.'
		);
	for (const right of snapshot.rights)
		add(
			'unmapped',
			`rights.${right.id}`,
			'Ownership and its territorial scope need an agreed rights-controller mapping; no deal is inferred.'
		);
	if (context.success && (context.data.dealScope.trim() || context.data.territoryScope.trim()))
		add(
			'unmapped',
			'context.scope',
			'Commercial or territorial scope requires a partner/deal mapping; this development export creates no deals.'
		);
	if (!Number.isFinite(now.getTime()) || !validText(messageId))
		add('invalid', 'message', 'The export clock or message identifier is invalid.');
	if (findings.length || !context.success) return { findings, xml: null };

	try {
		const doc = create({ version: '1.0', encoding: 'UTF-8' });
		doc.com(NOT_FOR_DELIVERY);
		const root = doc
			.ele(ERN_NAMESPACE, 'ern:NewReleaseMessage')
			.att('AvsVersionId', ERN_AVS_VERSION)
			.att('LanguageAndScriptCode', snapshot.release.metadataLanguage!);
		const header = root.ele('MessageHeader');
		header.ele('MessageId').txt(messageId);
		header.ele('MessageSender').ele('PartyId').txt(context.data.senderDpid);
		header.ele('MessageRecipient').ele('PartyId').txt(context.data.recipientDpid);
		header.ele('MessageCreatedDateTime').txt(now.toISOString());
		header.ele('MessageControlType').txt('TestMessage');
		const partyList = root.ele('PartyList');
		for (const row of [
			{ id: anchor('Plabel', snapshot.label.id), name: snapshot.label.name },
			...snapshot.parties.map((p) => ({ id: anchor('Pparty', p.id), name: p.displayName }))
		].sort((a, b) => a.id.localeCompare(b.id))) {
			const party = partyList.ele('Party');
			party.ele('PartyReference').txt(row.id);
			party.ele('PartyName').ele('FullName').txt(row.name);
		}
		type Builder = ReturnType<typeof create>;
		const titles = (node: Builder, row: Title) => {
			node.ele('DisplayTitleText').txt(displayTitle(row));
			const title = node.ele('DisplayTitle');
			title.ele('TitleText').txt(row.title);
			if (row.versionTitle) title.ele('SubTitle').txt(row.versionTitle);
		};
		const artists = (node: Builder, row: DurableFacts, list: ErnSnapshot['credits']) => {
			node.ele('DisplayArtistName').txt(row.displayArtistName!);
			let order = 0;
			for (const c of list.filter((c) => c.role === 'main' || c.role === 'featured')) {
				const artist = node.ele('DisplayArtist').att('SequenceNumber', String(++order));
				artist.ele('ArtistPartyReference').txt(anchor('Pparty', c.partyId));
				artist.ele('DisplayArtistRole').txt(c.role === 'main' ? 'MainArtist' : 'FeaturedArtist');
			}
		};
		const resources = root.ele('ResourceList');
		for (const row of [...snapshot.recordings].sort((a, b) => a.id.localeCompare(b.id))) {
			const recording = resources.ele('SoundRecording');
			if (row.metadataLanguage) recording.att('LanguageAndScriptCode', row.metadataLanguage);
			recording.ele('ResourceReference').txt(anchor('A', row.id));
			recording.ele('Type').txt(row.recordingType!);
			recording.ele('SoundRecordingEdition').ele('ResourceId').ele('ISRC').txt(row.isrc);
			for (const link of snapshot.workLinks
				.filter((l) => l.recordingId === row.id)
				.sort((a, b) => a.compositionId.localeCompare(b.compositionId)))
				recording.ele('WorkId').ele('ISWC').txt(works.get(link.compositionId)!.iswc!);
			titles(recording, row);
			const list = creditsFor(row.id, false);
			artists(recording, row, list);
			let sequence = 0;
			for (const c of list.filter((c) => CONTRIBUTORS[c.role])) {
				const contributor = recording.ele('Contributor').att('SequenceNumber', String(++sequence));
				contributor.ele('ContributorPartyReference').txt(anchor('Pparty', c.partyId));
				contributor.ele('Role').txt(CONTRIBUTORS[c.role]);
			}
			recording.ele('Duration').txt(duration(row.durationMs!));
			recording.ele('ParentalWarningType').txt(row.parentalWarning!);
		}
		const release = root.ele('ReleaseList').ele('Release');
		release.ele('ReleaseReference').txt(anchor('R', snapshot.release.id));
		release.ele('ReleaseType').txt(RELEASE_TYPES[snapshot.release.type]);
		release.ele('ReleaseId').ele('ICPN').txt(snapshot.release.upc);
		titles(release, snapshot.release);
		artists(release, snapshot.release, creditsFor(snapshot.release.id, true));
		release.ele('ReleaseLabelReference').txt(anchor('Plabel', snapshot.label.id));
		const genre = release.ele('Genre');
		genre.ele('GenreText').txt(snapshot.release.genre!);
		if (snapshot.release.subgenre) genre.ele('SubGenre').txt(snapshot.release.subgenre);
		if (snapshot.release.releaseDate) release.ele('ReleaseDate').txt(snapshot.release.releaseDate);
		release.ele('ParentalWarningType').txt(snapshot.release.parentalWarning!);
		const group = release.ele('ResourceGroup');
		const discs = [...new Set(snapshot.tracks.map((t) => t.disc))].sort((a, b) => a - b);
		for (const disc of discs) {
			const sub =
				discs.length === 1 && disc === 1
					? group
					: group.ele('ResourceGroup').att('ResourceGroupType', 'Component');
			sub.ele('SequenceNumber').txt(String(disc));
			for (const track of snapshot.tracks
				.filter((t) => t.disc === disc)
				.sort((a, b) => a.position - b.position)) {
				const item = sub.ele('ResourceGroupContentItem');
				item.ele('SequenceNumber').txt(String(track.position));
				item.ele('ReleaseResourceReference').txt(anchor('A', track.recordingId));
			}
		}
		return { findings: [], xml: doc.end({ prettyPrint: true }) };
	} catch {
		return {
			findings: [
				{
					kind: 'invalid',
					path: 'catalogue',
					message: 'Catalogue text could not be represented as XML.'
				}
			],
			xml: null
		};
	}
}
