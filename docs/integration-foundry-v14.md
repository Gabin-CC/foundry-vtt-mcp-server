# Foundry v14 integration harness (disposable world only)

The ordinary `npm run check` tests use mocks. `scripts/test-foundry-v14.mjs`
performs real Foundry login/socket calls and invokes the MCP's own
`handleTool` implementation. It can identify changes in Foundry v14's
internal `modifyDocument` protocol which mocks cannot detect.

**It never creates, starts, clones or switches a Foundry world automatically.**
Set up a *separate, disposable* Foundry v14 world first:

1. Create a **new empty world** with game system `dnd5e`. Its title must
   begin with the exact prefix `[MCP TEST]`, for example
   `[MCP TEST] D&D5e integration`. Do not use an existing campaign or a
   production world copy containing important data.
2. Start that world and create a dedicated **GM account (role 4)** with a
   password. Take a Foundry backup if you intend to preserve anything in it.
3. On the host running the MCP source, install dependencies with `npm ci`.
   Provide the URL of *this test Foundry instance*, its world ID and exact
   world title, plus a Basic-auth credential (base64 of `username:password`).

Environment variables (all required unless noted):

| Variable | Requirement |
| --- | --- |
| `FOUNDRY_URL` | Explicit test Foundry URL, e.g. `http://127.0.0.1:30000`; no inherited/default target |
| `FOUNDRY_AUTH` | Base64 of the dedicated test account's `username:password` (optional `Basic ` prefix) |
| `FOUNDRY_TEST_WORLD_ID` | Exact disposable world ID reported by Foundry |
| `FOUNDRY_TEST_WORLD_TITLE` | Exact title, beginning with `[MCP TEST]` |
| `FOUNDRY_TEST_SEARCH_QUERY` | Optional string to exercise an indexed compendium search |
| `FOUNDRY_TEST_WRITE` | `yes` only when deliberately enabling write tests |
| `FOUNDRY_TEST_CONFIRM_WORLD_ID` | Must repeat the exact disposable world ID in write mode |

Do not commit credentials or put plaintext passwords in shell history. Supply
`FOUNDRY_AUTH` through your shell's secure environment configuration or a
secret manager. Use TLS when accessing a non-local test Foundry instance.

## Read-only smoke run

After exporting the first four environment variables:

```bash
npm run test:foundry-v14
```

The script aborts if the authenticated Foundry session reports a different
world ID/title, a non-v14 `coreVersion` or a system other than `dnd5e`.
It checks real login, `world_info` in both locales, document listing and
reading, an actor sheet and an update `dry_run` (if an actor exists), and
compendium discovery. The socket wrapper blocks **all document writes**.
`coreVersion` is the last migrated core generation from the world manifest,
not a separate assertion of the running Foundry server build.

## Disposable-world write run

Only after validating that you are connected to the disposable world:

```bash
export FOUNDRY_TEST_WRITE=yes
export FOUNDRY_TEST_CONFIRM_WORLD_ID="$FOUNDRY_TEST_WORLD_ID"
npm run test:foundry-v14 -- --write
```

The script requires a GM account and creates a uniquely named character
fixture and a cantrip/activity under it. It exercises:

- Real document creation, retrieval and character-sheet calculation.
- An update dry-run, a real update, an inspection of its recovery snapshot,
  a restore dry-run and real restoration.
- Dice rolls, ability checks and an item/spell activity, with private chat
  messages.
- Manual damage, hit-point persistence, a long rest and recovery.
- GM permission inspection and synchronization diagnostics (dry-run only).
- Deletion preview and deletion of its own character fixture.

Write calls are restricted **at the socket boundary** to that one created
actor, its embedded items and the chat message IDs recorded by this run.
All other document mutations fail closed. The script attempts to remove the
fixture and test chat messages in a `finally` block, even if a test fails.
If cleanup fails or the fixture's name no longer matches, it reports the
fixture ID for manual inspection rather than deleting an unexpected document.
It uses an isolated temporary snapshot directory, not the MCP installation's
normal `SNAPSHOT_DIR`.

This suite **does write** to Foundry, and Foundry hooks/modules may trigger
additional changes. Use a world you can throw away; do not rely on cleanup as
a transaction or as a backup.

## What runs in CI?

- `npm run check` and `MCP_LOCALE=en npm run check` validate the write
  guard, wrong-world and wrong-version refusals, and all existing mocks on
  Node 20 and 22.
- The real test command is deliberately **not** included in CI; it requires a
  reachable disposable Foundry installation with explicit credentials.
- The harness targets the headless server path. It does not test HTTP Basic or
  OAuth endpoints end-to-end (those have separate mocked HTTP tests), nor
  all installed game-system modules and compendiums.

Foundry's v14 reference documents the world manifest's `coreVersion` and
the document API; the MCP's headless socket transport is an **internal**
protocol and is not covered by Foundry's public API compatibility promises.

- [Foundry v14 world manifest](https://foundryvtt.com/api/v14/interfaces/foundry.packages.types.WorldManifestData.html)
- [Foundry v14 API notes](https://foundryvtt.com/api/v14/)
- [Foundry backups and snapshots](https://foundryvtt.com/article/backups/)
