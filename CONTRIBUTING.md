# Contributing to Foundry VTT MCP Server

Thank you for helping improve this community project.

## Development setup

- Use Node.js 20 or newer.
- Install dependencies with `npm ci`.
- Run `npm run check` before opening a pull request. The test suite runs with mocked Foundry sessions and does not require credentials or a live game world.
- Keep tool schemas, tests, and user-facing documentation in English when adding new features. Existing French interfaces are being migrated in a separate, versioned effort to avoid breaking clients.

## Safe testing

This MCP server can update character sheets, world documents, and compendiums. Never test state-changing features against someone's production campaign or shared world without explicit permission.

For new write tools:

1. Support a non-mutating preview when practical.
2. Save the original document state **before** the first write and abort on snapshot failure.
3. Cover successful writes, malformed data, and failures with automated tests.
4. Verify embedded document behavior on a disposable Foundry world before proposing a release.

Foundry's internal client protocol is not a stable public API. State which Foundry and dnd5e system versions you tested with in the pull request description.

## Pull requests

Keep changes focused, describe the user-visible behavior, and link relevant issues. Include tests for bug fixes. If changing an existing MCP tool's arguments or response keys, propose a versioned migration instead of silently renaming fields.

For security-sensitive reports, contact the repository maintainers privately before posting exploit details publicly.
