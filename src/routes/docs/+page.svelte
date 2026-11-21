<script lang="ts">
	import { Button } from '#lib/components/ui/button/index.js';
	import type { PageProps } from './$types';
	let { data }: PageProps = $props();
</script>

<svelte:head>
	<title>API reference · LabelKit</title>
	<meta
		name="description"
		content="Read the LabelKit API reference for catalogue operations, authentication, parameters and response schemas, generated from the published OpenAPI contract."
	/>
</svelte:head>

<div class="container docs">
	<header class="stack">
		<a href="/" class="linkish">LabelKit</a>
		<p class="eyebrow">Developer documentation · {data.reference.version}</p>
		<h1 class="title">API reference</h1>
		<p class="intro">{data.reference.description}</p>
		{#each data.reference.servers as server (server)}<p class="soft">
				API server <code>{server}</code>
			</p>{/each}
		<div class="flex flex-wrap gap-2">
			<Button href="#operations" variant="primary">Browse operations</Button>
		</div>
	</header>

	<nav aria-label="API operations" class="contents">
		{#each data.reference.groups as group (group.tag)}
			<div>
				<p class="eyebrow">{group.tag}</p>
				<ul>
					{#each group.operations as operation (operation.id)}<li>
							<a href={`#${operation.id}`}><code>{operation.method} {operation.path}</code></a>
						</li>{/each}
				</ul>
			</div>
		{/each}
	</nav>

	<div id="operations">
		{#each data.reference.groups as group (group.tag)}
			<section aria-label={group.tag}>
				<h2>{group.tag}</h2>
				{#each group.operations as operation (operation.id)}
					<article id={operation.id} class="operation">
						<h3>
							<a class="plain" href={`#${operation.id}`}
								><span class="method">{operation.method}</span> <code>{operation.path}</code></a
							>
						</h3>
						<p class="summary">{operation.summary}</p>
						{#if operation.description}<p>{operation.description}</p>{/if}
						<h4>Authentication</h4>
						<p>{operation.auth}</p>
						<h4>Parameters</h4>
						{#if operation.parameters.length}
							{#each operation.parameters as parameter (`${parameter.location}:${parameter.name}`)}
								<div class="definition">
									<p>
										<code>{parameter.name}</code> · {parameter.location} · {parameter.required
											? 'Required'
											: 'Optional'}
									</p>
									{#if parameter.description}<p>{parameter.description}</p>{/if}
									{@render schema(parameter.schema)}
								</div>
							{/each}
						{:else}<p class="soft">No parameters.</p>{/if}
						<h4>Request body</h4>
						{#if operation.requestBody}
							<p>
								{operation.requestBody.required ? 'Required' : 'Optional'} · {operation.requestBody
									.description}
							</p>
							{#each operation.requestBody.content as body (body.mediaType)}<p>
									<code>{body.mediaType}</code>
								</p>
								{@render schema(body.schema)}{/each}
						{:else}<p class="soft">No request body.</p>{/if}
						<h4>Responses</h4>
						{#each operation.responses as response (response.status)}
							<details class="definition" open={response.status.startsWith('2')}>
								<summary><code>{response.status}</code> · {response.description}</summary>
								{#each response.content as body (body.mediaType)}<p>
										<code>{body.mediaType}</code>
									</p>
									{@render schema(body.schema)}{:else}<p class="soft">
										No response schema is specified in this contract.
									</p>{/each}
							</details>
						{/each}
					</article>
				{/each}
			</section>
		{/each}
	</div>
	<footer>
		<a href="/">LabelKit</a> · <a href="/terms">Terms</a> · <a href="/privacy">Privacy</a>
	</footer>
</div>

{#snippet schema(value: string)}
	{#if value}<pre><code>{value}</code></pre>{:else}<p class="soft">
			No schema is specified in this contract.
		</p>{/if}
{/snippet}

<style>
	.docs {
		max-width: 70rem;
		padding-block: 3rem;
	}
	.intro {
		max-width: 48rem;
		white-space: pre-line;
	}
	.contents {
		display: grid;
		gap: 1rem;
		margin-block: 2.5rem;
		padding: 1.5rem;
		border: 1px solid var(--line);
		background: var(--surface);
	}
	.contents ul {
		display: grid;
		gap: 0.75rem;
		margin: 0;
		padding-left: 1.25rem;
	}
	.operation {
		border-top: 1px solid var(--line);
		padding-block: 1.5rem 2rem;
		scroll-margin-top: 1.5rem;
	}
	h2 {
		font-size: 1.5rem;
		margin-block: 2rem 1rem;
	}
	h3 {
		font-size: 1.15rem;
		overflow-wrap: anywhere;
	}
	h4 {
		font-size: 0.9rem;
		margin-block: 1.5rem 0.5rem;
	}
	.summary {
		font-size: 1.1rem;
	}
	.method {
		font: 600 0.8rem var(--mono);
		color: var(--accent-ink);
	}
	.definition {
		margin-block: 0.75rem;
		border: 1px solid var(--line);
		padding: 0.75rem 1rem;
	}
	summary {
		cursor: pointer;
		overflow-wrap: anywhere;
	}
	pre {
		max-width: 100%;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		padding: 1rem;
		background: var(--surface);
		border: 1px solid var(--line);
		font-size: 0.8rem;
	}
	code {
		font-family: var(--mono);
	}
	footer {
		border-top: 1px solid var(--line);
		margin-top: 2rem;
		padding-top: 1.5rem;
	}
</style>
