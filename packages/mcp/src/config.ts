import { normalizeBaseUrl } from './url.js';

/** Settings from the environment, checked once at startup. */

export const DEFAULT_BASE_URL = 'https://api.labelkit.co';

export const ENV_API_KEY = 'LABELKIT_API_KEY';
export const ENV_API_URL = 'LABELKIT_API_URL';

export type Config = { apiKey: string; baseUrl: string };

/** A bad or missing setting. The message is meant for the person who runs the server. */
export class ConfigError extends Error {}

/** `lk_<8-character prefix>_<43-character secret>`, as LabelKit issues them (src/lib/server/api-keys.ts). */
const KEY_RE = /^lk_[a-z0-9]{8}_[A-Za-z0-9_-]{43}$/;

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export function loadConfig(env: Record<string, string | undefined>): Config {
	const apiKey = env[ENV_API_KEY]?.trim();
	if (!apiKey) {
		throw new ConfigError(
			`${ENV_API_KEY} is not set. Create a key with only the catalog:read scope on your label's API page in LabelKit, and set it in the MCP client's configuration for this server.`
		);
	}
	if (!KEY_RE.test(apiKey)) {
		// Never echo the value: it may be a real key with a typo.
		throw new ConfigError(
			`${ENV_API_KEY} is not a LabelKit API key. A key looks like lk_<8 characters>_<43 characters>.`
		);
	}

	const rawUrl = env[ENV_API_URL]?.trim() || DEFAULT_BASE_URL;
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		throw new ConfigError(`${ENV_API_URL} is not a URL.`);
	}
	// The key travels in a header on every request, so it never goes over plain HTTP to another host.
	const local = LOCAL_HOSTS.has(url.hostname);
	if (!(url.protocol === 'https:' || (url.protocol === 'http:' && local))) {
		throw new ConfigError(`${ENV_API_URL} must be an https:// URL (http:// only for localhost).`);
	}
	if (url.username || url.password || url.search || url.hash) {
		throw new ConfigError(`${ENV_API_URL} must be a plain origin such as ${DEFAULT_BASE_URL}.`);
	}
	return { apiKey, baseUrl: normalizeBaseUrl(url.href) };
}
