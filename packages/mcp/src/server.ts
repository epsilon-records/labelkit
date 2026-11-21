import { McpServer } from '@modelcontextprotocol/server';
import type { LabelKitApi } from './client.js';
import { runTool, TOOLS } from './tools.js';
import { VERSION } from './version.js';

export const SERVER_NAME = 'labelkit';
export const SERVER_TITLE = 'LabelKit';

const INSTRUCTIONS =
	"This server reads one record label's catalogue through the LabelKit API, as the label that owns the API key. " +
	'Ids are UUIDs, taken from list_*, search_catalog or get_* results. ' +
	"Lists are paged: pass a page's next_cursor as `after` to read the next. " +
	'Analysis is read-only in this version: get_recording_analysis returns stored results and runs nothing.';

/**
 * The server, built over anything that can answer the /v1 reads. The stdio entry passes a client
 * with one label's key. A remote host can call this once per request with the caller's own, so the
 * same tools serve both without being rewritten.
 */
export function buildServer(api: LabelKitApi): McpServer {
	const server = new McpServer(
		{ name: SERVER_NAME, title: SERVER_TITLE, version: VERSION },
		{ instructions: INSTRUCTIONS }
	);
	for (const tool of TOOLS) {
		server.registerTool(
			tool.name,
			{
				title: tool.title,
				description: tool.description,
				inputSchema: tool.inputSchema,
				outputSchema: tool.outputSchema,
				// Reads one label's data and nothing else. `destructiveHint` and `idempotentHint` apply
				// only to tools that write.
				annotations: { readOnlyHint: true, openWorldHint: false }
			},
			(args: unknown) => runTool(tool, api, args)
		);
	}
	return server;
}
