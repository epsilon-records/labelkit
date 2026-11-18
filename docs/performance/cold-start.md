# Cold function startup

Issue: epsilon-records/labelkit#168. Measurement date: 17 November 2026.

The generated Netlify handler starts SvelteKit, which dynamically imports the server hooks. The hooks import Sentry, Supabase SSR, Drizzle, postgres-js and Zod. Before this change those dependencies were mostly external modules: starting a function required resolving and evaluating hundreds of separate package files. The database client was already lazy; importing it did not open a connection. Sentry was initialised synchronously by the hooks.

The SSR `noExternal` list in `vite.config.ts` lets Vite compile that cold dependency graph into server chunks. This reduces module resolution, file reads, parsing and unused dependency code without changing Sentry options, Auth verification, RLS, queries or DB pool creation. Route modules remain lazy. Client builds are unaffected by this SSR setting.

## Local measurement

Hardware: Apple Silicon macOS, Node.js 26.13.0. Builds use placeholder environment values and no database. Times include the import of the actual adapter-generated handler and its first successful OpenAPI response, so hook imports and Sentry initialisation are included. They exclude process startup, Netlify provisioning, production network RTT and the authenticated root page's queries.

| Probe                                          |                          Before |                                 After |
| ---------------------------------------------- | ------------------------------: | ------------------------------------: |
| First cold response, including handler import  |             556 ms (one sample) |               91–110 ms (six samples) |
| Modules resolved in the cold graph             |                             958 |                                   114 |
| Loaded source, including external dependencies |                 5,971,415 bytes |                       3,092,930 bytes |
| Standalone Sentry package import / init        |                  277 ms / 51 ms | Included in bundled hook timing above |
| Connections during init + public response      | Not counted in initial baseline |                     0 in every sample |

The first sample is diagnostic evidence, not a production latency estimate. The loaded-source count is the unique resolved file graph, not compressed deployment size or source maps. Bundled server files are larger because they now contain dependencies previously shipped separately; cold code loaded is smaller.

## CI budget

After `pnpm build`, run:

```sh
node scripts/cold-start-budget.mjs
```

Six independent child processes start the generated handler: three with Sentry disabled and three with a dummy DSN enabled. Every sample must finish under 1000 ms, resolve at most 180 modules, load less than 4 MB of source and open zero network connections. After timing, the probe verifies that the hook initialised Sentry with the original DSN and 10% tracing setting. The SDK transport cannot contact a service. These are measurements of independent cold instances, not retries of a failed test.

This budget guards application startup and dependency growth. It does not prove the original five-second hosted cold start is eliminated. Once the Oracle deploys, verify the existing deploy warmer's log, the first real visitor's TTFB under one second, and root-page browser p95 under two seconds over a week. No Netlify setting, region, plan, warmer or production environment is changed here.
