# Foundry VTT MCP Server

A headless [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server for [Foundry VTT](https://foundryvtt.com), focused on D&D 5e and tested with Foundry v13/v14. It connects to a running world through Foundry's login and socket.io protocol—**no GM browser tab or custom Foundry module is required**.

Each player connects with **their own Foundry account**. Foundry permissions still apply: players can access the documents they are allowed to use, while GM-only tools require the appropriate role.

> This repository contains the **public MCP server**, not adventure content or translations. Private Babele translations and campaign compendiums are optional, independently installed Foundry modules. The server can work without them.

## What it can do

| Area | MCP tools |
| --- | --- |
| World and documents | `world_info`, `list_documents`, `get_document`, `create_documents`, `update_documents`, `delete_documents` |
| Safe changes and large results | `snapshots`, `next_page` |
| Search and diagnostics | `search_text`, `find_references`, `audit_translation` |
| D&D 5e characters | `actor_sheet`, `advance`, `advancement_blueprint`, `rebuild_actor`, `compare_actors`, `roll`, `check`, `use_item`, `apply_damage`, `rest`, `give_loot` |
| Compendiums | `list_packs`, `search_compendium`, `get_compendium_entry`, `add_from_compendium`, `localize_actor` |
| Other world features | `roll_table`, `cards`, `upload_file`, `send_chat` |
| GM and assistant-GM actions | `gm_scene`, `gm_music`, `gm_show`, `gm_permissions`, `gm_tile`, `gm_token`, `gm_combat`, `gm_pause`, `gm_check_ids`, `gm_sync_items`, `gm_patch_items` |

Highlights:

- `list_documents` supports filters, selected fields, stable `_id` ordering, and cursor/offset pagination. Large responses use valid JSON pages retrievable with `next_page`.
- For incremental chat, use `list_documents` with `type: "ChatMessage"` and `since_timestamp: <Unix milliseconds>` (inclusive). Results are sorted by `timestamp` (falling back to `_stats.createdTime`), then `_id`; `latest_timestamp` reports the highest observed time. Pass `next_cursor` to fetch subsequent pages. Without the filter, existing full-history and ID-order behavior is unchanged.
- `FoundrySession.doc("get", "ChatMessage", { query: { timestamp: { $gte: T } } })` supports the same filter without repeating a full Foundry socket read on every call: it caches an initial full read, consumes `modifyDocument` change broadcasts, and refreshes from Foundry periodically (15 seconds by default) in case broadcasts were missed. A new login starts with an empty cache. This optimization is in the MCP session client, not a change to Foundry's database query engine.
- Write tools support non-mutating previews where indicated; updates and deletions create recoverable snapshots before writing. `snapshots` can inspect and restore earlier values.
- `use_item` rolls attacks, damage and healing, consumes resources where applicable, and can generate per-target proposals (AC, saves, resistance, vulnerability, immunity). `apply_damage` applies an approved proposal or explicit values.
- Compendium lookups can use French or English names when compatible Babele translations are installed. `localize_actor` can apply translations and metric units to an existing actor.
- `advance` replays the dnd5e advancement workflow server-side (class, subclass, species, background, feat). Classes, subclasses, backgrounds and feats imported by Plutonium into world compendiums often lack dnd5e advancements; they are rebuilt on the fly from the Plutonium flags and the 5etools text (see [Plutonium content](#plutonium-content-in-world-compendiums)).
- `advancement_blueprint` reads the exact advancement decisions recorded on an existing single-class actor. `advance` can reuse those decisions with `replay_from`, including the official class source and pre-class ability scores for an empty target actor; `compare_actors` reports what still differs.
- `rebuild_actor` is the preview-first full-character workflow: replay the original class, species and background advancements; recover a missing choice only from the exact origin of a granted item; restore the source's remaining spells, inventory and campaign rewards; compare both sheets.
- `gm_show` supports recipient selection and a preview. `gm_permissions` reports what players can view or modify.
- `gm_sync_items` and `gm_patch_items` preview changes by default and require explicit application.

Tool **names and discovery descriptions are in English**. Some response keys, legacy argument values, enum values, and Foundry-specific status labels remain in French for backward compatibility. Renaming those fields requires an explicitly versioned protocol migration. See [CONTRIBUTING.md](CONTRIBUTING.md).

### Build a new D&D 2024 character

Use `build_actor` for a **new character with no source actor**, and `rebuild_actor` below to reproduce an existing character. An AI agent can find the required compendium UUIDs with `search_compendium` / `get_compendium_entry`, but should **not guess** an ambiguous class, species, background, subclass or feat.

1. Call `build_actor` with a unique `name`, `class_source`, `species_source`, `background_source`, a `level` (1–20), and six base `abilities` **before** background increases. These three sources must declare `system.source.rules: "2024"`. The tool also accepts partial inputs: it returns `parametres_requis` without writing.
2. Review the read-only preview: `choix_requis` includes missing advancement, subclass, feat and starting-equipment selections, with their exact option IDs/UUIDs. Supply them in `choices` and rerun until `pret: true`.
3. Set `apply: true` to create **one separate actor**, then replay class → species → background via the normal `advance` engine. No existing actor is changed. If a later Foundry write fails, the response identifies the partial actor for GM inspection; it never silently deletes it.

Example preview (the first call will ask for all outstanding selections):

```json
{
  "name": "New Cleric", "level": 3,
  "class_source": "Compendium.dnd5e.classes24.Item.phbclcCleric0000",
  "species_source": "Compendium.dnd5e.origins24.Item.phbspHuman000000",
  "background_source": "Compendium.dnd5e.origins24.Item.phbbgSage0000000",
  "abilities": { "str": 8, "dex": 14, "con": 12, "int": 10, "wis": 15, "cha": 10 }
}
```

**Spells:** the default `spells: "none"` does not import a full class spell list. Use `advance` to pick spells afterwards. The optional `spells: "all"` follows the existing `advance` behavior of importing **all accessible class spells** and asking for cantrip/preparation choices; it is not a legal spellbook-building mode for classes with limited known spells (notably Wizard). Full rules legality, ability-generation method, spellbook constraints and magic effects still require separate verification.

### Rebuild a character using recorded advancement choices

For the complete workflow, use `rebuild_actor`:

1. `rebuild_actor({ "source": "SOURCE_ACTOR_ID", "name": "New test character" })` returns a **read-only preview** with the exact compendium sources and recovered/missing choices. It does not create an actor.
2. If `choix_requis` is non-empty, provide those decisions explicitly with `choices`; **nothing is applied while choices remain unresolved**. `choix_recuperes_via_provenance` shows decisions recovered from granted items and flags those whose original parent item ID was replaced (`identifiant_historique: true`).
3. `rebuild_actor({ "source": "SOURCE_ACTOR_ID", "name": "New test character", "apply": true })` creates a separate character, starts from `pre_origin_abilities`, replays class/species/background through `advance`, omits starting equipment grants (the **source's actual inventory** is reconciled instead), copies remaining spells/equipment/campaign rewards and actor-level effects, and restores item use/preparation/equipment state.
4. Review `rapport.conforme`, `rapport.differences_de_valeurs`, `rapport.differences_de_contenu` and `rapport.integrite_objets` (item-level state, quantities, uses and effects). The source actor is never modified.

This supports **one class** with verifiable compendium provenance. A failed write may leave a clearly identified partially reconstructed target rather than silently deleting it. The comparison is structural and does not prove rules legality or the correctness of every active effect or manually edited field. Recovered `ItemChoice` values are marked in the preview. When a saved `ItemGrant` refers to an old embedded item ID, it is resolved only if the saved compendium UUID **and** the exact advancement lineage identify one current item. If the old ID has been **reused by a different granted item**, recovery additionally requires an orphaned saved choice value on that item, pointing to the exact selected descendant and its compendium source; otherwise the choice remains pending. Names/descriptions are never used to guess missing feats. Starting-equipment *selections* are not inferred, because the full original inventory is restored instead.

For lower-level, **class-only** testing, the existing tools remain available:

This tests the advancement engine, **not** a byte-for-byte duplication of a finished actor.
Use actor IDs to avoid matching an unintended character with a similar name.

1. Call `advancement_blueprint({ "actor": "SOURCE_ACTOR_ID" })`. It returns the original class compendium UUID, target level, recorded choices (including nested choices inside class-granted feats), `base_abilities` (*before class advancements*, including previously applied background/species bonuses) and `pre_origin_abilities` (*before all recorded ability increases*).
2. Call `create_documents({ "type": "Actor", "data": [{ "name": "MCP advancement test", "type": "character" }] })` to create an empty target actor. Do **not** copy the source's final level-12 ability scores onto the empty actor.
3. Call `advance({ "actor": "TARGET_ACTOR_ID", "replay_from": "SOURCE_ACTOR_ID" })`. With no explicit `source`, it uses the exact class compendium source from the original (rather than a similarly named world-compendium class); with no explicit `level`, it targets the original level. If required choices were not saved, the tool returns `choix_requis` and **does not change the target**. Call it again with `choices` to resolve only those missing selections. When all are resolved, it restores the pre-class ability scores on an **empty** actor and applies advancements.
4. Call `compare_actors({ "source": "SOURCE_ACTOR_ID", "target": "TARGET_ACTOR_ID" })`. Inspect the missing species, background, prepared spells, equipment and campaign rewards. Complete them through a *separate* origin-aware workflow; avoid double-applying origin ability increases. Compare again.

Safety and limitations:

- Replay is supported for **one class** and only when its original compendium UUID is verifiable. Multiclass or missing provenance is reported explicitly; the tool never guesses a replacement class.
- Replay uses **persisted selections only** (ASI vs feat, subclass, skills, nested class features). Unrecorded starting-equipment choices, prepared spells and rewards remain unresolved; the tool will not invent them.
- `advance.skip_starting_equipment` is an explicit opt-in for full rebuilds that restore the source inventory. Normal level-up behavior is unchanged.
- The target's ability scores are reset to their pre-class values **only when importing the class into an actor with no items**, after all pending choices have been resolved. Existing/partly built actors are not silently reset; a different class source is rejected.
- **Do not advance a background or species after the class-only replay without rebuilding from `pre_origin_abilities` first**: `base_abilities` already includes those origin increases. This workflow verifies the class; it is not yet a one-call reconstruction of the full character.
- The comparison is structural (including counts of duplicate items), not proof that every spell, enchantment or game rule has been interpreted correctly. Neither the blueprint nor the comparison modifies Foundry.

### Plutonium content in world compendiums

Plutonium imports classes, subclasses, backgrounds and feats into world compendiums without the dnd5e advancements its own importer applies. When `advance` reads such an entry (`flags.plutonium`), it rebuilds the missing advancements in memory (nothing is written to compendiums), with deterministic 16-character IDs (same entry, same IDs):

- **Class** (only HitPoints / Trait / ScaleValue present): one `ItemGrant` per level with the class features found in any world `Item` compendium (`flags.plutonium.page = "classFeature"`, hash `<feature>_<class>_<source>_<level>_<source>` matched against the class hash `<class>_<source>`; subclass features are ignored; one entry per name and level); `AbilityScoreImprovement` at every 5etools section "Level N: Ability Score Improvement" or "… feat or another feat of your choice" (e.g. Epic Boon, which then is not granted as an item); `Subclass` at the "Level N: <Class> Subclass" section (or the first subclass-feature level); an `ItemChoice` for "gain a *X* feat of your choice" when dnd5e has that feat category (e.g. Fighting Style). Armor/weapon/tool `Trait`s and starting equipment are not in the Plutonium text: they are copied from the official class with the same `system.identifier` and rules version, if installed.
- **Fallback**: if no class feature can be rebuilt, `advance` uses the official class with the same `system.identifier` from a dnd5e compendium (e.g. `fighter` → `dnd5e.classes24`) and says so in `avertissements`.
- A Plutonium class already on a sheet, imported before this reconstruction, is completed on the next `advance`: missing advancements are stored on the item and missing features/proficiencies for levels already gained are added.

## Requirements

- Node.js **20 or newer**.
- Foundry VTT v13/v14 with an active world; D&D 5e for the system-specific tools.
- A Foundry user account with a **non-empty password** for each person connecting.
- HTTPS termination at a reverse proxy for remote access.

This server uses Foundry's **internal** client protocol, not a supported public Foundry API. Test against your own Foundry/dnd5e versions before upgrading a production world.

## Installation

Run on the Foundry host (adapt paths and service account to your setup):

```bash
sudo useradd -r -m -d /opt/foundry-vtt-mcp-server -s /usr/sbin/nologin foundrymcp
sudo git clone https://github.com/Gabin-CC/foundry-vtt-mcp-server.git /opt/foundry-vtt-mcp-server
cd /opt/foundry-vtt-mcp-server
sudo npm ci --omit=dev
sudo chown -R foundrymcp:foundrymcp /opt/foundry-vtt-mcp-server
sudo cp deploy/foundry-mcp.service /etc/systemd/system/
# Review the Environment= values and service account before starting it.
sudo systemctl daemon-reload
sudo systemctl enable --now foundry-mcp
```

### Configuration

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `FOUNDRY_URL` | `http://127.0.0.1:30000` | Foundry URL reachable from the MCP process |
| `HOST` / `PORT` | `127.0.0.1` / `8808` | MCP listener; `/mcp` and local `/mcp-health` |
| `TRUSTED_PROXY` | empty | Exact proxy IP trusted for `X-Forwarded-For` |
| `PUBLIC_URL` | empty | Public Foundry URL used for uploaded-file links |
| `IDLE_SECONDS` | `10` | Release an idle Foundry socket session so its user can return to the browser |
| `MCP_LOCALE` | `fr` | Locale for supported server-owned messages: `fr` (legacy default) or `en` (opt-in English) |
| `TRANSLATION_SOURCES` | `dnd5e_fr-FR/compendium_fr` | Ordered, comma-separated Babele translation directories (relative to Foundry's modules directory), e.g. `vecna-phb-fr/compendium` |
| `UPLOAD_ALLOWED_ORIGINS` | empty | Comma-separated HTTPS origins allowed as remote upload sources; empty disables remote URLs |
| `SNAPSHOT_DIR` | `data/snapshots` | Recovery snapshots; must be writable and backed up |
| `SNAPSHOT_KEEP` / `SNAPSHOT_DAYS` | `500` / `90` | Snapshot retention |
| `MAX_OUT` | `60000` | Response-size threshold for JSON pagination |
| `CHAT_CACHE_MAX_AGE_MS` | `15000` | Maximum age of the authenticated session's chat cache before a full Foundry read; lower values reduce worst-case delay if socket broadcasts are missed |

**Language migration (incremental):** set `MCP_LOCALE=en` to receive English text for supported OAuth errors, dispatcher errors, pagination hints, snapshots, target diagnostics and selected GM / table / card feedback. The OAuth sign-in page additionally honors the browser's `Accept-Language` (English or French), independently for each player. This option deliberately **does not translate JSON keys, enum values, Foundry document content or user-entered names**. Some messages are still French; see [internationalization and compatibility](docs/internationalization.md) for current coverage, migration rules and future work.

If the proxy is in a separate container or host, bind `HOST` to a suitable **private** interface and apply firewall rules. Never expose the MCP HTTP port directly to the public internet.

### Reverse proxy

Expose **only the needed routes** over HTTPS. For HTTP Basic authentication, `/mcp` is sufficient. The reverse proxy should pass the `Authorization` header unchanged; the MCP server performs authentication.

Example Nginx location for Basic authentication:

```nginx
location = /mcp {
    proxy_pass http://127.0.0.1:8808;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_buffering off;
}
```

For OAuth, also route `/.well-known/oauth-protected-resource/mcp`,
`/.well-known/oauth-authorization-server`, `/authorize`, `/token`,
`/register`, `/revoke`, and `/oauth/approve` to the same service.
Do **not** expose `/mcp-health`.

## Connecting clients

### Claude / MCP clients with HTTP Basic authentication

Use a different Foundry username/password for each player. The HTTP header is `Authorization: Basic base64(username:password)`.

Claude Code:

```bash
claude mcp add --transport http foundry https://foundry.example.com/mcp \
  --header "Authorization: Basic $(printf 'MyUser:MyPassword' | base64)"
```

For Claude Desktop, `mcp-remote` can supply the header:

```json
{
  "mcpServers": {
    "foundry": {
      "command": "npx",
      "args": [
        "-y", "mcp-remote", "https://foundry.example.com/mcp",
        "--header", "Authorization: Basic <base64-credentials>"
      ]
    }
  }
}
```

Handle authentication headers as secrets; avoid committing credentials to a repository or putting them into shared shell history.

### ChatGPT / OAuth 2.1 (optional)

OAuth is **in addition to**, not a replacement for, Basic authentication. Each player authorizes access using their own Foundry account; no shared GM account is needed.

1. Create a persistent encryption key readable only by the service account:

   ```bash
   sudo install -d -m 700 -o foundrymcp -g foundrymcp /etc/foundry-mcp
   openssl rand -hex 32 | sudo tee /etc/foundry-mcp/oauth.key >/dev/null
   sudo chown foundrymcp:foundrymcp /etc/foundry-mcp/oauth.key
   sudo chmod 600 /etc/foundry-mcp/oauth.key
   ```

2. Add these entries to the `[Service]` section of `foundry-mcp.service`, using the exact public HTTPS MCP URL:

   ```ini
   Environment=OAUTH_ENABLED=1
   Environment=OAUTH_MCP_URL=https://foundry.example.com/mcp
   Environment=OAUTH_KEY_FILE=/etc/foundry-mcp/oauth.key
   ```

3. Route the OAuth endpoints listed above, reload the systemd configuration and restart the service:

   ```bash
   sudo systemctl daemon-reload
   sudo systemctl restart foundry-mcp
   sudo journalctl -u foundry-mcp -n 30 --no-pager
   ```

4. Add a custom MCP server in ChatGPT, select OAuth authentication, and use the public `/mcp` URL. Availability of custom MCP connections depends on your ChatGPT account and workspace settings.

The server implements OAuth discovery, dynamic client registration, authorization with PKCE, token exchange and revocation. Access tokens last one hour; rotating refresh tokens last 30 days. The persisted OAuth state stores hashed tokens and encrypted Foundry credentials. **Back up the key separately**: losing or rotating it without preserving the old state requires users to reconnect.

| OAuth variable | Default | Purpose |
| --- | --- | --- |
| `OAUTH_ENABLED` | `0` | Set to `1` to enable OAuth |
| `OAUTH_MCP_URL` | required when enabled | Exact external HTTPS URL ending in `/mcp` |
| `OAUTH_KEY_FILE` | required unless `OAUTH_ENCRYPTION_KEY` is set | File containing the 64-character hexadecimal encryption key |
| `OAUTH_STATE_PATH` | `data/oauth-state.json` | Persistent OAuth clients and encrypted account state (mode `0600`) |
| `OAUTH_REDIRECT_ORIGINS` | `https://chatgpt.com` | Comma-separated allowed redirect origins |

## Security and recovery

- Foundry account permissions are enforced for the authenticated user. GM operations are role-restricted.
- Foundry sends every world document to every client and lets the client hide what a user may not see, so the MCP applies Foundry's **read permissions itself** for non-GM accounts (`src/access.mjs`): documents without permission are absent from lists and refused when read; Limited permission exposes the title only; Observer or higher exposes the content. Journal pages with their own permission, role-based compendium permissions, hidden tokens/combatants, whispered chat messages and folders without visible content are handled the same way. GM and assistant-GM accounts see everything.
- Authentication failures are rate limited (10 failures per 15 minutes per client IP).
- The listener binds to loopback by default. Always use HTTPS externally.
- Remote `upload_file` URLs are disabled until explicitly allowlisted. Redirects must also be allowed; private/reserved IP targets, SVG files, unsupported file signatures and oversized downloads are rejected. This does not replace malware scanning.
- The server saves a recovery snapshot **before** supported destructive updates, imports or repairs. If snapshot creation fails, the guarded write is rejected.
- A snapshot is **not** a database transaction: a partial Foundry-side failure can still require manual restore. Review dry runs and test risky operations on a disposable world first.
- Back up Foundry itself and the MCP `SNAPSHOT_DIR`. The latter is not a substitute for normal world backups.

## Development and tests

```bash
npm ci
npm run check
```

CI runs syntax, schema, security, OAuth, document-integrity, snapshot, dice and HTTP tests on Node.js 20 and 22. Most tests use mocks; they do not prove compatibility with a live world.

For **Foundry v14 integration tests against a disposable dnd5e world**, see
[the guarded integration harness](docs/integration-foundry-v14.md). It runs
read-only by default; write tests additionally require two explicit
confirmations and can only modify the actor fixture and chat messages created
by that test run. The live-world suite is never launched by ordinary CI.

To run a separate integration call against a Foundry server, see `scripts/test-tools.mjs`. For example:

```bash
FOUNDRY_AUTH='<base64-user-colon-password>' \
  node scripts/test-tools.mjs - '@calls.json'
```

Responses can refer to a previous result with `@last.path`. Never use a production world for destructive integration tests without permission.

To update an existing systemd installation:

```bash
sudo /opt/foundry-vtt-mcp-server/scripts/update.sh
```

Contributions are welcome: [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE). Not affiliated with Foundry Gaming LLC or Anthropic.
