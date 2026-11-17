import { parse } from 'yaml';

const object = (value: unknown): Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
const text = (value: unknown) => (typeof value === 'string' ? value : '');
const array = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** Build-time view of the checked-in contract. Descriptions stay plain text, never HTML. */
export function apiReference(raw: string) {
	const spec = object(parse(raw));
	const resolve = (value: unknown, oneHop = false): Record<string, unknown> => {
		let result = object(value);
		const seen = new Set<string>();
		while (typeof result.$ref === 'string') {
			const ref = result.$ref;
			if (!ref.startsWith('#/') || seen.has(ref))
				throw new Error(`Unsupported OpenAPI reference: ${ref}`);
			seen.add(ref);
			let current: unknown = spec;
			for (const part of ref.slice(2).split('/'))
				current = object(current)[part.replace(/~1/g, '/').replace(/~0/g, '~')];
			if (!current) throw new Error(`Missing OpenAPI reference: ${ref}`);
			result = object(current);
			if (oneHop) break;
		}
		return result;
	};
	const expand = (value: unknown, seen: string[] = []): unknown => {
		if (Array.isArray(value)) return value.map((item) => expand(item, seen));
		if (value === null || typeof value !== 'object') return value;
		const node = object(value);
		if (typeof node.$ref === 'string') {
			if (seen.includes(node.$ref)) return { $ref: node.$ref };
			const siblings = Object.fromEntries(Object.entries(node).filter(([key]) => key !== '$ref'));
			const target = expand(resolve(node, true), [...seen, node.$ref]);
			return Object.keys(siblings).length
				? { allOf: [target, expand(siblings, [...seen, node.$ref])] }
				: target;
		}
		return Object.fromEntries(
			Object.entries(node).map(([key, child]) => [key, expand(child, seen)])
		);
	};
	const schema = (value: unknown) =>
		value === undefined ? '' : JSON.stringify(expand(value), null, 2);
	const content = (value: unknown) =>
		Object.entries(object(value)).map(([mediaType, definition]) => ({
			mediaType,
			schema: schema(object(definition).schema)
		}));
	const securitySchemes = object(object(spec.components).securitySchemes);
	const authFor = (value: unknown) => {
		const alternatives = array(value);
		if (!alternatives.length) return 'No authentication required.';
		return alternatives
			.map((entry) => {
				const schemes = Object.entries(object(entry));
				if (!schemes.length) return 'No authentication required';
				return schemes
					.map(([name, scopes]) => {
						const scheme = resolve(securitySchemes[name]);
						const description = text(scheme.description);
						return [
							name,
							text(scheme.scheme) || text(scheme.type),
							description,
							array(scopes).map(text).join(', ')
						]
							.filter(Boolean)
							.join(' · ');
					})
					.join(' AND ');
			})
			.join(' OR ');
	};
	const groups = new Map<string, ReturnType<typeof operation>[]>();
	const ids = new Set<string>();
	function operation(
		method: string,
		path: string,
		item: Record<string, unknown>,
		op: Record<string, unknown>
	) {
		const id = `operation-${text(op.operationId) || `${method}-${path}`}`.replace(
			/[^a-zA-Z0-9_-]+/g,
			'-'
		);
		if (ids.has(id)) throw new Error(`Duplicate operation anchor: ${id}`);
		ids.add(id);
		return {
			id,
			method: method.toUpperCase(),
			path,
			summary: text(op.summary),
			description: text(op.description),
			auth: authFor(op.security ?? spec.security),
			parameters: [
				...new Map(
					[...array(item.parameters), ...array(op.parameters)].map((raw) => {
						const p = resolve(raw);
						return [`${text(p.in)}:${text(p.name)}`, p] as const;
					})
				).values()
			].map((p) => {
				return {
					name: text(p.name),
					location: text(p.in),
					required: p.required === true || p.in === 'path',
					description: text(p.description),
					schema: schema(p.schema)
				};
			}),
			requestBody: op.requestBody
				? (() => {
						const body = resolve(op.requestBody);
						return {
							required: body.required === true,
							description: text(body.description),
							content: content(body.content)
						};
					})()
				: null,
			responses: Object.entries(object(op.responses)).map(([status, raw]) => {
				const response = resolve(raw);
				return {
					status,
					description: text(response.description),
					content: content(response.content)
				};
			})
		};
	}
	for (const [path, raw] of Object.entries(object(spec.paths))) {
		const item = resolve(raw);
		for (const method of ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace']) {
			if (!item[method]) continue;
			const op = object(item[method]);
			const tag = text(array(op.tags)[0]) || 'General';
			if (!groups.has(tag)) groups.set(tag, []);
			groups.get(tag)!.push(operation(method, path, item, op));
		}
	}
	return {
		title: text(object(spec.info).title),
		version: text(object(spec.info).version),
		description: text(object(spec.info).description),
		servers: array(spec.servers).map((server) => text(object(server).url)),
		groups: [...groups].map(([tag, operations]) => ({ tag, operations }))
	};
}
