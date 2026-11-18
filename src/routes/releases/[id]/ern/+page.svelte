<script lang="ts">
	import type { PageProps } from './$types';
	let { data, form }: PageProps = $props();
	const values = $derived(
		form?.values ?? {
			senderDpid: data.testSender,
			recipientDpid: '',
			territoryScope: '',
			dealScope: ''
		}
	);
</script>

<div class="container stack">
	<a href="/releases/{data.release.id}">← {data.release.title}</a>
	<h1>Export ERN</h1>
	<p class="alert">
		{data.notice}. This checks ERN 4.3 metadata only. Nothing is sent to a partner.
	</p>
	<p>
		Enter the context for this export. The test sender is a placeholder, not a registered DDEX ID.
	</p>
	<form method="POST" class="stack">
		<label class="field"
			>Sender DDEX party ID<input
				name="senderDpid"
				value={values.senderDpid}
				required
				maxlength="100"
			/></label
		>
		<label class="field"
			>Recipient DDEX party ID<input
				name="recipientDpid"
				value={values.recipientDpid}
				required
				maxlength="100"
			/></label
		>
		<label class="field"
			>Territory scope (optional)<textarea name="territoryScope" maxlength="2000" rows="2"
				>{values.territoryScope}</textarea
			></label
		>
		<label class="field"
			>Deal or partner scope (optional)<textarea name="dealScope" maxlength="2000" rows="2"
				>{values.dealScope}</textarea
			></label
		>
		<p class="muted">
			Commercial scope needs a partner mapping and will be reported as unmapped. Missing catalogue
			facts must be entered through separately scoped catalogue work; this form cannot override
			them.
		</p>
		<button type="submit" class="btn primary">Check export</button>
	</form>
	{#if form?.findings?.length}
		<section class="stack" aria-labelledby="findings-title">
			<h2 id="findings-title">Resolve these catalogue and export findings</h2>
			<p role="status">No XML was created. {form.findings.length} findings need attention.</p>
			<ul>
				{#each form.findings as finding, i (i)}<li>
						{#if finding.target}<strong>{finding.target}:</strong>
						{/if}{finding.message}
					</li>{/each}
			</ul>
		</section>
	{:else if form?.ready}
		<p role="status">Preflight passed for this catalogue snapshot. The download checks it again.</p>
		<form method="POST" action="/releases/{data.release.id}/ern/download">
			{#each Object.entries(values) as [name, value] (name)}<input
					type="hidden"
					{name}
					{value}
				/>{/each}
			<button type="submit" class="btn">Download ERN — not for delivery</button>
		</form>
	{/if}
</div>
