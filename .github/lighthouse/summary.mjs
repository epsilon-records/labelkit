/**
 * Prints the median-run scores and page weight of every report under lighthouse-report/ as a
 * Markdown table, so a run shows its numbers without opening the artifact. Used by
 * .github/workflows/lighthouse.yml; its output goes to the log and the job summary.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.argv[2] ?? 'lighthouse-report';
const walk = (dir) =>
	readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
		e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]
	);
const byPage = new Map();
for (const file of walk(root).filter((f) => /lhr-[^/]*\.json$/.test(f))) {
	const lhr = JSON.parse(readFileSync(file, 'utf8'));
	const page = new URL(lhr.finalDisplayedUrl).pathname;
	const runs = byPage.get(page) ?? [];
	runs.push(lhr);
	byPage.set(page, runs);
}
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const score = (runs, id) => median(runs.map((r) => r.categories[id].score)).toFixed(2);

const rows = [...byPage].map(([page, runs]) => {
	const kb = median(runs.map((r) => r.audits['total-byte-weight'].numericValue)) / 1000;
	return `| ${page} | ${runs.length} | ${score(runs, 'performance')} | ${score(runs, 'accessibility')} | ${score(runs, 'seo')} | ${kb.toFixed(0)} KB |`;
});
console.log(
	[
		'| Page | Runs | Performance | Accessibility | SEO | Total weight |',
		'| --- | --- | --- | --- | --- | --- |',
		...rows
	].join('\n')
);
