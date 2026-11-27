import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { parse as parseYaml } from 'yaml';

/** For tests: check what a /v1 route sends against the response schema docs/openapi.yaml gives it. */

type Doc = {
	paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
	components: { responses?: Record<string, unknown> };
};

export const openapiDoc = parseYaml(readFileSync('docs/openapi.yaml', 'utf8')) as Doc;

type Resolved = { content?: Record<string, { schema?: unknown }> };

function resolve(node: unknown): Resolved {
	const ref = (node as { $ref?: string }).$ref;
	if (!ref) return node as Resolved;
	const name = ref.replace('#/components/responses/', '');
	return resolve(openapiDoc.components.responses?.[name]);
}

const ajv = addFormats(new Ajv2020({ strict: false, allErrors: true }));

/** The JSON Schema of `path`'s GET response with this status, or null if the document gives none. */
export function responseSchema(path: string, status: string, method = 'get') {
	const response = openapiDoc.paths[path]?.[method]?.responses[status];
	if (!response) return null;
	return resolve(response).content?.['application/json']?.schema ?? null;
}

/** Throws with every violation if `body` does not match the documented response. */
export function expectMatchesSpec(
	path: string,
	status: string,
	body: unknown,
	method = 'get'
): void {
	const schema = responseSchema(path, status, method);
	if (!schema)
		throw new Error(
			`docs/openapi.yaml has no JSON schema for ${method.toUpperCase()} ${path} ${status}`
		);
	const validate = ajv.compile({ ...(schema as object), components: openapiDoc.components });
	if (!validate(body)) {
		throw new Error(
			`${method.toUpperCase()} ${path} ${status} does not match docs/openapi.yaml:\n` +
				(validate.errors ?? []).map((e) => `  ${e.instancePath || '/'} ${e.message}`).join('\n') +
				`\nbody: ${JSON.stringify(body).slice(0, 600)}`
		);
	}
}
