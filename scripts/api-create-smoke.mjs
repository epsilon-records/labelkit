/** Finite HTTP→key hook→RLS→audit proof against the throwaway CI Supabase stack only. */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import postgres from 'postgres';
assert.equal(process.env.CI, 'true', 'CI-only fixture');
const source = process.env.DATABASE_URL;
assert(source, 'DATABASE_URL is required');
assert(
	['localhost', '127.0.0.1', '[::1]'].includes(new URL(source).hostname),
	'local Supabase only'
);
const db = postgres(source, { max: 1, prepare: false });
const org = '01900000-0000-7000-8000-000000000001';
const label = '01900000-0000-7000-8000-000000000002';
const actor = randomUUID();
const key = 'lk_createci_' + randomBytes(32).toString('base64url');
const hash = createHash('sha256').update(key).digest('hex');
console.log(`::add-mask::${key}`);
async function post(path, body, credential = key, idem) {
	const response = await fetch('http://127.0.0.1:4173' + path, {
		method: 'POST',
		headers: {
			authorization: 'Bearer ' + credential,
			'content-type': 'application/json',
			...(idem ? { 'idempotency-key': idem } : {})
		},
		body: JSON.stringify(body)
	});
	return { status: response.status, body: await response.json() };
}
try {
	await db`insert into memberships(org_id,user_id,role,onboarded_at) values(${org},${actor},'agent',now())`;
	await db`insert into api_keys(id,org_id,actor_id,name,prefix,key_sha256,scopes,created_by) values(${randomUUID()},${org},${actor},'Create HTTP proof','createci',${hash},array['catalog:read','catalog:write'],${actor})`;
	for (const path of [
		'/v1/releases',
		'/v1/recordings',
		'/v1/artists',
		`/v1/releases/${randomUUID()}/tracks`
	]) {
		assert.equal(
			(await post(path, {}, process.env.LABELKIT_FUZZ_API_KEY)).status,
			403,
			'read-only key must not write'
		);
	}
	const release = await post('/v1/releases', {
		title: 'HTTP create fixture',
		upc: '000123450102',
		label_id: label
	});
	assert.equal(release.status, 201, JSON.stringify(release));
	const recordingBody = {
		title: 'HTTP recording fixture',
		isrc: 'USAAA2600001',
		duration: '03:30'
	};
	const receipts = await Promise.all([
		post('/v1/recordings', recordingBody, key, 'http-retry'),
		post('/v1/recordings', recordingBody, key, 'http-retry')
	]);
	assert.equal(receipts[0].status, 201, JSON.stringify(receipts[0]));
	assert.deepEqual(receipts[0], receipts[1], 'concurrent retry reuses the original receipt');
	assert.equal(
		(await post('/v1/recordings', { ...recordingBody, title: 'Changed' }, key, 'http-retry'))
			.status,
		409
	);
	const artist = await post('/v1/artists', { display_name: 'HTTP artist fixture' });
	assert.equal(artist.status, 201, JSON.stringify(artist));
	const trackPath = `/v1/releases/${release.body.release.id}/tracks`;
	assert.equal(
		(
			await post(trackPath, {
				mode: 'existing',
				recording_id: receipts[0].body.recording.id,
				disc: 1,
				position: 1
			})
		).status,
		201
	);
	const second = await post(trackPath, {
		mode: 'new',
		title: 'HTTP second track fixture',
		isrc: 'USAAA2600002',
		duration: '04:00',
		disc: 1,
		position: 2
	});
	assert.equal(second.status, 201, JSON.stringify(second));
	const [state] =
		await db`select count(*)::int as n from release_tracks where release_id=${release.body.release.id}`;
	assert.equal(state.n, 2);
	const [audits] =
		await db`select count(*)::int as n, bool_and(actor_kind='agent') as agents from audit_log where actor_id=${actor}`;
	assert.deepEqual(audits, { n: 6, agents: true });
	console.log(
		'API create HTTP proof passed: four endpoints, read-only denial, concurrent retry, conflict, two persisted tracks and six agent audit entries.'
	);
} finally {
	await db.end({ timeout: 1 });
}
