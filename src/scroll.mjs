/**
 * Parchemin de sort — équivalent d'Item5e.createScrollFromCompendiumSpell de dnd5e (explication « référence »),
 * qui ne tourne que dans le navigateur. Le parchemin de base du niveau du sort reçoit une activité « Lancer un sort »
 * (cast) pointant vers le sort, avec le bonus d'attaque et le DD des parchemins (table DND5E.spellScrollValues).
 */
import { fetchUuid } from "./advancement.mjs";
import { loc } from "./cast.mjs";
import { sanitizeItemData } from "./repair.mjs";

// CONFIG.DND5E.spellScrollIds / spellScrollValues (dnd5e 6.1)
const SCROLL_IDS = Object.fromEntries([["0", "Ca"], ["1", "1s"], ["2", "2n"], ["3", "3r"], ["4", "4t"], ["5", "5t"], ["6", "6t"], ["7", "7t"], ["8", "8t"], ["9", "9t"]]
  .map(([l, s]) => [l, `Compendium.dnd5e.equipment24.Item.dmgSpellScroll${s}`]));
const SCROLL_VALUES = { 0: { dc: 13, bonus: 5 }, 3: { dc: 15, bonus: 7 }, 5: { dc: 17, bonus: 9 }, 7: { dc: 18, bonus: 10 }, 9: { dc: 19, bonus: 11 } };
const ACTIVITY_ID = "dnd5escrollspell"; // staticID("dnd5escrollspell")

/** Données d'un parchemin pour le sort `spellUuid` (niveau du sort, ou `level` s'il est plus haut). */
export async function scrollFromSpell(fs, spellUuid, level) {
  const spell = await fetchUuid(fs, spellUuid);
  if (spell?.type !== "spell") throw new Error(`Pas un sort : ${spellUuid}`);
  const lvl = Math.max(Number(spell.system?.level) || 0, Number(level) || 0);
  const scrollUuid = SCROLL_IDS[lvl];
  const scroll = structuredClone(await fetchUuid(fs, scrollUuid));
  delete scroll._id; delete scroll.folder; delete scroll.sort; delete scroll.ownership; delete scroll.__pack;
  let values = {};
  for (let l = lvl; l >= 0; l--) if (SCROLL_VALUES[l]) { values = SCROLL_VALUES[l]; break; }
  const activity = {
    _id: ACTIVITY_ID, type: "cast",
    consumption: { targets: [{ type: "itemUses", value: "1" }] },
    spell: { challenge: { attack: values.bonus, save: values.dc, override: true }, level: lvl, uuid: spellUuid }
  };
  const conc = (spell.system?.properties || []).includes("concentration");
  const desc = ["<p><em>", await loc(`DND5E.SpellLevel${lvl}`, String(lvl)), " &Reference[Spell Scroll]",
    conc ? `, ${await loc("DND5E.Scroll.RequiresConcentration", "Requires Concentration")}` : "",
    "</em></p>", `<p>@Embed[${spellUuid} inline]</p>`].join("");
  scroll.name = `${await loc("DND5E.SpellScroll", "Spell Scroll")}: ${spell.name}`;
  scroll.system = { ...(scroll.system || {}), activities: { ...(scroll.system?.activities || {}), [ACTIVITY_ID]: activity },
    description: { ...(scroll.system?.description || {}), value: desc } };
  scroll._stats = { ...(scroll._stats || {}), compendiumSource: scrollUuid };
  sanitizeItemData(scroll);
  return scroll;
}
