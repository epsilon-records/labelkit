import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { apiReference } from './api-reference';

it('renders the checked-in operations with resolved parameters, responses and authentication', () => {
	const reference = apiReference(readFileSync('docs/openapi.yaml', 'utf8'));
	const operations = reference.groups.flatMap((group) => group.operations);
	expect(operations).toHaveLength(5);
	expect(new Set(operations.map((op) => op.id)).size).toBe(operations.length);
	expect(operations.find((op) => op.path === '/v1/openapi.yaml')?.auth).toBe(
		'No authentication required.'
	);
	const releases = operations.find((op) => op.path === '/v1/releases')!;
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
