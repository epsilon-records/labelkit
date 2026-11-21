import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { run } from './cli.js';

const key = 'lk_testtest_' + '_'.repeat(43);
const id = '018f0000-0000-7000-8000-000000000001';

function mock(body: unknown = { data: [], next_cursor: null }, status = 200) {
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
	[['search', '  Artist   name  '], '/v1/search?q=Artist+name']
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
		JSON.stringify(
			args[0] === 'auth' ? { authenticated: true } : { data: [], next_cursor: null },
			null,
			2
		)
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

it.each([
	[['search', 'x'.repeat(121)], 2],
	[['search', 'one\ttwo'], 2],
	[['search', '   '], 2],
	[['releases', 'list', '--after='], 2],
	[['recordings', 'list', '--after', 'invalid'], 2],
	[['releases', 'get', 'invalid'], 2],
	[['auth', '--url='], 2]
])('rejects %j before sending requests', async (args, code) => {
	const io = mock();
	expect(await run(args, io)).toBe(code);
	expect(io.fetch).not.toHaveBeenCalled();
	expect(io.out).not.toHaveBeenCalled();
});

it('does not confirm access with an unrelated JSON response', async () => {
	const io = mock({ status: 'ok' });
	expect(await run(['auth'], io)).toBe(1);
	expect(io.out).not.toHaveBeenCalled();
	expect(io.err).toHaveBeenCalledWith('Error: The LabelKit API did not return a release page.');
});

it('escapes terminal controls in API errors', async () => {
	const io = mock({ error: { code: 'invalid\ncode', message: 'Hidden\u001b' } }, 400);
	expect(await run(['auth'], io)).toBe(1);
	expect(io.err).toHaveBeenCalledWith('Error: HTTP 400 (invalid\\u{a}code): Hidden\\u{1b}');
});

it.each(['http://127.0.0.1:4173', 'http://api.labelkit.test'])(
	'explains the HTTPS requirement for %s before fetching',
	async (url) => {
		const io = mock();
		expect(await run(['auth', '--url', url], io)).toBe(1);
		expect(io.fetch).not.toHaveBeenCalled();
		expect(io.err).toHaveBeenCalledExactlyOnceWith('Error: The LabelKit CLI requires HTTPS.');
	}
);

it('sends each create body and its idempotency key to the documented endpoint', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'labelkit-cli-create-'));
	try {
		const file = join(dir, 'body.json');
		const cases = [
			{
				args: ['release', 'create'],
				path: '/v1/releases',
				body: { title: 'Test', upc: '012345678905', label_id: id }
			},
			{
				args: ['recording', 'create'],
				path: '/v1/recordings',
				body: { title: 'Test', isrc: 'ZZTST2600001' }
			},
			{ args: ['artist', 'create'], path: '/v1/artists', body: { display_name: 'Test Artist' } },
			{
				args: ['track', 'add', id],
				path: '/v1/releases/' + id + '/tracks',
				body: { mode: 'existing', recording_id: id, disc: 1, position: 1 }
			}
		];
		for (const { args, path, body } of cases) {
			await writeFile(file, JSON.stringify(body));
			const io = mock({ id }, 201);
			expect(
				await run([...args, '--file', file, '--idempotency-key', 'retry-1', '--json'], io)
			).toBe(0);
			expect(io.fetch).toHaveBeenCalledExactlyOnceWith(
				new URL('https://api.labelkit.test' + path),
				expect.objectContaining({
					method: 'POST',
					body: JSON.stringify(body),
					headers: expect.objectContaining({
						'Content-Type': 'application/json',
						'Idempotency-Key': 'retry-1',
						Authorization: 'Bearer ' + key
					})
				})
			);
			expect(io.out).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ id }, null, 2));
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

it('rejects invalid create arguments and handles a conflict without a retry', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'labelkit-cli-create-'));
	try {
		const file = join(dir, 'body.json');
		await writeFile(file, '[]');
		const io = mock({ error: { code: 'conflict', message: 'Request conflicts.' } }, 409);
		expect(await run(['recording', 'create'], io)).toBe(2);
		expect(
			await run(['recording', 'create', '--file', file, '--idempotency-key', 'not valid'], io)
		).toBe(2);
		expect(await run(['track', 'add', 'not-a-uuid', '--file', file], io)).toBe(2);
		expect(await run(['recording', 'create', '--file', file], io)).toBe(2);
		expect(io.fetch).not.toHaveBeenCalled();
		await writeFile(file, '{"title":"Test","isrc":"ZZTST2600001"}');
		expect(await run(['recording', 'create', '--file', file], io)).toBe(1);
		expect(io.fetch).toHaveBeenCalledTimes(1);
		expect(io.fetch.mock.calls[0]?.[1]?.headers).not.toHaveProperty('Idempotency-Key');
		expect(io.err).toHaveBeenLastCalledWith('Error: HTTP 409 (conflict): Request conflicts.');
		expect(io.out).not.toHaveBeenCalled();
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
