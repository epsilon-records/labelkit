import { beforeEach, expect, it, vi } from 'vitest';

// The element, depth and findings budgets hold while the XML streams: a message over budget is
// refused before a tree is built from it, and findings stop at their cap as they are produced.
const built = vi.hoisted(() => ({ calls: 0 }));
vi.mock('xmlbuilder2', async (original) => {
	const actual = await original<typeof import('xmlbuilder2')>();
	return {
		...actual,
		create: ((...args: Parameters<typeof actual.create>) => {
			built.calls++;
			return actual.create(...args);
		}) as typeof actual.create
	};
});

import { ERN_NAMESPACE } from '../ddex/ern';
import {
	findingsOverBudget,
	MAX_ERN_DEPTH,
	MAX_ERN_ELEMENTS,
	MAX_ERN_FINDINGS,
	MAX_ERN_FINDINGS_BYTES,
	parseErnDocuments
} from './ern';

const message = (inner: string) =>
	'<ern:NewReleaseMessage xmlns:ern="' + ERN_NAMESPACE + '">' + inner + '</ern:NewReleaseMessage>';

beforeEach(() => {
	built.calls = 0;
});

it('refuses a message with too many elements before building a tree', () => {
	const plan = parseErnDocuments([
		{ name: 'wide.xml', text: message('<a/>'.repeat(MAX_ERN_ELEMENTS)) }
	]);
	expect(plan.issues).toEqual([
		expect.objectContaining({ level: 'error', message: 'wide.xml: ERN message is too complex.' })
	]);
	expect(built.calls).toBe(0);
});

it('refuses a message nested too deep before building a tree', () => {
	const plan = parseErnDocuments([
		{
			name: 'deep.xml',
			text: message('<a>'.repeat(MAX_ERN_DEPTH) + '</a>'.repeat(MAX_ERN_DEPTH))
		}
	]);
	expect(plan.issues).toEqual([
		expect.objectContaining({ level: 'error', message: 'deep.xml: ERN message is too complex.' })
	]);
	expect(built.calls).toBe(0);
});

it('stops at the findings cap and does not read the documents after it', () => {
	const noisy = message('<ProprietaryId/>'.repeat(MAX_ERN_FINDINGS + 500));
	const plan = parseErnDocuments([
		{ name: 'noisy.xml', text: noisy },
		{ name: 'later.xml', text: noisy }
	]);
	expect(plan.issues).toHaveLength(MAX_ERN_FINDINGS + 1);
	expect(plan.issues.at(-1)).toMatchObject({ level: 'error', code: 'ern.too-many-findings' });
	expect(plan.issues.some((issue) => issue.message.startsWith('later.xml'))).toBe(false);
	expect(built.calls).toBe(1);
});

it('counts a validation error against the findings cap and stops there', () => {
	// Exactly the cap in warnings, then the missing-release error takes the upload over it.
	const full = message('<ProprietaryId/>'.repeat(MAX_ERN_FINDINGS));
	const plan = parseErnDocuments([
		{ name: 'full.xml', text: full },
		{ name: 'later.xml', text: full }
	]);
	expect(plan.issues).toHaveLength(MAX_ERN_FINDINGS + 1);
	expect(plan.issues.at(-1)).toMatchObject({ level: 'error', code: 'ern.invalid' });
	expect(plan.issues.some((issue) => issue.message.startsWith('later.xml'))).toBe(false);
	expect(built.calls).toBe(1);
});

it('measures findings by the size of their text, not only their count', () => {
	const few = message('<ProprietaryId/>'.repeat(10));
	const ordinary = parseErnDocuments([{ name: 'release.xml', text: few }]);
	expect(ordinary.issues.length).toBeLessThan(MAX_ERN_FINDINGS);
	expect(findingsOverBudget(ordinary.issues)).toBe(false);

	// The same few findings under a long archive member name; multi-byte text counts in bytes.
	const name = 'é'.repeat(MAX_ERN_FINDINGS_BYTES / 20) + '.xml';
	const long = parseErnDocuments([{ name, text: few }]);
	expect(long.issues).toHaveLength(ordinary.issues.length);
	expect(findingsOverBudget(long.issues)).toBe(true);
});
