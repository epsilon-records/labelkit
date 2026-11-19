# ERN development validation

The [mapping](ern-4.3-mapping.md) is exercised against the [generator](generator.md) and the official ERN 4.3 NewReleaseMessage XSD plus AVS 12. [schema-lock.json](schema-lock.json) records the two official HTTPS sources and SHA-256 digests checked on 17 November 2026. Schemas are downloaded outside the checkout for evaluation development/testing; they are not vendored. Production licensing and DPID registration remain with Nate/Oracle.

The `ERN schema validation` workflow runs the actual generator against explicitly fictional in-memory snapshots, then validates every successful XML result. These fixtures are never inserted into the catalogue. CI downloads the locked schemas, rejects changed digests, rewrites only the expected AVS import to its verified local copy, and runs `xmllint --nonet`. Required-header removal and an invalid release type must both fail, proving required fields and the AVS dependency are checked. Empty fixture directories fail. There is no partner or delivery network call.

| Mapping rule | Cases in `ern-mapping.test.ts`                                                                   |
| ------------ | ------------------------------------------------------------------------------------------------ |
| M01          | Exact namespace/AVS; explicit language; missing language blocks                                  |
| M02          | Test DPIDs, message ID, UTC timestamp; malformed DPID blocks                                     |
| M03          | Distinct label/party reference anchors even with equal source UUIDs                              |
| M04          | Single, EP and Album; unsupported compilation blocks                                             |
| M05          | Missing genre, unresolved identifier namespace, impossible date block                            |
| M06          | Repeated recording across two discs, stable positions, component type; duplicate position blocks |
| M07          | Exact subsecond/second/hour durations; missing, zero, negative and fractional milliseconds block |
| M08          | Explicit warning/type preserved; missing classification blocks                                   |
| M09          | Approved artist display; missing text, unapproved credits and unqualified writer block           |
| M10          | Recording-product genre blocks without a distinct track-product mapping                          |
| M11          | Linked ISWC preserved; missing work ID and writer-share mapping block                            |
| M12–M14      | Ownership remains distinct from commercial deals; WW/GB and supplied deal scope block            |
| M15          | Metadata-only XML has no file package, technical details or delivery locations                   |

The generator tests additionally cover XML escaping/illegal characters, cross-tenant snapshots and unknown roles. Request tests deny every non-owner role before reading the database, reject durable-fact overrides and repeat preflight on download. Svelte SSR tests render the context, findings and ready states. Real Supabase tests cover the selected-release SQL snapshot and RLS in the regular CI workflow; these database tests run in CI only when no local stack is available.

Run locally with Node 22+, Python 3.9+, curl and xmllint installed:

```sh
ERN_FIXTURE_DIR=/tmp/labelkit-ern-fixtures pnpm exec vitest run --project unit src/lib/server/ddex/ern-mapping.test.ts
python3 scripts/validate-ern.py --xml-dir /tmp/labelkit-ern-fixtures --schema-dir /tmp/labelkit-ern-schemas
```

Use fresh output directories for each run. Generated XML and downloaded schemas must remain outside the checkout. All valid fixtures carry TestMessage and the not-for-delivery warning. Structural XSD validity does not establish partner acceptance, registration, licensing or commercial rights. Missing durable catalogue facts still block live downloads; this validation does not supply defaults or resolve those gaps.
