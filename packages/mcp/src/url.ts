/** Hosts the key may reach over plain HTTP: the developer's own machine only. */
export const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * An API base URL as `origin + path` with no trailing slash. Parsed with `URL`, and trailing slashes
 * are cut in a loop rather than with a regex. The key travels in a header on every request, so the
 * URL must be https://, or http:// to a loopback host. Every client goes through this, not only the
 * CLI's config.
 */
export function normalizeBaseUrl(raw: string): string {
	const url = new URL(raw);
	const local = LOCAL_HOSTS.has(url.hostname);
	if (!(url.protocol === 'https:' || (url.protocol === 'http:' && local))) {
		throw new TypeError('The API base URL must be https:// (http:// only for localhost).');
	}
	let path = url.pathname;
	while (path.endsWith('/')) path = path.slice(0, -1);
	return url.origin + path;
}
