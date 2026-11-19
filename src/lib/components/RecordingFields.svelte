<script lang="ts">
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	let {
		recording = {},
		values = {},
		errors = {}
	}: {
		recording?: {
			title?: string;
			versionTitle?: string | null;
			isrc?: string;
			durationMs?: number | null;
			genre?: string | null;
			subgenre?: string | null;
		};
		values?: Record<string, string>;
		errors?: Record<string, string>;
	} = $props();
	const fmt = (ms?: number | null) =>
		ms == null
			? ''
			: `${String(Math.floor(ms / 60000)).padStart(2, '0')}:${String(Math.round(ms / 1000) % 60).padStart(2, '0')}`;
	const v = (key: string, fallback?: string | null) => values[key] ?? fallback ?? '';
	const fieldError = (key: string) => errors[key];
	const invalid = (key: string) =>
		errors[key] ? { 'aria-invalid': true as const, 'aria-describedby': `${key}-error` } : {};
</script>

{#snippet error(field: string)}{#if fieldError(field)}<Field.Error id="{field}-error"
			>{fieldError(field)}</Field.Error
		>{/if}{/snippet}
<Field.Group class="gap-2.5">
	<Field.Field orientation="responsive">
		<Field.Label for="title">Title</Field.Label>
		<Input
			id="title"
			name="title"
			value={v('title', recording.title)}
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
			value={v('versionTitle', recording.versionTitle)}
			placeholder="e.g. Extended Mix"
			{...invalid('versionTitle')}
		/>
		{@render error('versionTitle')}
	</Field.Field>
	<Field.Field orientation="responsive">
		<Field.Label for="isrc">ISRC</Field.Label>
		<Input
			id="isrc"
			name="isrc"
			class="font-mono"
			value={v('isrc', recording.isrc)}
			required
			{...invalid('isrc')}
		/>
		{@render error('isrc')}
	</Field.Field>
	<Field.Field orientation="responsive">
		<Field.Label for="duration">Length</Field.Label>
		<Input
			id="duration"
			name="duration"
			class="font-mono"
			value={v('duration', fmt(recording.durationMs))}
			placeholder="mm:ss"
			{...invalid('duration')}
		/>
		{@render error('duration')}
	</Field.Field>
	<Field.Field orientation="responsive">
		<Field.Label for="genre">Genre</Field.Label>
		<Input id="genre" name="genre" value={v('genre', recording.genre)} {...invalid('genre')} />
		{@render error('genre')}
	</Field.Field>
	<Field.Field orientation="responsive">
		<Field.Label for="subgenre">Subgenre</Field.Label>
		<Input
			id="subgenre"
			name="subgenre"
			value={v('subgenre', recording.subgenre)}
			{...invalid('subgenre')}
		/>
		{@render error('subgenre')}
	</Field.Field>
</Field.Group>
