import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import Ajv2020 from 'ajv/dist/2020';
import { parse } from 'yaml';
import { apiReference } from './api-reference';

it('renders the checked-in operations with resolved parameters, responses and authentication', () => {
	const source = readFileSync('docs/openapi.yaml', 'utf8');
	const contract = parse(source) as { paths: Record<string, Record<string, unknown>> };
	const methods = /^(get|post|put|patch|delete|head|options|trace)$/;
	const expected = Object.entries(contract.paths).flatMap(([path, item]) =>
		Object.keys(item)
			.filter((method) => methods.test(method))
			.map((method) => method.toUpperCase() + ' ' + path)
	);
	const reference = apiReference(source);
	const operations = reference.groups.flatMap((group) => group.operations);
	expect(operations.map((op) => op.method + ' ' + op.path).sort()).toEqual(expected.sort());
	expect(new Set(operations.map((op) => op.id)).size).toBe(operations.length);
	expect(operations.find((op) => op.path === '/v1/openapi.yaml')?.auth).toBe(
		'No authentication required.'
	);
	const releases = operations.find((op) => op.method === 'GET' && op.path === '/v1/releases')!;
	expect(releases.auth).toContain('bearer');
	expect(releases.parameters.map((p) => p.name)).toEqual(['limit', 'after']);
	expect(releases.responses.find((r) => r.status === '200')?.content[0].schema).toContain(
		'next_cursor'
	);
});

it('groups by contract tags and resolves request schemas without inventing missing responses', () => {
	const reference = apiReference(`
info: {title: Test, version: '1'}
security: [{key: []}]
components:
  securitySchemes: {key: {type: http, scheme: bearer}}
  schemas: {Payload: {type: object, required: [value], properties: {value: {type: string}}}}
paths:
  /resource:
    post:
      tags: [Writes]
      summary: Write a value
      requestBody:
        required: true
        content: {application/json: {schema: {$ref: '#/components/schemas/Payload'}}}
      responses: {'204': {description: No content}}
`);
	expect(reference.groups[0].tag).toBe('Writes');
	const operation = reference.groups[0].operations[0];
	expect(operation.requestBody?.required).toBe(true);
	expect(JSON.parse(operation.requestBody!.content[0].schema).properties.value.type).toBe('string');
	expect(operation.responses[0].content).toEqual([]);
});

it('refuses broken references instead of silently rendering an incomplete contract', () => {
	expect(() =>
		apiReference(`paths: {/broken: {get: {parameters: [{$ref: '#/missing'}]}}}`)
	).toThrow('Missing OpenAPI reference');
});

it('uses operation-level parameter overrides without duplicate names', () => {
	const reference = apiReference(`paths:
  /resource:
    parameters: [{name: cursor, in: query, schema: {type: string}}]
    get:
      parameters: [{name: cursor, in: query, required: true, schema: {type: string, minLength: 1}}]
      responses: {'200': {description: Fine}}
`);
	const parameters = reference.groups[0].operations[0].parameters;
	expect(parameters).toHaveLength(1);
	expect(parameters[0].required).toBe(true);
	expect(JSON.parse(parameters[0].schema).minLength).toBe(1);
});

it('preserves intermediate reference siblings and overlapping required constraints', () => {
	const reference = apiReference(`
components:
  schemas:
    Base: {type: object, required: [id]}
    Alias: {$ref: '#/components/schemas/Base', required: [name], minProperties: 2}
paths:
  /resource:
    get:
      responses:
        '200':
          description: Fine
          content:
            application/json:
              schema: {$ref: '#/components/schemas/Alias', required: [extra]}
`);
	const schema = JSON.parse(reference.groups[0].operations[0].responses[0].content[0].schema);
	expect(schema).toEqual({
		required: ['extra'],
		allOf: [
			{
				required: ['name'],
				minProperties: 2,
				allOf: [{ type: 'object', required: ['id'] }]
			}
		]
	});
});

it('keeps unevaluatedProperties adjacent to referenced properties and existing allOf entries', () => {
	const reference = apiReference(`
components:
  schemas:
    Base: {type: object, properties: {id: {type: string}}}
paths:
  /resource:
    get:
      responses:
        '200':
          description: Fine
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Base'
                unevaluatedProperties: false
                allOf: [{required: [id]}]
`);
	const schema = JSON.parse(reference.groups[0].operations[0].responses[0].content[0].schema);
	const validate = new Ajv2020({ strict: false }).compile(schema);
	expect(validate({ id: 'x' })).toBe(true);
	expect(validate({ id: 'x', extra: true })).toBe(false);
	expect(validate({})).toBe(false);
});
