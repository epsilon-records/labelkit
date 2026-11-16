<script lang="ts">
	import PublicAnalytics from '#lib/components/PublicAnalytics.svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { page } from '$app/state';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const brandName = $derived(page.data.brand?.name ?? 'LabelKit');
	const error = $derived(form && 'error' in form ? form.error : null);
</script>

<svelte:head>
	<title>Create an account · {brandName}</title>
	<meta
		name="description"
		content="Create a {brandName} account for your label. Enter your email, open the sign-up link we send, and name your label to start working."
	/>
</svelte:head>

<PublicAnalytics />

<div class="container" style="max-width: 480px; padding-top: 12vh">
	<section class="stack">
		<div class="eyebrow"><span>{page.data.brand?.name ?? 'LabelKit'}</span></div>
		<h1 class="form-title">Create an account</h1>
	</section>

	{#if !data.open}
		<div class="alert" role="status">
			Signup isn't open yet. If your label already uses LabelKit, ask an owner for an invite.
		</div>
		<p><a href="/login">Log in</a></p>
	{:else if form && 'sent' in form}
		<div class="alert ok" role="status">
			Sign-up link sent to {form.sent}. Open it to name your label.
		</div>
	{:else}
		<form method="POST" class="stack">
			<!-- gap-4: the label sits where it did before the migration. -->
			<Field.Field class="gap-4">
				<Field.Label for="email" class="font-mono">Email</Field.Label>
				<Input
					id="email"
					name="email"
					type="email"
					autocomplete="email"
					required
					aria-invalid={error ? true : undefined}
					aria-describedby={error ? 'signup-error' : undefined}
				/>
			</Field.Field>
			<div><Button type="submit" variant="primary">Send sign-up link</Button></div>
			<p class="soft">
				By signing up you agree to the <a href="/terms">Terms</a> on behalf of your label. The
				<a href="/privacy">Privacy notice</a> explains how we handle your data.
			</p>
			{#if error}
				<div id="signup-error" class="alert error" role="alert">{error}</div>
			{/if}
		</form>
		<p class="soft">Already have an account? <a href="/login">Log in</a></p>
	{/if}
</div>
