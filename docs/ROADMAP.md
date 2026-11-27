# Character automation roadmap (D&D 2024)

The earlier four-step plan was **feature-oriented**; its proposed PR numbers no longer match the actual GitHub history. Track capabilities by their behavior, not by a reused PR number.

| Capability | Status | Implemented / next milestone |
| --- | --- | --- |
| Rebuild an existing character from verifiable recorded choices | Available | `advancement_blueprint`, `rebuild_actor`, and orphaned-choice recovery (through PRs #22–#23) |
| Create a new character with class, species, background, advancements and equipment | Available | `build_actor` in PR #24; concrete Trait choices and replay validation in PRs #25–#26 |
| Finish a new character ready to play | Available | Equip starting gear and select an exact official spell set (`spells=selected`); PR #27, live-tested with a Paladin 2024 level 8 (AC 19, seven selected spells) |
| Level an existing single-class 2024 character with preview and rollback | In progress | `progress_actor`, write-free `advance` preflight and recoverable snapshots; PR #28 |
| Edit existing equipment, prepared spells and multiclass progress | Planned | Preview-first item/spell editing, per-class advancement, strict source and choice checks; do not guess |
| Certify D&D 2024 rules legality | Planned | Validate prerequisites, edition, class/subclass/feat progression, spellbook limits, selected equipment, and derived sheet values against verified sources |

## Principles

1. Choices the rules leave to a player or GM are **requested**, never invented. Automatically resolve a choice only when the underlying source and saved decision make it unambiguous.
2. Preview first; write to Foundry only after all required choices have been validated and the caller explicitly requests `apply: true`.
3. Keep spell selection **bounded** to the authorized class list and level. `spells=all` remains a legacy convenience option and is not a rules-legality certification.
4. Preserve the source character and its items during a rebuild; an update-in-place workflow must save the state **before** writing and reject rollback if later edits make it unsafe.
5. Distinguish **structural correctness** (required items and fields exist) from **rules legality** (the character follows all relevant D&D 2024 rules). Do not claim the latter until the corresponding checks are implemented and tested.

## Acceptance checks for the upcoming update-and-rules milestones

- New character: Paladin 2024 / Human / Soldier level 8, exact advancement choices, armor/shield/weapon equipped, and seven explicitly selected class spells without importing the entire class list.
- Progress existing character: level 8 to 9 in preview and apply modes, with changes limited to the chosen actor and a recorded recovery snapshot; test restore and failed intermediate writes. PR #28 covers the protocol and mock cases; live validation awaits merge/deployment.
- Rules validation: reject a spell outside the class list or above the unlocked slot level, duplicate or excess prepared spells, incompatible rule editions, and impossible equipment combinations.
- Compare post-update values (HP, saves, class level, subclass, features, spell slots, mastery, armor class and spells) with independently computed expectations.
