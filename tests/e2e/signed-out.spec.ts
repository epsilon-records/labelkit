import { expect, test } from '@playwright/test';

// Each test gets a fresh, signed-out browser context. No auth cookie or database fixture.
for (const path of [
	'/releases',
	'/search',
	'/members',
	'/import',
	'/org/branding',
	'/org/api-keys'
]) {
	test(`signed-out ${path} redirects to login`, async ({ page }) => {
		const response = await page.goto(path);
		expect(response?.status()).toBe(200);
		await expect(page).toHaveURL('/login');
		await expect(
			page.getByRole('heading', { level: 1, name: 'Log in', exact: true })
		).toBeVisible();

		// Check the server redirect itself, not just the final rendered page.
		const original = response?.request().redirectedFrom();
		expect(original?.url()).toBe(new URL(path, response!.url()).href);
		const redirect = await original?.response();
		expect(redirect?.status()).toBe(303);
		expect(redirect?.headers().location).toBe('/login');
	});
}
