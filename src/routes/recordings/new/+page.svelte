<script lang="ts">
	import RecordingFields from '#lib/components/RecordingFields.svelte';
	import type { PageProps } from './$types';
	let { form }: PageProps = $props();
	const values = $derived(form && 'values' in form ? (form.values ?? {}) : {});
	const errors = $derived(form && 'errors' in form ? (form.errors ?? {}) : {});
</script>

<div class="container stack">
	<h1 class="title">New recording</h1>
	<form method="POST" class="stack">
		<RecordingFields {values} {errors} />
		{#each Object.entries(errors) as [field, message] (field)}<p role="alert">
				{field}: {message}
			</p>{/each}
		<div class="btn-group">
			<button class="btn primary" type="submit">Create recording</button><a
				class="btn"
				href="/recordings">Cancel</a
			>
		</div>
	</form>
</div>
