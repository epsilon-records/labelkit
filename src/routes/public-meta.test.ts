import { render } from 'svelte/server';
import { describe, expect, it, vi } from 'vitest';

/**
 * Every public page has a meta description of a useful length (EPSILON-250). Lighthouse CI asserts
 * SEO 1.0 on these pages; this catches a missing or stubby description before CI does.
 */

const state = vi.hoisted(() => ({
	page: { url: new URL('https://labelkit.co/'), data: {} as { brand?: { name: string } } }
}));
vi.mock('$app/state', () => state);

const pages: Record<string, () => Promise<{ default: unknown }>> = {
	'/login': () => import('./login/+page.svelte'),
	'/signup': () => import('./signup/+page.svelte'),
	'/terms': () => import('./terms/+page.svelte'),
	'/privacy': () => import('./privacy/+page.svelte')
};

const descriptionOf = (head: string) =>
	head.match(/<meta name="description" content="([^"]*)"/)?.[1];

describe('public page meta descriptions', () => {
	for (const [path, load] of Object.entries(pages)) {
		it(`${path} has a 120-160 character description`, async () => {
			const { default: Page } = await load();
			const props = { data: { signupOpen: true, open: true }, form: null } as never;
			const description = descriptionOf(render(Page as never, { props }).head);
			expect(description, path).toBeTruthy();
			expect(description!.length).toBeGreaterThanOrEqual(120);
			expect(description!.length).toBeLessThanOrEqual(160);
		});
	}

	it('names the host brand on /login and /signup', async () => {
		state.page.data = { brand: { name: 'ERMS' } };
		for (const path of ['/login', '/signup']) {
			const { default: Page } = await pages[path]();
			const props = { data: { signupOpen: true, open: true }, form: null } as never;
			const description = descriptionOf(render(Page as never, { props }).head);
			expect(description, path).toContain('ERMS');
			expect(description, path).not.toContain('LabelKit');
		}
	});
});
