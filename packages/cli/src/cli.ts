import { readFile } from 'node:fs/promises';
import { inspect, parseArgs } from 'node:util';
import { ApiError, LabelKitClient, TransportError, type Query } from '../../mcp/src/client.js';
import { ConfigError, loadConfig } from '../../mcp/src/config.js';

const USAGE = [
	'Usage: labelkit [--url URL] [--api-key KEY] [--config FILE] [--json] COMMAND',
	'',
	'  auth                                  Check read access',
	'  releases list [--limit N] [--after ID] List releases',
	'  releases get ID                       Show one release',
	'  recordings list [--limit N] [--after ID] List recordings',
	'  recordings get ID                     Show one recording',
	'  search QUERY                          Search the catalogue',
	'  release create --file FILE            Create a release',
	'  recording create --file FILE          Create a recording',
	'  artist create --file FILE              Create an artist',
	'  track add RELEASE_ID --file FILE       Add a track to a release',
	'',
	'Create commands also accept --idempotency-key KEY.'
].join('\n');

type Io = {
	env: NodeJS.ProcessEnv;
	out: (text: string) => void;
	err: (text: string) => void;
	fetch?: typeof fetch;
};

type Request =
	| { path: string; query?: Query; auth?: true }
	| { path: string; bodyFile: string; idempotencyKey?: string };

class UsageError extends Error {}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function searchQuery(raw: string): string {
	const query = raw.replace(/\s+/g, ' ').trim();
	// Match GET /v1/search, which checks the raw input before collapsing whitespace.
	// eslint-disable-next-line no-control-regex -- the API refuses ASCII control characters.
	if (/[\u0000-\u001f\u007f]/.test(raw) || !query || query.length > 120) {
		throw new UsageError('Search requires 1 to 120 characters and no control characters.');
	}
	return query;
}

function isReleasePage(response: unknown): boolean {
	if (!response || typeof response !== 'object') return false;
	const { data, next_cursor } = response as Record<string, unknown>;
	return (
		Array.isArray(data) &&
		(next_cursor === null || (typeof next_cursor === 'string' && UUID.test(next_cursor)))
	);
}

function terminalText(text: string): string {
	return text.replace(
		/[\p{Cc}\p{Cf}]/gu,
		(char) => '\\u{' + char.codePointAt(0)?.toString(16) + '}'
	);
}

function args(argv: string[]) {
	try {
		return parseArgs({
			args: argv,
			allowPositionals: true,
			options: {
				url: { type: 'string' },
				'api-key': { type: 'string' },
				config: { type: 'string' },
				json: { type: 'boolean' },
				help: { type: 'boolean', short: 'h' },
				limit: { type: 'string' },
				after: { type: 'string' },
				file: { type: 'string' },
				'idempotency-key': { type: 'string' }
			}
		});
	} catch {
		throw new UsageError('Invalid arguments. Run labelkit --help for usage.');
	}
}

function requestFor(positionals: string[], values: ReturnType<typeof args>['values']): Request {
	const { limit, after, file, 'idempotency-key': idempotencyKey } = values;
	const [command, action, id, ...extra] = positionals;
	const paginated = limit !== undefined || after !== undefined;
	if (!paginated) {
		const path =
			action === 'create' &&
			positionals.length === 2 &&
			(command === 'release' || command === 'recording' || command === 'artist')
				? '/v1/' + command + 's'
				: command === 'track' && action === 'add' && id && extra.length === 0
					? '/v1/releases/' + checkedId(id) + '/tracks'
					: undefined;
		if (path) {
			if (!file?.trim()) throw new UsageError('Supply --file with a JSON request body.');
			if (idempotencyKey !== undefined && !/^[\x21-\x7e]{1,200}$/.test(idempotencyKey)) {
				throw new UsageError(
					'--idempotency-key must have 1 to 200 printable ASCII characters without spaces.'
				);
			}
			return { path, bodyFile: file, idempotencyKey };
		}
	}
	if (file !== undefined || idempotencyKey !== undefined) {
		throw new UsageError('--file and --idempotency-key are only for create commands.');
	}
	if (command === 'auth' && positionals.length === 1 && !paginated) {
		return { path: '/v1/releases', query: { limit: 1 }, auth: true };
	}
	if (command === 'search' && positionals.length === 2 && action !== undefined && !paginated) {
		return { path: '/v1/search', query: { q: searchQuery(action) } };
	}
	if (command === 'releases' || command === 'recordings') {
		const path = '/v1/' + command;
		if (action === 'list' && positionals.length === 2) {
			const size = limit === undefined ? undefined : Number(limit);
			if (size !== undefined && (!/^\d+$/.test(limit!) || size < 1 || size > 200)) {
				throw new UsageError('--limit must be an integer from 1 to 200.');
			}
			if (after !== undefined && !UUID.test(after)) {
				throw new UsageError('--after must be a UUID from a previous page.');
			}
			return { path, query: { limit: size, after } };
		}
		if (action === 'get' && id && extra.length === 0 && !paginated) {
			return { path: path + '/' + checkedId(id) };
		}
	}
	throw new UsageError('Invalid command or arguments. Run labelkit --help for usage.');
}

