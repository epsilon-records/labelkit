import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { run } from './cli.js';

const key = 'lk_testtest_' + '_'.repeat(43);
const id = '018f0000-0000-7000-8000-000000000001';

function mock(body: unknown = { data: [] }, status = 200) {
	const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(body, { status }));
	return {
		fetch,
		out: vi.fn<(text: string) => void>(),
		err: vi.fn<(text: string) => void>(),
		env: { LABELKIT_API_KEY: key, LABELKIT_URL: 'https://api.labelkit.test' }
	};
}

it.each([
	[['auth'], '/v1/releases?limit=1'],
	[['releases', 'list', '--limit', '12', '--after', id], '/v1/releases?limit=12&after=' + id],
	[['releases', 'get', id], '/v1/releases/' + id],
	[['recordings', 'list'], '/v1/recordings'],
	[['recordings', 'get', id], '/v1/recordings/' + id],
	[['search', 'Artist name'], '/v1/search?q=Artist+name']
])('runs %j against the documented endpoint', async (args, path) => {
	const io = mock();
	expect(await run([...args, '--json'], io)).toBe(0);
	expect(io.fetch).toHaveBeenCalledExactlyOnceWith(new URL('https://api.labelkit.test' + path), {
		method: 'GET',
		headers: {
			Authorization: 'Bearer ' + key,
			Accept: 'application/json',
			'User-Agent': expect.any(String)
		},
		redirect: 'error',
		signal: expect.any(AbortSignal)
	});
	expect(io.out).toHaveBeenCalledExactlyOnceWith(
		JSON.stringify(args[0] === 'auth' ? { authenticated: true } : { data: [] }, null, 2)
	);
	expect(io.err).not.toHaveBeenCalled();
});

it('keeps errors on stderr and redacts the key in error and success output', async () => {
	const denied = mock({ error: { code: 'forbidden', message: 'Rejected ' + key } }, 403);
	expect(await run(['auth', '--json'], denied)).toBe(1);
	expect(denied.out).not.toHaveBeenCalled();
	expect(denied.err).toHaveBeenCalledWith('Error: HTTP 403 (forbidden): Rejected [redacted]');

	const success = mock({ data: [key] });
	expect(await run(['recordings', 'list'], success)).toBe(0);
	expect(success.out.mock.calls[0]?.[0]).toContain('[redacted]');
	expect(success.out.mock.calls[0]?.[0]).not.toContain(key);
});

it('reports transport and usage failures without printing credentials or making invalid calls', async () => {
	const io = mock();
	expect(await run(['recordings', 'list', '--limit', '0'], io)).toBe(2);
	expect(io.fetch).not.toHaveBeenCalled();
	io.fetch.mockRejectedValueOnce(new Error(key));
	expect(await run(['auth'], io)).toBe(1);
	expect(io.err.mock.calls.flat().join('\n')).not.toContain(key);
	expect(io.out).not.toHaveBeenCalled();
	expect(await run(['--help'], { ...io, env: {} })).toBe(0);
});

it('reads a key from an explicit config file and prefers flags over environment and file values', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'labelkit-cli-'));
	try {
		const config = join(dir, 'config.json');
		const io = mock();
		await writeFile(config, JSON.stringify({ apiKey: key, url: 'https://file.example' }));
		expect(await run(['auth', '--config', config], { ...io, env: {} })).toBe(0);
		expect(String(io.fetch.mock.calls[0]?.[0])).toBe('https://file.example/v1/releases?limit=1');
		expect(await run(['auth', '--config', config, '--url', 'https://flag.example'], io)).toBe(0);
		expect(String(io.fetch.mock.calls[1]?.[0])).toBe('https://flag.example/v1/releases?limit=1');
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
