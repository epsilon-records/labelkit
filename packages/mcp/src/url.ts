/**
 * An API base URL as `origin + path` with no trailing slash. Parsed with `URL`, so anything that is
 * not http(s) is refused, and trailing slashes are cut in a loop rather than with a regex.
 */
export function normalizeBaseUrl(raw: string): string {
	const url = new URL(raw);
	if (url.protocol !== 'https:' && url.protocol !== 'http:') {
		throw new TypeError('The API base URL must be http(s).');
	}
	let path = url.pathname;
	while (path.endsWith('/')) path = path.slice(0, -1);
	return url.origin + path;
}
