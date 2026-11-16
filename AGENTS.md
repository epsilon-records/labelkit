# Notes for agents

- Decisions about LabelKit's scope, stack and hosting live in the private `epsilon-records/knowledge` repo, under `labelkit/decisions/` and `shared/decisions/`. Read them before proposing changes there; record new decisions there, not here.
- At the start of a session, check the message board for open issues labeled `to:labelkit`: `gh api "repos/epsilon-records/knowledge/issues?state=open&labels=to:labelkit"`. The protocol is in that repo's `AGENTS.md`.
- Routes query through `locals.db` so RLS applies; only `src/hooks.server.ts` and `src/lib/server/db/client.ts` may touch the owner connection, and `owner-access.test.ts` enforces it (see README, Security).
- Before finishing: `pnpm check`, `pnpm lint`, `pnpm test`.

## Codex worker

Codex works only on issues labelled `agent:codex` in this repo. Everything else belongs to the orchestrators.

- **Scope:** one issue, one branch (`codex/<issue-number>-<slug>`), one PR against `main`. Stay inside what the issue asks for. No drive-by refactors, dependency bumps or config changes.
- **Setup:** `pnpm install --frozen-lockfile`.
- **Before opening the PR:** `pnpm lint`, `pnpm check`, `pnpm test`. All must pass.
- **The PR:** link the issue (`Closes #N`), say what changed and how you checked it. Start every GitHub comment with `**Codex:**`, because agents post through Nate's account.
- **Stop at the PR.** Don't merge, deploy, change repo settings or secrets, delete branches, or touch production data. The Oracle reviews and merges in the evening release window.
- **Blocked or unclear:** don't guess. Open an issue in `epsilon-records/knowledge` with the Message template, label `to:oracle` (add `blocking` if the work waits on it), link the issue, and stop.
- **Never** commit secrets, and never describe a security hole in an issue or PR in this repo. Raise those on the knowledge message board instead.
