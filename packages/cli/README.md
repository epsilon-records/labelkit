# LabelKit CLI

Read releases and recordings, or search your label’s catalogue. Create a LabelKit API key with the `catalog:read` scope.

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
