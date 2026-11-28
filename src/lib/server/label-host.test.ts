import { describe, expect, it } from 'vitest';
import {
	LABEL_SESSION_COOKIE,
	handoffUrl,
	labelCookieOptions,
	labelHostFrom,
	labelSessionUser,
	noStoreRedirect
} from './label-host';

describe('label host helpers (labelkit#258, step 3)', () => {
	it('labelHostFrom accepts a custom domain as stored, normalised, and nothing else', () => {
		expect(labelHostFrom('Music.Example.TEST:443')).toBe('music.example.test');
		expect(labelHostFrom('music.example.test.')).toBe('music.example.test');
		for (const bad of [
			null,
			undefined,
			'',
			'localhost',
			'a/b.example.test',
			'a.b.c?x',
			'.example.test'
		])
			expect(labelHostFrom(bad)).toBeNull();
	});

	it('handoffUrl is https on the label host and keeps the ticket as one query value', () => {
		expect(handoffUrl('music.example.test', 'abc-_123')).toBe(
			'https://music.example.test/auth/handoff?t=abc-_123'
		);
		expect(handoffUrl('music.example.test', 'a&b=c')).toBe(
			'https://music.example.test/auth/handoff?t=a%26b%3Dc'
		);
	});

	it('the cookie is __Host- prefixed, host-only, HttpOnly, Secure and SameSite=Lax', () => {
		const expires = new Date('2026-12-26T08:00:00Z');
		expect(LABEL_SESSION_COOKIE.startsWith('__Host-')).toBe(true);
		expect(labelCookieOptions(expires)).toEqual({
			path: '/',
			httpOnly: true,
			secure: true,
			sameSite: 'lax',
			expires
		});
	});

	it('noStoreRedirect is a 303 that is never cached', () => {
		const res = noStoreRedirect('/x?y');
		expect([res.status, res.headers.get('location'), res.headers.get('cache-control')]).toEqual([
			303,
			'/x?y',
			'no-store'
		]);
	});

	it('a label session user carries an id and nothing else', () => {
		expect(labelSessionUser('u1')).toMatchObject({ id: 'u1', app_metadata: {}, user_metadata: {} });
		expect(labelSessionUser('u1').email).toBeUndefined();
	});
});
