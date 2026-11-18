#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { ApiError, LabelKitClient } from './client.js';
import { ConfigError, ENV_API_KEY, loadConfig } from './config.js';
import { buildServer } from './server.js';
import { VERSION } from './version.js';

// stdout carries the protocol. Everything meant for a person goes to stderr.
const say = (text: string) => process.stderr.write(`labelkit-co: ${text}\n`);

const HELP = `labelkit-co ${VERSION}: LabelKit MCP server over stdio.

Set ${ENV_API_KEY} to a LabelKit API key (the catalog:read scope is enough), then point an MCP client at this command.
Optional: LABELKIT_API_URL (default https://api.labelkit.co).
`;

async function main(): Promise<void> {
	const arg = process.argv[2];
	if (arg === '--version' || arg === '-v') return void process.stdout.write(`${VERSION}\n`);
	if (arg === '--help' || arg === '-h') return void process.stdout.write(HELP);

	let client: LabelKitClient;
	try {
		client = new LabelKitClient(loadConfig(process.env));
	} catch (e) {
		if (!(e instanceof ConfigError)) throw e;
		say(e.message);
		process.exitCode = 1;
		return;
	}

	// One cheap read, so a bad key fails here with a clear message instead of on the first tool
	// call. Only a rejected key stops the server; if the API is merely unreachable the tools say so
	// themselves when they are called.
	try {
		await client.get('/v1/releases', { limit: 1 });
	} catch (e) {
		if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
			say(
				e.status === 401
					? `the API rejected ${ENV_API_KEY}. The key may be wrong or revoked.`
					: `${ENV_API_KEY} lacks the catalog:read scope.`
			);
			process.exitCode = 1;
			return;
		}
		say(
			`could not check the API key at startup (${e instanceof Error ? e.message : 'unknown error'}); starting anyway.`
		);
	}

	serveStdio(() => buildServer(client), { onerror: (e) => say(`error: ${e.message}`) });
}

main().catch((e) => {
	say(`failed to start: ${e instanceof Error ? e.message : 'unknown error'}`);
	process.exitCode = 1;
});
