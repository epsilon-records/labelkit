import { expect, test } from '@playwright/test';

const pages = [
	{ path: '/', heading: "Run your label's catalogue, rights and masters in one place." },
	{ path: '/login', heading: 'Log in' },
	{ path: '/signup', heading: 'Create an account' },
	{ path: '/terms', heading: 'Terms of service' },
	{ path: '/privacy', heading: 'Privacy notice' }
];

for (const { path, heading } of pages) {
	test(`${path} loads without browser errors`, async ({ page }) => {
		const errors: string[] = [];
		page.on('console', (message) => {
			if (message.type() === 'error') errors.push(message.text());
		});
		page.on('pageerror', (error) => errors.push(error.message));

		const response = await page.goto(path);
		expect(response?.status()).toBe(200);
		await expect(page.getByRole('heading', { level: 1, name: heading, exact: true })).toBeVisible();
		// Wait for client hydration and its requests as well as the initial HTML.
		await page.waitForLoadState('networkidle');
		expect(errors).toEqual([]);
	});
}
