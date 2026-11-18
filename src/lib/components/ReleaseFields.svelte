<script lang="ts">
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	let {
		release = {},
		labels,
		values = {},
		errors = {},
		allowType = false
	}: {
		release?: Record<string, string | null>;
		labels: { id: string; name: string }[];
		values?: Record<string, string>;
		errors?: Record<string, string>;
		allowType?: boolean;
	} = $props();
	const v = (key: string, fallback?: string | null) => values[key] ?? fallback ?? '';
	const fieldError = (key: string) => errors[key];
	const invalid = (key: string) =>
		errors[key] ? { 'aria-invalid': true as const, 'aria-describedby': `${key}-error` } : {};
	const TYPES = ['single', 'ep', 'album', 'compilation'];
</script>

{#snippet error(field: string)}
	{#if fieldError(field)}<Field.Error id="{field}-error">{fieldError(field)}</Field.Error>{/if}
{/snippet}
<Field.Group class="gap-2.5">
	<Field.Field orientation="responsive">
		<Field.Label for="title">Title</Field.Label>
		<Input
			id="title"
			name="title"
			value={v('title', release.title)}
			required
			{...invalid('title')}
		/>
		{@render error('title')}
	</Field.Field>
	<Field.Field orientation="responsive">
		<Field.Label for="versionTitle">Version</Field.Label>
		<Input
			id="versionTitle"
			name="versionTitle"
			value={v('versionTitle', release.versionTitle)}
			{...invalid('versionTitle')}
		/>
		{@render error('versionTitle')}
	</Field.Field>
	{#if allowType}
		<Field.Field orientation="responsive">
			<Field.Label for="type">Type</Field.Label>
			<NativeSelect.Root id="type" name="type" value={v('type', release.type)} {...invalid('type')}>
				{#each TYPES as t (t)}<NativeSelect.Option value={t}>{t}</NativeSelect.Option>{/each}
			</NativeSelect.Root>
			{@render error('type')}
		</Field.Field>
	{/if}
	<Field.Field orientation="responsive">
		<Field.Label for="releaseDate">Release date</Field.Label>
		<Input
			id="releaseDate"
			name="releaseDate"
			value={v('releaseDate', release.releaseDate)}
			placeholder="YYYY-MM-DD"
			{...invalid('releaseDate')}
		/>
		{@render error('releaseDate')}
	</Field.Field>
	<Field.Field orientation="responsive">
		<Field.Label for="labelId">Label</Field.Label>
		<NativeSelect.Root
			id="labelId"
			name="labelId"
			value={v('labelId', release.labelId)}
			{...invalid('labelId')}
		>
			{#each labels as l (l.id)}
				<NativeSelect.Option value={l.id}>{l.name}</NativeSelect.Option>
			{/each}
		</NativeSelect.Root>
		{@render error('labelId')}
	</Field.Field>
	<Field.Field orientation="responsive">
		<Field.Label for="catalogNumber">Catalog #</Field.Label>
		<Input
			id="catalogNumber"
			name="catalogNumber"
			class="font-mono"
			value={v('catalogNumber', release.catalogNumber)}
			{...invalid('catalogNumber')}
		/>
		{@render error('catalogNumber')}
	</Field.Field>
	<Field.Field orientation="responsive">
		<Field.Label for="upc">UPC</Field.Label>
		<Input
			id="upc"
			name="upc"
			class="font-mono"
			value={v('upc', release.upc)}
			required
			{...invalid('upc')}
		/>
		{@render error('upc')}
	</Field.Field>
	<Field.Field orientation="responsive">
		<Field.Label for="genre">Genre</Field.Label>
		<Input id="genre" name="genre" value={v('genre', release.genre)} {...invalid('genre')} />
		{@render error('genre')}
	</Field.Field>
	<Field.Field orientation="responsive">
		<Field.Label for="subgenre">Subgenre</Field.Label>
		<Input
			id="subgenre"
			name="subgenre"
			value={v('subgenre', release.subgenre)}
			{...invalid('subgenre')}
		/>
		{@render error('subgenre')}
	</Field.Field>
</Field.Group>
