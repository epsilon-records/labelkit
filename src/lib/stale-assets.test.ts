import { describe, expect, it, vi } from 'vitest';
import { createAssetRecovery, isAssetLoadError } from './stale-assets';

function session() {
	const items = new Map<string, string>();
	return {
		getItem: (key: string) => items.get(key) ?? null,
		setItem: (key: string, value: string) => {
			items.set(key, value);
		}
	};
}
const target = new URL('https://example.test/terms');

describe('asset recovery guard', () => {
	it('loads the target once, persists across full loads, and permits a different target', () => {
		const storage = session();
		const load = vi.fn();
		const first = createAssetRecovery(() => storage, load);
		expect(first.reload(target)).toBe(true);
		expect(first.reload(target)).toBe(false);
		const afterReload = createAssetRecovery(() => storage, load);
		expect(afterReload.reload(target)).toBe(false);
		expect(afterReload.reload(new URL('/privacy', target))).toBe(true);
		expect(load.mock.calls).toEqual([[target.href], ['https://example.test/privacy']]);
	});

	it('allows another tab session to recover independently', () => {
		const load = vi.fn();
		for (let i = 0; i < 2; i++) {
			const storage = session();
			expect(createAssetRecovery(() => storage, load).reload(target)).toBe(true);
		}
		expect(load).toHaveBeenCalledTimes(2);
	});

	it('does not reload when session storage cannot preserve the guard', () => {
		const load = vi.fn();
		const denied = () => {
			throw new Error('Storage disabled');
		};
		expect(createAssetRecovery(denied, load).reload(target)).toBe(false);
		const storage = { ...session(), setItem: denied };
		expect(createAssetRecovery(() => storage, load).reload(target)).toBe(false);
		expect(load).not.toHaveBeenCalled();
	});

	it('marks only successfully recovered error objects for Sentry suppression', () => {
		const storage = session();
		const recovery = createAssetRecovery(() => storage, vi.fn());
		const error = new Error('Unable to preload CSS for /missing.css');
		const repeated = new Error(error.message);
		expect(recovery.wasRecovered(error)).toBe(false);
		expect(recovery.reload(target, error)).toBe(true);
		expect(recovery.wasRecovered(error)).toBe(true);
		expect(recovery.reload(target, repeated)).toBe(false);
		expect(recovery.wasRecovered(repeated)).toBe(false);
		expect(recovery.wasRecovered(null)).toBe(false);
	});

	it('remembers failed hover preloads without immediately navigating', () => {
		const load = vi.fn();
		const recovery = createAssetRecovery(session, load);
		expect(recovery.stale).toBe(false);
		recovery.markStale();
		expect(recovery.stale).toBe(true);
		expect(load).not.toHaveBeenCalled();
	});
});

it('recognises CSS and dynamic-import failures without hiding unrelated errors', () => {
	for (const message of [
		'Unable to preload CSS for /missing.css',
		'Failed to fetch dynamically imported module: /missing.js',
		'Importing a module script failed.',
		'error loading dynamically imported module: /missing.js'
	])
		expect(isAssetLoadError(new Error(message))).toBe(true);
	for (const error of [new Error('Failed to fetch'), new Error('Render failed'), null, 'oops']) {
		expect(isAssetLoadError(error)).toBe(false);
	}
});
