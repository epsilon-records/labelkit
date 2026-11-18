import type { ClientInit, HandleClientError } from '@sveltejs/kit/hooks';
import { navigating } from '$app/state';
import { assetRecovery, isAssetLoadError } from '#lib/stale-assets.js';
import * as Sentry from '@sentry/sveltekit';
import { isMetricsRequest } from '#lib/app-metrics-sentry.js';
import { PUBLIC_SENTRY_DSN } from '$app/env/public';

// Browser error monitoring (shared decision 0003). A no-op when the DSN is unset.
Sentry.init({
	dsn: PUBLIC_SENTRY_DSN,
	environment: __SENTRY_ENVIRONMENT__,
	release: __SENTRY_RELEASE__ ?? undefined,
	tracesSampleRate: PUBLIC_SENTRY_DSN ? 0.1 : 0,
	// The collector must not receive tracing headers or become a fetch breadcrumb.
	tracePropagationTargets: [
		/^\/(?!\/|api\/app-metrics(?:[?#]|$))/,
		/^https:\/\/erms\.epsilonrecords\.com\/(?!api\/app-metrics(?:[?#]|$))/
	],
	integrations: (defaults) => [
		...defaults.filter((i) => i.name !== 'BrowserTracing'),
		Sentry.browserTracingIntegration({
			shouldCreateSpanForRequest: (url) => !isMetricsRequest(url)
		})
	],
	beforeSend: (event, hint) => (assetRecovery.wasRecovered(hint.originalException) ? null : event),
	beforeBreadcrumb: (breadcrumb) => (isMetricsRequest(breadcrumb.data?.url) ? null : breadcrumb)
});

export const init: ClientInit = () => {
	window.addEventListener('vite:preloadError', (event) => {
		assetRecovery.markStale();
		// A hover preload must not discard unsaved state or reload the wrong page.
		const target = navigating.to?.url;
		if (target && assetRecovery.reload(target, event.payload)) event.preventDefault();
	});
};

const reportError = Sentry.handleErrorWithSentry<HandleClientError>();
export const handleError: HandleClientError = (caught) => {
	if (assetRecovery.wasRecovered(caught.error)) return;
	const target = navigating.to?.url;
	if (
		target?.href === caught.event.url.href &&
		isAssetLoadError(caught.error) &&
		assetRecovery.reload(target, caught.error)
	)
		return;
	return reportError(caught);
};
