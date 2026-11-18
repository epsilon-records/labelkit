import { describe, expect, it } from 'vitest';
import { ConfigError, DEFAULT_BASE_URL, loadConfig } from './config.js';
import { KEY } from './test-support.js';

describe('loadConfig', () => {
	it('reads the key and defaults the base URL', () => {
		expect(loadConfig({ LABELKIT_API_KEY: KEY })).toEqual({
			apiKey: KEY,
			baseUrl: DEFAULT_BASE_URL
		});
		expect(DEFAULT_BASE_URL).toBe('https://api.labelkit.co');
	});

	it('takes LABELKIT_API_URL, without a trailing slash', () => {
		const env = { LABELKIT_API_KEY: KEY };
		expect(loadConfig({ ...env, LABELKIT_API_URL: 'https://api.example.org/' }).baseUrl).toBe(
			'https://api.example.org'
		);
		expect(loadConfig({ ...env, LABELKIT_API_URL: 'http://localhost:5173' }).baseUrl).toBe(
			'http://localhost:5173'
		);
		expect(loadConfig({ ...env, LABELKIT_API_URL: '' }).baseUrl).toBe(DEFAULT_BASE_URL);
	});

	it('refuses a missing or malformed key without echoing it', () => {
		expect(() => loadConfig({})).toThrow(/LABELKIT_API_KEY is not set/);
		expect(() => loadConfig({ LABELKIT_API_KEY: '   ' })).toThrow(ConfigError);
		const typo = `${KEY}x`;
		try {
			loadConfig({ LABELKIT_API_KEY: typo });
			expect.unreachable();
		} catch (e) {
			expect((e as Error).message).toMatch(/not a LabelKit API key/);
			expect((e as Error).message).not.toContain(typo);
		}
	});

	it('refuses a base URL that would send the key in the clear or somewhere odd', () => {
		const env = { LABELKIT_API_KEY: KEY };
		for (const url of [
			'http://api.example.org',
			'ftp://x',
			'not a url',
			'https://user:pw@api.example.org',
			'https://api.example.org/?x=1'
		]) {
			expect(() => loadConfig({ ...env, LABELKIT_API_URL: url }), url).toThrow(ConfigError);
		}
	});
});
