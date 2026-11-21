# Notes for agents

This file is the single source of truth for every coding agent working in this repo (Claude, Codex, others). `CLAUDE.md` imports it; edit here only.

## Project rules

- Decisions about LabelKit's scope, stack and hosting live in the private `epsilon-records/knowledge` repo, under `labelkit/decisions/` and `shared/decisions/`. Read them before proposing changes there; record new decisions there, not here.
- At the start of a session, check the message board for open issues labeled `to:labelkit`: `gh api "repos/epsilon-records/knowledge/issues?state=open&labels=to:labelkit"`. The protocol is in that repo's `AGENTS.md`.
- Routes query through `locals.db` so RLS applies; only `src/hooks.server.ts` and `src/lib/server/db/client.ts` may touch the owner connection, and `owner-access.test.ts` enforces it (see README, Security).
- No fake or synthetic catalogue data. UI copy uses metric units, 24-hour time and European dates.

## Commands

- Install: `pnpm install`
- Before finishing: `pnpm check`, `pnpm lint`, `pnpm test`
- `pnpm test` needs the local Supabase stack (`supabase start`, which needs Docker). If your environment has no Docker, don't stop: run `pnpm lint` and `pnpm check`, open a **draft** PR, and let CI (which starts the stack) run the database tests. Fix until CI is green, then mark the PR ready. Note in the PR that database tests ran in CI only.
- Schema changes: `pnpm db:generate`, then `pnpm db:check`; touching RLS also needs `pnpm test:rls`
- Format: `pnpm format`

## Chain of command

- Nate is the board. The Oracle (a Claude session) is the only agent that talks to him, and its decisions are final.
- Worker agents take one issue at a time and deliver it as one PR. Codex takes only issues labelled `agent:codex`, and never takes issues assigned to another agent.

## How to work

- Branch from `main` (`codex/<issue#>-<slug>` for Codex). Never push to `main`.
- Keep each PR small and single-purpose, and include "Closes #<n>", a summary, test evidence and risks. CI must be green.
- If a PR makes a lasting decision, draft the decision record in the PR description so it can be filed in `epsilon-records/knowledge`.

## Never do these (raise them instead)

- Merge, deploy, or change production settings (Netlify, Supabase, Cloudflare R2, Resend).
- Change public API contracts, pricing, billing or artist-pay logic.
- Delete data, branches or files outside the issue's scope, or write migrations that drop data.
- Add paid services, contact anyone outside the company, or touch contracts. Never commit secrets.

## Blockers and reporting

- Messages to other agents (board issues and replies, status comments, Codex escalations) follow the agent message protocol, [kb:protocols/agent-messages.md](https://github.com/epsilon-records/knowledge/blob/main/protocols/agent-messages.md), using the terms in [kb:glossary.md](https://github.com/epsilon-records/knowledge/blob/main/glossary.md).
- Never stop silently. Post the blocker to the message board in `epsilon-records/knowledge` following that repo's `AGENTS.md`, with your options and a recommendation, link it from the issue, and carry on with anything that doesn't depend on the answer.
- When done, comment on the issue with what changed, the PR link, what's left and the next issue you'd suggest.
