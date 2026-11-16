import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const spies = vi.hoisted(() => ({
	init: vi.fn(),
	report: vi.fn(),
	navigation: { to: null as { url: URL } | null }
}));
vi.mock('@sentry/sveltekit', () => ({
	init: spies.init,
	handleErrorWithSentry: () => spies.report
}));
vi.mock('$app/state', () => ({ navigating: spies.navigation }));
vi.mock('$app/env/public', () => ({ PUBLIC_SENTRY_DSN: undefined }));

const target = new URL('https://example.test/terms');

afterEach(() => vi.unstubAllGlobals());

beforeEach(() => {
	vi.resetModules();
	vi.clearAllMocks();
	spies.navigation.to = null;
	const items = new Map<string, string>();
	vi.stubGlobal('window', {
		sessionStorage: {
			getItem: (key: string) => items.get(key) ?? null,
			setItem: (key: string, value: string) => items.set(key, value)
		},
		location: { assign: vi.fn() },
		addEventListener: vi.fn()
	});
});

it('recovers a navigation preload error and suppresses only that error in Sentry', async () => {
	const hooks = await import('./hooks.client');
	hooks.init();
	spies.navigation.to = { url: target };
	const error = new Error('Unable to preload CSS for /missing.css');
	const event = Object.assign(new Event('vite:preloadError', { cancelable: true }), {
		payload: error
	});
	const listener = vi.mocked(window.addEventListener).mock.calls[0][1] as (event: Event) => void;
	listener(event);
	expect(event.defaultPrevented).toBe(true);
	expect(window.location.assign).toHaveBeenCalledExactlyOnceWith(target.href);
	await hooks.handleError({ kind: 'unknown', error, event: { url: target } } as never);
	expect(spies.report).not.toHaveBeenCalled();
	const config = spies.init.mock.calls[0][0];
	expect(config.beforeSend({}, { originalException: error })).toBeNull();
	const unrelated = {};
	expect(config.beforeSend(unrelated, { originalException: new Error('Render failed') })).toBe(
		unrelated
	);
});

it('recovers a CSS error through the hook, but reports repeat failures and application errors', async () => {
	const { handleError } = await import('./hooks.client');
	const caught = {
		kind: 'unknown',
		error: new Error('Unable to preload CSS for /missing.css'),
		event: { url: target }
	};
	await handleError(caught as never);
	expect(window.location.assign).toHaveBeenCalledExactlyOnceWith(target.href);
	expect(spies.report).not.toHaveBeenCalled();
	const repeated = { ...caught, error: new Error(caught.error.message) };
	await handleError(repeated as never);
	expect(window.location.assign).toHaveBeenCalledTimes(1);
	expect(spies.report).toHaveBeenCalledWith(repeated);
	const unrelated = { ...caught, error: new Error('Render failed') };
	await handleError(unrelated as never);
	expect(spies.report).toHaveBeenCalledWith(unrelated);
});

it('does not reload the current page for a hover preload failure', async () => {
	const { init } = await import('./hooks.client');
	init();
	const event = Object.assign(new Event('vite:preloadError', { cancelable: true }), {
		payload: new Error('Unable to preload CSS for /missing.css')
	});
	const listener = vi.mocked(window.addEventListener).mock.calls[0][1] as (event: Event) => void;
	listener(event);
	expect(window.location.assign).not.toHaveBeenCalled();
	expect(event.defaultPrevented).toBe(false);
});
