<script lang="ts">
	import ReleaseFields from '#lib/components/ReleaseFields.svelte';
	import type { PageProps } from './$types';
	let { data, form }: PageProps = $props();
	const errors = $derived(form && 'errors' in form ? (form.errors ?? {}) : {});
</script>

<div class="container stack">
	<h1 class="title">New release</h1>
	<p class="muted">Release type is derived from its tracks and artist credits.</p>
	{#if data.labels.length === 0}<p>Create a label before creating a release.</p>{:else}
		<form method="POST" class="stack">
			<ReleaseFields
				labels={data.labels}
				values={form && 'values' in form ? (form.values ?? {}) : {}}
				{errors}
			/>
			{#each Object.entries(errors) as [field, message] (field)}<p role="alert">
					{field}: {message}
				</p>{/each}
			<div class="btn-group">
				<button class="btn primary" type="submit">Create release</button><a
					href="/releases"
					class="btn">Cancel</a
				>
			</div>
		</form>
	{/if}
</div>
