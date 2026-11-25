<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import ThemeSwitch from './ThemeSwitch.svelte';

	const { Story } = defineMeta({
		title: 'Components/ThemeSwitch',
		component: ThemeSwitch
	});
</script>

<Story name="Default" />
