# LabelKit CLI

Read and search your catalogue, or create releases, recordings, artists and track placements. Use an API key with `catalog:read` for reads and `catalog:write` for creates.

## Install from source

Use Node.js 22+ and the repository’s pinned pnpm version. From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm --filter ./packages/cli build
pnpm --filter ./packages/cli pack --pack-destination /tmp
npm install -g /tmp/epsilon-records-labelkit-cli-0.1.0.tgz
```

The package is built and installed locally from the checkout. Run `labelkit --help` to verify the installation.

## Credentials

Set `LABELKIT_API_KEY` in your environment, or provide a JSON file with an `apiKey` string via `--config FILE` or `LABELKIT_CONFIG`. An optional `url` setting overrides the default API origin, `https://api.labelkit.co`. Keep the file readable only by you and outside version control.

Flags `--url` and `--api-key` take precedence over `LABELKIT_URL` and `LABELKIT_API_KEY`, which take precedence over the file. Prefer the environment or a protected file for the key so it stays out of shell history and process arguments. The CLI requires HTTPS.

## Commands

| Command                                             | What it does                                                                             |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `labelkit auth`                                     | Checks that the key can read the catalogue. It never prints or writes the key.           |
| `labelkit releases list [--limit N] [--after ID]`   | Gets one page of releases.                                                               |
| `labelkit releases get ID`                          | Gets a release with its tracks, credits and artists.                                     |
| `labelkit recordings list [--limit N] [--after ID]` | Gets one page of recordings.                                                             |
| `labelkit recordings get ID`                        | Gets a recording with its releases and credits.                                          |
| `labelkit search QUERY`                             | Searches for matching releases, recordings and artists. Quote queries containing spaces. |

Pass `--json` to any command for pretty JSON on stdout. List commands accept limits from 1 to 200. When `next_cursor` is present, pass it as `--after` for the next page. Errors go to stderr. Exit status is 0 for success, 1 for configuration, API or transport errors, and 2 for invalid arguments.

## Create commands

Supply a JSON file matching the request body in the [public API contract](../../docs/openapi.yaml).

| Command                                     | Required JSON fields                                                                                        |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `labelkit release create --file FILE`       | `title`, `upc` and `label_id`                                                                               |
| `labelkit recording create --file FILE`     | `title` and `isrc`                                                                                          |
| `labelkit artist create --file FILE`        | `display_name`                                                                                              |
| `labelkit track add RELEASE_ID --file FILE` | `mode`, `disc` and `position`, plus `recording_id` for `existing` mode or `title` and `isrc` for `new` mode |

For safe retries, pass a unique `--idempotency-key KEY` on the first attempt and reuse it with the
same command, API key and JSON body if you need to retry. The CLI sends each create request once.
Add `--json` to get the API response on stdout as pretty JSON.
