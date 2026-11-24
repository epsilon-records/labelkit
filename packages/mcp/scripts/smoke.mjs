// Smoke test for the built labelkit-co CLI against a real LabelKit API (EPSILON-138).
//
// Run by .github/workflows/mcp-smoke.yml, by hand, after `pnpm --filter labelkit-co build`:
//   LABELKIT_API_KEY=lk_... node packages/mcp/scripts/smoke.mjs
//
// It starts dist/cli.js over stdio, as `npx labelkit-co` would, and only reads. It is not in the
// npm `files` list. It never prints the key or a response body: only tool names, counts and
// pass/fail, so the CI log holds nothing from the label's catalogue.
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import {
	RecordingAnalysis,
	RecordingDetail,
	RecordingPage,
	ReleaseDetail,
	ReleasePage,
	SearchResults
} from '../dist/schemas.js';

const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const EXPECTED_TOOLS = [
	'get_recording',
	'get_recording_analysis',
	'get_release',
	'list_recordings',
	'list_releases',
	'search_catalog'
];

const key = process.env.LABELKIT_API_KEY;
if (!key) {
	console.error('smoke: LABELKIT_API_KEY is not set');
	process.exit(1);
}

let failures = 0;
const pass = (name, detail = '') => console.log(`PASS ${name}${detail ? ` (${detail})` : ''}`);
const fail = (name, why) => {
	failures += 1;
	console.log(`FAIL ${name}: ${why}`);
};

/** Check a body against a Zod schema and say only where it differs, never what the value was. */
function shapeProblem(schema, body) {
	const parsed = schema.safeParse(body);
	if (parsed.success) return null;
	return parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'} ${i.code}`).join('; ');
}

/** The API's error code from a tool error, without the message text. */
const errorCode = (result) => {
	const text = result.content?.find((c) => c.type === 'text')?.text ?? '';
	return /LabelKit API error \d+ (\w+)/.exec(text)?.[1] ?? 'unknown';
};

/** Call a tool and check its result. Returns the structuredContent, or null after recording a failure. */
async function call(client, name, args, schema) {
	let result;
	try {
		result = await client.callTool({ name, arguments: args });
	} catch (e) {
		fail(name, `protocol error (${e instanceof Error ? e.constructor.name : 'unknown'})`);
		return null;
	}
	if (result.isError) {
		fail(name, `tool error ${errorCode(result)}`);
		return null;
	}
	const problem = result.structuredContent
		? shapeProblem(schema, result.structuredContent)
		: 'no structuredContent';
	if (problem) {
		fail(name, `invalid structuredContent: ${problem}`);
		return null;
	}
	return result.structuredContent;
}

// The child gets only what it needs, not this process's whole environment.
const transport = new StdioClientTransport({
	command: process.execPath,
	args: [CLI],
	env: {
		PATH: process.env.PATH ?? '',
		LABELKIT_API_KEY: key,
		...(process.env.LABELKIT_API_URL ? { LABELKIT_API_URL: process.env.LABELKIT_API_URL } : {})
	}
});
const client = new Client({ name: 'labelkit-smoke', version: '0.0.0' });

try {
	await client.connect(transport);
} catch {
	// Startup exits 1 when the API rejects the key, so this is usually a bad or revoked secret.
	console.log(
		'FAIL connect: the server did not start (check the key, its catalog:read scope and the build)'
	);
	process.exit(1);
}

try {
	// 1. Exactly six tools, all read-only.
	const { tools } = await client.listTools();
	const names = tools.map((t) => t.name).sort();
	if (JSON.stringify(names) !== JSON.stringify(EXPECTED_TOOLS)) {
		fail(
			'tools/list',
			`expected ${EXPECTED_TOOLS.join(', ')}; got ${names.length} tools: ${names.join(', ')}`
		);
	} else {
		pass('tools/list', `${tools.length} tools: ${names.join(', ')}`);
	}
	const writable = tools.filter((t) => t.annotations?.readOnlyHint !== true).map((t) => t.name);
	if (writable.length) fail('readOnlyHint', `not set on ${writable.join(', ')}`);
	else pass('readOnlyHint', 'set on every tool');

	// 2. The three calls that need no id.
	const releases = await call(client, 'list_releases', { limit: 5 }, ReleasePage);
	if (releases) pass('list_releases', `${releases.data.length} releases`);

	const recordings = await call(client, 'list_recordings', { limit: 5 }, RecordingPage);
	if (recordings) pass('list_recordings', `${recordings.data.length} recordings`);

	// A single letter is harmless and matches the start of many words; zero hits is fine too.
	const search = await call(client, 'search_catalog', { query: 'a' }, SearchResults);
	if (search) {
		pass(
			'search_catalog',
			`${search.releases.length} releases, ${search.recordings.length} recordings, ${search.artists.length} artists`
		);
	}

	// 3. Details, on the first ids returned, if any.
	const releaseId = releases?.data[0]?.id;
	if (releaseId) {
		const detail = await call(client, 'get_release', { release_id: releaseId }, ReleaseDetail);
		if (detail) pass('get_release', `${detail.release.tracks.length} tracks`);
	} else if (releases) {
		console.log('SKIP get_release: the label has no releases');
	}

	const recordingId = recordings?.data[0]?.id;
	if (recordingId) {
		const detail = await call(
			client,
			'get_recording',
			{ recording_id: recordingId },
			RecordingDetail
		);
		if (detail) {
			pass(
				'get_recording',
				`${detail.recording.releases.length} releases, ${detail.recording.credits.length} credits`
			);
		}

		// 4. Analysis. "None stored" is fine: every card pending with no result, or a not_found.
		const result = await client
			.callTool({ name: 'get_recording_analysis', arguments: { recording_id: recordingId } })
			.catch(() => null);
		if (!result) {
			fail('get_recording_analysis', 'protocol error');
		} else if (result.isError) {
			const code = errorCode(result);
			if (code === 'not_found') pass('get_recording_analysis', 'none stored (not_found)');
			else fail('get_recording_analysis', `tool error ${code}`);
		} else {
			const problem = result.structuredContent
				? shapeProblem(RecordingAnalysis, result.structuredContent)
				: 'no structuredContent';
			if (problem) {
				fail('get_recording_analysis', `invalid structuredContent: ${problem}`);
			} else {
				const cards = Object.values(result.structuredContent.analysis);
				const stored = cards.filter((c) => c.result !== null).length;
				pass(
					'get_recording_analysis',
					stored ? `${stored} of ${cards.length} cards stored` : 'none stored'
				);
			}
		}
	} else if (recordings) {
		console.log('SKIP get_recording, get_recording_analysis: the label has no recordings');
	}
} finally {
	await client.close();
}

console.log(failures ? `\nsmoke: ${failures} check(s) failed` : '\nsmoke: all checks passed');
process.exit(failures ? 1 : 0);
