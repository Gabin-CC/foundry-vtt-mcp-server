/** English MCP tool metadata. Wire keys and legacy enum values remain unchanged. */
const DESCRIPTIONS = {
  world_info: "Show the active Foundry world, authenticated account, and users.",
  list_documents: "List visible Foundry documents with filters and pagination. ChatMessage supports inclusive since_timestamp, chronological ordering, and latest_timestamp.",
  next_page: "Retrieve the next JSON page of an oversized MCP response using its cursor.",
  get_document: "Read a Foundry document or a specific nested property.",
  create_documents: "Create one or more Foundry documents, including embedded items, with ID sanitization and source warnings.",
  update_documents: "Update documents using dotted property paths. Supports dry-run previews and requires a recovery snapshot before writing.",
  delete_documents: "Delete documents after saving their complete original data to a recovery snapshot. Supports dry-run previews.",
  snapshots: "List, inspect and restore document recovery snapshots. Restore supports dry-run and creates its own undo snapshot for field updates.",
  actor_sheet: "Show a computed character or NPC sheet: level, abilities, modifiers, approximate AC and HP, skills, spells and resources.",
  roll: "Roll a dice formula and post the result to Foundry chat. Supports advantage/disadvantage and keep-high/keep-low.",
  check: "Roll an ability check, saving throw, skill check or initiative using the actor's derived bonus; post to chat.",
  use_item: "Use an actor's spell, weapon, consumable or feature: roll attacks and damage/healing, report save DC, spend resources and post a chat card. Optional targets produce a reviewable application proposal.",
  apply_damage: "Apply a validated use_item proposal to targets (damage, healing, temporary HP and effects) or apply explicit manual values. Unlinked tokens are updated independently.",
  rest: "Apply a short or long dnd5e rest and refresh the appropriate hit points, spell slots, hit dice and item uses.",
  list_packs: "List installed compendiums, entry counts, document types and available French translations.",
  search_compendium: "Search installed compendiums by French or English name, type and spell level.",
  get_compendium_entry: "Read a compendium entry, using an available French translation when configured.",
  localize_actor: "Reapply available French Babele translations to an actor's items and convert supported units when dnd5e metric mode is enabled.",
  add_from_compendium: "Import spells, equipment, classes, species, backgrounds or other compendium entries into an actor or the world. Supports 2014/2024 rules selection.",
  give_loot: "Give an actor currency and optionally create simple loot items. Weights use the world unit (kg with dnd5e metric weights, otherwise lb) unless weight_unit is given; lb is converted to kg by halving, like the French dnd5e module.",
  upload_file: "Upload a validated media file from base64 or an explicitly allowlisted HTTPS origin (max 20 MiB; SVG and private-network URLs blocked).",
  send_chat: "Post a Foundry chat message as the current user or a chosen character, optionally whispered to specified recipients.",
  advance: "Apply dnd5e class, subclass, species, background or feat advancements. Return explicit options when a character choice is required.",
  advancement_blueprint: "Inspect a single-class character and recover their recorded advancement decisions, class compendium source and pre-class ability scores without modifying Foundry.",
  compare_actors: "Compare two computed actor sheets and report differences in abilities, hit points, proficiencies, spells, features and inventory; does not modify either actor.",
  audit_translation: "Audit untranslated or mixed-language world/compendium fields, or calculate translation coverage by pack and document type.",
  search_text: "Search world and compendium names and text, including both original and translated variants, with UUIDs and field excerpts.",
  find_references: "Find references to a document UUID in text, copied items, tokens, map notes, table results and effects.",
  roll_table: "Roll on a Foundry roll table, including recursive tables and optional chat output; inspect and reset results.",
  cards: "Manage Foundry card decks and hands: list, draw, deal, pass, discard, shuffle and recall.",
  gm_scene: "GM: list scenes, activate a scene, bring players to a scene or adjust scene darkness.",
  gm_music: "GM: list playlists, play/stop playlists or tracks, stop all audio and adjust volume.",
  gm_show: "GM: show an image or journal entry to selected players, move recipients to a scene, or preview access and content without sharing.",
  gm_permissions: "GM: inspect what each user can see, read or edit in a Foundry document, including embedded pages and compendiums.",
  gm_tile: "GM: place an image tile on a scene using grid coordinates.",
  gm_token: "GM: list, place, move, remove, hide or reveal scene tokens.",
  gm_combat: "GM: start, inspect, advance, rewind or end combat on a scene.",
  gm_check_ids: "GM: scan and optionally repair invalid activity and advancement IDs in world packs, items and actor inventories, with a recovery snapshot.",
  gm_sync_items: "GM: compare a character's items with their source compendiums, preview missing activities/effects/advancements, and optionally synchronize with a recovery snapshot.",
  gm_patch_items: "GM: preview and optionally apply known dnd5e item-structure fixes to an actor, all actors or a compendium, with a recovery snapshot.",
  gm_pause: "GM: pause or resume the game for connected players."
};

