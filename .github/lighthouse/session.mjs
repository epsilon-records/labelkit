/**
 * Test sign-in for the signed-in Lighthouse run (.github/workflows/lighthouse.yml).
 *
 * Creates one throwaway user on the Supabase stack that is running on this runner, signs in with
 * its password, and writes the session cookies the app expects as a Cookie header for Lighthouse.
 * The cookies are built by @supabase/ssr, the library the app's request hook reads them with, so
 * the name and chunking always match. The user, its password and the stack exist for one job only.
 *
 *   [SUPABASE_ANON_KEY=... SUPABASE_SERVICE_KEY=... SUPABASE_JWT_SECRET=...] node session.mjs <out-dir>
 *
 * The keys come from `supabase status` when the CLI prints them (the workflow passes them in the
 * environment); otherwise they are minted from the stack's documented default signing secret.
 *
 * Writes <out-dir>/extra-headers.json ({"Cookie": "..."}), <out-dir>/user-id and
 * <out-dir>/publishable-key. Nothing is printed except the user's id.
 */
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServerClient } from '@supabase/ssr';

const [outDir] = process.argv.slice(2);
if (!outDir) throw new Error('usage: node session.mjs <out-dir>');
// Only the stack on this runner: the URL is fixed, not read from anywhere.
const apiUrl = 'http://127.0.0.1:54321';

// The local stack's signing secret is a documented shared default (the same one
// scripts/rls-postgrest.mjs uses), so if this CLI version doesn't print its API keys, the keys are
// minted from it the way Supabase does.
const secret =
	process.env.SUPABASE_JWT_SECRET || 'super-secret-jwt-token-with-at-least-32-characters-long';
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
function mint(role) {
	const head = b64({ alg: 'HS256', typ: 'JWT' });
	const body = b64({
		role,
		iss: 'supabase-demo',
		exp: Math.floor(Date.now() / 1000) + 3600
	});
	const sig = createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
	return `${head}.${body}.${sig}`;
}
const anonKey = process.env.SUPABASE_ANON_KEY || mint('anon');
const serviceKey = process.env.SUPABASE_SERVICE_KEY || mint('service_role');
console.log(
	`Keys: anon ${process.env.SUPABASE_ANON_KEY ? 'from the CLI' : 'minted'}, service ${process.env.SUPABASE_SERVICE_KEY ? 'from the CLI' : 'minted'}`
);

const email = `lighthouse-${randomUUID()}@example.test`;
const password = randomBytes(24).toString('base64url');

const created = await fetch(`${apiUrl}/auth/v1/admin/users`, {
	method: 'POST',
	headers: {
		apikey: serviceKey,
		authorization: `Bearer ${serviceKey}`,
		'content-type': 'application/json'
	},
	body: JSON.stringify({ email, password, email_confirm: true })
});
if (!created.ok) {
	throw new Error(
		`Creating the test user failed (HTTP ${created.status}): ${(await created.text()).slice(0, 300)}`
	);
}
const { id: userId } = await created.json();

const cookies = new Map();
const supabase = createServerClient(apiUrl, anonKey, {
	cookies: {
		getAll: () => [],
		setAll: (all) => all.forEach(({ name, value }) => cookies.set(name, value))
	}
});
const { error } = await supabase.auth.signInWithPassword({ email, password });
if (error) throw new Error(`Test sign-in failed (${error.status ?? 'no status'}).`);
if (!cookies.size) throw new Error('Sign-in set no session cookie.');

const cookie = [...cookies].map(([name, value]) => `${name}=${value}`).join('; ');
mkdirSync(outDir, { recursive: true });
writeFileSync(`${outDir}/extra-headers.json`, JSON.stringify({ Cookie: cookie }));
writeFileSync(`${outDir}/user-id`, userId);
writeFileSync(`${outDir}/publishable-key`, anonKey);
console.log(`Test user ${userId}, cookies: ${[...cookies.keys()].join(', ')}`);
