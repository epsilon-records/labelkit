<script lang="ts">
	import '../app.css';
	import '../tailwind.css';
	import { onMount, tick } from 'svelte';
	import { afterNavigate, beforeNavigate, replaceState } from '$app/navigation';
	import { page, updated } from '$app/state';
	import { assetRecovery } from '#lib/stale-assets.js';
	import { browser } from '$app/env';
	import { PUBLIC_APP_METRICS_ENABLED } from '$app/env/public';
	import AppMetrics from '#lib/AppMetrics.svelte';
	import ThemeSwitch from '#lib/components/ThemeSwitch.svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import { createCollector, documentLifetime } from '#lib/app-metrics-client.js';
	import { isMetricsOrigin } from '#lib/app-metrics-contract.js';
	import favicon from '#lib/assets/favicon.svg';
	import type { LayoutProps } from './$types';

	let { children, data }: LayoutProps = $props();

	const collector =
		browser &&
		PUBLIC_APP_METRICS_ENABLED &&
		__SENTRY_ENVIRONMENT__ === 'production' &&
		isMetricsOrigin(window.origin) &&
		typeof performance?.now === 'function'
			? createCollector({
					enabled: true,
					lifetime: documentLifetime,
					origin: window.origin,
					fetch: window.fetch.bind(window),
					now: () => performance.now(),
					visible: () => document.visibilityState === 'visible'
				})
			: null;

	// The login callback lands on /?signed-in (see auth/callback); tidy the address bar.
	// onMount, not $effect: replaceState updates page.state, and an effect that read it
	// would rerun and replace the URL again in a loop.
	onMount(() => {
		const url = new URL(location.href);
		if (url.searchParams.has('signed-in')) {
			url.searchParams.delete('signed-in');
			replaceState(url.pathname + url.search + url.hash, {});
		}
	});

	// The client hook handles asset failures; this catches a known new version before loading chunks.
	beforeNavigate(({ cancel, willUnload, to }) => {
		if (
			(updated.current || assetRecovery.stale) &&
			!willUnload &&
			to?.url &&
			assetRecovery.reload(to.url)
		) {
			cancel();
		}
	});

	const canImport = $derived(
		data.membership?.role === 'owner' || data.membership?.role === 'catalog_manager'
	);
	const canRights = $derived(
		data.membership?.role === 'owner' || data.membership?.role === 'rights_admin'
	);
	const canManageMembers = $derived(data.membership?.role === 'owner');
	const nav = $derived([
		{ href: '/releases', label: 'Releases' },
		{ href: '/artists', label: 'Artists' },
		{ href: '/compositions', label: 'Compositions' },
		...(canRights ? [{ href: '/rights', label: 'Rights' }] : []),
		...(canImport ? [{ href: '/import', label: 'Import' }] : []),
		...(canManageMembers ? [{ href: '/members', label: 'Members' }] : []),
		...(canManageMembers && data.plansEnabled ? [{ href: '/org/billing', label: 'Billing' }] : []),
		...(canManageMembers ? [{ href: '/org/export', label: 'Export' }] : []),
		...(canManageMembers ? [{ href: '/org/api-keys', label: 'API' }] : []),
		...(canManageMembers ? [{ href: '/org/branding', label: 'Branding' }] : [])
	]);
	const isCurrent = (href: string) => page.url.pathname.startsWith(href);
	// Phone top bar (audit F-11/F-16): under 760 px everything but the brand folds behind Menu.
	// It folds only once this code runs, so the links stay usable if it never loads.
	let ready = $state(false);
	let menuOpen = $state(false);
	let menuButton = $state<HTMLButtonElement>();
	onMount(() => (ready = true));
	afterNavigate(() => (menuOpen = false));
	async function closeMenu() {
		menuOpen = false;
		await tick();
		menuButton?.focus();
	}
	// Per-customer branding (EPSILON-132): ERMS on erms.epsilonrecords.com, LabelKit elsewhere.
	const brandName = $derived(data.brand?.name ?? 'LabelKit');
	const accent = $derived(data.brand?.accent ?? undefined);
</script>

