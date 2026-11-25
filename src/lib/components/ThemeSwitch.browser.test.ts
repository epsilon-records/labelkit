import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import ThemeSwitch from './ThemeSwitch.svelte';

const root = document.documentElement;

describe('ThemeSwitch', () => {
	beforeEach(() => {
		localStorage.removeItem('theme');
		delete root.dataset.theme;
	});

	afterEach(() => {
		cleanup();
		localStorage.removeItem('theme');
		delete root.dataset.theme;
	});

	it('cycles through System, Light, Dark and back to System', async () => {
		render(ThemeSwitch);

		const systemName = 'Theme: System. Switch to Light';
		const lightName = 'Theme: Light. Switch to Dark';
		const darkName = 'Theme: Dark. Switch to System';

		await fireEvent.click(screen.getByRole('button', { name: systemName }));
		expect(root.dataset.theme).toBe('light');
		expect(localStorage.getItem('theme')).toBe('light');

		await fireEvent.click(screen.getByRole('button', { name: lightName }));
		expect(root.dataset.theme).toBe('dark');
		expect(localStorage.getItem('theme')).toBe('dark');

		await fireEvent.click(screen.getByRole('button', { name: darkName }));
		expect(screen.getByRole('button', { name: systemName })).toBeDefined();
		expect(root.dataset.theme).toBeUndefined();
		expect(localStorage.getItem('theme')).toBeNull();
	});

	it('reads a saved dark preference on mount', async () => {
		localStorage.setItem('theme', 'dark');
		render(ThemeSwitch);

		expect(
			await screen.findByRole('button', { name: 'Theme: Dark. Switch to System' })
		).toBeDefined();
	});
});
