# Character automation roadmap (D&D 2024)

The earlier four-step plan was **feature-oriented**; its proposed PR numbers no longer match the actual GitHub history. Track capabilities by their behavior, not by a reused PR number.

| Capability | Status | Implemented / next milestone |
| --- | --- | --- |
| Rebuild an existing character from verifiable recorded choices | Available | `advancement_blueprint`, `rebuild_actor`, and orphaned-choice recovery (through PRs #22–#23) |
| Create a new character with class, species, background, advancements and equipment | Available | `build_actor` in PR #24; concrete Trait choices and replay validation in PRs #25–#26 |
| Finish a new character ready to play | Available | Equip starting gear and select an exact official spell set (`spells=selected`); PR #27, live-tested with a Paladin 2024 level 8 (AC 19, seven selected spells) |
| Level an existing single-class 2024 character with preview and rollback | Available | `progress_actor`, write-free `advance` preflight and recoverable snapshots; PR #28, live-tested 8→9→8 |
| Edit owned equipment and prepared class spells | Available | `edit_actor` previews state changes and validates equipment/spell constraints, with restorable snapshots; PR #29 |
| Multiclass progression | Available | `multiclass_actor`: verified D&D 2024 class prerequisites, one level at a time, secondary-class proficiencies, preview and recoverable snapshots; PR #30 |
| Multiclass spell acquisition | Available (PR #33) | Class-scoped verified 2024 cantrip/prepared selections, Wizard spellbook entry/growth, independent Pact Magic and shared multiclass slots; subclass third-casters and spell replacement rules remain out of scope |
| Read-only D&D 2024 sheet audit | Available (PR #34) | `validate_actor`: source-aware class/spell/equipment checks with errors, warnings and explicitly unverified cases. Does not claim global rules certification |
| Subclass spell evidence and verified third-casters | Available (PR #35) | Trace mandatory always-prepared spells through official subclass feature grants; check official 2024 subclass sources, Fighter/rogue third-caster scales and the Wizard spell list. Select and optionally replace third-caster spells on later level-ups with preview and rollback. Missing official subclass sources remain unverified |
| Recorded advancement and feat audit | Available (PR #36) | Compare persisted class/subclass choices to exact official advancements: ASI allocation, feat source and numeric level prerequisite, subclass choice, mandatory ItemGrant features and choices recorded past current level. Preserve uncertainty for historical attributes, stale item IDs and incomplete source data |
| Species and background 2024 advancement audit | Available (PR #37) | Verify official origin source, saved value-only advancement keys, origin ASI/size, exact single-pool trait choices and mandatory grants. Leave custom and ambiguous choices explicitly unverified |
| Nested official feat selections | Available (PR #38) | Verify recorded `ItemChoice` feature grants (Fighting Style, Human Versatile): choice count, allowed feat type/subtype, provenance and current numeric prerequisite. Respect open recommended pools and leave conditional/history checks unverified |
| Historical feat level prerequisites | Available (PR #39) | Prove acquisition timing from single-class official advancement levels or exact recorded ItemGrant provenance, including origin-at-creation feats. Respect multiclass lower bounds and mark undecidable historical totals unverified |
| Scoped audit false-positive cleanup | Available (PR #40) | Do not require a baseline cantrip scale for verified 2024 Paladin without ordinary cantrips; prove Fighting Style feat prerequisite only from the exact official feature and saved ItemGrant, retaining all unknown cases. Verified live after deployment: 0 errors, 0 warnings, 0 unverified on the level-8 test Paladin |
| Exact official compendium provenance | Available (PR #41) | Reject world-pack or wrong-pack same-ID fallbacks as class/subclass rules evidence; keep nested feature and always-prepared spell grants unverified unless they resolve from their exact official packs. Live verification: 4 explicitly unverified Devotion oath spells because `dnd-players-handbook.spells` is not installed |
| Verified 2024 spellcasting progression | Available (PR #42) | Detect embedded class/subclass caster progression contradicting its exact official source, and use verified progressions for class spell audits and expected spell slots. Live verification: 0 errors, 0 warnings, same 4 explicitly unverified missing-PHB spells |
| Saved ItemGrant object-ID provenance | Available (PR #43) | Check the exact owned ID and compendium UUID for recorded class/subclass/origin ItemGrant additions (mandatory and optional). Live verification: 0 errors, 0 warnings, same 4 missing-PHB unverified spell grants |
| Class spell attribution gaps | PR #44 (review) | Normalize owned spell `sourceClass` casing consistently for spell limits; report unexplained spells attributed to a verified noncaster as unverified, while exempting separately proven always-prepared subclass grants |
| Certify full D&D 2024 rules legality | Planned | Verify recorded historical choices, subclass/feat progression, equipment interactions, copied spellbook entries and derived sheet values against available authoritative rules |

## Principles

1. Choices the rules leave to a player or GM are **requested**, never invented. Automatically resolve a choice only when the underlying source and saved decision make it unambiguous.
2. Preview first; write to Foundry only after all required choices have been validated and the caller explicitly requests `apply: true`.
3. Keep spell selection **bounded** to the authorized class list and level. `spells=all` remains a legacy convenience option and is not a rules-legality certification.
4. Preserve the source character and its items during a rebuild; an update-in-place workflow must save the state **before** writing and reject rollback if later edits make it unsafe.
5. Distinguish **structural correctness** (required items and fields exist) from **rules legality** (the character follows all relevant D&D 2024 rules). Do not claim the latter until the corresponding checks are implemented and tested.

## Acceptance checks for the upcoming update-and-rules milestones

- New character: Paladin 2024 / Human / Soldier level 8, exact advancement choices, armor/shield/weapon equipped, and seven explicitly selected class spells without importing the entire class list.
- Progress existing character: level 8 to 9 in preview and apply modes, with changes limited to the chosen actor and a recorded recovery snapshot; restore and failed intermediate writes tested. PR #28 was also validated live: Paladin 8→9 (68→76 HP, 54→57 items) and rollback 9→8 with no inventory differences.
- Modify existing character: swap equipped items and prepared class spells with a read-only preview; reject two-handed weapon/shield conflicts, excessive preparation and 2014-only spells; warn about missing training without inventing a prohibition; restore exact prior item states.
- Rules validation: reject a spell outside the class list or above the unlocked slot level, duplicate or excess prepared spells, incompatible rule editions, and impossible equipment combinations.
- Compare post-update values (HP, saves, class level, subclass, features, spell slots, mastery, armor class and spells) with independently computed expectations.
