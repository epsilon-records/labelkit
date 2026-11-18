// tsc does not keep the executable bit; npm sets it from `bin` on install, but a local run of
// dist/cli.js (the e2e test) needs it too.
import { chmodSync } from 'node:fs';

chmodSync(new URL('../dist/cli.js', import.meta.url), 0o755);
