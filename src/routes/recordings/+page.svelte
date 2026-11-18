<script lang="ts">
	import type { PageProps } from './$types';
	let { data }: PageProps = $props();
</script>

<div class="container stack">
	<h1 class="title">Recordings</h1>
	{#if data.canCreate}<a href="/recordings/new" class="btn primary">New recording</a>{/if}
	{#if data.recordings.length === 0}<p class="muted">No recordings yet.</p>{:else}
		<div class="table-wrap">
			<table class="data">
				<thead><tr><th>Title</th><th>ISRC</th></tr></thead><tbody>
					{#each data.recordings as r (r.id)}<tr
							><td><a href="/recordings/{r.id}">{r.title}</a></td><td class="mono">{r.isrc}</td></tr
						>{/each}
				</tbody>
			</table>
		</div>
	{/if}
</div>
