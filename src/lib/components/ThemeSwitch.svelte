<script lang="ts">
	// System / Light / Dark (labelkit 0038), as one small icon button that cycles through the
	// three. The choice lives in this browser's localStorage under 'theme'; static/theme-init.js
	// applies it before first paint, this control changes it after.
	import { onMount } from 'svelte';
	import Monitor from '@lucide/svelte/icons/monitor';
	import Sun from '@lucide/svelte/icons/sun';
	import Moon from '@lucide/svelte/icons/moon';

	type Choice = 'system' | 'light' | 'dark';
	const order: Choice[] = ['system', 'light', 'dark'];
	const label: Record<Choice, string> = { system: 'System', light: 'Light', dark: 'Dark' };
	let choice = $state<Choice>('system');
	const next = $derived(order[(order.indexOf(choice) + 1) % order.length]);

	onMount(() => {
		try {
			const saved = localStorage.getItem('theme');
			if (saved === 'light' || saved === 'dark') choice = saved;
		} catch {
			// Storage blocked: stay on System.
		}
	});

	function pick(value: Choice) {
		choice = value;
		const root = document.documentElement;
		if (value === 'system') delete root.dataset.theme;
		else root.dataset.theme = value;
		try {
			if (value === 'system') localStorage.removeItem('theme');
			else localStorage.setItem('theme', value);
		} catch {
			// Storage blocked: the choice lasts for this page only.
		}
	}
</script>

<!-- 44 px hit area (the bar's touch floor, audit F-11); the visible part is an 18 px icon. -->
<button
	type="button"
	class="theme"
	aria-label="Theme: {label[choice]}. Switch to {label[next]}"
	title="Theme: {label[choice]}"
	onclick={() => pick(next)}
>
	{#if choice === 'light'}
		<Sun size={18} aria-hidden="true" />
	{:else if choice === 'dark'}
		<Moon size={18} aria-hidden="true" />
	{:else}
		<Monitor size={18} aria-hidden="true" />
	{/if}
</button>

<style>
	.theme {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 44px;
		height: 44px;
		padding: 0;
		border: 0;
		background: transparent;
		color: var(--muted);
		cursor: pointer;
	}
	.theme:hover {
		color: var(--text-strong);
	}
</style>
