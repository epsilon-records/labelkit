# ERN generator and admin preflight

PR 2/3 for epsilon-records/labelkit#187 implements the [mapping](ern-4.3-mapping.md). “Admin” maps to LabelKit's existing `owner` role (`roles:manage`); no new role is introduced. A release's Export ERN link opens a context form. Preflight returns all missing/unmapped facts; successful preflight enables a POST download that reads and checks a fresh snapshot again.

`src/lib/server/ddex/snapshot.ts` reads one selected release in one PostgreSQL statement under `locals.db`, using tenant-qualified joins. It includes no contract documents, private file locations or Auth/billing data. The statement supplies one MVCC snapshot without altering the scoped transaction's isolation or RLS setup.

`src/lib/server/ddex/ern.ts` is pure: snapshot plus export context in, structured findings or XML out. XML is written through xmlbuilder2. Release/recording references, UPC leading zeros, exact millisecond duration, approved parties/credits, ordered disc placements and supported work IDs are preserved. Unsupported rights, writer shares, compilation form, recording-product genres and commercial scope block the download rather than being dropped or reinterpreted.

The Oracle's 17 November split is deliberate:

- Sender/recipient DPID and per-export scope belong to the context form. The test sender is explicitly a placeholder.
- Durable catalogue facts belong to catalogue work, not this form. Current schema lacks metadata language, recording type, content warnings and confirmed artist-display text. The SQL loader does not fabricate them or read them from form parameters.
- Therefore current live catalogue rows return preflight findings; no valid download is promised until the separately scoped catalogue metadata work supplies those facts. Complete in-memory test snapshots can generate valid XML now, for development validation.
- All generated XML uses `MessageControlType=TestMessage`, a not-for-delivery comment and a not-for-delivery attachment name. Supplying a real-looking DPID does not enable delivery. DDEX implementation licensing and registration stay with Nate/Oracle.

Local validation covers generation, escaping, identifier/duration/disc preservation, unsupported data, role denial, fresh download checks and rendering the actual Svelte form/findings/download states. The fictional fixture is test-only and is never loaded into a runtime catalogue. Tenant isolation and the real SQL snapshot run against Supabase in CI. A local development fixture also validates against the official XSD/AVS pair, downloaded outside the repo; The [validation workflow](validation.md) adds reproducible checksum-pinned official-schema checks and the complete mapping-rule cases.

No network delivery, schema changes, registration, production environment changes or deployment occur in this PR.
