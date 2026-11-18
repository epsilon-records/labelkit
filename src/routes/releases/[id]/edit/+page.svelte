<script lang="ts">
	import Credits from '#lib/components/Credits.svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import ReleaseFields from '#lib/components/ReleaseFields.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const r = $derived(data.release);
	const errors = $derived<Record<string, string>>(
		form && 'errors' in form && form.errors ? form.errors : {}
	);
	const values = $derived<Record<string, string>>(
		form && 'values' in form && form.values ? form.values : {}
	);
	const failed = (a: string) => form && 'action' in form && form.action === a && !form.ok;
	const FIELDS = [
		'title',
		'versionTitle',
		'type',
		'releaseDate',
		'labelId',
		'catalogNumber',
		'upc',
		'genre',
		'subgenre'
	];
	const formErrors = $derived(
		failed('save')
			? Object.entries(errors)
					.filter(([k]) => !FIELDS.includes(k))
					.map(([, m]) => m)
			: []
	);

	const artistCredits = $derived(
		r.artists.map((a) => ({
			id: a.creditId,
			role: 'main',
			name: a.name,
			partyId: a.id,
			approvedAt: a.approvedAt
		}))
	);
</script>

<div class="container">
	<section class="stack">
		<div class="eyebrow">
			<a href="/releases/{r.id}" class="plain muted">← {r.title}</a>
			<span class="tag outline">Editing</span>
		</div>
		<h1 class="title">Edit release</h1>
	</section>

	<form method="POST" action="?/save" class="stack">
		<input type="hidden" name="updatedAt" value={r.updatedAt.toISOString()} />
		<ReleaseFields
			release={{
				title: r.title,
				versionTitle: r.versionTitle,
				type: r.type,
				releaseDate: r.releaseDate,
				labelId: r.labelId,
				catalogNumber: r.catalogNumber,
				upc: r.upc,
				genre: r.genre,
				subgenre: r.subgenre
			}}
			labels={data.labels}
			values={failed('save') ? values : {}}
			errors={failed('save') ? errors : {}}
			allowType={true}
		/>
		<!-- Lines the buttons up with the controls: the 140 px label column plus the 20 px gap. -->
		<div class="btn-group sm:pl-[160px]">
			<Button type="submit" variant="primary">Save</Button>
			<a href="/releases/{r.id}" class="btn">Cancel</a>
		</div>
		{#if formErrors.length}
			<div class="alert error" role="alert">{formErrors.join('\n')}</div>
		{/if}
	</form>

	<section class="stack" aria-labelledby="artists-h">
		<h2 id="artists-h" class="h2">Release artists</h2>
		<Credits
			credits={artistCredits}
			canEdit={true}
			canApprove={data.can.approve}
			roles={['main']}
			errors={failed('addCredit') || failed('removeCredit') || failed('approveCredit')
				? errors
				: {}}
			values={failed('addCredit') ? values : {}}
		/>
		<p class="muted" style="margin: 0; font-size: 13px">
			Track titles, ISRCs and track credits are edited on each recording's page.
		</p>
	</section>
</div>
