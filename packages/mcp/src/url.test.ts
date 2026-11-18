import { describe, expect, it } from 'vitest';
import { LabelKitClient } from './client.js';
import { loadConfig } from './config.js';
import { KEY } from './test-support.js';
import { normalizeBaseUrl } from './url.js';

describe('normalizeBaseUrl', () => {
	it('cuts every trailing slash, however many', () => {
		expect(normalizeBaseUrl('https://x//')).toBe('https://x');
		expect(normalizeBaseUrl('https://x/')).toBe('https://x');
		expect(normalizeBaseUrl('https://x/api///')).toBe('https://x/api');
		expect(normalizeBaseUrl('http://localhost:5173')).toBe('http://localhost:5173');
	});

	it('takes a very long run of slashes in linear time', () => {
		const started = Date.now();
		expect(normalizeBaseUrl(`https://x${'/'.repeat(200_000)}`)).toBe('https://x');
		expect(Date.now() - started).toBeLessThan(1000);
	});

	it('refuses what is not http(s)', () => {
		expect(() => normalizeBaseUrl('ftp://x')).toThrow(TypeError);
		expect(() => normalizeBaseUrl('not a url')).toThrow();
	});

	it('is what the client and config use', async () => {
		expect(loadConfig({ LABELKIT_API_KEY: KEY, LABELKIT_API_URL: 'https://x//' }).baseUrl).toBe(
			'https://x'
		);
		let seen = '';
		const client = new LabelKitClient({
			apiKey: KEY,
			baseUrl: 'https://x//',
			fetch: (async (u: URL) => {
				seen = String(u);
				return new Response('{}');
			}) as never
		});
		await client.get('/v1/releases');
		expect(seen).toBe('https://x/v1/releases');
	});
});
