// Profile the actual adapter-generated handler in fresh processes, not Vite's dev server.
// This measures app startup, not Netlify's platform/container provisioning or production RTT.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { Socket } from 'node:net';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

if (process.argv.includes('--child')) {
	const files = new Set();
	registerHooks({
		resolve(specifier, context, next) {
			const result = next(specifier, context);
			if (result.url.startsWith('file:')) files.add(result.url);
			return result;
		}
	});
	let connections = 0;
	// Public OpenAPI needs no DB/Auth/transport I/O. Catch accidental eager connection setup.
	Socket.prototype.connect = function () {
		connections++;
		throw new Error('Cold-start probe must not open a network connection');
	};
	const started = performance.now();
	const { default: handler } = await import(
		pathToFileURL(`${process.cwd()}/.netlify/v1/functions/sveltekit-render.mjs`).href
	);
	const imported = performance.now();
	const response = await handler(new Request('http://localhost/v1/openapi.yaml'), {
		ip: '127.0.0.1'
	});
	const body = await response.text();
	const done = performance.now();
	assert.equal(response.status, 200);
	assert.match(body, /openapi:/);
	assert.equal(connections, 0);
	const measurement = {
		import_ms: imported - started,
		first_response_ms: done - imported,
		total_ms: done - started,
		loaded_modules: files.size,
		loaded_source_bytes: [...files].reduce((sum, url) => sum + statSync(new URL(url)).size, 0),
		connections
	};
	// After timing, use the SDK's public API to verify the bundled hook kept monitoring on.
	// Importing this copy does not initialise it: both copies use Sentry's versioned carrier.
	const { getClient } = await import('@sentry/sveltekit');
	const client = getClient();
	assert(client, 'The server hook must initialise Sentry');
	assert.equal(client.getOptions().dsn || undefined, process.env.SENTRY_DSN || undefined);
	assert.equal(client.getOptions().tracesSampleRate, process.env.SENTRY_DSN ? 0.1 : 0);
	assert.equal(connections, 0);
	console.log(JSON.stringify(measurement));
	// A dummy DSN exercises Sentry init without allowing its transport to reach a service.
	// No events are generated. Do not wait for background SDK timers after the measurement.
	process.exit(0);
}

const samples = [];
for (const sentry of [false, true]) {
	for (let i = 0; i < 3; i++) {
		const child = spawnSync(process.execPath, [import.meta.filename, '--child'], {
			encoding: 'utf8',
			timeout: 15_000,
			env: {
				...process.env,
				PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
				PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'ci',
				DATABASE_URL: 'postgresql://localhost:1/unused',
				SENTRY_DSN: sentry ? 'https://public@127.0.0.1:1/1' : ''
			}
		});
		assert.equal(child.status, 0, child.stderr || child.error?.message);
		const result = JSON.parse(child.stdout.trim());
		console.log(JSON.stringify({ sentry, sample: i + 1, ...result }));
		samples.push(result);
	}
}
// Every sample must meet the budget; these are independent cold instances, not retries.
for (const sample of samples) {
	assert(sample.total_ms < 1000, `Cold first response exceeded 1000 ms: ${sample.total_ms}`);
	assert(sample.loaded_modules <= 180, `Cold dependency graph grew: ${sample.loaded_modules}`);
	assert(sample.loaded_source_bytes < 4_000_000, `Cold source graph exceeded 4 MB`);
}
console.log(
	'Cold-start budget passed: all six instances below 1s, <=180 modules and <4MB loaded source.'
);
