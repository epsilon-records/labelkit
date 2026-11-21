/** One recovery attempt per target URL for the lifetime of this tab, including full reloads. */
export function createAssetRecovery(
	storage: () => Pick<Storage, 'getItem' | 'setItem'>,
	load: (href: string) => void
) {
	const attempted = new Set<string>();
	const recovered = new WeakSet<object>();
	let stale = false;
	return {
		get stale() {
			return stale;
		},
		markStale() {
			stale = true;
		},
		wasRecovered(error: unknown) {
			return typeof error === 'object' && error !== null && recovered.has(error);
		},
		reload(target: URL, error?: unknown): boolean {
			const href = target.href;
			if (attempted.has(href)) return false;
			try {
				const session = storage();
				const key = `labelkit:asset-reload:${href}`;
				if (session.getItem(key)) return false;
				// Persist before navigating. If storage is unavailable, fail closed rather than loop.
				session.setItem(key, '1');
				attempted.add(href);
				load(href);
				if (typeof error === 'object' && error !== null) recovered.add(error);
				return true;
			} catch {
				return false;
			}
		}
	};
}

/** Recognise asset loading failures only; unrelated application errors still reach Sentry. */
export function isAssetLoadError(error: unknown): boolean {
	return (
		error instanceof Error &&
		/^(?:Unable to preload CSS for |Failed to fetch dynamically imported module:|Importing a module script failed|error loading dynamically imported module:)/i.test(
			error.message
		)
	);
}

export const assetRecovery = createAssetRecovery(
	() => window.sessionStorage,
	(href) => window.location.assign(href)
);
