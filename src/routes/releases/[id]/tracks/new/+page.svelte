<script lang="ts">
	import RecordingFields from '#lib/components/RecordingFields.svelte';
	import type { PageProps } from './$types';
	let { data, form }: PageProps = $props();
	const values = $derived(form && 'values' in form ? (form.values ?? {}) : {});
	const errors = $derived(form && 'errors' in form ? (form.errors ?? {}) : {});
	let mode = $derived(values.mode ?? 'existing');
</script>

<div class="container stack">
	<h1 class="title">Add track</h1>
	<p>{data.release.title}</p>
	<form method="POST" class="stack">
		<label for="mode">Recording</label>
		<select id="mode" name="mode" bind:value={mode}>
			<option value="existing">Choose existing recording</option><option value="new">
				Create new recording
			</option>
		</select>
		{#if mode === 'existing'}
			<label for="recordingId">Existing recording</label>
			<select id="recordingId" name="recordingId" required>
				<option value="">Choose a recording</option>{#each data.recordings as r (r.id)}<option
						value={r.id}
						selected={values.recordingId === r.id}
					>
						{r.title} · {r.isrc}
					</option>{/each}
			</select>
		{:else}
			<RecordingFields {values} {errors} />
		{/if}
		<label for="disc">Disc</label><input
			id="disc"
			name="disc"
			type="number"
			min="1"
			step="1"
			value={values.disc ?? '1'}
			required
		/>
		<label for="position">Track position</label><input
			id="position"
			name="position"
			type="number"
			min="1"
			step="1"
			value={values.position ??
				String(
					Math.max(0, ...data.release.tracks.filter((t) => t.disc === 1).map((t) => t.position)) + 1
				)}
			required
		/>
		{#each Object.entries(errors) as [field, message] (field)}<p role="alert">
				{field}: {message}
			</p>{/each}
		<div class="btn-group">
			<button class="btn primary" type="submit">Add track</button><a
				href="/releases/{data.release.id}"
				class="btn"
			>
				Cancel
			</a>
		</div>
	</form>
</div>