function checkedId(id: string): string {
	if (!UUID.test(id)) throw new UsageError('ID must be a UUID.');
	return id;
}

async function readPayload(path: string): Promise<object> {
	try {
		const value: unknown = JSON.parse(await readFile(path, 'utf8'));
		if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
		return value;
	} catch {
		throw new UsageError('--file must contain a JSON object.');
	}
}

async function fileConfig(path: string | undefined): Promise<{ apiKey?: string; url?: string }> {
	if (path === undefined) return {};
	try {
		const value: unknown = JSON.parse(await readFile(path, 'utf8'));
		if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
		const { apiKey, url } = value as Record<string, unknown>;
		if (apiKey !== undefined && typeof apiKey !== 'string') throw new Error();
		if (url !== undefined && typeof url !== 'string') throw new Error();
		return { apiKey, url };
	} catch {
		throw new ConfigError(
			'Could not read config. Supply a JSON object with apiKey and/or url strings.'
		);
	}
}

export async function run(argv: string[], io: Io): Promise<number> {
	try {
		const { values, positionals } = args(argv);
		if (values.help) {
			io.out(USAGE);
			return 0;
		}
		const request = requestFor(positionals, values);
		if (values.url !== undefined && !values.url.trim()) {
			throw new UsageError('--url must not be empty.');
		}
		const file = await fileConfig(values.config ?? io.env.LABELKIT_CONFIG);
		const key = values['api-key'] ?? io.env.LABELKIT_API_KEY ?? file.apiKey;
		if (!key?.trim())
			throw new ConfigError('Set LABELKIT_API_KEY or supply an API key in your config file.');
		const url = values.url ?? io.env.LABELKIT_URL ?? file.url;
		if (url !== undefined && !url.trim()) throw new ConfigError('LABELKIT_URL must not be empty.');
		if (url && URL.canParse(url) && new URL(url).protocol !== 'https:') {
			throw new ConfigError('The LabelKit CLI requires HTTPS.');
		}
		const config = loadConfig({
			LABELKIT_API_KEY: key,
			LABELKIT_API_URL: url
		});

		const client = new LabelKitClient({ ...config, fetch: io.fetch });
		const auth = 'auth' in request && request.auth;
		const response =
			'bodyFile' in request
				? await client.post(
						request.path,
						await readPayload(request.bodyFile),
						request.idempotencyKey
					)
				: await client.get(request.path, request.query);
		if (auth && !isReleasePage(response)) {
			throw new TransportError('The LabelKit API did not return a release page.');
		}
		const result = auth ? { authenticated: true } : response;
		const output = values.json
			? JSON.stringify(result, null, 2)
			: auth
				? 'Authenticated. Catalogue read access confirmed.'
				: inspect(result, {
						depth: null,
						colors: false,
						maxArrayLength: null,
						maxStringLength: null
					});
		io.out(output.replaceAll(config.apiKey, '[redacted]'));
		return 0;
	} catch (error) {
		if (error instanceof UsageError) {
			io.err(error.message);
			return 2;
		}
		if (error instanceof ApiError) {
			io.err(
				`Error: HTTP ${error.status} (${terminalText(error.code)}): ${terminalText(error.message)}`
			);
		} else if (error instanceof TransportError || error instanceof ConfigError) {
			io.err('Error: ' + error.message.replaceAll('LABELKIT_API_URL', 'LABELKIT_URL'));
		} else {
			io.err('Error: Could not complete the LabelKit command.');
		}
		return 1;
	}
}
