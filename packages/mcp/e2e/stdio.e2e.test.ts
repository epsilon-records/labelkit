import { spawn, spawnSync } from 'node:child_process';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bodyFor, KEY } from '../src/test-support.js';

/** The built package, started the way `npx labelkit-co` starts it, against a fake API on localhost. */

const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
let api: Server;
let url: string;
const seen: IncomingMessage[] = [];
let answerKey: string | null = KEY;

beforeAll(async () => {
	api = createServer((req, res) => {
		seen.push(req);
		res.setHeader('content-type', 'application/json');
		if (req.headers.authorization !== `Bearer ${answerKey}`) {
			res.statusCode = 401;
			return void res.end(
				JSON.stringify({ error: { code: 'unauthorized', message: 'Missing or invalid API key.' } })
			);
		}
		res.end(JSON.stringify(bodyFor('/v1/releases')));
	});
	await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
	url = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
});
afterAll(() => api.close());

// Async: the fake API lives in this process, so a blocking spawn would starve it.
const run = (env: Record<string, string>) =>
	new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
		const child = spawn(process.execPath, [CLI], {
			env: { PATH: process.env.PATH ?? '', ...env },
			stdio: ['ignore', 'pipe', 'pipe']
		});
		let stdout = '';
		let stderr = '';
		child.stdout.on('data', (d) => (stdout += d));
		child.stderr.on('data', (d) => (stderr += d));
		child.on('close', (status) => resolve({ status, stdout, stderr }));
	});

describe('dist/cli.js over stdio', () => {
	it('prints its version and help on stdout', () => {
		expect(spawnSync(process.execPath, [CLI, '--version'], { encoding: 'utf8' }).stdout).toMatch(
			/^\d+\.\d+\.\d+\n$/
		);
		expect(spawnSync(process.execPath, [CLI, '--help'], { encoding: 'utf8' }).stdout).toMatch(
			/LABELKIT_API_KEY/
		);
	});

	it('exits 1 with a message on stderr, and nothing on stdout, without a key', async () => {
		const r = await run({});
		expect(r.status).toBe(1);
		expect(r.stdout).toBe('');
		expect(r.stderr).toMatch(/LABELKIT_API_KEY is not set/);
	});

	it('exits 1 when the API rejects the key, without printing the key', async () => {
		answerKey = 'lk_zzzzzzzz_' + 'Z'.repeat(43);
		const r = await run({ LABELKIT_API_KEY: KEY, LABELKIT_API_URL: url });
		answerKey = KEY;
		expect(r.status).toBe(1);
		expect(r.stdout).toBe('');
		expect(r.stderr).toMatch(/rejected LABELKIT_API_KEY/);
		expect(r.stderr).not.toContain(KEY);
	});

	it('serves the six tools, checks the key once at startup, and calls the API with it', async () => {
		seen.length = 0;
		const transport = new StdioClientTransport({
			command: process.execPath,
			args: [CLI],
			env: { PATH: process.env.PATH ?? '', LABELKIT_API_KEY: KEY, LABELKIT_API_URL: url }
		});
		const client = new Client({ name: 'e2e', version: '0.0.0' });
		await client.connect(transport);
		try {
			expect(client.getServerVersion()).toMatchObject({ name: 'labelkit', title: 'LabelKit' });
			const { tools } = await client.listTools();
			expect(tools).toHaveLength(6);

			const result = await client.callTool({ name: 'list_releases', arguments: { limit: 5 } });
			expect(result.isError).toBeFalsy();
			expect(result.structuredContent).toEqual(bodyFor('/v1/releases'));
		} finally {
			await client.close();
		}
		// The startup check, then the tool call.
		expect(seen.map((r) => r.url)).toEqual(['/v1/releases?limit=1', '/v1/releases?limit=5']);
		for (const r of seen) expect(r.headers.authorization).toBe(`Bearer ${KEY}`);
	});
});
