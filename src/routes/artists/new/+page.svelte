<script lang="ts">
	import { Input } from '#lib/components/ui/input/index.js';
	import type { PageProps } from './$types';
	let { form }: PageProps = $props();
	const values = $derived(form && 'values' in form ? (form.values ?? {}) : {});
	const errors = $derived(form && 'errors' in form ? (form.errors ?? {}) : {});
</script>

<div class="container stack">
	<h1 class="title">New artist</h1>
	<form method="POST" class="stack">
		<label for="displayName">Artist name</label><Input
			id="displayName"
			name="displayName"
			value={values.displayName ?? ''}
			required
		/>
		{#each Object.entries(errors) as [field, message] (field)}<p role="alert">
				{field}: {message}
			</p>{/each}
		<div class="btn-group">
			<button class="btn primary" type="submit">Create artist</button><a
				class="btn"
				href="/artists"
			>
				Cancel
			</a>
		</div>
	</form>
</div>
