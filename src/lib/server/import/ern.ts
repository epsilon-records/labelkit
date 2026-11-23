import { create } from 'xmlbuilder2';
import { ERN_NAMESPACE } from '../ddex/ern';
import { isValidGtin, isValidIsrc, normalizeIsrc, partyMatchKey } from './identifiers';
import type { ImportPlan, PlannedCredit, PlannedRecording, PlannedRelease } from './symphonic';

export type ErnDocument = { name: string; text: string };

type Element = {
	nodeType: 1;
	localName: string;
	namespaceURI: string | null;
	textContent: string | null;
	childNodes: ArrayLike<{ nodeType: number }>;
	getAttribute(name: string): string | null;
};

type DomDocument = { documentElement: Element | null };

const elements = (node: Element | undefined) =>
	Array.from(node?.childNodes ?? []).filter((item) => item.nodeType === 1) as Element[];
const children = (node: Element | undefined, tag?: string) =>
	elements(node).filter(
		(child) =>
			(!child.namespaceURI || child.namespaceURI === ERN_NAMESPACE) &&
			(!tag || child.localName === tag)
	);
const child = (node: Element | undefined, tag: string) => children(node, tag)[0];
const text = (node: Element | undefined, tag: string) =>
	child(node, tag)?.textContent?.trim() || '';
const INT_MAX = 2147483647;

class InvalidErn extends Error {}

function required(value: string, label: string): string {
	if (!value) throw new InvalidErn('Missing ' + label + '.');
	return value;
}

function positive(raw: string, label: string): number {
	const n = Number(raw);
	if (!/^\d+$/.test(raw) || n < 1 || n > INT_MAX) {
		throw new InvalidErn('Invalid ' + label + '.');
	}
	return n;
}

function duration(raw: string): number | null {
	if (!raw) return null;
	const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)(?:\.(\d+))?S)?$/.exec(raw);
	if (!match) throw new InvalidErn('Recording duration must use ISO hours, minutes and seconds.');
	const [, h = '0', m = '0', s = '0', fraction = ''] = match;
	const ms =
		((Number(h) * 60 + Number(m)) * 60 + Number(s)) * 1000 +
		Number(fraction.slice(0, 3).padEnd(3, '0'));
	if (ms < 1 || ms > INT_MAX || /[1-9]/.test(fraction.slice(3))) {
		throw new InvalidErn('Recording duration must be positive and representable in milliseconds.');
	}
	return ms;
}

function date(raw: string): string | null {
	if (!raw) return null;
	const parsed = new Date(raw);
	if (
		!/^[1-9]\d{3}-\d{2}-\d{2}$/.test(raw) ||
		!Number.isFinite(+parsed) ||
		parsed.toISOString().slice(0, 10) !== raw
	) {
		throw new InvalidErn('ReleaseDate must be a complete calendar date.');
	}
	return raw;
}

function title(node: Element) {
	const composite = child(node, 'DisplayTitle');
	return {
		title: required(
			text(composite, 'TitleText') || text(node, 'DisplayTitleText'),
			'display title'
		),
		versionTitle: text(composite, 'SubTitle') || null
	};
}

function genre(node: Element) {
	const composite = child(node, 'Genre');
	return {
		genre: text(composite, 'GenreText') || null,
		subgenre: text(composite, 'SubGenre') || null
	};
}

function put<T>(map: Map<string, T>, key: string, value: T, kind: string) {
	const previous = map.get(key);
	if (previous !== undefined && JSON.stringify(previous) !== JSON.stringify(value)) {
		throw new InvalidErn('Conflicting ' + kind + ' for ' + key + '.');
	}
	map.set(key, value);
}

const releaseTypes = new Map<string, PlannedRelease['type']>([
	['Single', 'single'],
	['EP', 'ep'],
	['Album', 'album'],
	['Compilation', 'compilation']
]);
const artistRoles = new Map<string, PlannedCredit['role']>([
	['MainArtist', 'main'],
	['FeaturedArtist', 'featured']
]);
const contributorRoles = new Map<string, PlannedCredit['role']>([
	['Remixer', 'remixer'],
	['Producer', 'producer'],
	['Composer', 'composer'],
	['MixingEngineer', 'mixer'],
	['MasteringEngineer', 'mastering']
]);

// Record unsupported data by XML path, never as ownership or commercial instructions.
const unmapped =
	/^(?:.*Rights.*|.*Territor.*|.*Share.*|.*Deal.*|CommercialModelType|UseType|ValidityPeriod|PartyId|Name\w*Variant|ProprietaryId|WorkId|ParentalWarningType|[PC]Line|Technical\w*|Image|Video|TrackRelease|DisplayArtistName|LanguageOfPerformance|OriginalReleaseDate)$/i;

