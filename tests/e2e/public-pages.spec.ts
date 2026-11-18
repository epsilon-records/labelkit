import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const pages = [
	{ path: '/', heading: "Run your label's catalogue, rights and masters in one place." },
	{ path: '/login', heading: 'Log in' },
	{ path: '/signup', heading: 'Create an account' },
	{ path: '/terms', heading: 'Terms of service' },
	{ path: '/privacy', heading: 'Privacy notice' }
];

for (const { path, heading } of pages) {
	test(`${path} loads without browser errors`, async ({ page }, testInfo) => {
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
		const { violations } = await new AxeBuilder({ page }).analyze();
		await testInfo.attach('axe-violations', {
			body: JSON.stringify(violations, null, 2),
			contentType: 'application/json'
		});
		const blocking = violations.filter(
			({ impact }) => impact === 'serious' || impact === 'critical'
		);
		expect(blocking, `Serious/critical axe violations on ${path}`).toEqual([]);
		expect(errors).toEqual([]);
	});
}
