import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

const pages = [
	{
		path: '/',
		heading: "Run your label's catalogue, rights and masters in one place.",
		action: (page: Page) => page.locator('.hero .actions a[href="/signup"]')
	},
	{
		path: '/login',
		heading: 'Log in',
		action: (page: Page) => page.getByRole('button', { name: 'Send login link', exact: true })
	},
	// The placeholder environment leaves signup closed, so its primary available action is Log in.
	{
		path: '/signup',
		heading: 'Create an account',
		action: (page: Page) => page.getByRole('link', { name: 'Log in', exact: true })
	},
	{
		path: '/terms',
		heading: 'Terms of service',
		action: (page: Page) => page.getByRole('link', { name: 'LabelKit', exact: true })
	},
	{
		path: '/privacy',
		heading: 'Privacy notice',
		action: (page: Page) => page.getByRole('link', { name: 'LabelKit', exact: true })
	}
];

async function noHorizontalScroll(page: Page) {
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
		await page.evaluate(() => innerWidth)
	);
}

async function touchTargets(targets: Locator) {
	for (const target of await targets.all()) {
		if (!(await target.isVisible())) continue;
		const bounds = await target.boundingBox();
		expect(bounds, (await target.textContent()) ?? 'tap target').not.toBeNull();
		expect(bounds!.width, (await target.textContent()) ?? 'tap target').toBeGreaterThanOrEqual(44);
		expect(bounds!.height, (await target.textContent()) ?? 'tap target').toBeGreaterThanOrEqual(44);
	}
}

for (const { path, heading, action } of pages) {
	test(`phone ${path} fits and keeps its actions usable`, async ({ page }) => {
		expect((await page.goto(path))?.status()).toBe(200);
		await page.waitForLoadState('networkidle');
		await page.evaluate(() => document.fonts.ready);
		await noHorizontalScroll(page);
		await expect(page.getByRole('heading', { level: 1, name: heading, exact: true })).toBeVisible();
		await expect(
			page.getByRole('heading', { level: 1, name: heading, exact: true })
		).toBeInViewport();
		await expect(action(page)).toBeVisible();
		await expect(action(page)).toBeInViewport();
		await touchTargets(page.locator('header a, header button, .legal > p:first-child a'));
		const menu = page.locator('header .menu-toggle');
		if (await menu.isVisible()) {
			await menu.click();
			await expect(menu).toHaveAttribute('aria-expanded', 'true');
			await touchTargets(page.locator('header a, header button'));
			await noHorizontalScroll(page);
		}
	});
}
