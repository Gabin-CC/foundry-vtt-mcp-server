# Internationalization and compatibility

## Current behavior

The public MCP tool discovery metadata is English (`src/tool-english.mjs`).
The server's original responses and some arguments are older than this metadata
and use French keys or values. These are **protocol fields**, not text to
translate automatically.

This incremental rollout adds `src/i18n.mjs` for MCP-owned human-readable
messages. It does not introduce a locale setting for game documents, Babele
translations, or the Foundry world itself.

| Surface | Language selection | Compatibility |
| --- | --- | --- |
| Tool names and arguments | Unchanged | Always preserve existing spelling |
| Audited MCP response fields | Original keys in `MCP_LOCALE=fr`; original + English aliases in `en` | All legacy keys retained; no enum/status values renamed |
| Tool discovery descriptions | English | Already English, regardless of locale |
| Selected errors, pagination hints and GM/table/card feedback | `MCP_LOCALE=fr` (default) or `en` | Legacy French by default; opt-in English strings |
| D&D 5e advancement choices, spell preparation, check labels, item-use feedback, resource errors and dice-parser errors | `MCP_LOCALE=fr` (default) or `en` | Text values only; existing response keys, choice identifiers and Foundry document data remain unchanged |
| GM permissions explanations, item-repair warnings, synchronization diffs, dry-run guidance and snapshot-safety errors | `MCP_LOCALE=fr` (default) or `en` | Human-readable text only; permission-level/status values and snapshot metadata remain unchanged |
| Remaining MCP-owned user feedback: search/compendium/edition errors, file-upload and path-safety diagnostics, Foundry connection errors, chat cards (item use, rests, loot, damage/healing), and HTTP authentication errors | `MCP_LOCALE=fr` (default) or `en` | No argument, response key, enum, HTTP status, security check, or Foundry document is changed |
| OAuth sign-in page and its validation feedback | Browser `Accept-Language` (English/French), then `MCP_LOCALE` | Same form fields, endpoints, PKCE flow and credentials handling |
| Foundry names, journal text, dice rules, translations and data | Not translated by this layer | Unchanged |

Set the option in the MCP systemd unit if English messages are preferred:

```ini
Environment=MCP_LOCALE=en
```

Then reload systemd and restart the MCP service. This setting is **per server
process**, not per MCP client. On a shared server, the OAuth login page can
still use each player's browser language, but tool feedback follows the
server setting. Invalid locale values fall back to French.

## Additive English response keys

`src/response-aliases.mjs` adds **explicitly mapped** English keys to selected
MCP-owned result objects when `MCP_LOCALE=en`. It does not translate any values
or delete the French keys. The default French mode returns the original object
without an additional clone or any response-shape change.

For example, a search result containing `resultats` also contains `results`
in English mode:

```json
{
  "total": 1,
  "resultats": [{ "nom": "Bouclier", "niveau": 1, "name": "Bouclier", "level": 1 }],
  "results": [{ "nom": "Bouclier", "niveau": 1, "name": "Bouclier", "level": 1 }]
}
```

The `resultats` and `results` fields refer to the same **expanded** data in
memory, with both old and new keys on each mapped entry. JSON itself does not
support references, so serialization duplicates their contents; large results
can still be paginated by the existing response-size mechanism.

Key examples: `portee` → `scope`, `statut` → `status`, `simulation` → `dry_run`,
`choix_requis` → `required_choices`, `avertissements` → `warnings`,
`utilisateurs` → `users`, `niveau` → `permission_level` in GM permission
reports, and `detail` → `details` in repair reports. Keys inside a Foundry
document or recovery snapshot are **never** changed or aliased. Tool outputs
that contain raw documents (`get_document`, `list_documents`,
`get_compendium_entry`, snapshot contents) are excluded from this adapter.
Existing enum values such as `statut: "anglais"` and permission level
`niveau: "observateur"` remain unchanged under either key.

Mappings are per-tool and per-known nested shape, not a global recursive
translation. When adding a new alias, extend the whitelist and add a paired
FR/EN regression test. No input parameter, mode, action or enum alias is
introduced in this rollout.

## Rules for contributors

1. Use `message(english, french)` for **human-facing text only**, with an
   audited English translation and the current French text as fallback.
2. Do not rename legacy object keys, tool/action names, stored snapshot
   schemas, status enums, document content, D&D source terminology, or
   user-provided strings. New English response-key aliases must be additive,
   explicit, scoped to MCP-owned output objects and covered by tests.
3. For browser-facing text, pass an explicit locale selected from
   `Accept-Language` using `browserLocale`; escape all untrusted data.
4. Test both `MCP_LOCALE=fr npm run check` and `MCP_LOCALE=en npm run check`. Keep the
   documented legacy response keys unchanged in both modes; FR shape is exact.
5. Preserve Foundry internal API constants and class names unchanged.

## Final user-facing audit and deliberate exclusions

The latest audit covers MCP-owned text from search/reference and compendium
lookups, edition selection, security guards, uploads (including HTTPS/DNS
rejections), Foundry session establishment, chat cards and rest/loot/damage
messages, as well as HTTP authentication responses. The dedicated regression
tests exercise FR and EN and verify the unchanged result structure. The
translation layer never relaxes the existing validation/security checks.

The following are intentionally **not** translated by this layer:

- Foundry-provided errors and names, advancement titles/hints, synthesized
  Plutonium advancement labels, and spell/scroll or journal content. These
  belong to the running world and should be forwarded faithfully, even when
  the originating Foundry module sends English text.
- Translation audits and search responses retain stable fields such as
  `resultats`, `portee`, `statut`, and stable values such as `anglais` and
  `mixte`. English mode adds the mapped keys without changing these values.
- GM repair/synchronization protocol values (`niveau: "observateur"`,
  `statut: "sans source (créé à la main)"`), historical snapshot metadata,
  diff preview markers and recovery payloads. Translating stored or compared
  values may break recovery or automation and requires a versioned migration.
- Internal numeric-formula exceptions which are caught by the evaluator and
  never exposed as user-facing text, plus build-time/tool-metadata validation
  errors. Tool discovery metadata is already English and remains unchanged.
- Raw item-use roll results and stat labels returned by the D&D rules engine
  where the values may be treated as structured/historical output; these are
  left unchanged pending a separate compatibility review.
- End-to-end tests against a disposable Foundry v14 world remain necessary
  before changing stateful operations or making English the default. Unit tests
  use mocked Foundry sessions and do not deploy or modify the live world.

When the coverage is complete, the default locale can be reconsidered in a
separate release with a clear upgrade note.