const FIELDS = {
  type: "Foundry document type, such as Actor, Item, JournalEntry or RollTable.",
  pack: "Compendium identifier; limits the operation to a pack when supported.",
  parent: "Parent document UUID for embedded documents, such as Actor.ID or Scene.ID.",
  actor: "Actor name or ID.",
  item: "Item name or ID.",
  id: "Document or snapshot identifier.",
  name_contains: "Filter names case-insensitively.",
  since_timestamp: "For ChatMessage only: return messages from this Unix timestamp in milliseconds (inclusive).",
  filter: "Exact-match filters by property path, for example {\"type\":\"character\"}.",
  fields: "Fields to return as dotted paths, for example [\"name\",\"system.attributes.hp.value\"].",
  limit: "Maximum number of results per page.",
  cursor: "Cursor from the preceding page of results.",
  offset: "Alternative starting offset (stable document ID order).",
  path: "Optional nested document property path, for example system.abilities.",
  warn_packs: "Compendium IDs to search for items with the same name when a newly created item lacks activities and effects.",
  dry_run: "Preview the changes without mutating Foundry.",
  tool: "Filter snapshots by their originating MCP tool name.",
  flavor: "Human-readable label for the roll.",
  key: "Ability abbreviation (str, dex, con, int, wis, cha) or skill abbreviation (acr, ath, prc, etc.).",
  activity: "Activity name or ID when the item provides more than one activity.",
  slot_level: "Spell-slot level to use when upcasting.",
  versatile: "Use a versatile weapon with both hands.",
  consume: "Consume spell slots, uses or item quantities when applicable.",
  target: "Optional free-form target label displayed in chat.",
  targets: "Target token UUIDs/IDs or names, or Actor UUIDs; proposes individual hits, saves, damage, healing and effects.",
  proposal: "Proposal ID returned by use_item.",
  multiplier: "Damage multiplier (for example 0.5 for half damage, 0 for none, or 2 for double).",
  force: "Override the usual protection or permission check for this operation.",
  item_type: "Filter by item type, such as spell, weapon, feat, class, equipment or background.",
  level: "Spell level or target class level, depending on the tool.",
  rules: "Requested rules edition: 2014 or 2024. The corresponding entry is resolved by identity, not assumed to share the same ID.",
  name: "Exact French or English item name when no ID is provided.",
  uuid: "Foundry document or compendium UUID, such as Compendium.package.pack.Item.ID.",
  overrides: "Fields to override using dotted paths.",
  scroll: "UUID of a spell to place in a scroll, using a matching scroll template from a compendium.",
  enchant: "Enchantment to apply, specified by the source item UUID and effect name or ID.",
  folder: "Destination folder ID when importing into the world.",
  document_type: "With a name and no pack: compendium document type to search (world packs first, then dnd5e 2024, then others).",
  weight_unit: "Unit of the supplied item weights (defaults to the world unit: kg when dnd5e metric weights are enabled, otherwise lb).",
  currency: "Currency quantities, for example {\"gp\":50,\"sp\":20}; negative values remove money.",
  url: "HTTPS media URL from an origin configured in UPLOAD_ALLOWED_ORIGINS.",
  base64: "Base64 or data:...;base64 payload. Supply exactly one of url or base64.",
  whisper_to: "User names or IDs to receive the private message.",
  source: "Advancement source: {pack,id}, {pack,name}, or a document UUID.",
  spells: "Use all to add available class spells and request the required spell choices.",
  replay_from: "Source actor name or ID for reusing recorded class advancement choices; on an empty actor, restore pre-class ability scores only after all choices are resolved.",
  packs: "Compendium IDs to include in the audit; implies scope=packs when applicable.",
  types: "Foundry document types to include.",
  statuses: "Language statuses to include in the report (legacy French enum values).",
  check_fixes: "Report whether localize_actor can repair an untranslated character item.",
  scope: "Search world, packs or all; the default depends on the query.",
  table: "Roll-table name or ID.",
  count: "Number of rolls or cards, depending on the operation.",
  chat: "Post a result to Foundry chat when enabled.",
  from: "Source card deck or hand.",
  to: "Destination card deck or hand.",
  cards: "Card names or IDs to act on.",
  face_down: "Keep dealt or drawn cards face down.",
  scene: "Scene name or ID; defaults to the active scene where supported.",
  darkness: "Scene darkness between 0 (daylight) and 1 (darkness).",
  playlist: "Playlist name or ID.",
  sound: "Optional track name or ID within the playlist.",
  volume: "Audio volume between 0 and 1.",
  image: "Foundry image path or URL; upload a local file with upload_file first.",
  journal: "Journal name/ID or a specific JournalEntryPage UUID.",
  users: "Recipient user names or IDs; defaults to everyone.",
  preview: "Show a preview without revealing content to players.",
  user: "Limit the permissions report to one user name or ID.",
  x: "Horizontal position in grid cells.",
  y: "Vertical position in grid cells.",
  width: "Tile width in grid cells.",
  height: "Tile height in grid cells.",
  hidden: "Hide the tile or token from players.",
  token: "Token name or ID.",
  tokens: "Token IDs to include in the encounter.",
  only: "Limit synchronization to items with these names.",
  apply: "Apply the proposed changes; defaults to preview-only. Requires a recovery snapshot."
};

