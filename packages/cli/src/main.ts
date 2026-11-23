#!/usr/bin/env node
import { run } from './cli.js';

process.exitCode = await run(process.argv.slice(2), {
	env: process.env,
	out: (text) => process.stdout.write(text + '\n'),
	err: (text) => process.stderr.write(text + '\n')
});
