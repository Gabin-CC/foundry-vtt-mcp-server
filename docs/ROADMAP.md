# Character automation roadmap (D&D 2024)

The earlier four-step plan was **feature-oriented**; its proposed PR numbers no longer match the actual GitHub history. Track capabilities by their behavior, not by a reused PR number.

| Capability | Status | Implemented / next milestone |
| --- | --- | --- |
| Rebuild an existing character from verifiable recorded choices | Available | `advancement_blueprint`, `rebuild_actor`, and orphaned-choice recovery (through PRs #22–#23) |
| Create a new character with class, species, background, advancements and equipment | Available | `build_actor` in PR #24; concrete Trait choices and replay validation in PRs #25–#26 |
| Finish a new character ready to play | In progress | Equip starting gear and select an exact official spell set (`spells=selected`); PR #27 |
| Update or level an existing character through one unified, preview-first workflow | Planned | Reuse `advance` without rebuilding the actor; offer explicit class/feat/spell/equipment choices and a recoverable write path |
| Certify D&D 2024 rules legality | Planned | Validate prerequisites, edition, class/subclass/feat progression, spellbook limits, selected equipment, and derived sheet values against verified sources |

## Principles

1. Choices the rules leave to a player or GM are **requested**, never invented. Automatically resolve a choice only when the underlying source and saved decision make it unambiguous.
2. Preview first; write to Foundry only after all required choices have been validated and the caller explicitly requests `apply: true`.
3. Keep spell selection **bounded** to the authorized class list and level. `spells=all` remains a legacy convenience option and is not a rules-legality certification.
4. Preserve the source character and its items during a rebuild; any future update-in-place workflow must have a recovery snapshot.
5. Distinguish **structural correctness** (required items and fields exist) from **rules legality** (the character follows all relevant D&D 2024 rules). Do not claim the latter until the corresponding checks are implemented and tested.

## Acceptance checks for the upcoming update-and-rules milestones

- New character: Paladin 2024 / Human / Soldier level 8, exact advancement choices, armor/shield/weapon equipped, and seven explicitly selected class spells without importing the entire class list.
- Progress existing character: level 8 to 9 in preview and apply modes, with changes limited to the chosen actor and a recorded recovery snapshot.
- Rules validation: reject a spell outside the class list or above the unlocked slot level, duplicate or excess prepared spells, incompatible rule editions, and impossible equipment combinations.
- Compare post-update values (HP, saves, class level, subclass, features, spell slots, mastery, armor class and spells) with independently computed expectations.