function losses(root: Element, report: (code: string, message: string) => void) {
	const pending: { node: Element; path: string; depth: number }[] = [
		{ node: root, path: root.localName, depth: 1 }
	];
	let count = 0;
	while (pending.length) {
		const { node, path, depth } = pending.pop()!;
		if (++count > 20000 || depth > 32) throw new InvalidErn('ERN message is too complex.');
		if (unmapped.test(node.localName)) report('ern.unmapped', path + ' was not imported.');
		if (node.localName === 'ReleaseDate' && node.getAttribute('ApplicableTerritoryCode')) {
			report('ern.unmapped', path + '/@ApplicableTerritoryCode was not imported.');
		}
		if (node.getAttribute('LanguageAndScriptCode')) {
			report('ern.unmapped', path + '/@LanguageAndScriptCode was not imported.');
		}
		if (node.localName === 'SoundRecording' && text(node, 'Type')) {
			report('ern.unmapped', path + '/Type was not imported.');
		}
		const items = elements(node);
		for (const tag of ['DisplayTitle', 'Genre', 'PartyName', 'ReleaseDate']) {
			if (items.filter((item) => item.localName === tag).length > 1) {
				report(
					'ern.unmapped',
					path + '/' + tag + ' has variants beyond the first that were not imported.'
				);
			}
		}
		const indexes = new Map<string, number>();
		const next = items.map((item) => {
			const index = (indexes.get(item.localName) ?? 0) + 1;
			indexes.set(item.localName, index);
			return {
				node: item,
				path: path + '/' + item.localName + '[' + index + ']',
				depth: depth + 1
			};
		});
		for (let i = next.length - 1; i >= 0; i--) pending.push(next[i]);
	}
}

