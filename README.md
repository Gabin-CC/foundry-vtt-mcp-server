# Foundry VTT MCP Server

An open-source, headless [Model Context Protocol](https://modelcontextprotocol.io) server for [Foundry Virtual Tabletop](https://foundryvtt.com) v13/v14, focused on the **dnd5e** game system.

Each player signs in with their **own Foundry account**. The MCP connection respects that account's Foundry permissions: players can work with their characters, while GMs and assistant GMs have access to GM tools.

**No open GM browser tab or Foundry browser module is required.** The server connects to the running Foundry world through its internal web-client protocol (`/join` and socket.io).

> [Guide en français](docs/README.fr.md) — the existing French instructions remain available during the English-first migration.

## Features

| Tools | Capabilities |
| --- | --- |
| `world_info`, `actor_sheet` | World information and computed character/NPC statistics |
| `list_documents`, `get_document`, `create_documents`, `update_documents`, `delete_documents` | Generic Foundry document access, including embedded documents, filtering and previews |
| `next_page`, `snapshots` | Safe pagination of long JSON results; recovery snapshots and restoration previews |
| `roll`, `check`, `use_item`, `apply_damage`, `rest` | Dice, ability checks, attacks, spells, resource consumption, targeted damage/healing, rests |
| `list_packs`, `search_compendium`, `get_compendium_entry`, `add_from_compendium` | Compendium discovery and imports, with 2014/2024 rules selection |
| `localize_actor`, `audit_translation` | Apply available Babele translations and audit translation coverage |
| `search_text`, `find_references` | World/compendium full-text search and reverse references |
| `roll_table`, `cards` | Roll tables and card decks |
| `give_loot`, `upload_file`, `send_chat` | Inventory, validated media upload, Foundry chat messages |
| `advance` | Headless dnd5e advancement with explicit choices |

**GM-only tools:** `gm_scene`, `gm_music`, `gm_show`, `gm_permissions`, `gm_tile`, `gm_token`, `gm_combat`, `gm_pause`, `gm_check_ids`, `gm_sync_items`, and `gm_patch_items`.

The exact JSON schemas of tools are provided by the MCP `tools/list` endpoint. Some existing response field names and enum values remain French for backward compatibility; see [API compatibility](#api-compatibility).

## Requirements

- Node.js **20 or newer**.
- Foundry VTT **v13 or v14**, with an active world.
- The dnd5e system for D&D-specific features.
- One Foundry username/password per user. Accounts without passwords are not supported.
- An HTTPS reverse proxy for connections outside the Foundry host.

The server requires no direct access to Foundry's data directory. It uses Foundry's client protocol, not a public/stable server API; future Foundry updates may require compatibility changes.

## Installation

Run on the Foundry host:

```bash
sudo useradd -r -m -d /opt/foundry-vtt-mcp-server -s /usr/sbin/nologin foundrymcp
sudo git clone https://github.com/Gabin-CC/foundry-vtt-mcp-server.git /opt/foundry-vtt-mcp-server
cd /opt/foundry-vtt-mcp-server
sudo npm ci --omit=dev
sudo chown -R foundrymcp:foundrymcp /opt/foundry-vtt-mcp-server
sudo cp deploy/foundry-mcp.service /etc/systemd/system/
# Review the environment variables in the service file before enabling it.
sudo systemctl daemon-reload
sudo systemctl enable --now foundry-mcp
```

Key configuration variables:

| Variable | Default | Description |
| --- | --- | --- |
| `FOUNDRY_URL` | `http://127.0.0.1:30000` | Internal Foundry URL |
| `PORT` | `8808` | Local HTTP port for the MCP endpoint |
| `HOST` | `127.0.0.1` | Local bind address; expose a private interface only when required by your proxy setup |
| `TRUSTED_PROXY` | empty | IP of a trusted reverse proxy for rate limiting |
| `PUBLIC_URL` | empty | Public Foundry URL used when returning uploaded file URLs |
| `UPLOAD_ALLOWED_ORIGINS` | empty | Optional comma-separated HTTPS origins for remote uploads; disabled by default |
| `TRANSLATION_SOURCES` | `dnd5e_fr-FR/compendium_fr` | Priority-ordered Babele translation folders |
| `SNAPSHOT_DIR` | `data/snapshots` | Directory for document recovery snapshots |
| `SNAPSHOT_KEEP` / `SNAPSHOT_DAYS` | `500` / `90` | Snapshot retention limits |

### HTTPS reverse proxy

Expose only the MCP endpoint and, if enabled, its OAuth routes. Keep the Node.js port private.

Basic authentication (Nginx example):

```nginx
location = /mcp {
    proxy_pass http://127.0.0.1:8808;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_buffering off;
}
```

OAuth additionally requires routing `/.well-known/oauth-protected-resource/mcp`, `/.well-known/oauth-authorization-server`, `/authorize`, `/token`, `/register`, `/revoke`, and `/oauth/approve` to the same service. Do **not** expose `/mcp-health` or other unneeded routes publicly. The MCP server handles authentication; do not add a conflicting authentication layer at the proxy.

### Update an installation

```bash
sudo /opt/foundry-vtt-mcp-server/scripts/update.sh
```

## Connect an MCP client

### Basic authentication (Claude Code example)

The `Authorization` header contains `Basic` plus base64 encoding of `FoundryUsername:FoundryPassword`.

```bash
claude mcp add --transport http foundry https://foundry.example.com/mcp \
  --header "Authorization: Basic $(printf 'YourFoundryUsername:YourFoundryPassword' | base64)"
```

Use a dedicated Foundry user account with only the required permissions. Do not commit Basic credentials or expose the MCP endpoint over plain HTTP.

### OAuth for ChatGPT and multiple players

OAuth is optional and coexists with Basic authentication. Each player authorizes ChatGPT with their own Foundry credentials; no shared GM account is needed.

1. Generate a persistent encryption key on the server:

   ```bash
   sudo install -d -m 700 -o foundrymcp -g foundrymcp /etc/foundry-mcp
   openssl rand -hex 32 | sudo tee /etc/foundry-mcp/oauth.key >/dev/null
   sudo chown foundrymcp:foundrymcp /etc/foundry-mcp/oauth.key
   sudo chmod 600 /etc/foundry-mcp/oauth.key
   ```

2. Configure these systemd service environment variables:

   ```ini
   Environment=OAUTH_ENABLED=1
   Environment=OAUTH_MCP_URL=https://foundry.example.com/mcp
   Environment=OAUTH_KEY_FILE=/etc/foundry-mcp/oauth.key
   ```

3. Restart with `sudo systemctl daemon-reload && sudo systemctl restart foundry-mcp`.
4. In ChatGPT, connect a custom MCP server using the exact public `/mcp` URL and OAuth authentication, if supported by your account or workspace.

The server supports OAuth client registration, PKCE, refresh-token rotation and encrypted credential storage. Access tokens expire after one hour; refresh tokens after 30 days. Keep the encryption key and state file backed up securely. Losing the key means users must reconnect; never commit it to Git.

Optional OAuth settings: `OAUTH_STATE_PATH` (default `data/oauth-state.json`), `OAUTH_REDIRECT_ORIGINS` (default `https://chatgpt.com`), and `OAUTH_ENCRYPTION_KEY` (alternative to `OAUTH_KEY_FILE`).

## Security and data integrity

- HTTP binds to **localhost by default**. Use HTTPS and firewall restrictions for any public deployment.
- Foundry account permissions are preserved; per-IP rate limiting blocks repeated failed logins.
- Idle Foundry sessions are released by default after 10 seconds (`IDLE_SECONDS`).
- Remote URL uploads require explicit HTTPS origin allowlisting. Requests to private/reserved IP addresses, redirects outside the allowlist, oversized files (20 MiB), unsafe paths and SVG are rejected.
- `update_documents`, `delete_documents`, `gm_sync_items`, `gm_patch_items`, and `gm_check_ids` snapshot their original document values before writing. If recovery data cannot be obtained or saved, the migration is aborted.
- **Snapshots are not database transactions.** A Foundry failure midway through a batch may still leave partial writes. Inspect and restore the saved state using the `snapshots` tool when needed. Test bulk changes in a disposable Foundry world first.

## Tests and development

```bash
npm ci
npm run check
```

The checks validate tool declarations and run offline regression tests for HTTP/OAuth, security, dice arithmetic, edition selection, document synchronization and snapshot order. They do not require a running Foundry world.

Optional integration probe (requires access to your own disposable Foundry world):

```bash
ADMIN_PASSWORD='admin password' node scripts/test-tools.mjs PlayerName '[["actor_sheet",{"actor":"Example Hero"}]]'
```

For detailed test examples and contribution requirements, see [CONTRIBUTING.md](CONTRIBUTING.md).

## API compatibility

The project's public presentation is moving to English. Existing tool names and argument keys remain stable. Some legacy response keys (`nom`, `formule`, `resultats`, `instantane`, etc.), error messages, and enum values (`court`, `mj`, `prive`, etc.) still use French to avoid breaking existing clients.

English-facing metadata and documentation do not imply a breaking change to those keys. A future **versioned API** will introduce consistent English response names and aliases with an explicit migration period. Please do not silently rename existing keys in contributions.

## Limitations

- dnd5e's browser-based advancement wizard is not executed; the server models common advancement paths and requests explicit choices when necessary.
- Derived stats are approximations for standard cases. Exotic rules and unusual active-effect interactions may differ from Foundry's client-side calculations.
- The dice evaluator supports common arithmetic, keep-high/keep-low, and simple numeric functions. Complex function expressions that contain dice within parentheses are still being hardened and require integration testing.
- Translation quality depends on the Babele modules installed in your Foundry world. No private books or translation datasets are bundled in this repository.

## License

MIT. Not affiliated with Foundry Gaming LLC, Wizards of the Coast, Anthropic, or OpenAI.
