import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import prune, { config } from '../../../netlify/functions/app-metrics-prune.mjs';
let log: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;
let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
	log = vi.spyOn(console, 'log').mockImplementation(() => {});
	error = vi.spyOn(console, 'error').mockImplementation(() => {});
	warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});
it('runs daily at 00:10 UTC using only the existing machine bearer pattern', async () => {
	vi.stubEnv('URL', 'https://fixture.invalid');
	vi.stubEnv('WORKER_SECRET', 'FAKE_PRUNE_SECRET');
	const fetch = vi
		.fn<typeof globalThis.fetch>()
		.mockResolvedValue(new Response(null, { status: 204 }));
	vi.stubGlobal('fetch', fetch);
	expect(config.schedule).toBe('10 0 * * *');
	await prune();
	const [url, options] = fetch.mock.calls[0];
	expect(String(url)).toBe('https://fixture.invalid/api/internal/app-metrics-prune');
	expect(options).toMatchObject({
		method: 'POST',
		headers: { authorization: 'Bearer FAKE_PRUNE_SECRET', 'content-type': 'application/json' },
		redirect: 'error'
	});
	expect(options).not.toHaveProperty('body');
});
it('fails closed with fixed errors and never exposes credentials or response bodies', async () => {
	const fetch = vi
		.fn<typeof globalThis.fetch>()
		.mockResolvedValue(new Response('FAKE_RESPONSE_SECRET', { status: 503 }));
	vi.stubGlobal('fetch', fetch);
	vi.stubEnv('URL', '');
	vi.stubEnv('WORKER_SECRET', 'FAKE_PRUNE_SECRET');
	await expect(prune()).rejects.toThrow('Metrics prune configuration missing');
	expect(fetch).not.toHaveBeenCalled();
	vi.stubEnv('URL', 'https://fixture.invalid');
	await expect(prune()).rejects.toThrow('Metrics prune unavailable');
});
it('logs one fixed completion marker after an ok response and nothing else', async () => {
	vi.stubEnv('URL', 'https://fixture.invalid');
	vi.stubEnv('WORKER_SECRET', 'FAKE_PRUNE_SECRET');
	vi.stubGlobal(
		'fetch',
		vi
			.fn<typeof globalThis.fetch>()
			.mockResolvedValue(new Response('FAKE_RESPONSE_BODY', { status: 200 }))
	);
	await prune();
	expect(log).toHaveBeenCalledTimes(1);
	expect(log).toHaveBeenCalledWith('app_metrics_prune ok');
	expect(error).not.toHaveBeenCalled();
	expect(warn).not.toHaveBeenCalled();
});
it('does not log the marker for a non-ok response, a thrown fetch or missing configuration', async () => {
	vi.stubEnv('WORKER_SECRET', 'FAKE_PRUNE_SECRET');
	vi.stubEnv('URL', '');
	const fetch = vi.fn<typeof globalThis.fetch>();
	vi.stubGlobal('fetch', fetch);
	await expect(prune()).rejects.toThrow('Metrics prune configuration missing');
	vi.stubEnv('URL', 'https://fixture.invalid');
	vi.stubEnv('WORKER_SECRET', '');
	await expect(prune()).rejects.toThrow('Metrics prune configuration missing');
	expect(fetch).not.toHaveBeenCalled();
	vi.stubEnv('WORKER_SECRET', 'FAKE_PRUNE_SECRET');
	fetch.mockResolvedValueOnce(new Response('FAKE_RESPONSE_SECRET', { status: 503 }));
	await expect(prune()).rejects.toThrow('Metrics prune unavailable');
	fetch.mockRejectedValueOnce(new Error('network down'));
	await expect(prune()).rejects.toThrow('network down');
	expect(log).not.toHaveBeenCalled();
});
