import { describe, expect, it, vi } from 'vitest';
import { ApiError, LabelKitClient, TransportError } from './client.js';
import { BASE, jsonResponse, KEY } from './test-support.js';
import { VERSION } from './version.js';

const client = (fetchImpl: typeof fetch, timeoutMs?: number) =>
	new LabelKitClient({ apiKey: KEY, baseUrl: BASE, fetch: fetchImpl, timeoutMs });

describe('LabelKitClient', () => {
	it('sends a GET with the key as a bearer token, and no redirects', async () => {
		const fetchImpl = vi.fn(async () => jsonResponse({ ok: true }));
		expect(
			await client(fetchImpl as never).get('/v1/search', { q: 'a b', limit: undefined })
		).toEqual({
			ok: true
		});
		const [url, init] = fetchImpl.mock.calls[0] as unknown as [URL, RequestInit];
		expect(String(url)).toBe(`${BASE}/v1/search?q=a+b`);
		expect(init.method).toBe('GET');
		expect(init.redirect).toBe('error');
		expect(init.headers).toMatchObject({
			Authorization: `Bearer ${KEY}`,
			Accept: 'application/json',
			'User-Agent': `labelkit-co/${VERSION}`
		});
	});

	it('turns the error envelope into an ApiError', async () => {
		const fetchImpl = async () =>
			jsonResponse({ error: { code: 'not_found', message: 'Release not found.' } }, 404);
		await expect(client(fetchImpl).get('/v1/releases/x')).rejects.toMatchObject({
			name: 'ApiError',
			status: 404,
			code: 'not_found',
			message: 'Release not found.'
		});
		const html = async () => new Response('<html>bad gateway</html>', { status: 502 });
		await expect(client(html).get('/v1/releases')).rejects.toMatchObject({
			status: 502,
			code: 'http_error'
		});
		await expect(client(html).get('/v1/releases')).rejects.toBeInstanceOf(ApiError);
	});

	it('reports an unreachable API, a timeout and a non-JSON success as TransportError', async () => {
		const refused = async () => {
			throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
		};
		await expect(client(refused).get('/v1/releases')).rejects.toThrow(
			`Could not reach the LabelKit API at ${BASE} (ECONNREFUSED).`
		);
		const slow = (_url: unknown, init?: RequestInit) =>
			new Promise<Response>((_, reject) =>
				init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
			);
		await expect(client(slow as never, 20).get('/v1/releases')).rejects.toThrow(/did not answer/);
		const text = async () => new Response('hello', { status: 200 });
		await expect(client(text).get('/v1/releases')).rejects.toBeInstanceOf(TransportError);
	});

	it('never lets the key out in an error', async () => {
		const leaky = async () => {
			throw new Error(`boom ${KEY}`);
		};
		const e = await client(leaky)
			.get('/v1/releases')
			.catch((x: Error) => x);
		expect((e as Error).message).not.toContain(KEY);
		const echo = async () => jsonResponse({ error: { code: 'x', message: `bad ${KEY}` } }, 400);
		const f = await client(echo)
			.get('/v1/releases')
			.catch((x: Error) => x);
		expect((f as Error).message).toBe('bad [redacted]');
		// Nor in the code of an upstream error.
		const code = async () => jsonResponse({ error: { code: `code_${KEY}`, message: 'x' } }, 400);
		const g = (await client(code)
			.get('/v1/releases')
			.catch((x: unknown) => x)) as ApiError;
		expect(g.code).toBe('code_[redacted]');
		expect(JSON.stringify(g)).not.toContain(KEY);
	});
});
