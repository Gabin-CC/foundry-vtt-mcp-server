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
| Tool names, arguments and JSON response keys | Unchanged | Always preserve existing spelling |
| Tool discovery descriptions | English | Already English, regardless of locale |
| Selected errors, pagination hints and GM/table/card feedback | `MCP_LOCALE=fr` (default) or `en` | Legacy French by default; opt-in English strings |
| D&D 5e advancement choices, spell preparation, check labels, item-use feedback and resource errors | `MCP_LOCALE=fr` (default) or `en` | Text values only; existing response keys, choice identifiers and Foundry document data remain unchanged |
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

## Rules for contributors

1. Use `message(english, french)` for **human-facing text only**, with an
   audited English translation and the current French text as fallback.
2. Do not translate object keys, tool/action names, stored snapshot schemas,
   status enums, document content, D&D source terminology, or user-provided
   strings. A new English alias for a response field must be additive and
   explicitly designed/tested as a separate protocol change.
3. For browser-facing text, pass an explicit locale selected from
   `Accept-Language` using `browserLocale`; escape all untrusted data.
4. Test both `npm run check` and `MCP_LOCALE=en npm run check`. Keep the
   documented legacy response shape unchanged in both modes.
5. Preserve Foundry internal API constants and class names unchanged.

## Remaining migration work

This is not a claim that every message has been translated. In particular:

- D&D advancement, spell-preparation and resource-consumption feedback is now
  bilingual. Dice-parser errors remain in legacy French; migrate these only
  with dedicated regression tests for arithmetic and error behavior.
- Foundry-sourced names, advancement titles/hints, synthesized Plutonium
  advancement labels and spell/scroll document content remain in the source
  language (this setting does not retranslate game data). The legacy keys
  inside character sheets and pending choice objects remain unchanged.
- Translation audits and search responses still use stable fields such as
  `resultats`, `portee`, `statut`, `anglais`, and `mixte`.
- Some GM permission-level labels and repair/synchronization reports remain
  French. They need audited aliases or an explicit protocol version, not a
  global string replacement.
- End-to-end tests against a disposable Foundry v14 world remain necessary
  before changing stateful operations or making English the default.

When the coverage is complete, the default locale can be reconsidered in a
separate release with a clear upgrade note.
