import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const fixtureEnvironment = { ...process.env };
for (const name of [
	'GIT_DIR',
	'GIT_WORK_TREE',
	'GIT_INDEX_FILE',
	'GIT_COMMON_DIR',
	'GIT_OBJECT_DIRECTORY',
	'GIT_ALTERNATE_OBJECT_DIRECTORIES'
])
	delete fixtureEnvironment[name];

// Both ignore commands are TOML basic strings using JSON-compatible escapes.
function ignoreCommand(file: string): string {
	const line = readFileSync(resolve(file), 'utf8').match(/^\s*ignore = (".*")$/m);
	if (!line) throw new Error(`No ignore command found in ${file}`);
	return JSON.parse(line[1]);
}

for (const site of [
	{ name: 'app', config: 'netlify.toml', base: '.' },
	{ name: 'Storybook', config: 'storybook-site/netlify.toml', base: 'storybook-site' }
]) {
	describe(`${site.name} Netlify ignore command`, () => {
		const command = ignoreCommand(site.config);
		let directory: string;
		let initial: string;
		let changed: string;
		let irrelevant: string;

		function git(...args: string[]) {
			return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
				cwd: directory,
				encoding: 'utf8',
				env: fixtureEnvironment
			}).trim();
		}

		beforeAll(() => {
			directory = mkdtempSync(join(tmpdir(), 'labelkit-ignore-'));
			mkdirSync(join(directory, 'src/lib'), { recursive: true });
			mkdirSync(join(directory, 'storybook-site'));
			mkdirSync(join(directory, '.github'));
			git('init', '--quiet');
			git('config', 'user.name', 'Netlify ignore test');
			git('config', 'user.email', 'test@example.invalid');
			git('config', 'commit.gpgsign', 'false');
			writeFileSync(join(directory, 'src/lib/component.ts'), 'initial');
			git('add', '.');
			git('commit', '--quiet', '-m', 'Initial fixture');
			initial = git('rev-parse', 'HEAD');
			writeFileSync(join(directory, 'src/lib/component.ts'), 'changed');
			git('commit', '--quiet', '-am', 'Change a build input');
			changed = git('rev-parse', 'HEAD');
			writeFileSync(join(directory, '.github/ci.yml'), 'workflow only');
			git('add', '.');
			git('commit', '--quiet', '-m', 'Change only ignored paths');
			irrelevant = git('rev-parse', 'HEAD');
		});
		afterAll(() => rmSync(directory, { recursive: true, force: true }));

		function run(context: string, head: string, cached: string, current: string) {
			const result = spawnSync('sh', ['-c', command], {
				cwd: join(directory, site.base),
				encoding: 'utf8',
				env: {
					...fixtureEnvironment,
					CONTEXT: context,
					HEAD: head,
					CACHED_COMMIT_REF: cached,
					COMMIT_REF: current
				}
			});
			expect(result.error).toBeUndefined();
			expect(result.stderr).toBe('');
			return result.status;
		}

		it('skips previews without the -preview suffix even when build inputs change', () => {
			expect(run('deploy-preview', 'codex/199-opt-in', initial, changed)).toBe(0);
		});
		it('builds an opted-in preview when build inputs change', () => {
			expect(run('deploy-preview', 'codex/199-opt-in-preview', initial, changed)).toBe(1);
		});
		it('builds production when build inputs change', () => {
			expect(run('production', 'main', initial, changed)).toBe(1);
		});
		it('skips production when only ignored paths change', () => {
			expect(run('production', 'main', changed, irrelevant)).toBe(0);
		});
		it('still builds production with an empty cache ref', () => {
			expect(run('production', 'main', '', changed)).toBe(1);
		});
		it('still builds production with equal refs (clear cache)', () => {
			expect(run('production', 'main', changed, changed)).toBe(1);
		});
	});
}
