import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

/** Test helpers: read docs/openapi.yaml and make example bodies and flat descriptions from it. */

type Schema = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Doc = { paths: Record<string, any>; components: Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any

export const doc = parse(
	readFileSync(new URL('../../../docs/openapi.yaml', import.meta.url), 'utf8')
) as Doc;

function deref(s: Schema): Schema {
	if (s?.$ref) {
		return deref(
			(s.$ref as string)
				.replace(/^#\//, '')
				.split('/')
				.reduce((o, k) => o[k], doc as Schema)
		);
	}
	return s;
}

/** The documented JSON schema of GET `path`'s 200 body. */
export function responseSchema(path: string): Schema {
	const response = deref(doc.paths[path].get.responses['200']);
	return deref(response.content['application/json'].schema);
}

const FORMATS: Record<string, string> = {
	uuid: '01900000-0000-7000-8000-000000000001',
	date: '2026-01-09',
	'date-time': '2026-01-09T10:00:00.000Z'
};

/** An example value for a schema: every property present, nullable ones filled, first enum value. */
export function sample(schema: Schema, nulls = false): unknown {
	const s = deref(schema);
	const types: string[] = Array.isArray(s.type) ? s.type : s.type ? [s.type] : [];
	if (nulls && types.includes('null')) return null;
	const type = types.find((t) => t !== 'null');
	if (s.enum) return s.enum[0];
	switch (type) {
		case 'object':
			return Object.fromEntries(
				Object.entries(s.properties ?? {}).map(([k, v]) => [k, sample(v as Schema, nulls)])
			);
		case 'array':
			return [sample(s.items, nulls)];
		case 'string':
			return FORMATS[s.format] ?? 'text';
		case 'integer':
		case 'number':
			return s.minimum ?? 1;
		case undefined:
			return { any: 'json' }; // no type: any JSON value
		default:
			throw new Error(`no sample for type ${type}`);
	}
}

/** One line per node: path, types, format, enum, whether the parent requires it. Shape only. */
export function flatten(
	schemaIn: Schema,
	path = '$',
	required = true,
	out: string[] = []
): string[] {
	let s = deref(schemaIn);
	let types: string[] = Array.isArray(s.type) ? [...s.type] : s.type ? [s.type] : [];
	if (s.anyOf) {
		// Zod writes a nullable as anyOf [X, {type: null}].
		const parts = s.anyOf.map(deref) as Schema[];
		const nonNull = parts.filter((p) => p.type !== 'null');
		if (parts.some((p) => p.type === 'null')) types.push('null');
		if (nonNull.length === 1) s = { ...nonNull[0], ...s, anyOf: undefined };
		types = [...new Set([...types, ...(Array.isArray(s.type) ? s.type : s.type ? [s.type] : [])])];
	}
	const line = [
		path,
		types.sort().join('|') || 'any',
		s.format ?? '',
		s.enum ? [...s.enum].sort().join(',') : '',
		required ? 'required' : 'optional'
	].join(' ; ');
	out.push(line);
	if (s.properties) {
		const req = new Set<string>(s.required ?? []);
		for (const [k, v] of Object.entries(s.properties))
			flatten(v as Schema, `${path}.${k}`, req.has(k), out);
	}
	if (s.items) flatten(s.items, `${path}[]`, true, out);
	return out.sort();
}