{#if collector}<AppMetrics {collector} />{/if}

<svelte:head>
	<link rel="icon" href={data.brand?.favicon ? `/brand-icon?v=${data.brand.favicon}` : favicon} />
	<title>{brandName}</title>
</svelte:head>

<svelte:window
	onkeydown={(e) => {
		if (e.key === 'Escape' && menuOpen) closeMenu();
	}}
/>

<div class="app" style:--accent={accent}>
	{#if data.user}
		<header class="topbar" class:ready class:menu-open={menuOpen}>
			<a href="/" class="brand plain">{brandName}<span class="slash">/</span></a>
			<button
				bind:this={menuButton}
				type="button"
				class="menu-toggle"
				aria-expanded={menuOpen}
				aria-controls="topbar-tray"
				onclick={() => (menuOpen = !menuOpen)}>{menuOpen ? 'Close' : 'Menu'}</button
			>
			<div class="tray" id="topbar-tray">
				{#if data.membership}
					<nav aria-label="Main">
						{#each nav as item (item.href)}
							<a
								href={item.href}
								class="plain"
								aria-current={isCurrent(item.href) ? 'page' : undefined}>{item.label}</a
							>
						{/each}
					</nav>
				{/if}
				<div class="grow"></div>
				{#if data.membership}
					<form method="GET" action="/search" class="search" role="search">
						<label for="q" class="sr-only">Search the catalog</label>
						<input
							id="q"
							name="q"
							type="search"
							placeholder="Title, artist, ISRC, UPC, cat#"
							value={page.url.pathname === '/search' ? (page.url.searchParams.get('q') ?? '') : ''}
						/>
					</form>
				{/if}
				<ThemeSwitch />
				<div class="who">
					{#if data.memberships && data.memberships.length > 1}
						<form method="POST" action="/org" class="switch">
							<label for="org" class="sr-only">Label</label>
							<NativeSelect.Root
								id="org"
								name="orgId"
								value={data.membership?.orgId}
								wrapperClass="w-auto"
							>
								{#each data.memberships as m (m.orgId)}
									<NativeSelect.Option value={m.orgId}>{m.orgName}</NativeSelect.Option>
								{/each}
							</NativeSelect.Root>
							<!-- min-h-11: the 44 px touch floor for the bar (audit F-11). -->
							<Button type="submit" size="small" class="min-h-11">Switch</Button>
						</form>
					{/if}
					<span class="muted">{data.user.email}</span>
					{#if data.membership?.onboardedAt}
						<a href="/onboarding" class="linkish">Get started</a>
					{/if}
					<form method="POST" action="/logout"><button class="linkish">Log out</button></form>
				</div>
			</div>
		</header>
	{/if}

	<!-- The landing page puts #content after its own header and nav, so the skip link skips them. -->
	<main id={page.data.landing ? undefined : 'content'} tabindex="-1">
		{@render children()}
	</main>
</div>

<style>
	.topbar {
		display: flex;
		flex-wrap: wrap;
		align-items: stretch;
		gap: 0 32px;
		padding: 0 48px;
		border-bottom: 1px solid var(--line);
	}
	@media (max-width: 640px) {
		.topbar {
			padding: 0 20px;
			gap: 0 20px;
		}
	}
	.brand,
	nav a,
	.who,
	.switch {
		display: flex;
		gap: 8px;
		align-items: center;
	}
	.search {
		display: flex;
		align-items: center;
		min-height: 64px;
	}
	.brand {
		font-family: var(--mono);
		font-weight: 500;
		color: var(--text-strong);
	}
	.slash {
		color: var(--accent-ink, var(--accent));
	}
	nav {
		display: flex;
		flex-wrap: wrap;
		gap: 0 28px;
	}
	nav a {
		color: var(--muted);
	}
	nav a:hover {
		color: var(--text-strong);
	}
	nav a[aria-current='page'] {
		color: var(--text-strong);
		font-weight: 600;
		box-shadow: inset 0 -3px 0 var(--accent-ink, var(--accent));
	}
	.grow {
		flex-grow: 1;
	}
	.search input {
		width: 240px;
		max-width: 60vw;
		min-height: 40px;
	}
	.who {
		gap: 16px;
		font-size: 13px;
	}
	/* 44 px touch floor (audit F-11) for the small controls in the bar. */
	.who :global(.linkish) {
		min-height: 44px;
	}
	/* Full-width skip target: draw the keyboard ring inside it so it stays on screen. */
	main:focus-visible {
		outline-offset: -3px;
	}
	main:focus:not(:focus-visible) {
		outline: none;
	}
	.tray {
		display: contents;
	}
	.menu-toggle {
		display: none;
	}
	@media (max-width: 760px) {
		.ready .menu-toggle {
			display: inline-flex;
			align-items: center;
			align-self: center;
			margin-left: auto;
			min-height: 44px;
			padding: 0 16px;
			border: 1px solid var(--line-control);
			background: transparent;
			color: var(--text);
			font: inherit;
			font-weight: 600;
			cursor: pointer;
		}
		.ready .brand {
			min-height: 64px;
		}
		.ready .tray {
			display: none;
		}
		.ready.menu-open .tray {
			display: flex;
			flex-direction: column;
			align-items: stretch;
			flex-basis: 100%;
			gap: 12px;
			padding-bottom: 20px;
		}
		/* On a short screen the open menu scrolls inside the bar. */
		.ready.menu-open {
			max-height: 100dvh;
			overflow-y: auto;
		}
		.ready.menu-open nav {
			flex-direction: column;
			gap: 0;
		}
		.ready.menu-open nav a {
			min-height: 44px;
			border-top: 1px solid var(--line);
		}
		.ready.menu-open nav a[aria-current='page'] {
			box-shadow: inset 3px 0 0 var(--accent-ink, var(--accent));
			padding-left: 12px;
		}
		.ready.menu-open .grow {
			display: none;
		}
		.ready.menu-open .search {
			min-height: 0;
		}
		.ready.menu-open .search input {
			width: 100%;
			max-width: none;
			min-height: 44px;
		}
		.ready.menu-open .who {
			flex-wrap: wrap;
		}
	}
</style>
