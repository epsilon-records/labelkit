import type { CallToolResult } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { ApiError, TransportError, type LabelKitApi, type Query } from './client.js';
import {
	PageInput,
	RecordingAnalysis,
	RecordingDetail,
	RecordingId,
	RecordingPage,
	ReleaseDetail,
	ReleaseId,
	ReleasePage,
	SearchResults
} from './schemas.js';

/**
 * The six read-only tools. Each is one GET on the /v1 API: the input becomes a path and query,
 * the JSON answer is checked against the output schema and returned as `structuredContent`,
 * with the same JSON as a text block for clients that read only text.
 */

export type ToolDefinition<
	I extends z.ZodRawShape = z.ZodRawShape,
	O extends z.ZodType = z.ZodType
> = {
	name: string;
	title: string;
	description: string;
	inputSchema: z.ZodObject<I>;
	outputSchema: O;
	/** The API call for this input. */
	request(input: z.infer<z.ZodObject<I>>): { path: string; query?: Query };
};

function define<I extends z.ZodRawShape, O extends z.ZodType>(
	name: string,
	title: string,
	description: string,
	input: I,
	outputSchema: O,
	request: ToolDefinition<I, O>['request']
): ToolDefinition<I, O> {
	return { name, title, description, inputSchema: z.object(input), outputSchema, request };
}

export const TOOLS = [
	define(
		'search_catalog',
		'Search Catalogue',
		'Find releases, recordings and artists in the label by title, artist, ISRC, UPC or catalogue number. Every word of the query must match the start of a word, so "vex ra" finds "Vexo Rand". At most 25 of each kind, best match first; not paged, so narrow the query instead.',
		{
			query: z
				.string()
				.trim()
				.min(1)
				.max(120)
				.describe('Words, an ISRC, a UPC or a catalogue number. 1 to 120 characters.')
		},
		SearchResults,
		({ query }) => ({ path: '/v1/search', query: { q: query } })
	),
	define(
		'list_releases',
		'List Releases',
		"The label's releases, oldest first, one page at a time. To read the next page, pass the previous page's `next_cursor` as `after`.",
		PageInput,
		ReleasePage,
		({ limit, after }) => ({ path: '/v1/releases', query: { limit, after } })
	),
	define(
		'get_release',
		'Get Release',
		'One release with its tracks, credits and artists.',
		{ release_id: ReleaseId },
		ReleaseDetail,
		({ release_id }) => ({ path: `/v1/releases/${release_id}` })
	),
	define(
		'list_recordings',
		'List Recordings',
		"The label's recordings, oldest first, one page at a time. To read the next page, pass the previous page's `next_cursor` as `after`.",
		PageInput,
		RecordingPage,
		({ limit, after }) => ({ path: '/v1/recordings', query: { limit, after } })
	),
	define(
		'get_recording',
		'Get Recording',
		'One recording with the releases it is on and its credits.',
		{ recording_id: RecordingId },
		RecordingDetail,
		({ recording_id }) => ({ path: `/v1/recordings/${recording_id}` })
	),
	define(
		'get_recording_analysis',
		'Get Recording Analysis',
		'The latest AudioKit results stored for a recording: loudness, format (probe), waveform, preview, tempo, key and tags, each with status pending, failed or done. Reads stored results and runs nothing.',
		{ recording_id: RecordingId },
		RecordingAnalysis,
		({ recording_id }) => ({ path: `/v1/recordings/${recording_id}/analysis` })
	)
] as const;

function failure(text: string): CallToolResult {
	return { isError: true, content: [{ type: 'text', text }] };
}

/** An API error as a tool error, so the model can read the code and correct itself. */
function describeApiError(e: ApiError): string {
	const hint =
		e.status === 401
			? ' Check LABELKIT_API_KEY: it may be revoked.'
			: e.status === 403
				? ' The API key needs the catalog:read scope.'
				: '';
	return `LabelKit API error ${e.status} ${e.code}: ${e.message}${hint}`;
}

/** Run one tool. Never throws: every failure is a tool error (`isError`), not a protocol error. */
export async function runTool(
	tool: ToolDefinition,
	api: LabelKitApi,
	input: unknown
): Promise<CallToolResult> {
	try {
		const { path, query } = tool.request(tool.inputSchema.parse(input));
		const body = await api.get(path, query);
		const parsed = tool.outputSchema.safeParse(body);
		if (!parsed.success) {
			return failure(
				'The LabelKit API answered with a body this server does not recognise. Update labelkit-co, or report this if it is current.'
			);
		}
		return {
			content: [{ type: 'text', text: JSON.stringify(parsed.data) }],
			structuredContent: parsed.data as Record<string, unknown>
		};
	} catch (e) {
		if (e instanceof ApiError) return failure(describeApiError(e));
		if (e instanceof TransportError) return failure(e.message);
		if (e instanceof z.ZodError) return failure(`Invalid arguments: ${z.prettifyError(e)}`);
		return failure('The tool failed unexpectedly.');
	}
}
