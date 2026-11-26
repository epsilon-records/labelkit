import { describe, expect, it } from 'vitest';
import {
	HANDOFF_TTL_MS,
	SESSION_ABSOLUTE_MS,
	SESSION_IDLE_MS,
	handoffExpiry,
	idleCutoff,
	newToken,
	normaliseHost,
	sessionExpiry,
	sha256
} from './label-session';

// The pure parts of label sessions (knowledge labelkit 0051, 0054). The database parts are in
// label-session.db.test.ts.
const NOW = new Date('2026-11-26T08:00:00Z');

describe('tokens', () => {
	it('are 32 random bytes as 43 base64url characters, stored only as a SHA-256', () => {
		const { token, hash } = newToken();
		expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(hash).toMatch(/^[0-9a-f]{64}$/);
		expect(hash).toBe(sha256(token));
		expect(hash).not.toContain(token);
	});

	it('differ every time', () => {
		expect(new Set(Array.from({ length: 50 }, () => newToken().token)).size).toBe(50);
	});

	it('use the random source they are given', () => {
		const fixed = () => Buffer.alloc(32, 7);
		expect(newToken(fixed)).toEqual(newToken(fixed));
	});
});

describe('lifetimes', () => {
	it('a ticket lasts 60 seconds', () => {
		expect(HANDOFF_TTL_MS).toBe(60_000);
		expect(handoffExpiry(NOW).toISOString()).toBe('2026-11-26T08:01:00.000Z');
	});

	it('a session ends after 30 days at most and 7 days idle (labelkit 0054)', () => {
		expect(SESSION_ABSOLUTE_MS).toBe(30 * 24 * 3600 * 1000);
		expect(SESSION_IDLE_MS).toBe(7 * 24 * 3600 * 1000);
		expect(sessionExpiry(NOW).toISOString()).toBe('2026-12-26T08:00:00.000Z');
		expect(idleCutoff(NOW).toISOString()).toBe('2026-11-19T08:00:00.000Z');
	});
});

describe('normaliseHost', () => {
	it('lowercases and drops a port and a trailing dot', () => {
		expect(normaliseHost(' Music.Example.TEST:443 ')).toBe('music.example.test');
		expect(normaliseHost('music.example.test.')).toBe('music.example.test');
	});
});
