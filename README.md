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
| D&D 5e characters | `actor_sheet`, `roll`, `check`, `use_item`, `apply_damage`, `rest`, `give_loot` |
| Compendiums | `list_packs`, `search_compendium`, `get_compendium_entry`, `add_from_compendium`, `localize_actor` |
| Other world features | `roll_table`, `cards`, `upload_file`, `send_chat` |
| GM and assistant-GM actions | `gm_scene`, `gm_music`, `gm_show`, `gm_permissions`, `gm_tile`, `gm_token`, `gm_combat`, `gm_pause`, `gm_check_ids`, `gm_sync_items`, `gm_patch_items` |

Highlights:

- `list_documents` supports filters, selected fields, stable `_id` ordering, and cursor/offset pagination. Large responses use valid JSON pages retrievable with `next_page`.
- Write tools support non-mutating previews where indicated; updates and deletions create recoverable snapshots before writing. `snapshots` can inspect and restore earlier values.
- `use_item` rolls attacks, damage and healing, consumes resources where applicable, and can generate per-target proposals (AC, saves, resistance, vulnerability, immunity). `apply_damage` applies an approved proposal or explicit values.
- Compendium lookups can use French or English names when compatible Babele translations are installed. `localize_actor` can apply translations and metric units to an existing actor.
- `gm_show` supports recipient selection and a preview. `gm_permissions` reports what players can view or modify.
- `gm_sync_items` and `gm_patch_items` preview changes by default and require explicit application.

Tool **names are stable**. Some existing argument values, response fields, descriptions and errors are still in French; those form part of the current client-facing API and will only be migrated with explicit compatibility/versioning work. See [CONTRIBUTING.md](CONTRIBUTING.md).

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
| `TRANSLATION_SOURCES` | `dnd5e_fr-FR/compendium_fr` | Ordered, comma-separated Babele translation directories (relative to Foundry's modules directory), e.g. `vecna-phb-fr/compendium` |
| `UPLOAD_ALLOWED_ORIGINS` | empty | Comma-separated HTTPS origins allowed as remote upload sources; empty disables remote URLs |
| `SNAPSHOT_DIR` | `data/snapshots` | Recovery snapshots; must be writable and backed up |
| `SNAPSHOT_KEEP` / `SNAPSHOT_DAYS` | `500` / `90` | Snapshot retention |
| `MAX_OUT` | `60000` | Response-size threshold for JSON pagination |

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