function parseDocument(document: ErnDocument, plan: ImportPlan) {
	if (!document.text.trimStart().startsWith('<')) throw new InvalidErn('Expected XML.');
	if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(document.text)) {
		throw new InvalidErn('DTD and entity declarations are not accepted.');
	}
	// The XML builder can recover from an unterminated document. Require the final root close.
	// This also rejects uploads cut off inside a nested element.
	if (!/<\/([A-Za-z_][\w.-]*:)?NewReleaseMessage\s*>\s*$/.test(document.text)) {
		throw new InvalidErn('The XML is incomplete or has an unclosed root element.');
	}
	let root: Element | null;
	try {
		root = (create(document.text).doc().node as unknown as DomDocument).documentElement;
	} catch {
		throw new InvalidErn('The XML could not be parsed.');
	}
	if (root?.localName !== 'NewReleaseMessage' || root.namespaceURI !== ERN_NAMESPACE) {
		throw new InvalidErn('Expected a DDEX ERN 4.3 NewReleaseMessage.');
	}

	const warn = (code: string, message: string) =>
		plan.issues.push({
			level: 'warning',
			code,
			line: null,
			message: document.name + ': ' + message
		});
	losses(root, warn);

	const partyNames = new Map<string, string>();
	for (const node of children(child(root, 'PartyList'), 'Party')) {
		const ref = required(text(node, 'PartyReference'), 'PartyReference');
		const name = required(text(child(node, 'PartyName'), 'FullName'), 'party FullName');
		if (partyNames.has(ref)) throw new InvalidErn('Duplicate PartyReference ' + ref + '.');
		partyNames.set(ref, name);
	}
	const usedLabels = new Set<string>();
	function party(ref: string) {
		return required(partyNames.get(ref) ?? '', 'party for reference ' + ref);
	}
	function credits(node: Element, tag: string, roles: Map<string, PlannedCredit['role']>) {
		const output: PlannedCredit[] = [];
		for (const [index, entry] of children(node, tag).entries()) {
			const artist = tag === 'DisplayArtist';
			const name = party(
				text(entry, artist ? 'ArtistPartyReference' : 'ContributorPartyReference')
			);
			const seq = entry.getAttribute('SequenceNumber');
			const position = seq ? positive(seq, 'credit sequence') - 1 : index;
			for (const roleNode of children(entry, artist ? 'DisplayArtistRole' : 'Role')) {
				const raw = roleNode.textContent?.trim() ?? '';
				const role = roles.get(raw);
				if (role) output.push({ name, role, position });
				else warn('ern.credit-role', 'Unsupported credit role ' + raw + ' for ' + name + '.');
			}
		}
		return output.sort((a, b) => a.position - b.position);
	}
	const recordings = new Map<string, PlannedRecording>();
	for (const node of children(child(root, 'ResourceList'), 'SoundRecording')) {
		const ref = required(text(node, 'ResourceReference'), 'ResourceReference');
		if (recordings.has(ref)) throw new InvalidErn('Duplicate ResourceReference ' + ref + '.');
		const editions = children(node, 'SoundRecordingEdition');
		if (editions.length > 1)
			throw new InvalidErn('Multiple sound recording editions cannot be imported.');
		const currentIsrcs = new Set(
			children(child(node, 'SoundRecordingEdition'), 'ResourceId')
				.filter((id) => text(id, 'IsReplaced').toLowerCase() !== 'true')
				.map((id) => normalizeIsrc(text(id, 'ISRC')))
		);
		if (currentIsrcs.size !== 1 || !isValidIsrc([...currentIsrcs][0])) {
			throw new InvalidErn('Expected exactly one valid current ISRC for ' + ref + '.');
		}
		const isrc = [...currentIsrcs][0];
		const row: PlannedRecording = {
			isrc,
			...title(node),
			...genre(node),
			durationMs: duration(text(node, 'Duration')),
			credits: [
				...credits(node, 'DisplayArtist', artistRoles),
				...credits(node, 'Contributor', contributorRoles)
			]
		};
		put(plan.recordings, isrc, row, 'recording');
		recordings.set(ref, row);
	}
	const releases = children(child(root, 'ReleaseList'), 'Release');
	if (!releases.length) throw new InvalidErn('The message contains no release.');
	for (const node of releases) {
		const id = child(node, 'ReleaseId');
		const upc = text(id, 'ICPN');
		if (!isValidGtin(upc)) throw new InvalidErn('A release has a missing or invalid UPC/EAN.');
		const references = children(node, 'ReleaseLabelReference');
		const labelRefs = references.map((reference) =>
			required(reference.textContent?.trim() ?? '', 'ReleaseLabelReference')
		);
		const labels = new Set(labelRefs.map(party));
		if (labels.size !== 1) throw new InvalidErn('A release must name one unambiguous label.');
		const label = [...labels][0];
		for (const labelRef of labelRefs) usedLabels.add(labelRef);
		if (!plan.labels.includes(label)) plan.labels.push(label);
		const type = releaseTypes.get(text(node, 'ReleaseType'));
		if (!type) throw new InvalidErn('Unsupported or missing release type for UPC/EAN ' + upc + '.');
		const group = child(node, 'ResourceGroup');
		if (!group) throw new InvalidErn('Missing ResourceGroup for UPC/EAN ' + upc + '.');
		const discs = children(group, 'ResourceGroup');
		if (discs.length && children(group, 'ResourceGroupContentItem').length) {
			throw new InvalidErn('Mixed top-level and disc-level track positions are not supported.');
		}
		const seen = new Set<string>();
		const tracks = (discs.length ? discs : [group])
			.flatMap((discNode, index) => {
				if (children(discNode, 'ResourceGroup').length) {
					throw new InvalidErn('Nested groups below the disc level are not supported.');
				}
				const disc = positive(
					text(discNode, 'SequenceNumber') || String(index + 1),
					'disc position'
				);
				return children(discNode, 'ResourceGroupContentItem').map((item, i) => {
					const ref = text(item, 'ReleaseResourceReference');
					const recording = recordings.get(ref);
					if (!recording)
						throw new InvalidErn('Track points to an unsupported resource: ' + ref + '.');
					const position = positive(
						text(item, 'SequenceNumber') || String(i + 1),
						'track position'
					);
					const key = disc + ':' + position;
					if (seen.has(key)) throw new InvalidErn('Duplicate disc and track position ' + key + '.');
					seen.add(key);
					return { disc, position, isrc: recording.isrc };
				});
			})
			.sort((a, b) => a.disc - b.disc || a.position - b.position);
		if (!tracks.length)
			throw new InvalidErn('A release must contain at least one sound recording track.');
		const releaseCredits = credits(node, 'DisplayArtist', artistRoles);
		put(
			plan.releases,
			upc,
			{
				upc,
				label,
				type,
				...title(node),
				...genre(node),
				catalogNumber: text(id, 'CatalogNumber') || null,
				releaseDate: (() => {
					const raw = text(node, 'ReleaseDate');
					if (/^[1-9]\\d{3}-(?:0[1-9]|1[0-2])$/.test(raw)) {
						warn('ern.unmapped', 'ReleaseDate ' + raw + ' has month precision and was not imported.');
						return null;
					}
					return date(raw);
				})(),
				artists: releaseCredits
					.filter((credit) => credit.role === 'main')
					.map((credit) => credit.name),
				releaseCredits,
				tracks
			},
			'release'
		);
	}
	for (const [ref, name] of partyNames) {
		if (!usedLabels.has(ref) && !plan.parties.has(partyMatchKey(name))) {
			plan.parties.set(partyMatchKey(name), name);
		}
	}
	for (const name of [
		...Array.from(recordings.values()).flatMap((row) => row.credits.map((credit) => credit.name)),
		...Array.from(plan.releases.values()).flatMap(
			(row) => row.releaseCredits?.map((credit) => credit.name) ?? []
		)
	]) {
		if (!plan.parties.has(partyMatchKey(name))) plan.parties.set(partyMatchKey(name), name);
	}
}

export function parseErnDocuments(documents: ErnDocument[]): ImportPlan {
	const plan: ImportPlan = {
		labels: [],
		parties: new Map(),
		recordings: new Map(),
		releases: new Map(),
		issues: [],
		rowCount: documents.length
	};
	for (const document of documents) {
		try {
			parseDocument(document, plan);
		} catch (e) {
			if (!(e instanceof InvalidErn)) throw e;
			plan.issues.push({
				level: 'error',
				line: null,
				code: 'ern.invalid',
				message: document.name + ': ' + e.message
			});
		}
	}
	return plan;
}
