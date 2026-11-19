import { expect, test } from '@playwright/test';

test('a missing navigation stylesheet reloads the target once', async ({ page }) => {
	const pageErrors: string[] = [];
	page.on('pageerror', (error) => pageErrors.push(error.message));
	await page.goto('/');
	await page.waitForLoadState('networkidle');

	let missingStylesheets = 0;
	let documentLoads = 0;
	page.on('request', (request) => {
		if (request.isNavigationRequest() && request.frame() === page.mainFrame()) documentLoads++;
	});
	// Reproduce an old tab's missing hashed asset without changing a deployment.
	await page.route(
		/\/_app\/immutable\/assets\/LegalPage[^/]*\.css$/,
		async (route) => {
			missingStylesheets++;
			await route.fulfill({ status: 404, contentType: 'text/css', body: '' });
		},
		{ times: 1 }
	);

	// Click without hovering: this exercises an active navigation, not speculative preloading.
	await page.locator('a[href="/terms"]').evaluate((link: HTMLAnchorElement) => link.click());
	await expect(page).toHaveURL('/terms');
	await expect(page.getByRole('heading', { level: 1, name: 'Terms of service' })).toBeVisible();
	await page.waitForLoadState('networkidle');
	expect(missingStylesheets).toBe(1);
	expect(documentLoads).toBe(1);
	expect(
		await page.evaluate(() => sessionStorage.getItem(`labelkit:asset-reload:${location.href}`))
	).toBe('1');
	expect(pageErrors).toEqual([]);
});

test('a failed hover preload stays on the current page until the link is clicked', async ({
	page
}) => {
	await page.goto('/');
	await page.waitForLoadState('networkidle');
	let missingStylesheets = 0;
	let documentLoads = 0;
	page.on('request', (request) => {
		if (request.isNavigationRequest() && request.frame() === page.mainFrame()) documentLoads++;
	});
	await page.route(
		/\/_app\/immutable\/assets\/LegalPage[^/]*\.css$/,
		async (route) => {
			missingStylesheets++;
			await route.fulfill({ status: 404, contentType: 'text/css', body: '' });
		},
		{ times: 1 }
	);
	await page.locator('a[href="/terms"]').hover();
	await expect.poll(() => missingStylesheets).toBe(1);
	await page.waitForLoadState('networkidle');
	await expect(page).toHaveURL('/');
	expect(documentLoads).toBe(0);
	expect(
		await page.evaluate(() =>
			sessionStorage.getItem(`labelkit:asset-reload:${new URL('/terms', location.href).href}`)
		)
	).toBeNull();
	await page.locator('a[href="/terms"]').evaluate((link: HTMLAnchorElement) => link.click());
	await expect(page).toHaveURL('/terms');
	await expect(page.getByRole('heading', { level: 1, name: 'Terms of service' })).toBeVisible();
	expect(documentLoads).toBe(1);
});
