import { z } from 'zod';

/**
 * Output schemas of the six tools: the /v1 response bodies in docs/openapi.yaml, field for field.
 * drift.test.ts fails when the two disagree. Unknown fields the API adds later are dropped, so a
 * tool's output stays what its schema says.
 */

const Id = z.uuid();
const Timestamp = z.iso.datetime();
const DateOnly = z.iso.date();
const Text = z.string();
const MaybeText = z.string().nullable();
const MaybeTimestamp = Timestamp.nullable();
const MaybeDate = DateOnly.nullable();

const ReleaseType = z.enum(['single', 'ep', 'album', 'compilation']);
const CreditRole = z.enum([
	'main',
	'featured',
	'remixer',
	'producer',
	'writer',
	'composer',
	'mixer',
	'mastering'
]);

const ReleaseSummary = z.object({
	id: Id,
	title: Text,
	version_title: MaybeText,
	type: ReleaseType,
	release_date: MaybeDate,
	upc: Text,
	catalog_number: MaybeText,
	label: Text.describe("The imprint's name."),
	updated_at: Timestamp
});

const RecordingSummary = z.object({
	id: Id,
	isrc: Text,
	title: Text,
	version_title: MaybeText,
	duration_ms: z.number().int().nullable(),
	genre: MaybeText,
	updated_at: Timestamp
});

const Recording = z.object({
	id: Id,
	isrc: Text,
	title: Text,
	version_title: MaybeText,
	duration_ms: z.number().int().nullable(),
	genre: MaybeText,
	subgenre: MaybeText,
	created_at: Timestamp,
	updated_at: Timestamp
});

export const ReleasePage = z.object({
	data: z.array(ReleaseSummary),
	next_cursor: Id.nullable().describe('Pass as `after` for the next page. Null on the last page.')
});

export const RecordingPage = z.object({
	data: z.array(RecordingSummary),
	next_cursor: Id.nullable().describe('Pass as `after` for the next page. Null on the last page.')
});

export const ReleaseDetail = z.object({
	release: z.object({
		id: Id,
		label_id: Id,
		label: Text.describe("The imprint's name."),
		upc: Text,
		catalog_number: MaybeText,
		title: Text,
		version_title: MaybeText,
		type: ReleaseType,
		release_date: MaybeDate,
		genre: MaybeText,
		subgenre: MaybeText,
		created_at: Timestamp,
		updated_at: Timestamp,
		artists: z
			.array(
				z.object({
					id: Id,
					name: Text,
					credit_id: Id,
					approved_at: MaybeTimestamp
				})
			)
			.describe("The release's main artists, in credit order."),
		tracks: z.array(
			z.object({
				position: z.number().int(),
				disc: z.number().int(),
				recording: Recording,
				credits: z.array(
					z.object({
						id: Id,
						approved_at: MaybeTimestamp,
						recording_id: Id,
						role: CreditRole,
						position: z.number().int(),
						party_id: Id,
						name: Text
					})
				)
			})
		)
	})
});

export const RecordingDetail = z.object({
	recording: z.object({
		recording: Recording,
		releases: z
			.array(
				z.object({
					id: Id,
					title: Text,
					release_date: MaybeDate,
					catalog_number: MaybeText,
					position: z.number().int()
				})
			)
			.describe('The releases the recording is on, newest first.'),
		credits: z.array(
			z.object({
				id: Id,
				role: CreditRole,
				position: z.number().int(),
				source: Text.describe('Where the credit came from, such as an import.'),
				approved_at: MaybeTimestamp,
				party_id: Id,
				name: Text
			})
		)
	})
});

export const SearchResults = z.object({
	query: Text.describe('The query as searched, whitespace collapsed.'),
	releases: z.array(
		z.object({
			id: Id,
			title: Text,
			version_title: MaybeText,
			catalog_number: MaybeText,
			upc: Text,
			release_date: MaybeDate,
			label: Text,
			artists: z.array(Text)
		})
	),
	recordings: z.array(
		z.object({
			id: Id,
			title: Text,
			version_title: MaybeText,
			isrc: Text,
			artists: z.array(Text)
		})
	),
	artists: z.array(
		z.object({
			id: Id,
			name: Text,
			credits: z.number().int().describe('Credits the artist holds.')
		})
	)
});

const AnalysisCard = z.object({
	key: z.enum(['probe', 'loudness', 'waveform', 'preview', 'tempo', 'key', 'tags']),
	label: Text,
	status: z.enum(['pending', 'failed', 'done']),
	reason: MaybeText.describe('Why the newest job failed.'),
	job_id: Id.nullable().describe('The newest job.'),
	result_job_id: Id.nullable().describe('The job `result` comes from.'),
	requested_at: MaybeTimestamp,
	finished_at: MaybeTimestamp,
	result: z
		.unknown()
		.describe(
			'The stored AudioKit result, or null while none has succeeded. Its shape depends on the card.'
		)
});

export const RecordingAnalysis = z.object({
	analysis: z.object({
		loudness: AnalysisCard,
		probe: AnalysisCard,
		waveform: AnalysisCard,
		preview: AnalysisCard,
		tempo: AnalysisCard,
		key: AnalysisCard,
		tags: AnalysisCard
	})
});

// Inputs.

export const RecordingId = z.uuid().describe("A recording's id, as returned by the other tools.");
export const ReleaseId = z.uuid().describe("A release's id, as returned by the other tools.");

export const PageInput = {
	limit: z.number().int().min(1).max(200).optional().describe('Page size, 1 to 200. Default 50.'),
	after: Id.optional().describe('The `next_cursor` of the previous page. Omit for the first page.')
};
