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
| Indexed D&D books | `rules_list_sources`, `rules_search`, `rules_read_page` (SRD + locally indexed private PDFs, role-filtered) |
| D&D 5e characters | `actor_sheet`, `validate_actor`, `advance`, `progress_actor`, `multiclass_actor`, `edit_actor`, `build_actor`, `advancement_blueprint`, `rebuild_actor`, `compare_actors`, `roll`, `check`, `use_item`, `apply_damage`, `rest`, `give_loot` |
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
- `rules_search` queries the already-built BM25 index in short passages (up to eight results, 1,300-character passages); `rules_read_page` reads an exact indexed PDF page in 6,000-character windows. The PDFs are never uploaded to the MCP server or returned in bulk.
- `advance` replays the dnd5e advancement workflow server-side (class, subclass, species, background, feat). Classes, subclasses, backgrounds and feats imported by Plutonium into world compendiums often lack dnd5e advancements; they are rebuilt on the fly from the Plutonium flags and the 5etools text (see [Plutonium content](#plutonium-content-in-world-compendiums)).
- `advancement_blueprint` reads the exact advancement decisions recorded on an existing single-class actor. `advance` can reuse those decisions with `replay_from`, including the official class source and pre-class ability scores for an empty target actor; `compare_actors` reports what still differs.
- `rebuild_actor` is the preview-first full-character workflow: replay the original class, species and background advancements; recover a missing choice only from the exact origin of a granted item; restore the source's remaining spells, inventory and campaign rewards; compare both sheets.
- `gm_show` supports recipient selection and a preview. `gm_permissions` reports what players can view or modify.
- `gm_sync_items` and `gm_patch_items` preview changes by default and require explicit application.

Tool **names and discovery descriptions are in English**. Some response keys, legacy argument values, enum values, and Foundry-specific status labels remain in French for backward compatibility. Renaming those fields requires an explicitly versioned protocol migration. See [CONTRIBUTING.md](CONTRIBUTING.md).

The character automation milestones (rebuild, new build, progression and D&D 2024 rules certification) are tracked in [docs/ROADMAP.md](docs/ROADMAP.md).

### Build a new D&D 2024 character

Use `build_actor` for a **new character with no source actor**, and `rebuild_actor` below to reproduce an existing character. An AI agent can find the required compendium UUIDs with `search_compendium` / `get_compendium_entry`, but should **not guess** an ambiguous class, species, background, subclass or feat.

1. Call `build_actor` with a unique `name`, `class_source`, `species_source`, `background_source`, a `level` (1–20), and six base `abilities` **before** background increases. These three sources must declare `system.source.rules: "2024"`. The tool also accepts partial inputs: it returns `parametres_requis` without writing.
2. Review the read-only preview: `choix_requis` includes missing advancement, subclass, feat and starting-equipment selections, with their exact option IDs/UUIDs. Supply them in `choices` and rerun until `pret: true`.
3. Set `apply: true` to create **one separate actor**, then replay class → species → background via the normal `advance` engine. Starting armor, a compatible shield and one primary weapon are equipped by default (`auto_equip: false` opts out). No existing actor is changed. If a later Foundry write fails, the response identifies the partial actor for GM inspection; it never silently deletes it.

**Trait choices (D&D 2024):** weapon mastery (`weapon:*`) and gaming-set proficiency (`tool:game:*`) are expanded using installed `dnd5e.equipment24` base items. The preview shows concrete selections such as `weapon:mar:longsword` or `tool:game:dice`; supply **those keys**, never the wildcard. Weapon mastery is limited to weapon categories the character is proficient with, and is recorded separately from weapon proficiency. Invalid or repeated selections leave `pret: false` and cannot create an actor. If the official equipment compendium is missing, the tool cannot resolve these wildcards and stays in preview mode.

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

**Spells:** the default `spells: "none"` postpones class spell selection. For 2024 classes with a supported prepared-spell progression, choose `spells: "selected"`: the preview requests `choices["spells:prepared"]` (and `choices["spells:cantrips"]` when applicable), arrays of **exact 2024 compendium UUIDs**. It enforces the number of choices, class spell list, spell level, edition and uniqueness, then imports **only those selections**, marking the leveled spells prepared. Automatically granted subclass/class spells are excluded from selection where verifiable. A missing official class spell list blocks creation. The legacy `spells: "all"` still imports **all accessible class spells**, which may produce an illegal spellbook. Full rules legality, ability-generation method, Wizard spellbook constraints and magic effects still require separate verification.

### Progress an existing D&D 2024 character safely

Use `progress_actor` to level up **an existing single-class D&D 2024 character** without cloning or replacing it:

1. Call `progress_actor({ "actor": "ACTOR_ID", "level": 9 })`. It returns a **read-only preview** with the planned level changes and `choix_requis` (subclass, feat, mastery, ability score improvements, etc.). No Foundry update occurs, including background advancement-marker repairs.
2. Provide the explicit choices from the preview, such as `progress_actor({ "actor": "ACTOR_ID", "level": 9, "choices": { "ADVANCEMENT_ID@8": { "str": 2 } } })`. Repeat until `pret: true`.
3. Only then set `"apply": true`. The tool saves a **pre-change character snapshot before writing**, advances the selected class through `advance`, verifies the final class level, and returns `instantane`.
4. If something goes wrong, inspect `snapshots({ "action": "show", "id": "SNAPSHOT_ID" })`, preview rollback with `"action": "restore", "dry_run": true`, then restore explicitly. Restoring itself creates an undo snapshot.

Rollback refuses to run if the character has changed **after** the recorded level-up, to avoid overwriting subsequent player/GM edits. A failed partial progression is likewise identified and backed up when its final state can be recorded. `advance` also supports `apply: false` for strictly read-only planning; its pre-existing default remains `apply: true` for compatibility.

**Scope:** this tool handles single-class level progression rather than free-form item edits (see `edit_actor` below). Use `multiclass_actor` for 2024 multiclass progression. De-leveling and full D&D 2024 rules-legality certification remain separate work.

### D&D 2024 multiclassing

Use `multiclass_actor` to **add a secondary 2024 class** to an existing character, or advance **one class** on an already multiclass character. It is preview-first, changes an existing actor only with `apply: true`, and advances **exactly one character level per call**.

1. Find the exact 2024 class UUID using `search_compendium(item_type="class", rules="2024")`. Preview a new class with `multiclass_actor({ "actor": "ACTOR_ID", "class_source": "Compendium.dnd5e.classes24.Item.FIGHTER_ID" })`. The target is class level 1 by default.
2. Review `prerequis` and `choix_requis`. On entry to a new class, each **existing** class and the **new** class must meet its D&D 2024 primary-ability prerequisites (13 or higher; Fighter: STR **or** DEX; Monk, Paladin and Ranger: both listed scores). Mixed 2014/2024 classes, missing verification data, duplicate classes, exceeding character level 20 or skipping levels are rejected.
3. Supply exact advancement `choices` and repeat the preview until `pret: true`, then explicitly set `apply: true`. The tool saves the complete pre-change actor state, invokes `advance` with secondary-class proficiencies and **without new-class starting equipment**, verifies each class level and returns `instantane` for `snapshots` restore.
4. For a later level-up of any **existing** class on the multiclass actor, pass its embedded class item ID: `multiclass_actor({ "actor": "ACTOR_ID", "item": "CLASS_ITEM_ID", "level": 2 })`. The total character level and proficiency bonus follow the sum of class levels.

Spell slots follow the D&D 2024 multiclass rule: full casters contribute all class levels, Paladin and Ranger contribute **half rounded up**, third casters contribute one third rounded down when combined with another spellcasting class (single-class third casters use their own rounded-up progression), and Warlock Pact Magic remains separate. **Combined slots do not increase the level of spells eligible for any individual class.**

To select verified spells for the class being added/advanced, use `spells: "selected"` and preview first. The tool lists `choix_requis` containing exact 2024 compendium UUIDs; supply `choices["spells:cantrips"]` and `choices["spells:prepared"]` as arrays of those UUIDs. For a Wizard entering at class level 1, also provide `choices["spells:spellbook"]` with **six** eligible spell UUIDs (two newly added spellbook spells per later Wizard level); the prepared choices must be among the Wizard's eligible spellbook spells. For example:

```json
{
  "actor": "ACTOR_ID",
  "class_source": "Compendium.dnd5e.classes24.Item.CLASS_ID",
  "spells": "selected",
  "choices": {
    "spells:cantrips": ["Compendium.dnd5e.spells24.Item.CANTRIP_ID"],
    "spells:prepared": ["Compendium.dnd5e.spells24.Item.SPELL_ID"]
  },
  "apply": false
}
```

The arrays must match the exact counts shown in the preview; placeholder IDs above are illustrative, **not usable UUIDs**. `spells: "none"` (default) leaves spell selection to the GM. Selection requires installed, verifiable official D&D 2024 spell lists. **Existing Eldritch Knight (Fighter) and Arcane Trickster (Rogue) subclasses** are supported only if their exact official 2024 subclass source, Wizard spell list and preparation/cantrip scales are installed; unsupported or world-imported subclass data is refused, not guessed. This does not yet select spells on the level-up that *first grants* a subclass: apply the subclass choice separately before using selected spell progression.

For these two verified third-casters, the optional `choices["spells:replace"]` can replace at most one ordinary owned cantrip and one ordinary prepared spell on a class level-up, each with `{ "kind": "cantrip" | "prepared", "from": "OWNED_ITEM_ID", "to": "Compendium.OFFICIAL.SPELL_UUID" }`. Selection and replacement are both **preview-first**; the replacement must be on the verified Wizard list and within the class's own spell-level ceiling. Neither permanently granted spells nor spells from another class may be replaced. Imports, deletions, and partial failures are covered by the existing restorable actor snapshot. Other classes' spell-replacement rules remain out of scope. `edit_actor`, `rebuild_actor` and `progress_actor` retain their documented **single-class** restrictions. No de-leveling or cross-edition mixing is included.

### Audit a D&D 2024 character (read-only)

Call `validate_actor({ "actor": "ACTOR_ID" })` to inspect **an existing actor without any Foundry writes**. It reports class levels (including multiclass total), official 2024 class/subclass source provenance, documented spell slots, class-specific cantrip and prepared-spell limits, class-specific spell-level ceilings, exact installed official class-list membership, mandatory always-prepared subclass spell grants traced through official feature advancements, and obvious equipment conflicts. It also checks verified Eldritch Knight/Arcane Trickster third-caster progression against the Wizard list. Missing or world-imported subclass source evidence is explicitly `unverified`.

The advancement audit now compares **saved level-up decisions** with the exact installed official class/subclass advancements: ability-score allocation limits (points, ability cap, locked scores), recorded feat source and verifiable numeric level prerequisites, subclass selection, mandatory feature grants, saved source mismatches and choices recorded beyond the actor's current class level. Item-ID drift or unavailable feat sources produce review/unverified diagnostics rather than guessed legality. Only historical/conditional requirements actually provable from recorded data are checked; a character's *current* scores do not establish their scores when a feat was taken. Fixed-plus-selected ability increases also stay unverified rather than causing a false points error.

Each diagnostic has a stable `code`, `severity` (`error`, `warning`, or `unverified`), a human-readable explanation, and source UUIDs where they were actually verified. The `status` is one of `issues`, `review`, `incomplete`, or `passed_scoped_checks`. In particular, **`passed_scoped_checks` is NOT a declaration of full D&D 2024 legality**. A character with missing compendium provenance or unverifiable third-party material is reported as `incomplete`, not incorrectly rejected. Scores currently below multiclass entry prerequisites are warnings because the *historical* score at entry may differ.

```json
{ "actor": "ACTOR_ID" }
```

The report includes `expected_spell_slots` (shared multiclass table, Pact Magic separately), `verified_sources` (including verified feat UUIDs) and explicit `limits`. Wizard spellbooks may legitimately contain additional copied spells: the audit **does not impose a false six-plus-two maximum**. Always-prepared feature spells are not counted as ordinary prepared-class selections; unverified grants and exceptional subclass spells remain outside certification. Historical ability values, feat eligibility at the time of acquisition, copied spells, HP rolls and derived magic-item effects still require separate review; this tool neither rewrites the sheet nor invents PDF page citations.

### Change equipment and prepared spells on an existing character

Use `edit_actor` on a single-class 2024 character. Both maps use the **embedded Item IDs** from `list_documents(type="Item", parent="Actor.ACTOR_ID")`:

```json
{
  "actor": "ACTOR_ID",
  "equipment": { "OLD_WEAPON_ITEM_ID": false, "NEW_WEAPON_ITEM_ID": true },
  "prepared_spells": { "OLD_SPELL_ITEM_ID": false, "NEW_SPELL_ITEM_ID": true }
}
```

1. Without `apply: true`, the tool is read-only and previews each before/after state, as well as the resulting number of prepared class spells.
2. It accepts only owned equipment and already-known 2024 class spells, refuses preparing always-granted feature spells or exceeding the class's verified `max-prepared` scale, and checks the unlocked spell level. It also refuses equipping a two-handed weapon together with a shield.
3. It **warns**, without rejecting, if armor is worn without training (2024: Disadvantage on Strength/Dexterity D20 Tests and inability to cast spells), a shield is used without training (no shield AC bonus), or a weapon is used without proficiency (no Proficiency Bonus to its attacks). Multiple equipped one-handed weapons are allowed; the actual hands used during an attack remain the player's/GM's decision.
4. With `apply: true`, the MCP snapshots the actor and inventory **before** changing only the requested item flags; the response returns `instantane`. Review and restore it via the existing `snapshots` tool, including a read-only rollback preview and conflict check.

This changes **existing** item states; it does not learn new spells, resolve long-rest timing or certify every class restriction. New spells must be acquired through the normal advancement/compendium workflow, with legal choices verified independently.

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
| `RULES_INDEX_PATH` | `.rules/rules-index.json` relative to MCP working directory | Path to the **existing** index produced by `foundry-ai-agent` (legacy `srd-5.2.1.json` also accepted); the matching `search-v1.json` is loaded from the same directory when valid |
| `RULES_ACCESS_FILE` | `rules-private/access.json` relative to MCP working directory | Optional `{"version":1,"rules_for_all":["Player Handbook 2024.pdf"]}` allowlist; all other private PDFs, including adventures, are GM-only by default |
| `RULES_SEARCH_METRICS` | unset | Set `1` to log retrieval times without logging excerpts |

**Language migration (incremental):** set `MCP_LOCALE=en` to receive English text for supported OAuth errors, dispatcher errors, pagination hints, snapshots, target diagnostics and selected GM / table / card feedback. The OAuth sign-in page additionally honors the browser's `Accept-Language` (English or French), independently for each player. This option deliberately **does not translate JSON keys, enum values, Foundry document content or user-entered names**. Some messages are still French; see [internationalization and compatibility](docs/internationalization.md) for current coverage, migration rules and future work.

If the proxy is in a separate container or host, bind `HOST` to a suitable **private** interface and apply firewall rules. Never expose the MCP HTTP port directly to the public internet.

### Shared D&D book search (MCP)

The indexed book collection is local data, **not part of this public repository**. If both services run on the same host, configure the MCP service to read the agent's existing index and policy, e.g.:

```ini
RULES_INDEX_PATH=/opt/foundry-ai-agent/.rules/rules-index.json
RULES_ACCESS_FILE=/opt/foundry-ai-agent/rules-private/access.json
```

The account running `foundry-mcp` needs read access to the index, the `search-v1.json` sidecar and policy file (for example via a dedicated read-only group or ACL). Do not copy private books into Git, make the index world-readable, or re-extract the PDFs. The index is refreshed automatically when its file metadata changes. Missing indexes produce a tool error, **not an invented rule**. `rules_list_sources` shows only books permitted for that request; `rules_search` returns verifiable excerpts with PDF page numbers; `rules_read_page` follows up on an exact source/page and uses `next_offset` if needed. Private PDFs have no public URL in the result.

For direct MCP connections, Foundry's authenticated roles determine visibility: players see the official SRD plus PDFs explicitly listed in `rules_for_all`, while GM and Assistant GM accounts can consult all indexed books. For a shared AI bridge authenticated as an Assistant GM but responding to a player, set the HTTP header `X-Rules-Audience: player` **from trusted, server-side message-role data**. That header can only reduce access; a player account cannot use it to gain GM access. The model must never control this header. Keep the role-scoped tool output out of shared logs and player chat; the agent bridge must set the audience separately for each request.

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
