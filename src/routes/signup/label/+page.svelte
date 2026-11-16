<script lang="ts">
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { page } from '$app/state';
	import { slugFromName } from '#lib/slug.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	// Values come back after a refused submit (the form posts without JavaScript).
	const sent = $derived((form as { values?: { name: string; slug: string } } | null)?.values);
	let name = $derived(sent?.name ?? '');
	let slug = $derived(sent?.slug ?? '');
	let slugEdited = $derived(Boolean(sent?.slug));

	// Suggest the address from the name until the user types their own.
	const suggested = $derived(slugFromName(name));
	const slugValue = $derived(slugEdited ? slug : suggested);
	const error = $derived(form && 'error' in form ? form.error : null);
	// Which input the error belongs to (the action names it; default to the name).
	const errorField = $derived(form && 'field' in form ? form.field : 'name');
</script>

<div class="container" style="max-width: 480px; padding-top: 12vh">
	<section class="stack">
		<div class="eyebrow"><span>{page.data.brand?.name ?? 'LabelKit'}</span></div>
		<h1 class="form-title">Name your label</h1>
	</section>

	{#if !data.open}
		<div class="alert" role="status">
			You're signed in{data.email ? ` as ${data.email}` : ''}, but you're not a member of any label.
			Ask a label owner to invite you.
		</div>
		<form method="POST" action="/logout"><Button type="submit">Log out</Button></form>
	{:else}
		<form method="POST" class="stack">
			<!-- gap-4: the labels sit where they did before the migration. -->
			<Field.Field class="gap-4">
				<Field.Label for="name" class="font-mono">Label name</Field.Label>
				<Input
					id="name"
					name="name"
					required
					maxlength={120}
					value={name}
					oninput={(e) => (name = e.currentTarget.value)}
					aria-invalid={error && errorField === 'name' ? true : undefined}
					aria-describedby={error && errorField === 'name' ? 'label-error' : undefined}
				/>
			</Field.Field>

			<Field.Field class="gap-4">
				<Field.Label for="slug" class="font-mono">Address</Field.Label>
				<Input
					id="slug"
					name="slug"
					required
					maxlength={40}
					value={slugValue}
					aria-invalid={error && errorField === 'slug' ? true : undefined}
					aria-describedby={error && errorField === 'slug' ? 'slug-hint label-error' : 'slug-hint'}
					oninput={(e) => {
						slugEdited = true;
						slug = e.currentTarget.value;
					}}
				/>
				<p id="slug-hint" class="soft">Lowercase letters, digits and hyphens.</p>
			</Field.Field>

			<div><Button type="submit" variant="primary">Create label</Button></div>
			{#if error}
				<div id="label-error" class="alert error" role="alert">{error}</div>
			{/if}
		</form>
	{/if}
</div>