const SPECIAL_FIELDS = {
  apply_damage: { targets: "Limit application to selected target UUIDs or names.", force: "Allow reapplying an already consumed proposal." },
  find_references: { uuid: "Document UUID to search for, for example Compendium.dnd5e.spells24.Item.ID." },
  gm_sync_items: { pack: "Only synchronize items originating from this specific source compendium." },
  gm_patch_items: { pack: "World compendium whose items should be patched instead of an actor." },
  gm_check_ids: {},
  roll_table: { table: "Roll table name or ID to roll from." },
  list_packs: { type: "Filter compendiums by document type (Item, Actor, JournalEntry, etc.)." },
  search_compendium: { level: "Filter by spell level." },
  advance: { level: "Target class level; defaults to the source actor's level when replay_from is provided, otherwise current level + 1 or 1 for a new class." },
  compare_actors: { source: "Source actor name or ID for the comparison.", target: "Target actor name or ID for the comparison." },
  gm_token: { hidden: "Create a token hidden from players." },
  gm_tile: { hidden: "Create a tile visible only to the GM." },
  gm_show: { force: "Allow journal sharing even when recipients lack ordinary read permission.", image: "Image path or URL to display to recipients." },
  snapshots: { id: "Recovery snapshot ID used by show and restore." }
};

function translateSchema(schema, toolName) {
  const visit = (node, field) => {
    if (!node || typeof node !== "object") return;
    if (node.description) {
      const replacement = SPECIAL_FIELDS[toolName]?.[field] || FIELDS[field];
      if (!replacement) throw new Error(`Missing English schema description for ${toolName}.${field}`);
      node.description = replacement;
    }
    for (const [key, child] of Object.entries(node.properties || {})) visit(child, key);
    if (node.items) visit(node.items, field);
  };
  visit(schema, "");
}

export function englishToolMetadata(tool) {
  const description = DESCRIPTIONS[tool.name];
  if (!description) throw new Error(`Missing English MCP description for ${tool.name}`);
  const copy = structuredClone(tool);
  copy.description = description;
  translateSchema(copy.inputSchema, tool.name);
  return copy;
}
