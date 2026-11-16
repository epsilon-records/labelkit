# labelkit-co

The LabelKit MCP server. It lets an MCP client (Claude Desktop, Claude Code, Cursor and others) read one record label's catalogue: search, releases, recordings and stored analysis results. It reads only and changes nothing.

It is a thin client over the public LabelKit API (`https://api.labelkit.co/v1`, contract in [`docs/openapi.yaml`](../../docs/openapi.yaml)) and runs on your machine over stdio.

> Not published yet. `package.json` is `"private": true`, so `npm publish` refuses. Publishing is a separate step that needs Nate's approval. Until then, run the local build (see Install).

## Install

Create an API key on your label's API page in LabelKit. Give it only the `catalog:read` scope: every tool needs that and nothing else. A key sees only its own label.

Build it from this repository (`pnpm install && pnpm --filter labelkit-co build`), then add the server to your MCP client's configuration, pointing at the built file:

```json
{
	"mcpServers": {
		"labelkit": {
			"command": "node",
			"args": ["/path/to/labelkit/packages/mcp/dist/cli.js"],
			"env": { "LABELKIT_API_KEY": "lk_xxxxxxxx_..." }
		}
	}
}
```

Claude Code: `claude mcp add labelkit --env LABELKIT_API_KEY=lk_... -- node /path/to/labelkit/packages/mcp/dist/cli.js`.

After publication (not yet), `npx -y labelkit-co` replaces the `node` command and path:

```json
{ "command": "npx", "args": ["-y", "labelkit-co"] }
```

Claude Code, after publication: `claude mcp add labelkit --env LABELKIT_API_KEY=lk_... -- npx -y labelkit-co`.

## Environment

| Variable           | Required | Meaning                                                                                                                                                    |
| ------------------ | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LABELKIT_API_KEY` | yes      | A LabelKit API key, `lk_<8 characters>_<43 characters>`. Checked once at startup; the server exits with a message if it is missing, malformed or rejected. |
| `LABELKIT_API_URL` | no       | API origin. Default `https://api.labelkit.co`. Must be `https`, except `http://localhost` for local development.                                           |

The key is read only from the environment. It is never a tool argument, is not logged, and is removed from any error text.

## Tools

All six are read-only (`readOnlyHint: true`, `openWorldHint: false`) and return `structuredContent` that matches the tool's `outputSchema`, plus the same JSON as text.

| Tool                     | Title                  | Does                                                                                           |
| ------------------------ | ---------------------- | ---------------------------------------------------------------------------------------------- |
| `search_catalog`         | Search Catalogue       | Releases, recordings and artists by words, ISRC, UPC or catalogue number.                      |
| `list_releases`          | List Releases          | One page of releases. Pass `next_cursor` back as `after`.                                      |
| `get_release`            | Get Release            | A release with tracks, credits and artists.                                                    |
| `list_recordings`        | List Recordings        | One page of recordings.                                                                        |
| `get_recording`          | Get Recording          | A recording with its releases and credits.                                                     |
| `get_recording_analysis` | Get Recording Analysis | Stored AudioKit results (loudness, format, waveform, preview, tempo, key, tags). Runs nothing. |

API errors come back as tool errors (`isError: true`) with the API's code and message, such as `not_found`.

## Develop

```sh
pnpm install
pnpm --filter labelkit-co test        # unit, protocol and drift tests
pnpm --filter labelkit-co build
pnpm --filter labelkit-co test:e2e    # runs dist/cli.js over stdio against a fake API
```

`buildServer(api)` in `src/server.ts` is the server factory: it takes anything that can answer the `/v1` reads, so the same tools can later be hosted remotely. The tests include a drift check that each tool's output schema equals the response schema in `docs/openapi.yaml`.
